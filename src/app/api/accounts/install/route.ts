import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";
import { extractSoftaculousError, extractSoftaculousInstallations, normalizeHost } from "@/lib/softaculous";

const SOFTACULOUS_APPS: Record<string, { id: number; name: string }> = {
    wordpress: { id: 26, name: "WordPress" },
    prestashop: { id: 29, name: "PrestaShop" },
};

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

function generateSecurePassword(): string {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&";
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => charset[b % charset.length]).join("");
}

function parseMaybeJson(input: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(input) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // ignore
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findInstallation(baseUrl: string, cookie: string, domain: string): Promise<boolean> {
    const targetHost = normalizeHost(domain);
    const res = await fetch(
        `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
        { headers: { Cookie: cookie } }
    );
    if (!res.ok) return false;
    const text = await res.text();
    const data = parseMaybeJson(text);
    const installations = extractSoftaculousInstallations(data);
    return Object.values(installations).some((install) => {
        const host = normalizeHost(install.softurl ?? install.domain ?? "");
        return host === targetHost;
    });
}

export async function POST(req: NextRequest) {
    const { denied, session } = await requireAuthSession(req);
    if (denied) return denied;

    try {
        const { user, app, adminEmail, targetDomain } = await req.json();

        if (!user || !app || !targetDomain) {
            return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
        }
        if (!isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Username invalide" }, { status: 400 });
        }
        const forbidden = ensureAccountAccess(session, user);
        if (forbidden) return forbidden;
        if (!DOMAIN_RE.test(targetDomain)) {
            return NextResponse.json({ error: "Domaine cible invalide" }, { status: 400 });
        }

        const appConfig = SOFTACULOUS_APPS[app];
        if (!appConfig) {
            return NextResponse.json({ error: `Application "${app}" non supportée` }, { status: 400 });
        }

        const { host, cpsess, cookie } = await getCPanelSessionData(user);
        const baseUrl = `https://${host}:2083/${cpsess}`;

        // Vérifier qu'une installation n'existe pas déjà sur ce domaine
        const alreadyExists = await findInstallation(baseUrl, cookie, targetDomain);
        if (alreadyExists) {
            return NextResponse.json({ error: `Une installation existe déjà sur ${targetDomain}` }, { status: 409 });
        }

        // Charger le formulaire pour récupérer soft_status_key
        const formUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appConfig.id}`;
        const formRes = await fetch(formUrl, { headers: { Cookie: cookie } });
        if (!formRes.ok) {
            throw new Error(`Impossible de charger le formulaire Softaculous (HTTP ${formRes.status})`);
        }
        const formHtml = await formRes.text();

        const statusKeyMatch = formHtml.match(/name=["']soft_status_key["'][^>]*value=["']([^"']+)["']/i)
            ?? formHtml.match(/value=["']([^"']+)["'][^>]*name=["']soft_status_key["']/i);
        const softStatusKey = statusKeyMatch?.[1] ?? "";

        const adminUser = "admin";
        const adminPass = generateSecurePassword();
        const adminEmailFinal = adminEmail || "admin@" + targetDomain;

        const installParams = new URLSearchParams({
            softsubmit: "1",
            auto_upgrade: "1",
            protocol: "https://",
            domain: targetDomain,
            in_dir: "",
            datadir: "",
            dbname: app === "wordpress" ? "wpdb" : "psdb",
            dbuser: app === "wordpress" ? "wpu" : "psu",
            admin_username: adminUser,
            admin_pass: adminPass,
            admin_email: adminEmailFinal,
            language: "en",
            site_name: app === "wordpress" ? "Mon Site WordPress" : "Ma Boutique PrestaShop",
            site_desc: "Installé par WHM Manager",
            ...(softStatusKey ? { soft_status_key: softStatusKey } : {}),
        });

        // Soumettre l'installation
        const installUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appConfig.id}&api=json`;
        const installRes = await fetch(installUrl, {
            method: "POST",
            headers: {
                Cookie: cookie,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: installParams.toString(),
        });

        const rawText = await installRes.text();
        const installData = parseMaybeJson(rawText);

        const softaculousError = extractSoftaculousError(installData);
        if (softaculousError) {
            throw new Error(softaculousError);
        }
        if (!installRes.ok) {
            throw new Error(`Installation échouée (HTTP ${installRes.status})`);
        }

        const siteUrl = `https://${targetDomain}`;
        const adminUrl = app === "wordpress" ? `${siteUrl}/wp-admin` : `${siteUrl}/admin`;

        // Toujours vérifier dans la liste des installations — Softaculous peut mentir sur done
        // Attendre jusqu'à 30s (6 tentatives × 5s)
        for (let attempt = 0; attempt < 6; attempt++) {
            await sleep(5000);
            const found = await findInstallation(baseUrl, cookie, targetDomain);
            if (found) {
                return NextResponse.json({
                    success: true,
                    pending: false,
                    app: appConfig.name,
                    siteUrl,
                    adminUrl,
                    adminUser,
                    adminPass,
                    adminEmail: adminEmailFinal,
                    message: `${appConfig.name} installé sur ${targetDomain}`,
                });
            }
        }

        // Après 30s sans confirmation : installation peut encore être en cours
        const taskId =
            typeof installData?.taskid === "string" ? installData.taskid :
            typeof installData?.task_id === "string" ? installData.task_id : null;

        return NextResponse.json({
            success: true,
            pending: true,
            app: appConfig.name,
            siteUrl,
            adminUrl,
            adminUser,
            adminPass,
            adminEmail: adminEmailFinal,
            taskId,
            message: `Installation lancée sur ${targetDomain}. Vérifiez dans quelques minutes.`,
        });

    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de l'installation") }, { status: 500 });
    }
}

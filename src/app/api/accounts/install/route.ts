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

function extractSelectOptions(html: string, selectName: string): string[] {
    const escapedName = selectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selectRegex = new RegExp(`<select\\b[^>]*\\bname=["']${escapedName}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i");
    const selectMatch = html.match(selectRegex);
    if (!selectMatch) return [];
    const optionRegex = /<option\b[^>]*value=["']([^"']*)["'][^>]*>/gi;
    const options: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = optionRegex.exec(selectMatch[1])) !== null) {
        if (match[1]) options.push(match[1]);
    }
    return options;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findInstallationId(baseUrl: string, cookie: string, domain: string): Promise<string | null> {
    const targetHost = normalizeHost(domain);
    const res = await fetch(
        `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
        { headers: { Cookie: cookie } }
    );
    if (!res.ok) return null;
    const text = await res.text();
    const data = parseMaybeJson(text);
    const installations = extractSoftaculousInstallations(data);
    for (const [id, install] of Object.entries(installations)) {
        const host = normalizeHost(install.softurl ?? install.domain ?? "");
        if (host === targetHost) return id;
    }
    return null;
}


async function findInstallation(baseUrl: string, cookie: string, domain: string): Promise<boolean> {
    return (await findInstallationId(baseUrl, cookie, domain)) !== null;
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

        // Si une installation existe déjà sur ce domaine, la supprimer d'abord
        const existingInsid = await findInstallationId(baseUrl, cookie, targetDomain);
        console.log(`[install] existingInsid=${existingInsid}`);
        if (existingInsid) {
            const removeParams = new URLSearchParams({
                softsubmit: "1",
                removedb: "1",
                removedir: "1",
                insid: existingInsid,
            });
            const removeRes = await fetch(
                `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=remove&insid=${encodeURIComponent(existingInsid)}&softsubmit=1&removedb=1&removedir=1&api=json`,
                { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: removeParams.toString() }
            );
            const removeText = await removeRes.text();
            console.log(`[install] removeStatus=${removeRes.status} removeText=`, removeText.slice(0, 300));
            await sleep(5000);
        }

        // Debug : lister toutes les installations détectées
        const listRes2 = await fetch(
            `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
            { headers: { Cookie: cookie } }
        );
        const listText2 = await listRes2.text();
        const listData2 = parseMaybeJson(listText2);
        const allInstalls = extractSoftaculousInstallations(listData2);
        console.log(`[install] installations détectées:`, Object.values(allInstalls).map(i => i.softurl ?? i.domain));

        const adminUser = "admin";
        const adminPass = generateSecurePassword();
        const adminEmailFinal = adminEmail || "admin@" + targetDomain;

        // Fetcher le formulaire d'install pour extraire les options du select "softdomain"
        // Softaculous ignore domain= s'il ne correspond pas exactement à une option du select
        const formUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appConfig.id}`;
        const formRes = await fetch(formUrl, { headers: { Cookie: cookie } });
        const formHtml = formRes.ok ? await formRes.text() : "";

        // Extraire les options disponibles du select softdomain
        const softdomainOptions = extractSelectOptions(formHtml, "softdomain");
        const targetHost = normalizeHost(targetDomain);

        // Trouver l'option qui correspond au sous-domaine ciblé
        const matchedOption = softdomainOptions.find((opt) => normalizeHost(opt) === targetHost)
            ?? softdomainOptions.find((opt) => opt.includes(targetHost));

        // Si aucune option ne correspond, le sous-domaine n'existe pas encore dans cPanel
        if (softdomainOptions.length > 0 && !matchedOption) {
            return NextResponse.json({
                error: `Le domaine "${targetDomain}" n'est pas disponible dans Softaculous. Créez d'abord le sous-domaine dans cPanel.`,
            }, { status: 400 });
        }

        const softdomainValue = matchedOption ?? targetDomain;

        // Extraire soft_status_key (requis par certaines versions de Softaculous)
        const statusKeyMatch = formHtml.match(/name=["']soft_status_key["'][^>]*value=["']([^"']+)["']/i)
            ?? formHtml.match(/value=["']([^"']+)["'][^>]*name=["']soft_status_key["']/i);
        const softStatusKey = statusKeyMatch?.[1];

        const installParams = new URLSearchParams({
            softsubmit: "1",
            auto_upgrade: "1",
            softproto: "https://",
            softdomain: softdomainValue,
            softdirectory: "",
            admin_username: adminUser,
            admin_pass: adminPass,
            admin_email: adminEmailFinal,
            language: "en",
            site_name: app === "wordpress" ? "Mon Site WordPress" : "Ma Boutique PrestaShop",
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

        // Log pour diagnostic
        console.log(`[install] app=${app} domain=${targetDomain} status=${installRes.status}`);
        console.log(`[install] rawText=`, rawText.slice(0, 500));

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

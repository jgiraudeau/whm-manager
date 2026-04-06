import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData, cpanelApi } from "@/lib/whm";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";
import { extractSoftaculousError } from "@/lib/softaculous";

const SOFTACULOUS_APPS: Record<string, { id: number; name: string }> = {
    wordpress: { id: 26, name: "WordPress" },
    prestashop: { id: 29, name: "PrestaShop" },
};

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

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

export async function POST(req: NextRequest) {
    const { denied, session } = await requireAuthSession(req);
    if (denied) return denied;

    try {
        const { user, app, adminEmail, targetDomain, subdomain } = await req.json();

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
        if (subdomain && !SUBDOMAIN_RE.test(subdomain)) {
            return NextResponse.json({ error: "Format du sous-domaine invalide" }, { status: 400 });
        }

        // 1. Créer le sous-domaine si demandé
        let finalDomain = targetDomain;
        if (subdomain) {
            try {
                const subRes = await cpanelApi(user, "SubDomain", "addsubdomain", {
                    domain: subdomain,
                    rootdomain: targetDomain,
                    dir: `public_html/${subdomain}`,
                });
                if (subRes.metadata?.result === 0 && !subRes.errors?.some((e: string) => e.toLowerCase().includes("exist"))) {
                    throw new Error("Erreur lors de la création du sous-domaine");
                }
                finalDomain = `${subdomain}.${targetDomain}`;
            } catch (err) {
                const msg = safeError(err);
                if (!msg.toLowerCase().includes("exist")) {
                    throw new Error(`Échec création sous-domaine: ${msg}`);
                }
                finalDomain = `${subdomain}.${targetDomain}`;
            }
        }

        const appConfig = SOFTACULOUS_APPS[app];
        if (!appConfig) {
            return NextResponse.json({ error: `Application "${app}" non supportée` }, { status: 400 });
        }

        const { host, cpsess, cookie } = await getCPanelSessionData(user);
        const baseUrl = `https://${host}:2083/${cpsess}`;

        const adminUser = "admin";
        const adminPass = generateSecurePassword();
        const adminEmailFinal = adminEmail || "admin@" + finalDomain;

        // 2. Charger le formulaire d'installation pour récupérer soft_status_key et les champs cachés
        const formUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appConfig.id}`;
        const formRes = await fetch(formUrl, { headers: { Cookie: cookie } });
        if (!formRes.ok) {
            throw new Error(`Impossible de charger le formulaire Softaculous (HTTP ${formRes.status})`);
        }
        const formHtml = await formRes.text();

        // Extraire soft_status_key depuis le formulaire
        const statusKeyMatch = formHtml.match(/name=["']soft_status_key["'][^>]*value=["']([^"']+)["']/i)
            ?? formHtml.match(/value=["']([^"']+)["'][^>]*name=["']soft_status_key["']/i);
        const softStatusKey = statusKeyMatch?.[1] ?? "";

        // 3. Soumettre l'installation avec api=json pour une réponse structurée
        const installParams = new URLSearchParams({
            softsubmit: "1",
            auto_upgrade: "1",
            protocol: "https://",
            domain: finalDomain,
            in_dir: "",
            datadir: "",
            dbname: app === "wordpress" ? "wpdb" : "psdb",
            dbuser: app === "wordpress" ? "wpu" : "psu",
            admin_username: adminUser,
            admin_pass: adminPass,
            admin_email: adminEmailFinal,
            language: "fr",
            site_name: app === "wordpress" ? "Mon Site WordPress" : "Ma Boutique PrestaShop",
            site_desc: "Installé par WHM Manager",
            ...(softStatusKey ? { soft_status_key: softStatusKey } : {}),
        });

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

        // Vérifier les erreurs Softaculous dans la réponse JSON
        const softaculousError = extractSoftaculousError(installData);
        if (softaculousError) {
            throw new Error(softaculousError);
        }

        if (!installRes.ok) {
            throw new Error(`Installation échouée (HTTP ${installRes.status})`);
        }

        // Déterminer si l'installation est terminée ou asynchrone
        const taskId =
            typeof installData?.taskid === "string" ? installData.taskid :
            typeof installData?.task_id === "string" ? installData.task_id : null;

        const returnedInsid =
            typeof installData?.insid === "string" && (installData.insid as string).trim().length > 0
                ? installData.insid
                : null;

        const doneMessage =
            typeof installData?.done_msg === "string" ? installData.done_msg :
            typeof installData?.msg === "string" ? installData.msg : null;

        const isCompleted =
            installData?.done === true ||
            Boolean(returnedInsid) ||
            /Installation Complete|successfully installed|installé avec succès|was installed/i.test(rawText);

        const siteUrl = `https://${finalDomain}`;
        const adminUrl = app === "wordpress" ? `${siteUrl}/wp-admin` : `${siteUrl}/admin`;

        if (isCompleted) {
            return NextResponse.json({
                success: true,
                pending: false,
                app: appConfig.name,
                siteUrl,
                adminUrl,
                adminUser,
                adminPass,
                adminEmail: adminEmailFinal,
                message: doneMessage ?? `${appConfig.name} installé sur ${finalDomain}`,
            });
        }

        // Si Softaculous répond sans erreur mais en async (taskId ou message)
        if (taskId || doneMessage) {
            // Attendre quelques secondes et vérifier dans la liste des installations
            for (let attempt = 0; attempt < 3; attempt++) {
                await sleep(3000);
                const listRes = await fetch(
                    `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
                    { headers: { Cookie: cookie } }
                );
                if (listRes.ok) {
                    const listText = await listRes.text();
                    if (listText.includes(finalDomain)) {
                        return NextResponse.json({
                            success: true,
                            pending: false,
                            app: appConfig.name,
                            siteUrl,
                            adminUrl,
                            adminUser,
                            adminPass,
                            adminEmail: adminEmailFinal,
                            message: `${appConfig.name} installé sur ${finalDomain}`,
                        });
                    }
                }
            }

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
                message: doneMessage ?? `Installation lancée sur ${finalDomain}. Vérifiez dans 1 à 2 minutes.`,
            });
        }

        throw new Error("Softaculous n'a pas confirmé l'installation. Vérifiez les logs cPanel.");

    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de l'installation") }, { status: 500 });
    }
}

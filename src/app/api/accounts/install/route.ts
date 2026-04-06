import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData, cpanelApi } from "@/lib/whm";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

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

        // 1. Create subdomain if requested
        let finalDomain = targetDomain;
        if (subdomain) {
            try {
                const subRes = await cpanelApi(user, "SubDomain", "addsubdomain", {
                    domain: subdomain,
                    rootdomain: targetDomain,
                    dir: `public_html/${subdomain}`,
                });
                // Note: result 0 often means "already exists" in some contexts, but let's check metadata
                // If it fails but results show it exists, we continue.
                if (subRes.metadata?.result === 0 && !subRes.errors?.some((e: string) => e.toLowerCase().includes("exist"))) {
                    throw new Error("Erreur lors de la création du sous-domaine");
                }
                finalDomain = `${subdomain}.${targetDomain}`;
            } catch (err) {
                // If the error says it already exists, we silent it. 
                // Otherwise report.
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
        });

        const softaUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appConfig.id}`;
        const installRes = await fetch(softaUrl, {
            method: "POST",
            headers: {
                Cookie: cookie,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: installParams.toString(),
        });

        const html = await installRes.text();
        const isSuccess =
            html.includes("Installation Complete") ||
            html.includes("installé avec succès") ||
            html.includes("was installed") ||
            html.includes("successfully installed");

        if (!isSuccess && installRes.status !== 200) {
            throw new Error("Installation échouée");
        }

        const siteUrl = `https://${finalDomain}`;

        return NextResponse.json({
            success: true,
            app: appConfig.name,
            siteUrl,
            adminUrl: app === "wordpress" ? `${siteUrl}/wp-admin` : `${siteUrl}/admin123`,
            adminUser,
            adminPass,
            adminEmail: adminEmailFinal,
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de l'installation") }, { status: 500 });
    }
}

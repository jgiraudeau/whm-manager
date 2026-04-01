import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";

const SOFTACULOUS_APPS: Record<string, { id: number; name: string }> = {
    wordpress: { id: 26, name: "WordPress" },
    prestashop: { id: 29, name: "PrestaShop" },
};

const USERNAME_RE = /^[a-z][a-z0-9]{2,7}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

function generateSecurePassword(): string {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&";
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => charset[b % charset.length]).join("");
}

export async function POST(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { user, app, adminEmail, targetDomain } = await req.json();

        if (!user || !app || !targetDomain) {
            return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
        }
        if (!USERNAME_RE.test(user)) {
            return NextResponse.json({ error: "Username invalide" }, { status: 400 });
        }
        if (!DOMAIN_RE.test(targetDomain)) {
            return NextResponse.json({ error: "Domaine cible invalide" }, { status: 400 });
        }

        const appConfig = SOFTACULOUS_APPS[app];
        if (!appConfig) {
            return NextResponse.json({ error: `Application "${app}" non supportée` }, { status: 400 });
        }

        const { host, cpsess, cookie } = await getCPanelSessionData(user);
        const baseUrl = `https://${host}:2083/${cpsess}`;

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

        const siteUrl = `https://${targetDomain}`;

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

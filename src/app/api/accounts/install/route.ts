import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";
import { extractSoftaculousError, extractSoftaculousInstallations, normalizeHost } from "@/lib/softaculous";

const APP_KEYWORDS: Record<string, string[]> = {
    wordpress: ["wordpress"],
    prestashop: ["prestashop"],
};

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

function generateSecurePassword(): string {
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const digits = "0123456789";
    const special = "!@#$%&";
    const all = lower + upper + digits + special;
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    // Garantit au moins un de chaque type
    const pwd = [
        lower[bytes[0] % lower.length],
        upper[bytes[1] % upper.length],
        digits[bytes[2] % digits.length],
        special[bytes[3] % special.length],
        ...Array.from(bytes.slice(4), (b) => all[b % all.length]),
    ];
    // Mélanger
    for (let i = pwd.length - 1; i > 0; i--) {
        const j = bytes[i % bytes.length] % (i + 1);
        [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
    }
    return pwd.join("");
}

function parseMaybeJson(input: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(input) as unknown;
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch { /* ignore */ }
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
    const data = parseMaybeJson(await res.text());
    const installations = extractSoftaculousInstallations(data);
    for (const [id, install] of Object.entries(installations)) {
        if (normalizeHost(install.softurl ?? install.domain ?? "") === targetHost) return id;
    }
    return null;
}

async function findInstallation(baseUrl: string, cookie: string, domain: string): Promise<boolean> {
    return (await findInstallationId(baseUrl, cookie, domain)) !== null;
}

// Cherche l'ID de l'app en lisant le SID depuis les installations existantes
// L'insid Softaculous a le format "SID_INSTALLID" — le SID est l'ID du script
async function findAppId(baseUrl: string, cookie: string, app: string): Promise<number | null> {
    const keywords = APP_KEYWORDS[app] ?? [app];
    const res = await fetch(
        `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
        { headers: { Cookie: cookie } }
    );
    if (!res.ok) return null;
    const data = parseMaybeJson(await res.text());
    const installations = extractSoftaculousInstallations(data);

    // Chercher une installation existante dont le nom contient le keyword de l'app
    for (const [insid, install] of Object.entries(installations)) {
        const name = (install.softname ?? install.script_name ?? "").toLowerCase();
        if (keywords.some(kw => name.includes(kw))) {
            // insid = "SID_INSTALLID" ou juste "SID"
            const sid = parseInt(insid.split("_")[0], 10);
            if (!isNaN(sid)) {
                console.log(`[install] trouvé SID=${sid} via installation existante "${name}" (insid=${insid})`);
                return sid;
            }
        }
    }

    // Fallback : chercher dans la liste des scripts HTML
    const scriptsRes = await fetch(
        `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=scripts&api=json`,
        { headers: { Cookie: cookie } }
    );
    if (!scriptsRes.ok) return null;
    const scriptsData = parseMaybeJson(await scriptsRes.text());
    if (!scriptsData) return null;
    const scripts = (scriptsData.scripts ?? (scriptsData.data as Record<string, unknown>)?.scripts) as Record<string, unknown> | undefined;
    if (!scripts) return null;
    for (const [idStr, script] of Object.entries(scripts)) {
        const s = script as Record<string, unknown>;
        const name = (typeof s.name === "string" ? s.name : typeof s.softname === "string" ? s.softname : "").toLowerCase();
        if (keywords.some(kw => name.includes(kw))) {
            const id = parseInt(idStr, 10);
            if (!isNaN(id)) return id;
        }
    }
    return null;
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
        if (!APP_KEYWORDS[app]) {
            return NextResponse.json({ error: `Application "${app}" non supportée` }, { status: 400 });
        }

        const appName = app === "wordpress" ? "WordPress" : "PrestaShop";
        const { host, cpsess, cookie } = await getCPanelSessionData(user);
        const baseUrl = `https://${host}:2083/${cpsess}`;

        // Chercher l'ID de l'app dynamiquement
        let appId = await findAppId(baseUrl, cookie, app);
        console.log(`[install] appId dynamique pour ${app}=${appId}`);
        // Fallback IDs connus
        if (!appId) appId = app === "wordpress" ? 26 : 29;

        // Supprimer l'installation existante si elle existe
        const existingInsid = await findInstallationId(baseUrl, cookie, targetDomain);
        console.log(`[install] existingInsid=${existingInsid}`);
        if (existingInsid) {
            const removeFormRes = await fetch(
                `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=remove&insid=${encodeURIComponent(existingInsid)}`,
                { headers: { Cookie: cookie } }
            );
            const removeFormHtml = removeFormRes.ok ? await removeFormRes.text() : "";
            const hiddenFields: Record<string, string> = {};
            const hiddenRegex = /<input[^>]+type=["']hidden["'][^>]*>/gi;
            let hMatch: RegExpExecArray | null;
            while ((hMatch = hiddenRegex.exec(removeFormHtml)) !== null) {
                const nameM = hMatch[0].match(/name=["']([^"']+)["']/i);
                const valM = hMatch[0].match(/value=["']([^"']*)["']/i);
                if (nameM?.[1]) hiddenFields[nameM[1]] = valM?.[1] ?? "";
            }
            const removeParams = new URLSearchParams({ ...hiddenFields, softsubmit: "1", removedb: "1", removedir: "1" });
            const removeRes = await fetch(
                `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=remove&insid=${encodeURIComponent(existingInsid)}&api=json`,
                { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: removeParams.toString() }
            );
            const removeText = await removeRes.text();
            console.log(`[install] removeStatus=${removeRes.status} removeText=`, removeText.slice(0, 300));
            await sleep(5000);
        }

        const adminUser = "admin";
        const adminPass = generateSecurePassword();
        const adminEmailFinal = adminEmail || "admin@" + targetDomain;

        // Fetcher le formulaire pour extraire softdomain et soft_status_key
        const formUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appId}`;
        const formRes = await fetch(formUrl, { headers: { Cookie: cookie } });
        const formHtml = formRes.ok ? await formRes.text() : "";
        console.log(`[install] formUrl=${formUrl} formStatus=${formRes.status} formLength=${formHtml.length}`);

        const softdomainOptions = extractSelectOptions(formHtml, "softdomain");
        const targetHost = normalizeHost(targetDomain);
        const matchedOption = softdomainOptions.find((opt) => normalizeHost(opt) === targetHost)
            ?? softdomainOptions.find((opt) => opt.includes(targetHost));

        console.log(`[install] softdomainOptions=`, softdomainOptions.slice(0, 5), `matched=${matchedOption}`);

        if (softdomainOptions.length > 0 && !matchedOption) {
            return NextResponse.json({
                error: `Le domaine "${targetDomain}" n'est pas disponible dans Softaculous. Créez d'abord le sous-domaine dans cPanel.`,
            }, { status: 400 });
        }

        const softdomainValue = matchedOption ?? targetDomain;
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
            overwrite_existing: "1",
            php_version_select: "1",
            cookie_key: generateSecurePassword() + generateSecurePassword(),
            ...(softStatusKey ? { soft_status_key: softStatusKey } : {}),
        });

        const installUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=software&soft=${appId}&api=json`;
        const installRes = await fetch(installUrl, {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
            body: installParams.toString(),
        });

        const rawText = await installRes.text();
        const installData = parseMaybeJson(rawText);
        console.log(`[install] app=${app} appId=${appId} domain=${targetDomain} status=${installRes.status}`);
        console.log(`[install] rawText=`, rawText.slice(0, 500));

        const softaculousError = extractSoftaculousError(installData);
        if (softaculousError) throw new Error(softaculousError);
        if (!installRes.ok) throw new Error(`Installation échouée (HTTP ${installRes.status})`);

        const siteUrl = `https://${targetDomain}`;
        const adminUrl = app === "wordpress" ? `${siteUrl}/wp-admin` : `${siteUrl}/admin`;

        if (installData?.done === true) {
            return NextResponse.json({
                success: true, pending: true, app: appName, siteUrl, adminUrl,
                adminUser, adminPass, adminEmail: adminEmailFinal,
                message: `Installation de ${appName} lancée sur ${targetDomain}. Le site sera disponible dans quelques minutes.`,
            });
        }

        for (let attempt = 0; attempt < 6; attempt++) {
            await sleep(5000);
            if (await findInstallation(baseUrl, cookie, targetDomain)) {
                return NextResponse.json({
                    success: true, pending: false, app: appName, siteUrl, adminUrl,
                    adminUser, adminPass, adminEmail: adminEmailFinal,
                    message: `${appName} installé sur ${targetDomain}`,
                });
            }
        }

        return NextResponse.json({
            success: true, pending: true, app: appName, siteUrl, adminUrl,
            adminUser, adminPass, adminEmail: adminEmailFinal,
            message: `Installation lancée sur ${targetDomain}. Vérifiez dans quelques minutes.`,
        });

    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de l'installation") }, { status: 500 });
    }
}

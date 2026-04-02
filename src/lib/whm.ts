// WHM API Client Library
// Wraps the WHM JSON API for o2switch server management

interface WhmConfig {
    host: string;
    user: string;
    token: string;
}

function getWhmConfig(): WhmConfig {
    const host = process.env.WHM_HOST;
    const user = process.env.WHM_USER;
    const token = process.env.WHM_TOKEN;

    if (!host || !user || !token) {
        throw new Error("Configuration WHM manquante (WHM_HOST, WHM_USER, WHM_TOKEN)");
    }

    return { host, user, token };
}

/**
 * Temporarily disable TLS verification for WHM/cPanel self-signed certs.
 * Restores the original value after the fetch completes.
 */
async function fetchInsecure(url: string, init?: RequestInit): Promise<Response> {
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
        return await fetch(url, init);
    } finally {
        if (prev === undefined) {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
    }
}

export function getCPanelURL(): string {
    const { host } = getWhmConfig();
    return host.replace(":2087", ":2083");
}

async function whmFetch(endpoint: string, params: Record<string, string> = {}) {
    const { host, user, token } = getWhmConfig();
    const url = new URL(`${host}/json-api/${endpoint}`);
    url.searchParams.set("api.version", "1");
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const res = await fetchInsecure(url.toString(), {
        headers: {
            Authorization: `whm ${user}:${token}`,
        },
        cache: "no-store",
    });

    if (!res.ok) {
        throw new Error(`WHM API error: ${res.status} ${res.statusText}`);
    }

    return res.json();
}

export interface WHMAccount {
    user: string;
    domain: string;
    email: string;
    diskused: string;
    disklimit: string;
    plan: string;
    ip: string;
    suspendreason: string;
    startdate: string;
    unix_startdate: number;
    maxsql: string;
    maxpop: string;
}

// List all cPanel accounts
export async function listAccounts(): Promise<WHMAccount[]> {
    const data = await whmFetch("listaccts");
    return data?.data?.acct || [];
}

// Get info for a single account
export async function getAccountInfo(user: string): Promise<WHMAccount | null> {
    const accounts = await listAccounts();
    return accounts.find((a) => a.user === user) || null;
}

// Create a new cPanel account
export async function createAccount(params: {
    user: string;
    domain: string;
    password: string;
    email: string;
    plan?: string;
}) {
    const data = await whmFetch("createacct", {
        username: params.user,
        domain: params.domain,
        password: params.password,
        contactemail: params.email,
        plan: params.plan || "default",
    });
    return data;
}

// Suspend an account
export async function suspendAccount(user: string, reason = "Suspended by admin") {
    const data = await whmFetch("suspendacct", { user, reason });
    return data;
}

// Unsuspend an account
export async function unsuspendAccount(user: string) {
    const data = await whmFetch("unsuspendacct", { user });
    return data;
}

// Terminate (delete) an account
export async function deleteAccount(user: string) {
    const data = await whmFetch("removeacct", { user });
    return data;
}

// Change account password
export async function changePassword(user: string, password: string) {
    const data = await whmFetch("passwd", { user, password });
    return data;
}

// Generate a cPanel login URL (auto-login link)
export async function getCPanelLoginURL(user: string): Promise<string | null> {
    const data = await whmFetch("create_user_session", {
        user,
        service: "cpaneld",
    });
    const url = data?.data?.url;
    return url || null;
}

/**
 * Creates a cPanel session and returns full data including the real cpsession cookie
 */
export async function getCPanelSessionData(user: string) {
    const data = await whmFetch("create_user_session", {
        user,
        service: "cpaneld",
    });
    const url = data?.data?.url;
    if (!url) throw new Error("Impossible de créer une session cPanel");

    // Hit the login URL to get the real cpsession cookie from cPanel
    const loginResp = await fetchInsecure(url, { redirect: "manual" });
    const setCookieHeader = loginResp.headers.get("set-cookie");
    let cookie = "";

    if (setCookieHeader) {
        const cookies = setCookieHeader.split(", ").map(c => c.split(";")[0]);
        const cpsessionCookie = cookies.find(c => c.startsWith("cpsession="));
        if (cpsessionCookie) {
            cookie = cpsessionCookie;
        }
    }

    const match = url.match(/\/cpsess\d+\//);
    const cpsess = match ? match[0].replace(/\//g, "") : "";
    const session = data?.data?.session;
    const host = url.split("/")[2].split(":")[0];

    return { url, session, cpsess, host, cookie };
}

// Get AutoSSL status for a user
export async function getAutoSSLStatus(user: string) {
    const data = await whmFetch("get_autossl_check_status_for_user", { user });
    return data;
}

// Get AutoSSL logs for a user
export async function getAutoSSLLogs(user: string) {
    const data = await whmFetch("get_autossl_logs_for_user", { user });
    return data;
}

// Start an AutoSSL check for a specific cPanel user
export async function startAutoSSLCheck(user: string) {
    const data = await whmFetch("start_autossl_check_for_user", { user });
    return data;
}

/**
 * Relay a call to cPanel's UAPI through WHM
 * @param user The cPanel username
 * @param module cPanel module (e.g., 'SubDomain')
 * @param func cPanel function (e.g., 'addsubdomain')
 * @param params Query parameters
 */
export async function cpanelApi(user: string, module: string, func: string, params: Record<string, string> = {}) {
    return whmFetch("cpanel", {
        user,
        cpanel_jsonapi_user: user,
        cpanel_jsonapi_module: module,
        cpanel_jsonapi_func: func,
        cpanel_jsonapi_apiversion: "3", // Use UAPI (v3)
        ...params,
    });
}

/**
 * Relay a call to cPanel API2 through WHM.
 * Some legacy Fileman operations (mkdir, fileop unlink, etc.) are still only exposed via API2.
 */
export async function cpanelApi2(
    user: string,
    module: string,
    func: string,
    params: Record<string, string> = {},
) {
    return whmFetch("cpanel", {
        user,
        cpanel_jsonapi_user: user,
        cpanel_jsonapi_module: module,
        cpanel_jsonapi_func: func,
        cpanel_jsonapi_apiversion: "2",
        ...params,
    });
}

// Helper: generate username from name
export function generateUsername(firstName: string, lastName: string): string {
    const clean = (s: string) =>
        s.toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]/g, "");

    const base = `${clean(firstName).slice(0, 4)}${clean(lastName).slice(0, 4)}`;
    return base.slice(0, 8);
}

// Helper: generate cryptographically secure random password
export function generatePassword(length = 14): string {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => charset[b % charset.length]).join("");
}

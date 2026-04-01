import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

type UnknownRecord = Record<string, unknown>;

interface SoftaculousInstallation {
    softurl?: string;
    domain?: string;
    script_name?: string;
    softname?: string;
    softpath?: string;
    ver?: string;
}

function asRecord(value: unknown): UnknownRecord | null {
    if (typeof value === "object" && value !== null) {
        return value as UnknownRecord;
    }
    return null;
}

function extractInstallationsData(payload: unknown): Record<string, SoftaculousInstallation> {
    const root = asRecord(payload);
    if (!root) return {};

    const dataNode = asRecord(root.data);
    const installationsCandidate = dataNode?.installations ?? root.installations;
    const groupedInstallations = asRecord(installationsCandidate);
    if (!groupedInstallations) return {};

    const flattened: Record<string, SoftaculousInstallation> = {};

    for (const scriptInstalls of Object.values(groupedInstallations)) {
        const installsForScript = asRecord(scriptInstalls);
        if (!installsForScript) continue;

        for (const [id, install] of Object.entries(installsForScript)) {
            const installation = asRecord(install) as SoftaculousInstallation | null;
            if (!installation) continue;
            flattened[id] = installation;
        }
    }

    return flattened;
}

function secureDbSuffix(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { user, sourceUrl, targetSubdomain, domain } = await req.json();

        if (!user || !sourceUrl || !targetSubdomain || !domain) {
            return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
        }
        if (!isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Username invalide" }, { status: 400 });
        }
        if (!SUBDOMAIN_RE.test(targetSubdomain)) {
            return NextResponse.json({ error: "Sous-domaine cible invalide" }, { status: 400 });
        }
        if (!DOMAIN_RE.test(domain)) {
            return NextResponse.json({ error: "Domaine invalide" }, { status: 400 });
        }

        const { host, cpsess, cookie } = await getCPanelSessionData(user);
        const baseUrl = `https://${host}:2083/${cpsess}`;

        const listRes = await fetch(
            `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
            { headers: { Cookie: cookie } }
        );

        const listText = await listRes.text();
        let installId: string | null = null;

        try {
            const parsed = JSON.parse(listText) as unknown;
            const installations = extractInstallationsData(parsed);
            const sourceHost = sourceUrl.replace(/https?:\/\//, "").split("/")[0];

            for (const [id, install] of Object.entries(installations)) {
                const url = install.softurl ?? install.domain ?? "";
                if (url.includes(sourceHost)) {
                    installId = id;
                    break;
                }
            }
        } catch {
            // JSON parse failed
        }

        const targetUrl = `${targetSubdomain}.${domain}`;

        const cloneParams = new URLSearchParams({
            softsubmit: "1",
            act: "sclone",
            insid: installId || "",
            softdomain: targetUrl,
            softdirectory: "",
            softdb: `cln${secureDbSuffix()}`,
            api: "json",
        });

        const cloneRes = await fetch(`${baseUrl}/frontend/jupiter/softaculous/index.php`, {
            method: "POST",
            headers: {
                Cookie: cookie,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: cloneParams.toString(),
        });

        const cloneText = await cloneRes.text();
        let cloneData: UnknownRecord | null = null;
        try {
            const parsed = JSON.parse(cloneText);
            cloneData = asRecord(parsed);
        } catch {
            cloneData = null;
        }

        if (!cloneData) {
            const isSuccess =
                cloneText.includes("Clone Complete") ||
                cloneText.includes("cloné") ||
                cloneText.includes("successfully cloned");

            if (!isSuccess && cloneText.includes("error")) {
                throw new Error("Erreur lors du clonage");
            }
        }

        return NextResponse.json({
            success: true,
            message: `Site en cours de clonage vers ${targetUrl}`,
            targetUrl: `https://${targetUrl}`,
            taskId: typeof cloneData?.taskid === "string" ? cloneData.taskid : null,
            note: !installId ? "Installation source non trouvée. Clonage manuel possible dans cPanel." : undefined,
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors du clonage") }, { status: 500 });
    }
}

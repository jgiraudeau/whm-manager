import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";
import {
    extractSoftaculousError,
    extractSoftaculousInstallations,
    normalizeHost,
} from "@/lib/softaculous";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

function secureDbSuffix(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

function hasSuccessMarkers(text: string, data: Record<string, unknown> | null): boolean {
    const doneMessage =
        typeof data?.done_msg === "string"
            ? data.done_msg
            : typeof data?.msg === "string"
                ? data.msg
                : null;
    const hasTaskId =
        typeof data?.taskid === "string" ||
        typeof data?.task_id === "string";
    const hasDoneFlag = data?.done === true;

    return (
        text.includes("Clone Complete") ||
        text.includes("cloné") ||
        text.includes("successfully cloned") ||
        Boolean(doneMessage) ||
        hasTaskId ||
        hasDoneFlag
    );
}

async function targetInstallationExists(baseUrl: string, cookie: string, targetUrl: string): Promise<boolean> {
    const targetHost = normalizeHost(targetUrl);
    if (!targetHost) return false;

    const res = await fetch(
        `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
        { headers: { Cookie: cookie } }
    );
    if (!res.ok) return false;

    const text = await res.text();
    const parsed = parseMaybeJson(text);
    const installations = extractSoftaculousInstallations(parsed);

    return Object.values(installations).some((install) => {
        const host = normalizeHost(install.softurl ?? install.domain ?? "");
        return host === targetHost;
    });
}

export async function POST(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { user, sourceUrl, sourceRef, sourceInstallationId, targetSubdomain, domain } = await req.json();
        const sourceInput = sourceInstallationId ?? sourceRef ?? sourceUrl;

        if (!user || !sourceInput || !targetSubdomain || !domain) {
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
        let detectedInstallations: string[] = [];

        const sourceAsText = String(sourceInput).trim();
        const looksLikeInsid = /^\d+(_\d+)?$/.test(sourceAsText);
        if (looksLikeInsid) {
            installId = sourceAsText;
        }

        if (!installId) {
            try {
                const parsed = JSON.parse(listText) as unknown;
                const installations = extractSoftaculousInstallations(parsed);
                const sourceHost = normalizeHost(sourceAsText);
                detectedInstallations = Object.values(installations)
                    .map((install) => install.softurl ?? install.domain ?? "")
                    .filter((value) => value.length > 0);

                for (const [id, install] of Object.entries(installations)) {
                    const installUrl = install.softurl ?? install.domain ?? "";
                    const installHost = normalizeHost(installUrl);
                    if (!installHost) continue;

                    if (
                        installHost === sourceHost ||
                        installHost.endsWith(`.${sourceHost}`) ||
                        sourceHost.endsWith(`.${installHost}`)
                    ) {
                        installId = id;
                        break;
                    }
                }
            } catch {
                // JSON parse failed
            }
        }

        if (!installId) {
            return NextResponse.json(
                {
                    error: "Installation source introuvable dans Softaculous pour ce compte.",
                    detectedInstallations,
                },
                { status: 404 },
            );
        }

        const targetUrl = `${targetSubdomain}.${domain}`;

        const cloneParams = new URLSearchParams({
            softsubmit: "1",
            insid: installId || "",
            softdomain: targetUrl,
            softdirectory: "",
            softdb: `cln${secureDbSuffix()}`,
        });

        const cloneEndpoints = [
            `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&api=json`,
            `${baseUrl}/frontend/jupiter/softaculous/index.php?act=sclone&api=json`,
        ];

        let lastSoftError: string | null = null;
        let lastHttpStatus: number | null = null;

        for (const endpoint of cloneEndpoints) {
            const cloneRes = await fetch(endpoint, {
                method: "POST",
                headers: {
                    Cookie: cookie,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: cloneParams.toString(),
            });

            const cloneText = await cloneRes.text();
            const cloneData = parseMaybeJson(cloneText);
            const softaculousError = extractSoftaculousError(cloneData);
            const doneMessage =
                typeof cloneData?.done_msg === "string"
                    ? cloneData.done_msg
                    : typeof cloneData?.msg === "string"
                        ? cloneData.msg
                        : null;
            const taskId =
                typeof cloneData?.taskid === "string"
                    ? cloneData.taskid
                    : typeof cloneData?.task_id === "string"
                        ? cloneData.task_id
                        : null;

            lastHttpStatus = cloneRes.status;
            if (!cloneRes.ok) {
                if (softaculousError) lastSoftError = softaculousError;
                continue;
            }

            if (softaculousError) {
                lastSoftError = softaculousError;
                continue;
            }

            if (hasSuccessMarkers(cloneText, cloneData)) {
                const completed =
                    cloneText.includes("Clone Complete") ||
                    cloneText.includes("successfully cloned") ||
                    cloneData?.done === true;
                const pending = !completed || Boolean(taskId);

                return NextResponse.json({
                    success: true,
                    message: doneMessage ?? (pending ? `Clonage lancé vers ${targetUrl}` : `Site cloné vers ${targetUrl}`),
                    targetUrl: `https://${targetUrl}`,
                    taskId,
                    pending,
                });
            }
        }

        // Softaculous may queue clone tasks without explicit confirmation in response body.
        // Confirm by checking if target installation appears.
        const existsNow = await targetInstallationExists(baseUrl, cookie, targetUrl);
        if (existsNow) {
            return NextResponse.json({
                success: true,
                message: `Installation cible détectée pour ${targetUrl}. Le clonage peut encore être en cours.`,
                targetUrl: `https://${targetUrl}`,
                taskId: null,
                pending: true,
            });
        }

        if (lastSoftError) {
            throw new Error(lastSoftError);
        }

        throw new Error(
            lastHttpStatus
                ? `Softaculous clone HTTP ${lastHttpStatus} (insid/source/url à vérifier)`
                : "Softaculous n'a pas confirmé le clonage et aucune nouvelle installation cible n'a été détectée"
        );
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors du clonage") }, { status: 500 });
    }
}

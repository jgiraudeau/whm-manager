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

interface HtmlSelectOption {
    value: string;
    label: string;
    selected: boolean;
}

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractInputValue(html: string, fieldName: string): string | null {
    const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inputRegex = new RegExp(`<input\\b[^>]*\\bname=["']${escapedName}["'][^>]*>`, "i");
    const inputMatch = html.match(inputRegex);
    if (!inputMatch) return null;

    const valueMatch = inputMatch[0].match(/\bvalue=["']([^"']*)["']/i);
    return valueMatch ? valueMatch[1] : null;
}

function extractSelectOptions(html: string, selectName: string): HtmlSelectOption[] {
    const escapedName = selectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const selectRegex = new RegExp(
        `<select\\b[^>]*\\bname=["']${escapedName}["'][^>]*>([\\s\\S]*?)<\\/select>`,
        "i",
    );
    const selectMatch = html.match(selectRegex);
    if (!selectMatch) return [];

    const optionsHtml = selectMatch[1];
    const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    const options: HtmlSelectOption[] = [];
    let match: RegExpExecArray | null = null;
    while ((match = optionRegex.exec(optionsHtml)) !== null) {
        const attrs = match[1] ?? "";
        const valueMatch = attrs.match(/\bvalue=["']([^"']*)["']/i);
        options.push({
            value: valueMatch?.[1]?.trim() ?? "",
            label: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
            selected: /\bselected\b/i.test(attrs),
        });
    }
    return options;
}

function preferredProtocolLabel(sourceUrl: string): string | null {
    const raw = sourceUrl.trim();
    if (!raw) return null;

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const url = new URL(withProtocol);
        const hasWww = url.hostname.toLowerCase().startsWith("www.");
        return `${url.protocol}//${hasWww ? "www." : ""}`;
    } catch {
        return null;
    }
}

function pickSoftprotoOption(options: HtmlSelectOption[], sourceUrl: string): HtmlSelectOption | null {
    if (!options.length) return null;

    const preferredLabel = preferredProtocolLabel(sourceUrl);
    if (preferredLabel) {
        const preferred = options.find((option) => option.label.toLowerCase() === preferredLabel.toLowerCase());
        if (preferred) return preferred;
    }

    const selected = options.find((option) => option.selected && option.value);
    if (selected) return selected;

    return options.find((option) => option.value) ?? null;
}

function buildTargetUrl(protocolLabel: string | null, host: string): string {
    const prefix = protocolLabel && /^https?:\/\/(www\.)?$/i.test(protocolLabel) ? protocolLabel : "https://";
    return `${prefix}${host}`;
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
        if (!listRes.ok) {
            throw new Error(`Impossible de lire les installations Softaculous (HTTP ${listRes.status})`);
        }

        const listData = parseMaybeJson(listText);
        const installations = extractSoftaculousInstallations(listData);
        let installId: string | null = null;
        const detectedInstallations = Object.values(installations)
            .map((install) => install.softurl ?? install.domain ?? "")
            .filter((value) => value.length > 0);

        const sourceAsText = String(sourceInput).trim();
        const looksLikeInsid = /^\d+(_\d+)?$/.test(sourceAsText);
        if (looksLikeInsid && installations[sourceAsText]) {
            installId = sourceAsText;
        } else if (looksLikeInsid) {
            const fallbackId = Object.keys(installations).find((id) => id === sourceAsText || id.endsWith(`_${sourceAsText}`));
            if (fallbackId) {
                installId = fallbackId;
            } else if (!Object.keys(installations).length) {
                installId = sourceAsText;
            }
        }

        if (!installId) {
            const sourceHost = normalizeHost(sourceAsText);
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
        const sourceInstallationUrl = installations[installId]?.softurl ?? installations[installId]?.domain ?? sourceAsText;

        const formUrl =
            `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(installId)}`;
        const formRes = await fetch(formUrl, { headers: { Cookie: cookie } });
        if (!formRes.ok) {
            throw new Error(`Impossible de charger le formulaire de clonage Softaculous (HTTP ${formRes.status})`);
        }

        const formHtml = await formRes.text();
        const softStatusKey = extractInputValue(formHtml, "soft_status_key");
        if (!softStatusKey) {
            throw new Error("Softaculous n'a pas fourni de clé de statut pour le clonage");
        }

        const softdomainOptions = extractSelectOptions(formHtml, "softdomain")
            .map((option) => option.value)
            .filter((value) => value.length > 0);
        if (softdomainOptions.length && !softdomainOptions.includes(targetUrl)) {
            throw new Error(
                `Le sous-domaine cible ${targetUrl} n'est pas disponible dans Softaculous. Créez-le dans cPanel puis réessayez.`,
            );
        }

        const softprotoOptions = extractSelectOptions(formHtml, "softproto");
        const softproto = pickSoftprotoOption(softprotoOptions, sourceInstallationUrl);
        if (!softproto?.value) {
            throw new Error("Softaculous n'a pas fourni d'option de protocole valide pour le clonage");
        }

        const cloneParams = new URLSearchParams({
            softsubmit: "Cloner",
            softproto: softproto.value,
            softdomain: targetUrl,
            softdirectory: "",
            softdb: `cln${secureDbSuffix()}`,
            soft_status_key: softStatusKey,
        });

        const cloneEndpoint =
            `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(installId)}&api=json`;
        const cloneRes = await fetch(cloneEndpoint, {
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
        if (!cloneRes.ok) {
            throw new Error(softaculousError ?? `Softaculous clone HTTP ${cloneRes.status}`);
        }
        if (softaculousError) {
            throw new Error(softaculousError);
        }

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
        const returnedInstallId =
            typeof cloneData?.insid === "string" && cloneData.insid.trim().length > 0
                ? cloneData.insid
                : null;
        const completed =
            cloneData?.done === true ||
            Boolean(returnedInstallId) ||
            /Clone Complete|successfully cloned/i.test(cloneText);

        const fullTargetUrl = buildTargetUrl(softproto.label, targetUrl);
        if (completed) {
            return NextResponse.json({
                success: true,
                message: doneMessage ?? `Site cloné vers ${targetUrl}`,
                targetUrl: fullTargetUrl,
                taskId,
                pending: false,
            });
        }

        // Softaculous can answer before the installation list is updated.
        // Retry a few times to avoid false negatives.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const exists = await targetInstallationExists(baseUrl, cookie, targetUrl);
            if (exists) {
                return NextResponse.json({
                    success: true,
                    message: doneMessage ?? `Clonage lancé vers ${targetUrl}. Vérifiez dans 1 à 2 minutes.`,
                    targetUrl: fullTargetUrl,
                    taskId,
                    pending: true,
                });
            }
            if (attempt < 2) {
                await sleep(2000);
            }
        }

        if (taskId || doneMessage) {
            return NextResponse.json({
                success: true,
                message: doneMessage ?? `Commande de clonage envoyée vers ${targetUrl}, confirmation en attente.`,
                targetUrl: fullTargetUrl,
                taskId,
                pending: true,
            });
        }

        throw new Error("Softaculous n'a pas confirmé le clonage et aucune installation cible n'a été détectée");
    } catch (error: unknown) {
        return NextResponse.json(
            { success: false, error: safeError(error, "Erreur lors du clonage") },
            { status: 400 },
        );
    }
}

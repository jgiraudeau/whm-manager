import { getCPanelSessionData } from "@/lib/whm";
import {
  extractSoftaculousError,
  extractSoftaculousInstallations,
  normalizeHost,
  type SoftaculousInstallation,
} from "@/lib/softaculous";
import { isValidCpanelUsername } from "@/lib/validators";

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

function formatFetchError(url: string, error: unknown): string {
  if (!(error instanceof Error)) {
    return `fetch failed (${url})`;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  let details = error.message || "fetch failed";
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "";
    const hostname = typeof record.hostname === "string" ? record.hostname : "";
    if (code && hostname) {
      details = `${details} [${code} ${hostname}]`;
    } else if (code) {
      details = `${details} [${code}]`;
    }
  }
  return details;
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  const attempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error: unknown) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(250 * attempt);
        continue;
      }
    }
  }

  throw new Error(formatFetchError(url, lastError), {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

export type SoftAppType = "wordpress" | "prestashop" | "other";

export interface SoftaculousInstallationSummary {
  id: string;
  name: string;
  app: SoftAppType;
  url: string;
  host: string;
  path: string;
  ver: string;
  raw: SoftaculousInstallation;
}

export function detectSoftAppType(value: string): SoftAppType {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("wordpress")) return "wordpress";
  if (normalized.includes("prestashop")) return "prestashop";
  return "other";
}

function mapInstallation(
  id: string,
  installation: SoftaculousInstallation,
): SoftaculousInstallationSummary {
  const name = installation.script_name ?? installation.softname ?? "Application";
  const url = installation.softurl ?? installation.domain ?? "";

  return {
    id,
    name,
    app: detectSoftAppType(name),
    url,
    host: normalizeHost(url),
    path: installation.softpath ?? "",
    ver: installation.ver ?? "",
    raw: installation,
  };
}

export async function listSoftaculousInstallationsForUser(
  user: string,
): Promise<SoftaculousInstallationSummary[]> {
  if (!isValidCpanelUsername(user)) {
    throw new Error("Utilisateur cPanel invalide");
  }

  const { host, cpsess, cookie } = await getCPanelSessionData(user);
  const baseUrl = `https://${host}:2083/${cpsess}`;
  const res = await fetchWithRetry(
    `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
    { headers: { Cookie: cookie } },
  );

  if (!res.ok) {
    throw new Error(`Erreur Softaculous (HTTP ${res.status})`);
  }

  const text = await res.text();
  const parsed = parseMaybeJson(text);
  if (!parsed) {
    throw new Error("Réponse Softaculous invalide");
  }

  const installations = extractSoftaculousInstallations(parsed);
  return Object.entries(installations).map(([id, installation]) => mapInstallation(id, installation));
}

export function resolveInstallationByRef(
  installations: SoftaculousInstallationSummary[],
  sourceRef: string,
): SoftaculousInstallationSummary | null {
  const ref = sourceRef.trim();
  if (!ref) return null;

  const byId = installations.find((installation) => installation.id === ref);
  if (byId) return byId;

  const refHost = normalizeHost(ref);
  if (!refHost) return null;

  return (
    installations.find((installation) => installation.host === refHost) ??
    installations.find((installation) => installation.host.endsWith(`.${refHost}`) || refHost.endsWith(`.${installation.host}`)) ??
    null
  );
}

export interface SoftaculousBackupTriggerResult {
  success: boolean;
  message: string;
  softError: string | null;
  payload: Record<string, unknown> | null;
}

export async function triggerSoftaculousBackup(
  user: string,
  installationId: string,
): Promise<SoftaculousBackupTriggerResult> {
  if (!isValidCpanelUsername(user)) {
    throw new Error("Utilisateur cPanel invalide");
  }
  if (!installationId.trim()) {
    throw new Error("ID d'installation manquant");
  }

  const { host, cpsess, cookie } = await getCPanelSessionData(user);
  const baseUrl = `https://${host}:2083/${cpsess}`;

  const res = await fetchWithRetry(
    `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=backup&insid=${encodeURIComponent(
      installationId,
    )}&api=json`,
    { headers: { Cookie: cookie } },
  );
  const text = await res.text();
  const parsed = parseMaybeJson(text);
  const softError = extractSoftaculousError(parsed);
  const doneMessage =
    typeof parsed?.done_msg === "string"
      ? parsed.done_msg
      : typeof parsed?.msg === "string"
        ? parsed.msg
        : "";

  if (!res.ok) {
    return {
      success: false,
      message: `Softaculous backup HTTP ${res.status}`,
      softError,
      payload: parsed,
    };
  }

  if (softError) {
    return {
      success: false,
      message: softError,
      softError,
      payload: parsed,
    };
  }

  return {
    success: true,
    message: doneMessage || "Sauvegarde Softaculous déclenchée",
    softError: null,
    payload: parsed,
  };
}

import { getCPanelSessionData } from "@/lib/whm";
import {
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
  const res = await fetch(
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

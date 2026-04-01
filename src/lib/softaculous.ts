type UnknownRecord = Record<string, unknown>;

export interface SoftaculousInstallation {
  script_name?: string;
  softname?: string;
  softurl?: string;
  domain?: string;
  softpath?: string;
  ver?: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (typeof value === "object" && value !== null) {
    return value as UnknownRecord;
  }
  return null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function looksLikeInstallation(value: unknown): value is SoftaculousInstallation {
  const record = asRecord(value);
  if (!record) return false;

  return (
    isString(record.softurl) ||
    isString(record.domain) ||
    isString(record.softpath) ||
    isString(record.softname) ||
    isString(record.script_name)
  );
}

function sanitizeInstallation(value: unknown): SoftaculousInstallation | null {
  const record = asRecord(value);
  if (!record) return null;

  return {
    script_name: isString(record.script_name) ? record.script_name : undefined,
    softname: isString(record.softname) ? record.softname : undefined,
    softurl: isString(record.softurl) ? record.softurl : undefined,
    domain: isString(record.domain) ? record.domain : undefined,
    softpath: isString(record.softpath) ? record.softpath : undefined,
    ver: isString(record.ver) ? record.ver : undefined,
  };
}

// Supports Softaculous payloads that can be either:
// - grouped by script id: { installations: { "26": { "123": {...} } } }
// - flat by installation id: { installations: { "123": {...} } }
export function extractSoftaculousInstallations(payload: unknown): Record<string, SoftaculousInstallation> {
  const root = asRecord(payload);
  if (!root) return {};

  const dataNode = asRecord(root.data);
  const candidate = dataNode?.installations ?? root.installations;
  const container = asRecord(candidate);
  if (!container) return {};

  const out: Record<string, SoftaculousInstallation> = {};

  for (const [key, value] of Object.entries(container)) {
    if (looksLikeInstallation(value)) {
      const installation = sanitizeInstallation(value);
      if (installation) out[key] = installation;
      continue;
    }

    const nested = asRecord(value);
    if (!nested) continue;

    for (const [nestedId, nestedValue] of Object.entries(nested)) {
      if (!looksLikeInstallation(nestedValue)) continue;
      const installation = sanitizeInstallation(nestedValue);
      if (installation) out[nestedId] = installation;
    }
  }

  return out;
}

export function normalizeHost(input: string): string {
  const raw = input.trim();
  if (!raw) return "";

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase()
      .replace(/^www\./, "");
  }
}

export function extractSoftaculousError(data: unknown): string | null {
  const root = asRecord(data);
  if (!root) return null;

  const errorValue = root.error ?? root.errors ?? asRecord(root.data)?.error;
  if (isString(errorValue) && errorValue.trim()) return errorValue;

  if (Array.isArray(errorValue)) {
    const first = errorValue.find((item) => isString(item) && item.trim());
    if (isString(first)) return first;
  }

  return null;
}

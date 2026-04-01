import { cpanelApi } from "@/lib/whm";

type UnknownRecord = Record<string, unknown>;

interface DomainEntry {
  domain?: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (typeof value === "object" && value !== null) {
    return value as UnknownRecord;
  }
  return null;
}

function parseDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const domains: string[] = [];
  for (const item of value) {
    const entry = asRecord(item) as DomainEntry | null;
    if (entry && typeof entry.domain === "string") {
      domains.push(entry.domain.toLowerCase());
    }
  }
  return domains;
}

export interface CpanelDomainInfo {
  mainDomain: string;
  subDomains: string[];
  addonDomains: string[];
  parkedDomains: string[];
  domains: string[];
}

export function parseCpanelDomainInfo(data: unknown): CpanelDomainInfo {
  const dataRecord = asRecord(data);
  const metadata = asRecord(dataRecord?.metadata);
  const errors = dataRecord?.errors;

  if (metadata?.result === 0 || (Array.isArray(errors) && errors.length > 0)) {
    throw new Error("Erreur lors de la récupération des domaines");
  }

  const resultNode = asRecord(dataRecord?.result);
  const domainData = asRecord(dataRecord?.data ?? resultNode?.data);
  const mainDomainNode = asRecord(domainData?.main_domain) as DomainEntry | null;
  const mainDomain = typeof mainDomainNode?.domain === "string" ? mainDomainNode.domain.toLowerCase() : "";
  const subDomains = parseDomainList(domainData?.sub_domains);
  const addonDomains = parseDomainList(domainData?.addon_domains);
  const parkedDomains = parseDomainList(domainData?.parked_domains);

  const domains = [mainDomain, ...subDomains, ...addonDomains, ...parkedDomains]
    .filter((value) => Boolean(value))
    .filter((value, index, array) => array.indexOf(value) === index);

  return {
    mainDomain,
    subDomains,
    addonDomains,
    parkedDomains,
    domains,
  };
}

export async function getCpanelDomainInfo(user: string): Promise<CpanelDomainInfo> {
  const data = await cpanelApi(user, "DomainInfo", "domains_data");
  return parseCpanelDomainInfo(data);
}

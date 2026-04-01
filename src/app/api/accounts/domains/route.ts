import { NextRequest, NextResponse } from "next/server";
import { cpanelApi } from "@/lib/whm";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

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
            domains.push(entry.domain);
        }
    }
    return domains;
}

export async function GET(req: NextRequest) {
    const { denied, session } = await requireAuthSession(req);
    if (denied) return denied;

    try {
        const { searchParams } = new URL(req.url);
        const user = searchParams.get("user");

        if (!user || !isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Utilisateur manquant ou invalide" }, { status: 400 });
        }
        const forbidden = ensureAccountAccess(session, user);
        if (forbidden) return forbidden;

        const data = await cpanelApi(user, "DomainInfo", "domains_data");
        const dataRecord = asRecord(data);
        const metadata = asRecord(dataRecord?.metadata);
        const errors = dataRecord?.errors;

        if (metadata?.result === 0 || (Array.isArray(errors) && errors.length > 0)) {
            throw new Error("Erreur lors de la récupération des domaines");
        }

        const resultNode = asRecord(dataRecord?.result);
        const domainData = asRecord(dataRecord?.data ?? resultNode?.data);
        const mainDomainNode = asRecord(domainData?.main_domain) as DomainEntry | null;
        const mainDomain = typeof mainDomainNode?.domain === "string" ? mainDomainNode.domain : undefined;
        const subDomains = parseDomainList(domainData?.sub_domains);
        const addonDomains = parseDomainList(domainData?.addon_domains);
        const parkedDomains = parseDomainList(domainData?.parked_domains);

        const allDomains = [mainDomain, ...subDomains, ...addonDomains, ...parkedDomains].filter(Boolean);

        return NextResponse.json({
            domains: allDomains,
            mainDomain: mainDomain ?? "",
            subDomains,
            addonDomains,
            parkedDomains,
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de la récupération des domaines") }, { status: 500 });
    }
}

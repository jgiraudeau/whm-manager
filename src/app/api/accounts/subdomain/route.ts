import { NextRequest, NextResponse } from "next/server";
import { cpanelApi } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const RESERVED_SUBDOMAINS = ["www", "mail", "ftp", "admin", "cpanel", "webmail", "whm"];

export async function POST(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { user, subdomain, domain } = await req.json();

        if (!user || !subdomain || !domain) {
            return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
        }
        if (!isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Username invalide" }, { status: 400 });
        }
        if (!SUBDOMAIN_RE.test(subdomain)) {
            return NextResponse.json({ error: "Format de sous-domaine invalide" }, { status: 400 });
        }
        if (RESERVED_SUBDOMAINS.includes(subdomain.toLowerCase())) {
            return NextResponse.json({ error: "Nom de sous-domaine réservé" }, { status: 400 });
        }
        if (!DOMAIN_RE.test(domain)) {
            return NextResponse.json({ error: "Domaine invalide" }, { status: 400 });
        }

        const data = await cpanelApi(user, "SubDomain", "addsubdomain", {
            domain: subdomain,
            rootdomain: domain,
            dir: `public_html/${subdomain}`,
        });

        if (data.metadata?.result === 0 || (data.errors && data.errors.length > 0)) {
            throw new Error("Erreur lors de la création du sous-domaine");
        }

        return NextResponse.json({
            success: true,
            subdomain: `${subdomain}.${domain}`,
            url: `http://${subdomain}.${domain}`,
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de la création du sous-domaine") }, { status: 500 });
    }
}

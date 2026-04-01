import { NextRequest, NextResponse } from "next/server";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { getCpanelDomainInfo } from "@/lib/domain-info";
import { isValidCpanelUsername } from "@/lib/validators";

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

    const domainInfo = await getCpanelDomainInfo(user);
    return NextResponse.json(domainInfo);
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la récupération des domaines") },
      { status: 500 },
    );
  }
}

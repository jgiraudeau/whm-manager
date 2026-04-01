import { NextRequest, NextResponse } from "next/server";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
import { listSoftaculousInstallationsForUser } from "@/lib/softaculous-client";
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

    const installations = await listSoftaculousInstallationsForUser(user);
    return NextResponse.json({
      installations: installations.map((installation) => ({
        id: installation.id,
        name: installation.name,
        app: installation.app,
        url: installation.url,
        path: installation.path,
        ver: installation.ver,
      })),
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la récupération des installations") },
      { status: 500 },
    );
  }
}

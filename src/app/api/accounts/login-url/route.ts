import { NextRequest, NextResponse } from "next/server";
import { getCPanelLoginURL } from "@/lib/whm";
import { ensureAccountAccess, requireAuthSession, safeError } from "@/lib/auth";
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

        const url = await getCPanelLoginURL(user);
        if (!url) return NextResponse.json({ error: "Impossible de générer le lien" }, { status: 500 });

        return NextResponse.json({ url });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from "next/server";
import { getCPanelLoginURL } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";

const USERNAME_RE = /^[a-z][a-z0-9]{2,7}$/;

export async function GET(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { searchParams } = new URL(req.url);
        const user = searchParams.get("user");
        if (!user || !USERNAME_RE.test(user)) {
            return NextResponse.json({ error: "Utilisateur manquant ou invalide" }, { status: 400 });
        }

        const url = await getCPanelLoginURL(user);
        if (!url) return NextResponse.json({ error: "Impossible de générer le lien" }, { status: 500 });

        return NextResponse.json({ url });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, safeError } from "@/lib/auth";
import { startAutoSSLCheck } from "@/lib/whm";
import { isValidCpanelUsername } from "@/lib/validators";

export async function POST(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { user } = await req.json();

        if (!user || !isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Utilisateur manquant ou invalide" }, { status: 400 });
        }

        const data = await startAutoSSLCheck(user);

        if (data?.metadata?.result === 0) {
            throw new Error("Échec du déclenchement AutoSSL");
        }

        return NextResponse.json({
            success: true,
            message: "Vérification AutoSSL lancée. Cela peut prendre quelques minutes.",
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur AutoSSL") }, { status: 500 });
    }
}

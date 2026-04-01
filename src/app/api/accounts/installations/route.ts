import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";
import { extractSoftaculousInstallations } from "@/lib/softaculous";

export async function GET(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { searchParams } = new URL(req.url);
        const user = searchParams.get("user");

        if (!user || !isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Utilisateur manquant ou invalide" }, { status: 400 });
        }

        const { host, cpsess, cookie } = await getCPanelSessionData(user);
        const baseUrl = `https://${host}:2083/${cpsess}`;
        const res = await fetch(
            `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
            { headers: { Cookie: cookie } }
        );

        if (!res.ok) {
            throw new Error("Erreur Softaculous");
        }

        const data = await res.json().catch(() => {
            throw new Error("Réponse Softaculous invalide");
        });

        const list = Object.entries(extractSoftaculousInstallations(data)).map(([id, installation]) => ({
            id,
            name: installation.script_name ?? installation.softname ?? "Application",
            url: installation.softurl ?? installation.domain ?? "",
            path: installation.softpath ?? "",
            ver: installation.ver ?? "",
        }));

        return NextResponse.json({ installations: list });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de la récupération des installations") }, { status: 500 });
    }
}

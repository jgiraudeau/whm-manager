import { NextRequest, NextResponse } from "next/server";
import { getCPanelSessionData } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

type UnknownRecord = Record<string, unknown>;

interface SoftaculousInstallation {
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

function extractInstallations(payload: unknown): { id: string; name: string; url: string; path: string; ver: string }[] {
    const root = asRecord(payload);
    if (!root) return [];

    const dataNode = asRecord(root.data);
    const grouped = asRecord(root.installations ?? dataNode?.installations);
    if (!grouped) return [];

    const list: { id: string; name: string; url: string; path: string; ver: string }[] = [];

    for (const scriptInstalls of Object.values(grouped)) {
        const installsForScript = asRecord(scriptInstalls);
        if (!installsForScript) continue;

        for (const [id, install] of Object.entries(installsForScript)) {
            const installation = asRecord(install) as SoftaculousInstallation | null;
            if (!installation) continue;

            list.push({
                id,
                name: installation.script_name ?? installation.softname ?? "Application",
                url: installation.softurl ?? installation.domain ?? "",
                path: installation.softpath ?? "",
                ver: installation.ver ?? "",
            });
        }
    }

    return list;
}

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

        const list = extractInstallations(data);

        return NextResponse.json({ installations: list });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de la récupération des installations") }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from "next/server";
import { getAutoSSLStatus, getAutoSSLLogs } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

export async function GET(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { searchParams } = new URL(req.url);
        const user = searchParams.get("user");

        if (!user || !isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Utilisateur manquant ou invalide" }, { status: 400 });
        }

        const [statusData, logsData] = await Promise.all([
            getAutoSSLStatus(user),
            getAutoSSLLogs(user),
        ]);

        const isRunning = statusData?.data?.status === "in_progress";
        const result = statusData?.data?.result || "idle";

        const logs = logsData?.data?.payload || [];
        const lastLog = logs.length > 0 ? logs[logs.length - 1].contents : "Aucun log récent";

        return NextResponse.json({
            isRunning,
            result,
            lastLog,
            fullStatus: statusData?.data,
            timestamp: new Date().toISOString(),
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error, "Erreur lors de la vérification AutoSSL") }, { status: 500 });
    }
}

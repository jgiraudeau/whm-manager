import { NextRequest, NextResponse } from "next/server";
import { listAccounts } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";

export async function GET(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const accounts = await listAccounts();
        return NextResponse.json({ accounts });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

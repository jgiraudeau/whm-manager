import { NextRequest, NextResponse } from "next/server";
import { listAccounts } from "@/lib/whm";
import { filterAccountsForSession, requireAuthSession, safeError } from "@/lib/auth";

export async function GET(req: NextRequest) {
    const { denied, session } = await requireAuthSession(req);
    if (denied) return denied;

    try {
        const accounts = await listAccounts();
        const visibleAccounts = filterAccountsForSession(session, accounts);
        return NextResponse.json({ accounts: visibleAccounts });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

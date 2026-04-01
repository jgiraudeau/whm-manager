import { NextRequest, NextResponse } from "next/server";
import { suspendAccount, unsuspendAccount, deleteAccount } from "@/lib/whm";
import { requireAuth, safeError } from "@/lib/auth";

const VALID_ACTIONS = ["suspend", "unsuspend", "delete"] as const;
const USERNAME_RE = /^[a-z][a-z0-9]{2,7}$/;

export async function POST(req: NextRequest) {
    const denied = await requireAuth(req);
    if (denied) return denied;

    try {
        const { user, action, reason } = await req.json();

        if (!user || !action) {
            return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
        }
        if (!USERNAME_RE.test(user)) {
            return NextResponse.json({ error: "Username invalide" }, { status: 400 });
        }
        if (!VALID_ACTIONS.includes(action)) {
            return NextResponse.json({ error: "Action invalide" }, { status: 400 });
        }

        let result;
        if (action === "suspend") {
            result = await suspendAccount(user, reason);
        } else if (action === "unsuspend") {
            result = await unsuspendAccount(user);
        } else {
            result = await deleteAccount(user);
        }

        return NextResponse.json({ success: true, result });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

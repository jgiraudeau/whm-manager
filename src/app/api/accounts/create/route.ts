import { NextRequest, NextResponse } from "next/server";
import { createAccount, generatePassword } from "@/lib/whm";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
    const { denied, session } = await requireAuthSession(req);
    if (denied) return denied;
    const forbidden = ensureSuperAdmin(session);
    if (forbidden) return forbidden;

    try {
        const body = await req.json();
        const { user, domain, email, password } = body;

        if (!user || !domain || !email) {
            return NextResponse.json({ error: "Champs manquants" }, { status: 400 });
        }
        if (!isValidCpanelUsername(user)) {
            return NextResponse.json({ error: "Username invalide (3-16 caractères, minuscules, chiffres et underscore)" }, { status: 400 });
        }
        if (!DOMAIN_RE.test(domain)) {
            return NextResponse.json({ error: "Domaine invalide" }, { status: 400 });
        }
        if (!EMAIL_RE.test(email)) {
            return NextResponse.json({ error: "Email invalide" }, { status: 400 });
        }

        const pwd = password || generatePassword();
        const result = await createAccount({ user, domain, password: pwd, email });

        const success = result?.metadata?.result === 1;
        if (!success) {
            const reason = result?.metadata?.reason || "Erreur lors de la création du compte";
            return NextResponse.json({ error: reason }, { status: 500 });
        }

        return NextResponse.json({ success: true, password: pwd, user, domain });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

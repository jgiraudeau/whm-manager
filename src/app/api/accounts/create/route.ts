import { NextRequest, NextResponse } from "next/server";
import { createAccount, generatePassword } from "@/lib/whm";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import { isValidCpanelUsername } from "@/lib/validators";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CREATE_ATTEMPTS = 8;

function normalizeUsername(input: string): string {
    return input.trim().toLowerCase();
}

function buildUsernameCandidates(baseUsername: string): string[] {
    const candidates: string[] = [];
    const pushCandidate = (value: string) => {
        const candidate = value.slice(0, 16);
        if (!isValidCpanelUsername(candidate)) return;
        if (!candidates.includes(candidate)) candidates.push(candidate);
    };

    pushCandidate(baseUsername);
    for (let i = 1; candidates.length < MAX_CREATE_ATTEMPTS && i <= 99; i += 1) {
        const suffix = String(i);
        const trimmedBase = baseUsername.slice(0, Math.max(0, 16 - suffix.length));
        pushCandidate(`${trimmedBase}${suffix}`);
    }

    return candidates;
}

function deriveDomainSuffix(domain: string, baseUsername: string): string {
    const normalizedDomain = domain.trim().toLowerCase();
    const prefix = `${baseUsername}.`;
    if (normalizedDomain.startsWith(prefix)) {
        return normalizedDomain.slice(prefix.length);
    }

    const dotIndex = normalizedDomain.indexOf(".");
    if (dotIndex === -1) return "";
    return normalizedDomain.slice(dotIndex + 1);
}

function buildDomainForUsername(baseDomain: string, baseUsername: string, candidateUsername: string): string {
    const suffix = deriveDomainSuffix(baseDomain, baseUsername);
    if (!suffix) return baseDomain.trim().toLowerCase();
    return `${candidateUsername}.${suffix}`;
}

function isRetryableUsernameReason(reason: string): boolean {
    const text = reason.toLowerCase();
    return (
        text.includes("reserved username") ||
        text.includes("nom d’utilisateur réservé") ||
        text.includes("nom d'utilisateur réservé") ||
        text.includes("already exists") ||
        text.includes("already taken") ||
        text.includes("already in use") ||
        text.includes("already assigned") ||
        text.includes("username exists") ||
        text.includes("ce nom d’utilisateur est déjà utilisé") ||
        text.includes("ce nom d'utilisateur est déjà utilisé")
    );
}

export async function POST(req: NextRequest) {
    const { denied, session } = await requireAuthSession(req);
    if (denied) return denied;
    const forbidden = ensureSuperAdmin(session);
    if (forbidden) return forbidden;

    try {
        const body = await req.json();
        const { user, domain, email, password } = body;
        const baseUser = normalizeUsername(String(user ?? ""));
        const baseDomain = String(domain ?? "").trim().toLowerCase();
        const contactEmail = String(email ?? "").trim();

        if (!baseUser || !baseDomain || !contactEmail) {
            return NextResponse.json({ error: "Champs manquants" }, { status: 400 });
        }
        if (!isValidCpanelUsername(baseUser)) {
            return NextResponse.json({ error: "Username invalide (3-16 caractères, minuscules, chiffres et underscore)" }, { status: 400 });
        }
        if (!DOMAIN_RE.test(baseDomain)) {
            return NextResponse.json({ error: "Domaine invalide" }, { status: 400 });
        }
        if (!EMAIL_RE.test(contactEmail)) {
            return NextResponse.json({ error: "Email invalide" }, { status: 400 });
        }

        const pwd = password || generatePassword();
        const candidates = buildUsernameCandidates(baseUser);
        let lastReason = "Erreur lors de la création du compte";

        for (const candidateUser of candidates) {
            const candidateDomain =
                candidateUser === baseUser
                    ? baseDomain
                    : buildDomainForUsername(baseDomain, baseUser, candidateUser);

            if (!DOMAIN_RE.test(candidateDomain)) {
                continue;
            }

            const result = await createAccount({
                user: candidateUser,
                domain: candidateDomain,
                password: pwd,
                email: contactEmail,
            });

            const success = result?.metadata?.result === 1;
            if (success) {
                return NextResponse.json({
                    success: true,
                    password: pwd,
                    user: candidateUser,
                    domain: candidateDomain,
                    originalUser: baseUser,
                    autoAdjustedUsername: candidateUser !== baseUser,
                });
            }

            const reason = String(result?.metadata?.reason || "Erreur lors de la création du compte");
            lastReason = reason;
            if (!isRetryableUsernameReason(reason)) {
                break;
            }
        }

        if (isRetryableUsernameReason(lastReason)) {
            return NextResponse.json(
                {
                    error: `Le nom d'utilisateur "${baseUser}" est réservé ou déjà utilisé. Échec après ${candidates.length} tentatives automatiques.`,
                },
                { status: 409 },
            );
        }

        return NextResponse.json({ error: lastReason }, { status: 500 });
    } catch (error: unknown) {
        return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from "next/server";
import {
  authenticatePrincipal,
  canAccessAccount,
  isSuperAdmin,
  resolvePrincipalByUsername,
  type AccessPrincipal,
} from "@/lib/access-control";

const encoder = new TextEncoder();

export const SESSION_COOKIE_NAME = "whm_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 2; // 2 hours

interface SessionPayload {
  u: string;
  exp: number;
}

export type AuthenticatedSession = AccessPrincipal;

export interface AuthConfigStatus {
  hasAdminUser: boolean;
  hasAdminPassword: boolean;
  hasAuthSecret: boolean;
  adminUserSource: "ADMIN_USER" | "ADMIN_BASIC_USER" | null;
  adminPasswordSource: "ADMIN_PASSWORD" | "ADMIN_BASIC_PASSWORD" | null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function getExpectedAdminUser(): string | undefined {
  return process.env.ADMIN_USER ?? process.env.ADMIN_BASIC_USER;
}

function getExpectedAdminPassword(): string | undefined {
  return process.env.ADMIN_PASSWORD ?? process.env.ADMIN_BASIC_PASSWORD;
}

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("Missing AUTH_SECRET");
  }
  return secret;
}

async function importHmacKey(): Promise<CryptoKey> {
  const secret = getAuthSecret();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(input: string): Promise<string> {
  const key = await importHmacKey();
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function createSessionToken(username: string): Promise<string> {
  const payload: SessionPayload = {
    u: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadEncoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(payloadEncoded);
  return `${payloadEncoded}.${signature}`;
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadEncoded, givenSignature] = parts;
  const expectedSignature = await sign(payloadEncoded);

  if (!constantTimeEqual(givenSignature, expectedSignature)) {
    return null;
  }

  const payloadBytes = base64UrlDecode(payloadEncoded);
  const payloadText = new TextDecoder().decode(payloadBytes);

  let payload: SessionPayload;
  try {
    payload = JSON.parse(payloadText) as SessionPayload;
  } catch {
    return null;
  }

  if (!payload.u || typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

export async function authenticateCredentials(user: string, password: string): Promise<AuthenticatedSession | null> {
  const principal = await authenticatePrincipal(user, password);
  return principal;
}

export function getAuthConfigStatus(): AuthConfigStatus {
  const hasAdminUser = Boolean(getExpectedAdminUser());
  const hasAdminPassword = Boolean(getExpectedAdminPassword());
  const hasAuthSecret = Boolean(process.env.AUTH_SECRET);

  const adminUserSource = process.env.ADMIN_USER
    ? "ADMIN_USER"
    : process.env.ADMIN_BASIC_USER
      ? "ADMIN_BASIC_USER"
      : null;

  const adminPasswordSource = process.env.ADMIN_PASSWORD
    ? "ADMIN_PASSWORD"
    : process.env.ADMIN_BASIC_PASSWORD
      ? "ADMIN_BASIC_PASSWORD"
      : null;

  return {
    hasAdminUser,
    hasAdminPassword,
    hasAuthSecret,
    adminUserSource,
    adminPasswordSource,
  };
}

export function authIsConfigured(): boolean {
  const status = getAuthConfigStatus();
  return status.hasAdminUser && status.hasAdminPassword && status.hasAuthSecret;
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

async function readSessionFromRequest(req: NextRequest): Promise<AuthenticatedSession | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload?.u) return null;

  const principal = await resolvePrincipalByUsername(payload.u);
  if (!principal) return null;
  return principal;
}

export async function getAuthSession(req: NextRequest): Promise<AuthenticatedSession | null> {
  return readSessionFromRequest(req);
}

export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  const session = await readSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Session invalide ou expirée" }, { status: 401 });
  }
  return null;
}

export async function requireAuthSession(
  req: NextRequest,
): Promise<
  | { denied: NextResponse; session: null }
  | { denied: null; session: AuthenticatedSession }
> {
  const session = await readSessionFromRequest(req);
  if (!session) {
    return {
      denied: NextResponse.json({ error: "Session invalide ou expirée" }, { status: 401 }),
      session: null,
    };
  }
  return { denied: null, session };
}

export function filterAccountsForSession<T extends { user: string }>(
  session: AuthenticatedSession,
  accounts: T[],
): T[] {
  if (session.role === "superadmin") return accounts;
  return accounts.filter((account) => canAccessAccount(session, account.user));
}

export function ensureAccountAccess(
  session: AuthenticatedSession,
  cpanelUser: string,
): NextResponse | null {
  if (canAccessAccount(session, cpanelUser)) return null;
  return NextResponse.json({ error: "Accès refusé pour ce compte" }, { status: 403 });
}

export function ensureSuperAdmin(session: AuthenticatedSession): NextResponse | null {
  if (isSuperAdmin(session)) return null;
  return NextResponse.json({ error: "Action réservée aux administrateurs" }, { status: 403 });
}

/**
 * Returns a safe error message for API responses (no internal details leaked).
 */
export function safeError(error: unknown, fallback = "Une erreur est survenue"): string {
  console.error("[API Error]", error);
  if (error instanceof Error && error.message && !error.message.includes("WHM API")) {
    return error.message;
  }
  return fallback;
}

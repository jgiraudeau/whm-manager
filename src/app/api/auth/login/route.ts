import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  authenticateCredentials,
  authIsConfigured,
  createSessionToken,
  getAuthConfigStatus,
  getSessionCookieOptions,
} from "@/lib/auth";

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Simple in-memory rate limiter: max 5 failed attempts per IP per 10 minutes.
// Works for a single-worker deployment (Railway). For multi-instance: use Redis.
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function checkRateLimit(ip: string): { blocked: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || entry.resetAt < now) {
    // Reset window
    rateLimitMap.set(ip, { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    return { blocked: true, retryAfterSeconds };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function resetRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}
// ─────────────────────────────────────────────────────────────────────────────

interface LoginBody {
  user?: string;
  username?: string;
  password?: string;
}

function parseBody(input: unknown): LoginBody {
  if (!input || typeof input !== "object") return {};
  return input as LoginBody;
}

export async function POST(req: NextRequest) {
  if (!authIsConfigured()) {
    const status = getAuthConfigStatus();
    return NextResponse.json(
      {
        error: "Authentication is not configured on the server.",
        configStatus: status,
      },
      { status: 503 },
    );
  }

  const ip = getClientIp(req);
  const { blocked, retryAfterSeconds } = checkRateLimit(ip);
  if (blocked) {
    return NextResponse.json(
      { error: `Trop de tentatives. Réessayez dans ${retryAfterSeconds} secondes.` },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }

  const rawBody: unknown = await req.json().catch(() => null);
  const body = parseBody(rawBody);
  const user = body.user?.trim() ?? body.username?.trim() ?? "";
  const password = body.password ?? "";

  if (!user || !password) {
    return NextResponse.json({ error: "Missing credentials." }, { status: 400 });
  }

  const authenticatedUser = await authenticateCredentials(user, password);
  if (!authenticatedUser) {
    recordFailedAttempt(ip);
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  // Successful login: reset counter
  resetRateLimit(ip);
  const token = await createSessionToken(authenticatedUser.username);
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());

  return res;
}

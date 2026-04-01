import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  authenticateCredentials,
  authIsConfigured,
  createSessionToken,
  getAuthConfigStatus,
  getSessionCookieOptions,
} from "@/lib/auth";

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

  const rawBody: unknown = await req.json().catch(() => null);
  const body = parseBody(rawBody);
  const user = body.user?.trim() ?? body.username?.trim() ?? "";
  const password = body.password ?? "";

  if (!user || !password) {
    return NextResponse.json({ error: "Missing credentials." }, { status: 400 });
  }

  const authenticatedUser = await authenticateCredentials(user, password);
  if (!authenticatedUser) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const token = await createSessionToken(authenticatedUser.username);
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());

  return res;
}

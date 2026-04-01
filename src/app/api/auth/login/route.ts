import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  authIsConfigured,
  createSessionToken,
  getAuthConfigStatus,
  getSessionCookieOptions,
  verifyAdminCredentials,
} from "@/lib/auth";

interface LoginBody {
  user?: string;
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
  const user = body.user?.trim() ?? "";
  const password = body.password ?? "";

  if (!user || !password) {
    return NextResponse.json({ error: "Missing credentials." }, { status: 400 });
  }

  if (!verifyAdminCredentials(user, password)) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const token = await createSessionToken(user);
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());

  return res;
}

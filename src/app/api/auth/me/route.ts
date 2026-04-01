import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: "Session invalide ou expirée" }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      username: session.username,
      role: session.role,
      source: session.source,
      allowedAccounts: session.role === "superadmin" ? [] : session.allowedAccounts,
    },
  });
}

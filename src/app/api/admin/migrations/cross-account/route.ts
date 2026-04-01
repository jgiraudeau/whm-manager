import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import { listPreparedMigrations } from "@/lib/migration-store";

export async function GET(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;
  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const { searchParams } = new URL(req.url);
    const limitParam = Number(searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(limitParam) ? limitParam : 30;
    const plans = await listPreparedMigrations(limit);
    return NextResponse.json({ plans });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors du chargement des migrations préparées") },
      { status: 500 },
    );
  }
}

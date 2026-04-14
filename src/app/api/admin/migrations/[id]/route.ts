import { NextRequest, NextResponse } from "next/server";
import { requireAuthSession, ensureSuperAdmin, safeError } from "@/lib/auth";
import { getMigrationJob } from "@/lib/migration-store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const { id } = await params;
    const job = await getMigrationJob(id);
    if (!job) {
      return NextResponse.json({ error: "Job introuvable" }, { status: 404 });
    }
    return NextResponse.json({ job });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la lecture du job") },
      { status: 500 },
    );
  }
}

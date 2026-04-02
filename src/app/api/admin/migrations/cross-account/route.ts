import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import {
  clearMigrations,
  deleteMigrationById,
  findMigrationById,
  listPreparedMigrations,
} from "@/lib/migration-store";

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

export async function DELETE(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;
  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const { searchParams } = new URL(req.url);
    const deleteAll = searchParams.get("all") === "1";

    if (deleteAll) {
      const plans = await listPreparedMigrations(200);
      const runningCount = plans.filter((plan) => plan.status === "running").length;
      if (runningCount > 0) {
        return NextResponse.json(
          {
            error:
              runningCount === 1
                ? "Une migration est en cours. Arrête-la avant de vider l'historique."
                : `${runningCount} migrations sont en cours. Arrête-les avant de vider l'historique.`,
          },
          { status: 409 },
        );
      }

      const removedCount = await clearMigrations();
      return NextResponse.json({
        success: true,
        removedCount,
        message:
          removedCount > 0
            ? `${removedCount} tentative(s) supprimée(s)`
            : "Aucune tentative à supprimer",
      });
    }

    const planId = (searchParams.get("planId") ?? "").trim();
    if (!planId) {
      return NextResponse.json({ error: "planId manquant" }, { status: 400 });
    }

    const existing = await findMigrationById(planId);
    if (!existing) {
      return NextResponse.json({ error: "Plan introuvable" }, { status: 404 });
    }
    if (existing.status === "running") {
      return NextResponse.json(
        { error: "Migration en cours. Arrête-la avant suppression." },
        { status: 409 },
      );
    }

    await deleteMigrationById(planId);
    return NextResponse.json({
      success: true,
      message: `Tentative ${planId} supprimée`,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la suppression des migrations") },
      { status: 500 },
    );
  }
}

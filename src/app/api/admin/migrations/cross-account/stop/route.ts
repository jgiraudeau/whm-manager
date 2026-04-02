import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import { appendExecutionLog, findMigrationById, updateMigrationById } from "@/lib/migration-store";

interface StopBody {
  planId?: string;
}

export async function POST(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;
  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as StopBody;
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      return NextResponse.json({ error: "planId manquant" }, { status: 400 });
    }

    const existing = await findMigrationById(planId);
    if (!existing) {
      return NextResponse.json({ error: "Plan de migration introuvable" }, { status: 404 });
    }
    if (existing.status === "completed") {
      return NextResponse.json({
        success: true,
        message: "Plan déjà terminé",
        plan: existing,
      });
    }
    if (existing.execution?.stopRequestedAt) {
      return NextResponse.json({
        success: true,
        message: "Arrêt déjà demandé",
        plan: existing,
      });
    }

    const now = new Date().toISOString();
    const stopMessage = `Arrêt demandé par ${session.username}`;
    const blockerReason = `Interrompu manuellement par ${session.username}`;

    const updated = await updateMigrationById(planId, (plan) => {
      const withLog = appendExecutionLog(plan, stopMessage);
      return {
        ...withLog,
        status: "blocked",
        execution: {
          ...(withLog.execution ?? { logs: [] }),
          stopRequestedAt: now,
          stoppedAt: now,
          stoppedBy: session.username,
          blockerReason,
          finishedAt: now,
          fallbackSummary:
            withLog.execution?.fallbackSummary
            ?? "Exécution interrompue manuellement avant la fin",
        },
        nextActions: [
          "Relancer la migration si besoin",
          "Supprimer cette tentative si elle n'est plus utile",
          "Vérifier l'état du sous-domaine cible avant nouvelle exécution",
        ],
      };
    });

    return NextResponse.json({
      success: true,
      message: "Demande d'arrêt enregistrée",
      plan: updated,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de l'arrêt de la migration") },
      { status: 500 },
    );
  }
}

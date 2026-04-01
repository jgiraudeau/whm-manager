import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import {
  appendExecutionLog,
  findMigrationById,
  updateMigrationById,
  type CrossAccountMigrationPlan,
} from "@/lib/migration-store";
import { triggerSoftaculousBackup } from "@/lib/softaculous-client";

interface ExecuteBody {
  planId?: string;
}

function backupRestoreDisabled(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("off_backup_restore") ||
    text.includes("backup/restoration is disabled") ||
    text.includes("backup/restauration a été désactivée") ||
    text.includes("sauvegarde/restauration a été désactivée")
  );
}

function withStatus(
  plan: CrossAccountMigrationPlan,
  status: CrossAccountMigrationPlan["status"],
): CrossAccountMigrationPlan {
  return { ...plan, status };
}

export async function POST(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;
  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as ExecuteBody;
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      return NextResponse.json({ error: "planId manquant" }, { status: 400 });
    }

    const existing = await findMigrationById(planId);
    if (!existing) {
      return NextResponse.json({ error: "Plan de migration introuvable" }, { status: 404 });
    }
    if (existing.status === "completed") {
      return NextResponse.json({ success: true, message: "Plan déjà terminé", plan: existing });
    }

    const runningPlan = await updateMigrationById(planId, (plan) =>
      appendExecutionLog(
        {
          ...withStatus(plan, "running"),
          execution: {
            ...(plan.execution ?? { logs: [] }),
            startedAt: plan.execution?.startedAt ?? new Date().toISOString(),
            finishedAt: undefined,
            blockerReason: undefined,
          },
        },
        `Exécution lancée par ${session.username}`,
      ),
    );
    if (!runningPlan) {
      return NextResponse.json({ error: "Plan de migration introuvable" }, { status: 404 });
    }

    const backupResult = await triggerSoftaculousBackup(
      runningPlan.sourceAccount,
      runningPlan.sourceInstallationId,
    );

    if (!backupResult.success) {
      const blocked = await updateMigrationById(planId, (plan) => {
        const withLog = appendExecutionLog(
          plan,
          `Backup source échoué: ${backupResult.message}`,
        );
        return {
          ...withStatus(withLog, "blocked"),
          execution: {
            ...(withLog.execution ?? { logs: [] }),
            backupTriggered: false,
            backupMessage: backupResult.message,
            blockerReason: backupResult.message,
            finishedAt: new Date().toISOString(),
          },
          nextActions: backupRestoreDisabled(backupResult.message)
            ? [
              "Demander à l'hébergeur d'activer Softaculous Backup/Restore",
              "Relancer l'exécution du plan depuis /admin/migrations",
              "Alternative: migration manuelle fichiers + base SQL",
            ]
            : withLog.nextActions,
        };
      });

      return NextResponse.json({
        success: false,
        message: backupResult.message,
        blocked: true,
        plan: blocked,
      });
    }

    const updated = await updateMigrationById(planId, (plan) => {
      const withLog = appendExecutionLog(plan, `Backup source déclenché: ${backupResult.message}`);
      return {
        ...withStatus(withLog, "running"),
        execution: {
          ...(withLog.execution ?? { logs: [] }),
          backupTriggered: true,
          backupMessage: backupResult.message,
        },
        nextActions: [
          "Le backup source vient d'être déclenché",
          "Attendre la disponibilité de l'archive backup côté Softaculous",
          "Étape suivante: restauration automatisée inter-compte (phase 2b)",
        ],
      };
    });

    return NextResponse.json({
      success: true,
      message: "Exécution lancée: backup source déclenché",
      plan: updated,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de l'exécution de migration inter-compte") },
      { status: 500 },
    );
  }
}

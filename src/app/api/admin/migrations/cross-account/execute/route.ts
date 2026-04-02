import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import {
  appendExecutionLog,
  findMigrationById,
  updateMigrationById,
  type CrossAccountMigrationPlan,
} from "@/lib/migration-store";
import { triggerSoftaculousBackup } from "@/lib/softaculous-client";
import { runWordPressCrossAccountCloneFallback } from "@/lib/cross-account-wordpress-fallback";

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

    const appendLog = async (message: string) => {
      await updateMigrationById(planId, (plan) => appendExecutionLog(plan, message));
    };

    const backupResult = await triggerSoftaculousBackup(
      runningPlan.sourceAccount,
      runningPlan.sourceInstallationId,
    );

    if (!backupResult.success) {
      if (backupRestoreDisabled(backupResult.message) && runningPlan.sourceApp === "wordpress") {
        await appendLog("Backup/Restore Softaculous indisponible: bascule vers fallback WordPress");
        try {
          const fallback = await runWordPressCrossAccountCloneFallback(
            {
              sourceAccount: runningPlan.sourceAccount,
              destinationAccount: runningPlan.destinationAccount,
              sourceInstallationId: runningPlan.sourceInstallationId,
              destinationSubdomain: runningPlan.destinationSubdomain,
              destinationDomain: runningPlan.destinationDomain,
              sourceUrl: runningPlan.sourceUrl,
              targetUrl: runningPlan.targetUrl,
            },
            async (message) => {
              await appendLog(message);
            },
          );

          const completed = await updateMigrationById(planId, (plan) => {
            const withLog = appendExecutionLog(
              plan,
              `Fallback terminé: ${fallback.copiedFiles} fichiers, ${Math.round((fallback.copiedBytes / 1024 / 1024) * 10) / 10} MiB`,
            );
            return {
              ...withStatus(withLog, "completed"),
              execution: {
                ...(withLog.execution ?? { logs: [] }),
                backupTriggered: false,
                backupMessage: backupResult.message,
                fallbackUsed: true,
                fallbackSummary:
                  `Fichiers: ${fallback.copiedFiles}, Dossiers: ${fallback.copiedDirectories}, DB: ${fallback.destinationDatabase}`,
                blockerReason: undefined,
                finishedAt: new Date().toISOString(),
              },
              nextActions: [
                `Vérifier le site cloné sur ${runningPlan.targetUrl}`,
                "Regénérer les permaliens WordPress et vider le cache",
                "Contrôler l'accès /wp-admin et lancer un test fonctionnel",
              ],
            };
          });

          return NextResponse.json({
            success: true,
            fallback: true,
            message: "Migration terminée via fallback WordPress (sans Backup/Restore Softaculous)",
            plan: completed,
          });
        } catch (fallbackError: unknown) {
          const fallbackMessage = safeError(
            fallbackError,
            "Fallback WordPress échoué pendant la copie fichiers/base",
          );
          const blocked = await updateMigrationById(planId, (plan) => {
            const withLog = appendExecutionLog(plan, `Fallback échoué: ${fallbackMessage}`);
            return {
              ...withStatus(withLog, "blocked"),
              execution: {
                ...(withLog.execution ?? { logs: [] }),
                backupTriggered: false,
                backupMessage: backupResult.message,
                fallbackUsed: true,
                fallbackSummary: fallbackMessage,
                blockerReason: fallbackMessage,
                finishedAt: new Date().toISOString(),
              },
              nextActions: [
                "Réessayer la phase 2 (fallback) depuis /admin/migrations",
                "Alléger le site source (archives/cache) puis relancer",
                "Sinon: migration manuelle via plugin WordPress (Duplicator/All-in-One Migration)",
              ],
            };
          });

          return NextResponse.json({
            success: false,
            blocked: true,
            message: fallbackMessage,
            plan: blocked,
          });
        }
      }

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
            fallbackUsed: false,
            fallbackSummary: undefined,
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

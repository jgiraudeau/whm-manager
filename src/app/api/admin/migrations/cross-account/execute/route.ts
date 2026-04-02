import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import {
  appendExecutionLog,
  findMigrationById,
  updateMigrationById,
  type CrossAccountMigrationPlan,
} from "@/lib/migration-store";
import { triggerSoftaculousBackup } from "@/lib/softaculous-client";
import {
  MIGRATION_ABORTED_ERROR,
  runWordPressCrossAccountCloneFallback,
} from "@/lib/cross-account-wordpress-fallback";

interface ExecuteBody {
  planId?: string;
}

function describeUnknownError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Erreur inconnue";
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    const code = typeof causeRecord.code === "string" ? causeRecord.code : "";
    const hostname = typeof causeRecord.hostname === "string" ? causeRecord.hostname : "";
    if (code && hostname) {
      return `${error.message} (${code} ${hostname})`;
    }
    if (code) {
      return `${error.message} (${code})`;
    }
  }

  return error.message || "Erreur inconnue";
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

function createStopChecker(planId: string): () => Promise<boolean> {
  let lastCheckAt = 0;
  let lastValue = false;

  return async () => {
    const now = Date.now();
    if (now - lastCheckAt < 1200) {
      return lastValue;
    }
    lastCheckAt = now;
    const latest = await findMigrationById(planId);
    lastValue = Boolean(latest?.execution?.stopRequestedAt);
    return lastValue;
  };
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
    if (existing.status === "running") {
      return NextResponse.json({
        success: true,
        pending: true,
        message: "Une exécution est déjà en cours pour ce plan",
        plan: existing,
      });
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
            fallbackSummary: undefined,
            stopRequestedAt: undefined,
            stoppedAt: undefined,
            stoppedBy: undefined,
          },
        },
        `Exécution lancée par ${session.username}`,
      ),
    );
    if (!runningPlan) {
      return NextResponse.json({ error: "Plan de migration introuvable" }, { status: 404 });
    }
    const isStopRequested = createStopChecker(planId);

    const appendLog = async (message: string) => {
      if (await isStopRequested()) return;
      await updateMigrationById(planId, (plan) => appendExecutionLog(plan, message));
    };

    const backupResult = await triggerSoftaculousBackup(
      runningPlan.sourceAccount,
      runningPlan.sourceInstallationId,
    );

    if (await isStopRequested()) {
      const stopped = await updateMigrationById(planId, (plan) => {
        const withLog = appendExecutionLog(plan, "Exécution interrompue avant la phase backup/restore");
        return {
          ...withStatus(withLog, "blocked"),
          execution: {
            ...(withLog.execution ?? { logs: [] }),
            backupTriggered: false,
            backupMessage: backupResult.message,
            fallbackUsed: false,
            fallbackSummary: "Exécution interrompue manuellement",
            blockerReason: withLog.execution?.blockerReason ?? "Interrompu manuellement",
            finishedAt: withLog.execution?.finishedAt ?? new Date().toISOString(),
          },
        };
      });
      return NextResponse.json({
        success: true,
        stopped: true,
        message: "Exécution arrêtée",
        plan: stopped,
      });
    }

    if (!backupResult.success) {
      if (backupRestoreDisabled(backupResult.message) && runningPlan.sourceApp === "wordpress") {
        await appendLog("Backup/Restore Softaculous indisponible: bascule vers fallback WordPress");
        void (async () => {
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
                if (await isStopRequested()) {
                  throw new Error(MIGRATION_ABORTED_ERROR);
                }
                await appendLog(message);
              },
              {
                shouldAbort: isStopRequested,
              },
            );

            if (await isStopRequested()) {
              await updateMigrationById(planId, (plan) => {
                const withLog = appendExecutionLog(plan, "Exécution interrompue avant finalisation");
                return {
                  ...withStatus(withLog, "blocked"),
                  execution: {
                    ...(withLog.execution ?? { logs: [] }),
                    backupTriggered: false,
                    backupMessage: backupResult.message,
                    fallbackUsed: true,
                    fallbackSummary: "Exécution interrompue manuellement",
                    blockerReason: withLog.execution?.blockerReason ?? "Interrompu manuellement",
                    finishedAt: withLog.execution?.finishedAt ?? new Date().toISOString(),
                  },
                };
              });
              return;
            }

            await updateMigrationById(planId, (plan) => {
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
          } catch (fallbackError: unknown) {
            const abortedByUser =
              fallbackError instanceof Error && fallbackError.message === MIGRATION_ABORTED_ERROR;
            if (abortedByUser || (await isStopRequested())) {
              await updateMigrationById(planId, (plan) => {
                const withLog = appendExecutionLog(plan, "Exécution interrompue par l'administrateur");
                return {
                  ...withStatus(withLog, "blocked"),
                  execution: {
                    ...(withLog.execution ?? { logs: [] }),
                    backupTriggered: false,
                    backupMessage: backupResult.message,
                    fallbackUsed: true,
                    fallbackSummary: "Exécution interrompue manuellement",
                    blockerReason: withLog.execution?.blockerReason ?? "Interrompu manuellement",
                    finishedAt: withLog.execution?.finishedAt ?? new Date().toISOString(),
                  },
                };
              });
              return;
            }

            const fallbackMessage = describeUnknownError(fallbackError)
              || safeError(
                fallbackError,
                "Fallback WordPress échoué pendant la copie fichiers/base",
              );
            await updateMigrationById(planId, (plan) => {
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
          }
        })();

        const queuedPlan = await findMigrationById(planId);
        return NextResponse.json({
          success: true,
          pending: true,
          fallback: true,
          message: "Fallback WordPress lancé en arrière-plan. Actualise pour suivre les logs.",
          plan: queuedPlan ?? runningPlan,
        });
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

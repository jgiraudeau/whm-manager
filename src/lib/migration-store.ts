import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStorePath } from "@/lib/store-path";

export type MigrationStatus = "prepared" | "running" | "blocked" | "completed";

export interface MigrationExecutionState {
  startedAt?: string;
  finishedAt?: string;
  backupTriggered?: boolean;
  backupMessage?: string;
  blockerReason?: string;
  logs: string[];
}

export interface CrossAccountMigrationPlan {
  id: string;
  status: MigrationStatus;
  createdAt: string;
  createdBy: string;
  sourceAccount: string;
  sourceInstallationId: string;
  sourceApp: "wordpress" | "prestashop" | "other";
  sourceUrl: string;
  destinationAccount: string;
  destinationDomain: string;
  destinationSubdomain: string;
  targetUrl: string;
  createdTargetSubdomain: boolean;
  checks: string[];
  nextActions: string[];
  execution?: MigrationExecutionState;
}

interface MigrationStore {
  version: 1;
  plans: CrossAccountMigrationPlan[];
}

function getStorePath(): string {
  return resolveStorePath({
    explicitEnvVar: "MIGRATION_STORE_PATH",
    vercelTmpFile: "whm-manager-migrations.json",
    defaultFileName: "migrations.json",
  });
}

function normalizePlan(raw: unknown): CrossAccountMigrationPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const plan = raw as Partial<CrossAccountMigrationPlan>;
  if (
    typeof plan.id !== "string" ||
    typeof plan.createdAt !== "string" ||
    typeof plan.createdBy !== "string" ||
    typeof plan.sourceAccount !== "string" ||
    typeof plan.sourceInstallationId !== "string" ||
    typeof plan.sourceApp !== "string" ||
    typeof plan.sourceUrl !== "string" ||
    typeof plan.destinationAccount !== "string" ||
    typeof plan.destinationDomain !== "string" ||
    typeof plan.destinationSubdomain !== "string" ||
    typeof plan.targetUrl !== "string" ||
    typeof plan.createdTargetSubdomain !== "boolean" ||
    !Array.isArray(plan.checks) ||
    !Array.isArray(plan.nextActions)
  ) {
    return null;
  }

  const status: MigrationStatus =
    plan.status === "running" || plan.status === "blocked" || plan.status === "completed"
      ? plan.status
      : "prepared";

  const executionInput = plan.execution;
  const execution: MigrationExecutionState | undefined =
    executionInput && typeof executionInput === "object"
      ? {
        startedAt: typeof executionInput.startedAt === "string" ? executionInput.startedAt : undefined,
        finishedAt: typeof executionInput.finishedAt === "string" ? executionInput.finishedAt : undefined,
        backupTriggered: Boolean(executionInput.backupTriggered),
        backupMessage:
          typeof executionInput.backupMessage === "string" ? executionInput.backupMessage : undefined,
        blockerReason:
          typeof executionInput.blockerReason === "string" ? executionInput.blockerReason : undefined,
        logs: Array.isArray(executionInput.logs)
          ? executionInput.logs.filter((item): item is string => typeof item === "string")
          : [],
      }
      : undefined;

  return {
    id: plan.id,
    status,
    createdAt: plan.createdAt,
    createdBy: plan.createdBy,
    sourceAccount: plan.sourceAccount,
    sourceInstallationId: plan.sourceInstallationId,
    sourceApp: plan.sourceApp as "wordpress" | "prestashop" | "other",
    sourceUrl: plan.sourceUrl,
    destinationAccount: plan.destinationAccount,
    destinationDomain: plan.destinationDomain,
    destinationSubdomain: plan.destinationSubdomain,
    targetUrl: plan.targetUrl,
    createdTargetSubdomain: plan.createdTargetSubdomain,
    checks: plan.checks.filter((item): item is string => typeof item === "string"),
    nextActions: plan.nextActions.filter((item): item is string => typeof item === "string"),
    execution,
  };
}

function asStore(raw: unknown): MigrationStore {
  if (!raw || typeof raw !== "object") {
    return { version: 1, plans: [] };
  }
  const input = raw as Partial<MigrationStore>;
  const plans = Array.isArray(input.plans) ? input.plans : [];

  return {
    version: 1,
    plans: plans
      .map((item) => normalizePlan(item))
      .filter((item): item is CrossAccountMigrationPlan => Boolean(item)),
  };
}

async function readStore(): Promise<MigrationStore> {
  const filePath = getStorePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return asStore(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return { version: 1, plans: [] };
    }
    throw error;
  }
}

async function writeStore(store: MigrationStore): Promise<void> {
  const filePath = getStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function createPlanId(): string {
  const random = crypto.randomUUID().split("-")[0];
  return `mig_${Date.now()}_${random}`;
}

export async function savePreparedMigration(
  plan: Omit<CrossAccountMigrationPlan, "id" | "status" | "createdAt" | "execution">,
): Promise<CrossAccountMigrationPlan> {
  const store = await readStore();
  const fullPlan: CrossAccountMigrationPlan = {
    ...plan,
    id: createPlanId(),
    status: "prepared",
    createdAt: new Date().toISOString(),
    execution: { logs: [] },
  };
  store.plans = [fullPlan, ...store.plans].slice(0, 200);
  await writeStore(store);
  return fullPlan;
}

export async function listPreparedMigrations(limit = 30): Promise<CrossAccountMigrationPlan[]> {
  const store = await readStore();
  return store.plans.slice(0, Math.max(1, Math.min(200, limit)));
}

export async function findMigrationById(id: string): Promise<CrossAccountMigrationPlan | null> {
  const store = await readStore();
  return store.plans.find((plan) => plan.id === id) ?? null;
}

export async function updateMigrationById(
  id: string,
  updater: (plan: CrossAccountMigrationPlan) => CrossAccountMigrationPlan,
): Promise<CrossAccountMigrationPlan | null> {
  const store = await readStore();
  const index = store.plans.findIndex((plan) => plan.id === id);
  if (index === -1) return null;

  const current = store.plans[index];
  const updated = updater(current);
  store.plans[index] = updated;
  await writeStore(store);
  return updated;
}

export function appendExecutionLog(
  plan: CrossAccountMigrationPlan,
  message: string,
): CrossAccountMigrationPlan {
  const now = new Date().toISOString();
  const logs = [...(plan.execution?.logs ?? []), `[${now}] ${message}`].slice(-100);
  return {
    ...plan,
    execution: {
      ...(plan.execution ?? { logs: [] }),
      logs,
    },
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";

export type MigrationStatus = "prepared";

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
}

interface MigrationStore {
  version: 1;
  plans: CrossAccountMigrationPlan[];
}

function getStorePath(): string {
  const explicitPath = process.env.MIGRATION_STORE_PATH?.trim();
  if (explicitPath) return explicitPath;
  if (process.env.VERCEL) return "/tmp/whm-manager-migrations.json";
  return path.join(process.cwd(), "data", "migrations.json");
}

function asStore(raw: unknown): MigrationStore {
  if (!raw || typeof raw !== "object") {
    return { version: 1, plans: [] };
  }
  const input = raw as Partial<MigrationStore>;
  const plans = Array.isArray(input.plans) ? input.plans : [];

  return {
    version: 1,
    plans: plans.filter((item) => item && typeof item === "object") as CrossAccountMigrationPlan[],
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
  plan: Omit<CrossAccountMigrationPlan, "id" | "status" | "createdAt">,
): Promise<CrossAccountMigrationPlan> {
  const store = await readStore();
  const fullPlan: CrossAccountMigrationPlan = {
    ...plan,
    id: createPlanId(),
    status: "prepared",
    createdAt: new Date().toISOString(),
  };
  store.plans = [fullPlan, ...store.plans].slice(0, 200);
  await writeStore(store);
  return fullPlan;
}

export async function listPreparedMigrations(limit = 30): Promise<CrossAccountMigrationPlan[]> {
  const store = await readStore();
  return store.plans.slice(0, Math.max(1, Math.min(200, limit)));
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStorePath } from "@/lib/store-path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MigrationStatus = "pending" | "running" | "done" | "error";
export type AppType = "wordpress" | "prestashop";

export interface MigrationTarget {
  user: string;
  subdomain: string;
  domain: string;
  status: MigrationStatus;
  error: string | null;
  logs: string[];
  startedAt: string | null;
  finishedAt: string | null;
  targetUrl: string | null;
}

export interface MigrationJob {
  id: string;
  sourceUser: string;
  sourceInstallId: string;
  sourceUrl: string;
  appType: AppType;
  targets: MigrationTarget[];
  createdAt: string;
  updatedAt: string;
}

interface MigrationStore {
  version: 1;
  jobs: MigrationJob[];
}

// ─── Store helpers ────────────────────────────────────────────────────────────

function getStorePath(): string {
  return resolveStorePath({
    explicitEnvVar: "MIGRATION_STORE_PATH",
    vercelTmpFile: "whm-manager-migrations.json",
    defaultFileName: "migrations.json",
  });
}

function sanitizeStore(raw: unknown): MigrationStore {
  if (!raw || typeof raw !== "object") return { version: 1, jobs: [] };
  const input = raw as Partial<MigrationStore>;
  return {
    version: 1,
    jobs: Array.isArray(input.jobs) ? (input.jobs as MigrationJob[]) : [],
  };
}

async function readStore(): Promise<MigrationStore> {
  try {
    const raw = await fs.readFile(getStorePath(), "utf8");
    try {
      return sanitizeStore(JSON.parse(raw) as unknown);
    } catch {
      // JSON corrupted (e.g. concurrent write race) — reset rather than crash
      console.error("[migration-store] JSON parse error, resetting store");
      return { version: 1, jobs: [] };
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw error;
  }
}

// Module-level write lock — serialises concurrent writeStore calls so concurrent
// appendMigrationLog calls from the same process never interleave their file writes.
let writeLock: Promise<void> = Promise.resolve();

async function writeStore(store: MigrationStore): Promise<void> {
  const doWrite = async () => {
    const filePath = getStorePath();
    const tmpPath = `${filePath}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Write to .tmp then rename — atomic on POSIX, prevents partial-read corruption
    await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  };
  // Chain onto the existing lock so writes are serialised
  writeLock = writeLock.then(doWrite, doWrite);
  return writeLock;
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createMigrationJob(params: {
  sourceUser: string;
  sourceInstallId: string;
  sourceUrl: string;
  appType: AppType;
  targets: Array<{ user: string; subdomain: string; domain: string }>;
}): Promise<MigrationJob> {
  const store = await readStore();
  const now = new Date().toISOString();

  const job: MigrationJob = {
    id: randomId(),
    sourceUser: params.sourceUser,
    sourceInstallId: params.sourceInstallId,
    sourceUrl: params.sourceUrl,
    appType: params.appType,
    targets: params.targets.map((t) => ({
      user: t.user,
      subdomain: t.subdomain,
      domain: t.domain,
      status: "pending",
      error: null,
      logs: [],
      startedAt: null,
      finishedAt: null,
      targetUrl: null,
    })),
    createdAt: now,
    updatedAt: now,
  };

  store.jobs.unshift(job); // newest first
  // Keep last 50 jobs
  store.jobs = store.jobs.slice(0, 50);
  await writeStore(store);
  return job;
}

export async function getMigrationJob(id: string): Promise<MigrationJob | null> {
  const store = await readStore();
  return store.jobs.find((j) => j.id === id) ?? null;
}

export async function listMigrationJobs(): Promise<MigrationJob[]> {
  const store = await readStore();
  return store.jobs;
}

export async function updateMigrationTarget(
  jobId: string,
  targetUser: string,
  patch: Partial<Pick<MigrationTarget, "status" | "error" | "logs" | "startedAt" | "finishedAt" | "targetUrl">>,
): Promise<void> {
  const store = await readStore();
  const job = store.jobs.find((j) => j.id === jobId);
  if (!job) return;

  const target = job.targets.find((t) => t.user === targetUser);
  if (!target) return;

  Object.assign(target, patch);
  job.updatedAt = new Date().toISOString();
  await writeStore(store);
}

export async function appendMigrationLog(
  jobId: string,
  targetUser: string,
  message: string,
): Promise<void> {
  const store = await readStore();
  const job = store.jobs.find((j) => j.id === jobId);
  if (!job) return;

  const target = job.targets.find((t) => t.user === targetUser);
  if (!target) return;

  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  target.logs.push(`[${ts}] ${message}`);
  // Keep last 200 log lines per target
  if (target.logs.length > 200) target.logs = target.logs.slice(-200);
  job.updatedAt = new Date().toISOString();
  await writeStore(store);
}

export async function deleteMigrationJob(id: string): Promise<void> {
  const store = await readStore();
  store.jobs = store.jobs.filter((j) => j.id !== id);
  await writeStore(store);
}

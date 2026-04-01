import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidCpanelUsername } from "@/lib/validators";
import { resolveStorePath } from "@/lib/store-path";

export type AccessRole = "superadmin" | "operator";

export interface AccessPrincipal {
  username: string;
  role: AccessRole;
  allowedAccounts: string[];
  source: "env" | "managed";
}

interface ManagedUserRecord {
  username: string;
  role: AccessRole;
  passwordHash: string;
  allowedAccounts: string[];
  createdAt: string;
  updatedAt: string;
}

interface AccessStore {
  version: 1;
  users: ManagedUserRecord[];
}

export interface ManagedUserView {
  username: string;
  role: AccessRole;
  allowedAccounts: string[];
  createdAt: string;
  updatedAt: string;
}

interface UpsertManagedUserInput {
  username: string;
  role: AccessRole;
  allowedAccounts: string[];
  password?: string;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAllowedAccounts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const normalized = normalizeUsername(item);
    if (isValidCpanelUsername(normalized)) {
      out.add(normalized);
    }
  }
  return Array.from(out);
}

function isRole(value: unknown): value is AccessRole {
  return value === "superadmin" || value === "operator";
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function getEnvAdminUsername(): string | undefined {
  const value = process.env.ADMIN_USER ?? process.env.ADMIN_BASIC_USER;
  const normalized = value ? normalizeUsername(value) : "";
  return normalized || undefined;
}

function getEnvAdminPassword(): string | undefined {
  const value = process.env.ADMIN_PASSWORD ?? process.env.ADMIN_BASIC_PASSWORD;
  return value?.trim() || undefined;
}

function getStorePath(): string {
  return resolveStorePath({
    explicitEnvVar: "ACCESS_CONTROL_STORE_PATH",
    vercelTmpFile: "whm-manager-access-control.json",
    defaultFileName: "access-control.json",
  });
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHash] = parts;
  const hash = scryptSync(password, salt, 64).toString("hex");
  return constantTimeEqual(hash, expectedHash);
}

function sanitizeStore(raw: unknown): AccessStore {
  if (!raw || typeof raw !== "object") {
    return { version: 1, users: [] };
  }
  const input = raw as Partial<AccessStore>;
  const users = Array.isArray(input.users) ? input.users : [];
  const now = new Date().toISOString();

  const sanitizedUsers: ManagedUserRecord[] = [];
  for (const user of users) {
    if (!user || typeof user !== "object") continue;
    const record = user as Partial<ManagedUserRecord>;
    const username = typeof record.username === "string" ? normalizeUsername(record.username) : "";
    if (!username || !isValidCpanelUsername(username)) continue;
    if (!isRole(record.role)) continue;
    if (typeof record.passwordHash !== "string" || !record.passwordHash.trim()) continue;

    sanitizedUsers.push({
      username,
      role: record.role,
      passwordHash: record.passwordHash,
      allowedAccounts: normalizeAllowedAccounts(record.allowedAccounts),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    });
  }

  return { version: 1, users: sanitizedUsers };
}

async function readStore(): Promise<AccessStore> {
  const filePath = getStorePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return sanitizeStore(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return { version: 1, users: [] };
    }
    throw error;
  }
}

async function writeStore(store: AccessStore): Promise<void> {
  const filePath = getStorePath();
  const directory = path.dirname(filePath);

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function toManagedUserView(record: ManagedUserRecord): ManagedUserView {
  return {
    username: record.username,
    role: record.role,
    allowedAccounts: record.allowedAccounts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function isSuperAdmin(principal: AccessPrincipal): boolean {
  return principal.role === "superadmin";
}

export function canAccessAccount(principal: AccessPrincipal, accountUsername: string): boolean {
  if (principal.role === "superadmin") return true;
  const normalized = normalizeUsername(accountUsername);
  return principal.allowedAccounts.includes(normalized);
}

export async function resolvePrincipalByUsername(username: string): Promise<AccessPrincipal | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;

  const envAdmin = getEnvAdminUsername();
  if (envAdmin && constantTimeEqual(normalized, envAdmin)) {
    return {
      username: envAdmin,
      role: "superadmin",
      allowedAccounts: [],
      source: "env",
    };
  }

  const store = await readStore();
  const managed = store.users.find((record) => record.username === normalized);
  if (!managed) return null;

  return {
    username: managed.username,
    role: managed.role,
    allowedAccounts: managed.allowedAccounts,
    source: "managed",
  };
}

export async function authenticatePrincipal(username: string, password: string): Promise<AccessPrincipal | null> {
  const normalized = normalizeUsername(username);
  if (!normalized || !password) return null;

  const envAdmin = getEnvAdminUsername();
  const envPassword = getEnvAdminPassword();
  if (envAdmin && envPassword && constantTimeEqual(normalized, envAdmin) && constantTimeEqual(password, envPassword)) {
    return {
      username: envAdmin,
      role: "superadmin",
      allowedAccounts: [],
      source: "env",
    };
  }

  const store = await readStore();
  const managed = store.users.find((record) => record.username === normalized);
  if (!managed) return null;
  if (!verifyPassword(password, managed.passwordHash)) return null;

  return {
    username: managed.username,
    role: managed.role,
    allowedAccounts: managed.allowedAccounts,
    source: "managed",
  };
}

export async function listManagedUsers(): Promise<ManagedUserView[]> {
  const store = await readStore();
  return store.users.map(toManagedUserView).sort((a, b) => a.username.localeCompare(b.username));
}

export async function upsertManagedUser(input: UpsertManagedUserInput): Promise<ManagedUserView> {
  const username = normalizeUsername(input.username);
  const role = input.role;
  const allowedAccounts = normalizeAllowedAccounts(input.allowedAccounts);
  const now = new Date().toISOString();

  if (!isValidCpanelUsername(username)) {
    throw new Error("Nom d'utilisateur invalide (format cPanel attendu)");
  }
  if (!isRole(role)) {
    throw new Error("Rôle invalide");
  }

  const envAdmin = getEnvAdminUsername();
  if (envAdmin && username === envAdmin) {
    throw new Error("Le compte administrateur principal ne peut pas être modifié ici");
  }

  const store = await readStore();
  const existingIndex = store.users.findIndex((record) => record.username === username);

  if (existingIndex === -1) {
    if (!input.password || input.password.length < 8) {
      throw new Error("Un mot de passe de 8 caractères minimum est requis");
    }
    const created: ManagedUserRecord = {
      username,
      role,
      passwordHash: hashPassword(input.password),
      allowedAccounts,
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(created);
    await writeStore(store);
    return toManagedUserView(created);
  }

  const previous = store.users[existingIndex];
  const updated: ManagedUserRecord = {
    ...previous,
    role,
    allowedAccounts,
    updatedAt: now,
  };
  if (input.password && input.password.length > 0) {
    if (input.password.length < 8) {
      throw new Error("Le mot de passe doit contenir au moins 8 caractères");
    }
    updated.passwordHash = hashPassword(input.password);
  }

  store.users[existingIndex] = updated;
  await writeStore(store);
  return toManagedUserView(updated);
}

export async function deleteManagedUser(username: string): Promise<void> {
  const normalized = normalizeUsername(username);
  const envAdmin = getEnvAdminUsername();
  if (envAdmin && normalized === envAdmin) {
    throw new Error("Le compte administrateur principal ne peut pas être supprimé");
  }

  const store = await readStore();
  const nextUsers = store.users.filter((record) => record.username !== normalized);
  if (nextUsers.length === store.users.length) {
    return;
  }
  store.users = nextUsers;
  await writeStore(store);
}

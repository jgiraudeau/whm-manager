import path from "node:path";
import { cpanelApi, cpanelApi2, getCPanelSessionData } from "@/lib/whm";
import {
  listSoftaculousInstallationsForUser,
  resolveInstallationByRef,
  type SoftaculousInstallationSummary,
} from "@/lib/softaculous-client";
import { normalizeHost } from "@/lib/softaculous";

type UnknownRecord = Record<string, unknown>;

interface SessionContext {
  user: string;
  baseUrl: string;
  cookie: string;
}

interface FallbackCloneInput {
  sourceAccount: string;
  destinationAccount: string;
  sourceInstallationId: string;
  destinationSubdomain: string;
  destinationDomain: string;
  sourceUrl: string;
  targetUrl: string;
}

interface FallbackRuntimeControl {
  shouldAbort?: () => Promise<boolean> | boolean;
}

interface DbProvisioningResult {
  database: string;
  user: string;
  password: string;
}

export interface WordPressFallbackCloneResult {
  sourcePath: string;
  destinationPath: string;
  copiedFiles: number;
  copiedDirectories: number;
  copiedBytes: number;
  destinationDatabase: string;
  destinationDatabaseUser: string;
}

interface WordPressDbSourceConfig {
  database: string;
  user: string;
  password: string;
  host: string;
  tablePrefix: string;
}

interface FileEntry {
  type: string;
  file: string;
  fullpath: string;
  size?: string | number;
}

interface UploadStrategy {
  label: string;
  endpoint: string;
  form: FormData;
}

interface FetchInsecureOptions {
  timeoutMs?: number;
  attempts?: number;
}

const SKIP_RELATIVE_PREFIXES = [
  "wp-content/ai1wm-backups/",
  "wp-content/updraft/",
  "wp-content/cache/",
  "wp-content/litespeed/",
  "wp-content/wflogs/",
  "wp-content/debug.log",
  "error_log",
];

const MAX_FILES_TO_COPY = 6000;
const MAX_BYTES_TO_COPY = 1024 * 1024 * 1024; // 1 GiB
export const MIGRATION_ABORTED_ERROR = "MIGRATION_ABORTED_BY_USER";
const DEFAULT_FETCH_TIMEOUT_MS = 90_000;
const FILE_TRANSFER_BASE_TIMEOUT_MS = 180_000;
const FILE_TRANSFER_MAX_TIMEOUT_MS = 15 * 60 * 1000;
const FILE_TRANSFER_TIMEOUT_PER_MB_MS = 2_500;
const HEARTBEAT_LOG_INTERVAL_MS = 45_000;

function asRecord(value: unknown): UnknownRecord | null {
  if (typeof value === "object" && value !== null) {
    return value as UnknownRecord;
  }
  return null;
}

function normalizeDirPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function normalizeRelativePath(input: string): string {
  return input.replace(/^\/+/, "").replace(/\\/g, "/");
}

function shouldSkipRelative(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  if (!normalized) return false;
  return SKIP_RELATIVE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
}

function randomToken(size = 16): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSizeBytes(size: string | number | undefined): number | undefined {
  if (typeof size === "number") {
    return Number.isFinite(size) && size >= 0 ? size : undefined;
  }
  if (typeof size === "string") {
    const normalized = size.replace(/,/g, "").trim();
    if (!normalized) return undefined;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function computeTransferTimeoutMs(sizeBytes?: number): number {
  if (!sizeBytes || sizeBytes <= 0) {
    return FILE_TRANSFER_BASE_TIMEOUT_MS;
  }
  const sizeMb = sizeBytes / (1024 * 1024);
  const dynamic = FILE_TRANSFER_BASE_TIMEOUT_MS + Math.ceil(sizeMb) * FILE_TRANSFER_TIMEOUT_PER_MB_MS;
  return Math.max(FILE_TRANSFER_BASE_TIMEOUT_MS, Math.min(FILE_TRANSFER_MAX_TIMEOUT_MS, dynamic));
}

function formatSizeMiB(sizeBytes?: number): string {
  if (!sizeBytes || sizeBytes <= 0) return "taille inconnue";
  return `${Math.round((sizeBytes / 1024 / 1024) * 10) / 10} MiB`;
}

function formatFetchError(url: string, error: unknown): string {
  if (!(error instanceof Error)) {
    return `fetch failed (${url})`;
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  let details = error.message || "fetch failed";
  if (cause && typeof cause === "object") {
    const record = cause as UnknownRecord;
    const code = typeof record.code === "string" ? record.code : "";
    const hostname = typeof record.hostname === "string" ? record.hostname : "";
    if (code && hostname) {
      details = `${details} [${code} ${hostname}]`;
    } else if (code) {
      details = `${details} [${code}]`;
    }
  }

  try {
    const host = new URL(url).host;
    return `${details} (url host: ${host})`;
  } catch {
    return `${details} (url: ${url})`;
  }
}

function sanitizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function parseWordPressConfigFromSoftaculous(
  installation: SoftaculousInstallationSummary,
): WordPressDbSourceConfig {
  const raw = asRecord(installation.raw);
  const database = typeof raw?.softdb === "string" ? raw.softdb : "";
  const user = typeof raw?.softdbuser === "string" ? raw.softdbuser : "";
  const password = typeof raw?.softdbpass === "string" ? raw.softdbpass : "";
  const host = typeof raw?.softdbhost === "string" ? raw.softdbhost : "localhost";
  const tablePrefix = typeof raw?.dbprefix === "string" ? raw.dbprefix : "wp_";

  if (!database || !user || !password) {
    throw new Error("Softaculous n'a pas fourni les identifiants DB de la source");
  }

  return {
    database,
    user,
    password,
    host: host || "localhost",
    tablePrefix: tablePrefix || "wp_",
  };
}

async function fetchInsecure(
  url: string,
  init?: RequestInit,
  options?: FetchInsecureOptions,
): Promise<Response> {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const attempts = Math.max(1, options?.attempts ?? 3);
  const timeoutMs = Math.max(5_000, options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  let lastError: unknown = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(`timeout ${timeoutMs}ms`), timeoutMs);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } catch (error: unknown) {
        const isTimeout = controller.signal.aborted;
        const reason = isTimeout ? `timeout ${timeoutMs}ms` : error instanceof Error ? error.message : "fetch failed";
        lastError = new Error(`Tentative ${attempt}/${attempts}: ${reason}`, {
          cause: error instanceof Error ? error : undefined,
        });
        if (attempt < attempts) {
          await sleep(250 * attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(formatFetchError(url, lastError), {
      cause: lastError instanceof Error ? lastError : undefined,
    });
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  }
}

async function createSessionContext(user: string): Promise<SessionContext> {
  const session = await getCPanelSessionData(user);
  if (!session.cookie) {
    throw new Error(`Impossible d'obtenir le cookie cPanel pour ${user}`);
  }

  return {
    user,
    baseUrl: `https://${session.host}:2083/${session.cpsess}`,
    cookie: session.cookie,
  };
}

async function executeCpanelJson(
  session: SessionContext,
  module: string,
  func: string,
  params: Record<string, string> = {},
): Promise<UnknownRecord> {
  const url = new URL(`${session.baseUrl}/execute/${module}/${func}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetchInsecure(url.toString(), {
    headers: { Cookie: session.cookie },
  });
  const text = await res.text();
  let parsed: UnknownRecord | null = null;
  try {
    parsed = JSON.parse(text) as UnknownRecord;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    throw new Error(`Réponse cPanel invalide (${module}/${func})`);
  }

  const status = parsed.status;
  if (status !== 1) {
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((item): item is string => typeof item === "string")
      : [];
    throw new Error(errors[0] ?? `Erreur cPanel ${module}/${func}`);
  }

  return parsed;
}

async function listDirectoryEntries(session: SessionContext, absoluteDir: string): Promise<FileEntry[]> {
  const payload = await executeCpanelJson(session, "Fileman", "list_files", {
    dir: absoluteDir,
    show_hidden: "1",
  });
  const entries = Array.isArray(payload.data) ? payload.data : [];
  const out: FileEntry[] = [];
  for (const item of entries) {
    const record = asRecord(item);
    if (!record) continue;

    const type = typeof record.type === "string" ? record.type : "";
    const file = typeof record.file === "string" ? record.file : "";
    const fullpath = typeof record.fullpath === "string" ? record.fullpath : "";
    if (!type || !file || !fullpath) continue;

    out.push({
      type,
      file,
      fullpath,
      size: typeof record.size === "string" || typeof record.size === "number" ? record.size : undefined,
    });
  }
  return out;
}

async function downloadSourceFile(
  session: SessionContext,
  absolutePath: string,
  expectedSizeBytes?: number,
): Promise<ArrayBuffer> {
  // Use UAPI Fileman::get_file_content — returns base64 content, avoids viewer path encoding issues
  const timeoutMs = computeTransferTimeoutMs(expectedSizeBytes);
  const url = new URL(`${session.baseUrl}/execute/Fileman/get_file_content`);
  url.searchParams.set("file", absolutePath);
  const res = await fetchInsecure(url.toString(), {
    headers: { Cookie: session.cookie },
  }, { timeoutMs });
  if (!res.ok) {
    throw new Error(`Lecture source impossible (${absolutePath}) — HTTP ${res.status}`);
  }
  const json = await res.json() as Record<string, unknown>;
  const result = (json?.result ?? json) as Record<string, unknown>;
  if (result?.status === 0 || result?.status === "0") {
    const errs = Array.isArray(result?.errors) ? (result.errors as string[]) : [];
    const msgs = Array.isArray(result?.messages) ? (result.messages as string[]) : [];
    throw new Error(`Lecture source impossible (${absolutePath}) — ${errs[0] ?? msgs[0] ?? "erreur inconnue"}`);
  }
  const b64 = (result?.data as Record<string, unknown>)?.content as string ?? result?.content as string;
  if (!b64) {
    throw new Error(`Lecture source impossible (${absolutePath}) — contenu vide ou format inattendu`);
  }
  // Decode base64 to ArrayBuffer
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function uploadDestinationFile(
  session: SessionContext,
  destinationDir: string,
  fileName: string,
  content: BlobPart,
  expectedSizeBytes?: number,
): Promise<void> {
  const normalizedDir = normalizeDirPath(destinationDir);
  const homePrefix = `/home/${session.user}`;
  const relativeDir = normalizedDir === homePrefix
    ? "."
    : normalizedDir.startsWith(`${homePrefix}/`)
      ? normalizedDir.slice(homePrefix.length + 1)
      : normalizedDir.replace(/^\/+/, "") || ".";

  const buildForm = (fileField: "file" | "file-1", includeDirField: boolean): FormData => {
    const form = new FormData();
    if (includeDirField) {
      form.append("dir", relativeDir);
      form.append("overwrite", "1");
    }
    form.append(fileField, new Blob([content]), fileName);
    return form;
  };

  const strategies: UploadStrategy[] = [
    {
      // cPanel guide: multipart payload with dir + file-1 fields.
      label: "dir+file-1",
      endpoint: `${session.baseUrl}/execute/Fileman/upload_files`,
      form: buildForm("file-1", true),
    },
    {
      // cURL examples often use `file` as upload field.
      label: "dir+file",
      endpoint: `${session.baseUrl}/execute/Fileman/upload_files`,
      form: buildForm("file", true),
    },
    {
      // Backward-compat with previous behavior.
      label: "query-dir+file",
      endpoint: `${session.baseUrl}/execute/Fileman/upload_files?dir=${encodeURIComponent(normalizedDir)}&overwrite=1`,
      form: buildForm("file", false),
    },
  ];

  const timeoutMs = computeTransferTimeoutMs(expectedSizeBytes);
  
  const executeStrategies = async () => {
    const strategyErrors: string[] = [];
    for (const strategy of strategies) {
      try {
        const res = await fetchInsecure(strategy.endpoint, {
          method: "POST",
          headers: { Cookie: session.cookie },
          body: strategy.form,
        }, { timeoutMs });
        const text = await res.text();
        let parsed: UnknownRecord | null = null;
        try {
          parsed = JSON.parse(text) as UnknownRecord;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          throw new Error(`Réponse non JSON (HTTP ${res.status})`);
        }

        const payload = asRecord(parsed.result) ?? parsed;
        const statusValue = payload.status;
        const isSuccess = statusValue === 1 || statusValue === "1" || statusValue === true;
        if (!isSuccess) {
          const errors = Array.isArray(payload.errors)
            ? payload.errors.filter((item): item is string => typeof item === "string")
            : [];
          const messages = Array.isArray(payload.messages)
            ? payload.messages.filter((item): item is string => typeof item === "string")
            : [];
          throw new Error(errors[0] ?? messages[0] ?? `status=${String(statusValue ?? "unknown")}`);
        }
        
        const payloadData = asRecord(payload.data);
        if (Array.isArray(payloadData?.uploads)) {
          for (const item of payloadData.uploads) {
             const uploadResult = asRecord(item);
             if (uploadResult?.status === 0 || uploadResult?.status === "0") {
                 throw new Error(String(uploadResult.reason || "internal upload error"));
             }
          }
        }

        return;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : "erreur inconnue";
        strategyErrors.push(`${strategy.label}: ${detail}`);
      }
    }

    throw new Error(
      `Upload échoué (${fileName}) vers ${relativeDir}: ${strategyErrors.join(" | ")}`.slice(0, 700),
    );
  };

  try {
    await executeStrategies();
  } catch (error) {
    try {
      await unlinkFile(session.user, `${normalizedDir}/${fileName}`);
    } catch {
      // ignore
    }
    await executeStrategies();
  }
}

function parseApi2Error(data: unknown): string {
  const root = asRecord(data);
  const cpanelResult = asRecord(root?.cpanelresult);
  if (!cpanelResult) return "";
  const error = cpanelResult.error;
  if (typeof error === "string") return error;
  
  if (Array.isArray(cpanelResult.data)) {
      const first = asRecord(cpanelResult.data[0]);
      if (first && (first.status === 0 || first.status === "0" || first.result === 0 || first.result === "0")) {
          return String(first.statusmsg || first.reason || first.error || "Erreur interne API2");
      }
  }
  
  const event = asRecord(cpanelResult.event);
  if (event && (event.result === 0 || event.result === "0")) {
      if (typeof event.reason === "string") return event.reason;
  }
  return "";
}

function isDirectoryAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already exists") ||
    normalized.includes("existe déjà") ||
    normalized.includes("file exists")
  );
}

async function directoryExistsInParent(
  destinationUser: string,
  parentDir: string,
  directoryName: string,
): Promise<boolean> {
  const payload = await cpanelApi(destinationUser, "Fileman", "list_files", {
    dir: parentDir,
    show_hidden: "1",
  });

  const root = asRecord(payload);
  const result = asRecord(root?.result);
  const metadata = asRecord(result?.metadata);
  if (metadata?.result === 0) {
    return false;
  }

  const entries = Array.isArray(result?.data) ? result?.data : [];
  return entries.some((item) => {
    const entry = asRecord(item);
    return entry?.file === directoryName && entry?.type === "dir";
  });
}

async function ensureDirectory(destinationUser: string, absoluteDir: string): Promise<void> {
  const normalized = normalizeDirPath(absoluteDir);
  const expectedPrefix = `/home/${destinationUser}`;
  if (!normalized.startsWith(expectedPrefix)) {
    throw new Error(`Chemin destination invalide: ${normalized}`);
  }

  const suffix = normalized.slice(expectedPrefix.length).replace(/^\/+/, "");
  if (!suffix) return;

  let current = expectedPrefix;
  const segments = suffix.split("/").filter(Boolean);
  for (const segment of segments) {
    const result = await cpanelApi2(destinationUser, "Fileman", "mkdir", {
      path: current,
      name: segment,
    });
    const rawError = parseApi2Error(result);
    const error = rawError.toLowerCase();
    if (error) {
      if (isDirectoryAlreadyExistsError(rawError)) {
        current = `${current}/${segment}`;
        continue;
      }

      const exists = await directoryExistsInParent(destinationUser, current, segment);
      if (exists) {
        current = `${current}/${segment}`;
        continue;
      }

      throw new Error(`Impossible de créer le dossier ${current}/${segment}: ${rawError}`);
    }
    current = `${current}/${segment}`;
  }
}

async function unlinkFile(user: string, absolutePath: string): Promise<void> {
  const result = await cpanelApi2(user, "Fileman", "fileop", {
    op: "unlink",
    sourcefiles: absolutePath,
  });
  const error = parseApi2Error(result);
  if (error && !error.toLowerCase().includes("no such file") && !error.toLowerCase().includes("introuvable")) {
    throw new Error(`Suppression impossible (${absolutePath}): ${error}`);
  }
}

function buildDbNames(prefix: string, hint: string, maxDbLength: number, maxUserLength: number): {
  database: string;
  user: string;
} {
  const suffix = randomToken(4);
  const cleanHint = sanitizeName(hint).replace(/^_+/, "");
  const maxDbShort = Math.max(1, maxDbLength - prefix.length - suffix.length - 1);
  const maxUserShort = Math.max(1, maxUserLength - prefix.length - suffix.length - 1);
  const shortDb = `${cleanHint.slice(0, maxDbShort)}_${suffix}`.slice(0, maxDbShort + suffix.length + 1);
  const shortUser = `${cleanHint.slice(0, maxUserShort)}_${suffix}`.slice(0, maxUserShort + suffix.length + 1);
  return {
    database: `${prefix}${shortDb}`.slice(0, maxDbLength),
    user: `${prefix}${shortUser}`.slice(0, maxUserLength),
  };
}

function generateDbPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*_+-=";
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function throwIfAborted(control?: FallbackRuntimeControl): Promise<void> {
  const shouldAbort = await control?.shouldAbort?.();
  if (shouldAbort) {
    throw new Error(MIGRATION_ABORTED_ERROR);
  }
}

async function createDestinationDatabase(
  session: SessionContext,
  hint: string,
): Promise<DbProvisioningResult> {
  const restrictionsPayload = await executeCpanelJson(session, "Mysql", "get_restrictions");
  const restrictions = asRecord(restrictionsPayload.data);
  const prefix = typeof restrictions?.prefix === "string" ? restrictions.prefix : `${session.user}_`;
  const maxDbLengthRaw = restrictions?.max_database_name_length;
  const maxUserLengthRaw = restrictions?.max_username_length;
  const maxDbLength =
    typeof maxDbLengthRaw === "number"
      ? maxDbLengthRaw
      : typeof maxDbLengthRaw === "string" && Number.isFinite(Number(maxDbLengthRaw))
        ? Number(maxDbLengthRaw)
        : 64;
  const maxUserLength =
    typeof maxUserLengthRaw === "number"
      ? maxUserLengthRaw
      : typeof maxUserLengthRaw === "string" && Number.isFinite(Number(maxUserLengthRaw))
        ? Number(maxUserLengthRaw)
        : 47;

  const names = buildDbNames(prefix, hint, maxDbLength, maxUserLength);
  const password = generateDbPassword();

  await executeCpanelJson(session, "Mysql", "create_database", { name: names.database });
  await executeCpanelJson(session, "Mysql", "create_user", {
    name: names.user,
    password,
  });
  await executeCpanelJson(session, "Mysql", "set_privileges_on_database", {
    user: names.user,
    database: names.database,
    privileges: "ALL PRIVILEGES",
  });

  return {
    database: names.database,
    user: names.user,
    password,
  };
}

function buildWordPressDbClonePhp(
  token: string,
  sourceConfig: WordPressDbSourceConfig,
  destinationDb: DbProvisioningResult,
  targetUrl: string,
): string {
  const configPayload = Buffer.from(
    JSON.stringify({
      source: sourceConfig,
      destination: {
        database: destinationDb.database,
        user: destinationDb.user,
        password: destinationDb.password,
        host: sourceConfig.host || "localhost",
      },
      targetUrl,
      tablePrefix: sourceConfig.tablePrefix || "wp_",
    }),
    "utf8",
  ).toString("base64");

  return `<?php
header('Content-Type: application/json; charset=utf-8');
@set_time_limit(0);
@ini_set('memory_limit', '1024M');
mysqli_report(MYSQLI_REPORT_OFF);

function fail_json($message, $code = 500) {
    http_response_code($code);
    echo json_encode(['success' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

$token = $_GET['token'] ?? '';
if ($token !== ${JSON.stringify(token)}) {
    fail_json('forbidden', 403);
}

$rawConfig = base64_decode(${JSON.stringify(configPayload)}, true);
if ($rawConfig === false) {
    fail_json('invalid migration config (base64)');
}
$config = json_decode($rawConfig, true);
if (!is_array($config)) {
    fail_json('invalid migration config (json)');
}

$src = $config['source'] ?? [];
$dst = $config['destination'] ?? [];
$targetUrl = (string)($config['targetUrl'] ?? '');
$tablePrefix = (string)($config['tablePrefix'] ?? 'wp_');

$srcDb = @new mysqli((string)($src['host'] ?? 'localhost'), (string)($src['user'] ?? ''), (string)($src['password'] ?? ''), (string)($src['database'] ?? ''));
if ($srcDb->connect_error) {
    fail_json('Source DB connection failed: ' . $srcDb->connect_error);
}
$dstDb = @new mysqli((string)($dst['host'] ?? 'localhost'), (string)($dst['user'] ?? ''), (string)($dst['password'] ?? ''), (string)($dst['database'] ?? ''));
if ($dstDb->connect_error) {
    fail_json('Destination DB connection failed: ' . $dstDb->connect_error);
}
$srcDb->set_charset('utf8mb4');
$dstDb->set_charset('utf8mb4');
$dstDb->query('SET foreign_key_checks = 0');

$tablesRes = $srcDb->query('SHOW FULL TABLES');
if (!$tablesRes) {
    fail_json('Unable to list source tables: ' . $srcDb->error);
}

$tables = [];
while ($row = $tablesRes->fetch_array(MYSQLI_NUM)) {
    if (!isset($row[0])) continue;
    $tables[] = [(string)$row[0], strtoupper((string)($row[1] ?? 'BASE TABLE'))];
}

$copiedRows = 0;

foreach ($tables as $tableInfo) {
    $table = $tableInfo[0];
    $kind = $tableInfo[1];
    $tableEsc = '\`' . str_replace('\`', '\`\`', $table) . '\`';

    if ($kind === 'VIEW') {
        $dstDb->query('DROP VIEW IF EXISTS ' . $tableEsc);
    } else {
        $dstDb->query('DROP TABLE IF EXISTS ' . $tableEsc);
    }

    $createRes = $srcDb->query('SHOW CREATE TABLE ' . $tableEsc);
    if (!$createRes) {
        fail_json('SHOW CREATE TABLE failed for ' . $table . ': ' . $srcDb->error);
    }
    $createRow = $createRes->fetch_assoc();
    $createSql = $createRow['Create Table'] ?? $createRow['Create View'] ?? null;
    if (!$createSql) {
        fail_json('Unable to read CREATE statement for ' . $table);
    }
    if (!$dstDb->query($createSql)) {
        fail_json('Create failed for ' . $table . ': ' . $dstDb->error);
    }

    if ($kind === 'VIEW') {
        continue;
    }

    $rowsRes = $srcDb->query('SELECT * FROM ' . $tableEsc, MYSQLI_USE_RESULT);
    if (!$rowsRes) {
        fail_json('SELECT failed for ' . $table . ': ' . $srcDb->error);
    }

    $fields = $rowsRes->fetch_fields();
    $columnSqlParts = [];
    foreach ($fields as $field) {
        $columnSqlParts[] = '\`' . str_replace('\`', '\`\`', (string)$field->name) . '\`';
    }
    $columnSql = implode(',', $columnSqlParts);

    $batch = [];
    $batchLimit = 200;
    while ($row = $rowsRes->fetch_assoc()) {
        $values = [];
        foreach ($fields as $field) {
            $name = (string)$field->name;
            $value = $row[$name] ?? null;
            if ($value === null) {
                $values[] = 'NULL';
            } else {
                $values[] = \"'\" . $dstDb->real_escape_string((string)$value) . \"'\";
            }
        }
        $batch[] = '(' . implode(',', $values) . ')';
        if (count($batch) >= $batchLimit) {
            $insertSql = 'INSERT INTO ' . $tableEsc . ' (' . $columnSql . ') VALUES ' . implode(',', $batch);
            if (!$dstDb->query($insertSql)) {
                fail_json('INSERT failed for ' . $table . ': ' . $dstDb->error);
            }
            $copiedRows += count($batch);
            $batch = [];
        }
    }
    if (!empty($batch)) {
        $insertSql = 'INSERT INTO ' . $tableEsc . ' (' . $columnSql . ') VALUES ' . implode(',', $batch);
        if (!$dstDb->query($insertSql)) {
            fail_json('INSERT (final batch) failed for ' . $table . ': ' . $dstDb->error);
        }
        $copiedRows += count($batch);
    }
    $rowsRes->close();
}

$dstDb->query('SET foreign_key_checks = 1');

$prefix = preg_replace('/[^A-Za-z0-9_]/', '', $tablePrefix);
if ($prefix === '') {
    $prefix = 'wp_';
}
$optionsTableEsc = '\`' . str_replace('\`', '\`\`', $prefix . 'options') . '\`';
$targetUrlEsc = $dstDb->real_escape_string($targetUrl);
$dstDb->query(\"UPDATE \" . $optionsTableEsc . \" SET option_value='\" . $targetUrlEsc . \"' WHERE option_name IN ('siteurl','home')\");

echo json_encode([
    'success' => true,
    'tables' => count($tables),
    'rows' => $copiedRows,
], JSON_UNESCAPED_UNICODE);
`;
}

function replaceWordPressDefine(content: string, key: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const defineRegex = new RegExp(`define\\(\\s*['"]${key}['"]\\s*,\\s*['"][^'"]*['"]\\s*\\);`);
  if (!defineRegex.test(content)) {
    throw new Error(`Constante ${key} introuvable dans wp-config.php`);
  }
  return content.replace(defineRegex, `define( '${key}', '${escaped}' );`);
}

async function updateDestinationWpConfig(
  destinationSession: SessionContext,
  destinationDir: string,
  destinationDb: DbProvisioningResult,
  dbHost: string,
): Promise<void> {
  const payload = await executeCpanelJson(destinationSession, "Fileman", "get_file_content", {
    dir: destinationDir,
    file: "wp-config.php",
  });
  const data = asRecord(payload.data);
  const currentContent = typeof data?.content === "string" ? data.content : "";
  if (!currentContent) {
    throw new Error("wp-config.php introuvable sur la destination après copie");
  }

  let nextContent = currentContent;
  nextContent = replaceWordPressDefine(nextContent, "DB_NAME", destinationDb.database);
  nextContent = replaceWordPressDefine(nextContent, "DB_USER", destinationDb.user);
  nextContent = replaceWordPressDefine(nextContent, "DB_PASSWORD", destinationDb.password);
  nextContent = replaceWordPressDefine(nextContent, "DB_HOST", dbHost || "localhost");

  await executeCpanelJson(destinationSession, "Fileman", "save_file_content", {
    dir: destinationDir,
    file: "wp-config.php",
    content: nextContent,
  });
}

function resolveSourceInstallation(
  installations: SoftaculousInstallationSummary[],
  sourceInstallationId: string,
): SoftaculousInstallationSummary {
  const direct = resolveInstallationByRef(installations, sourceInstallationId);
  if (direct) return direct;
  throw new Error("Installation source Softaculous introuvable");
}

function parseDocumentRootEntry(item: unknown): { domain: string; documentRoot: string } | null {
  const entry = asRecord(item);
  if (!entry) return null;
  const domain = typeof entry.domain === "string" ? entry.domain.toLowerCase() : "";
  const documentRoot = typeof entry.documentroot === "string" ? entry.documentroot : "";
  if (!domain || !documentRoot) return null;
  return { domain, documentRoot };
}

async function resolveDestinationDocumentRoot(
  destinationAccount: string,
  targetHost: string,
  fallbackSubdomain: string,
): Promise<string> {
  const domainPayload = await cpanelApi(destinationAccount, "DomainInfo", "domains_data");
  const dataRecord = asRecord(domainPayload);
  const domainData = asRecord(dataRecord?.data ?? asRecord(dataRecord?.result)?.data);

  const subDomains = Array.isArray(domainData?.sub_domains) ? domainData.sub_domains : [];
  for (const item of subDomains) {
    const parsed = parseDocumentRootEntry(item);
    if (parsed && normalizeHost(parsed.domain) === targetHost) {
      return normalizeDirPath(parsed.documentRoot);
    }
  }

  const mainDomain = parseDocumentRootEntry(domainData?.main_domain);
  if (mainDomain && normalizeHost(mainDomain.domain) === targetHost) {
    return normalizeDirPath(mainDomain.documentRoot);
  }

  return `/home/${destinationAccount}/public_html/${fallbackSubdomain}`;
}

async function removeTemporaryScript(sourceAccount: string, sourcePath: string, scriptFileName: string): Promise<void> {
  const scriptPath = `${normalizeDirPath(sourcePath)}/${scriptFileName}`;
  try {
    await unlinkFile(sourceAccount, scriptPath);
  } catch {
    // best effort
  }
}

export async function runWordPressCrossAccountCloneFallback(
  input: FallbackCloneInput,
  onLog?: (message: string) => Promise<void> | void,
  control?: FallbackRuntimeControl,
): Promise<WordPressFallbackCloneResult> {
  await throwIfAborted(control);
  await onLog?.("Fallback: chargement des installations source");
  const sourceInstallations = await listSoftaculousInstallationsForUser(input.sourceAccount);
  const sourceInstallation = resolveSourceInstallation(sourceInstallations, input.sourceInstallationId);

  if (sourceInstallation.app !== "wordpress") {
    throw new Error("Fallback sans backup/restore disponible uniquement pour WordPress");
  }

  const sourcePath = normalizeDirPath(sourceInstallation.path || "");
  if (!sourcePath.startsWith(`/home/${input.sourceAccount}/`)) {
    throw new Error(`Chemin source invalide: ${sourcePath || "(vide)"}`);
  }

  await onLog?.("Fallback: résolution du document root destination");
  const targetHost = normalizeHost(input.targetUrl);
  const destinationPath = normalizeDirPath(
    await resolveDestinationDocumentRoot(input.destinationAccount, targetHost, input.destinationSubdomain),
  );

  await throwIfAborted(control);
  await onLog?.("Fallback: ouverture des sessions cPanel source/destination");
  const sourceSession = await createSessionContext(input.sourceAccount);
  const destinationSession = await createSessionContext(input.destinationAccount);

  await throwIfAborted(control);
  await ensureDirectory(input.destinationAccount, destinationPath);
  await onLog?.(`Fallback phase 2 activé (WordPress): ${sourcePath} -> ${destinationPath}`);

  await onLog?.("Analyse sélective du contenu pour ignorer les lourds dossiers de cache et backups...");
  const rootEntries = await listDirectoryEntries(sourceSession, sourcePath);
  const selectedPaths: string[] = [];

  for (const entry of rootEntries) {
     if (entry.file === "." || entry.file === "..") continue;
     // Exclude giant archives often left at root
     if (entry.file.endsWith(".zip") || entry.file.endsWith(".tar.gz") || entry.file.endsWith(".sql")) continue;
     if (entry.file === "wp-snapshots" || entry.file === ".cache") continue;

     if (entry.file === "wp-content" && entry.type === "dir") {
         const wpContentEntries = await listDirectoryEntries(sourceSession, entry.fullpath);
         for (const wcEntry of wpContentEntries) {
             if (wcEntry.file === "." || wcEntry.file === "..") continue;
             if (wcEntry.file.endsWith(".zip") || wcEntry.file.endsWith(".tar.gz") || wcEntry.file.endsWith(".sql")) continue;
             
             // Crucial: SKIP heavy junk folders
             const skipFolders = ["cache", "updraft", "backups", "upgrade", "wflogs", "wprfc", "debug.log", "et-cache", "litespeed"];
             if (skipFolders.includes(wcEntry.file.toLowerCase())) continue;
             
             selectedPaths.push(wcEntry.fullpath);
         }
     } else {
         selectedPaths.push(entry.fullpath);
     }
  }

  const sourceRelativePaths = selectedPaths.map(p => p.replace(new RegExp(`^/home/${input.sourceAccount}/`), ""));
  const sourceRelativeDir = sourcePath.replace(new RegExp(`^/home/${input.sourceAccount}/`), ""); // e.g. "public_html/wp1"
  const tempZipName = `mgr_fallback_${randomToken(6)}.zip`;
  // Always put the ZIP at account root (~) so the path is unambiguous and easy to download.
  const destZipRelativePath = tempZipName;

  let copiedFiles = selectedPaths.length; // Approximate
  let copiedDirectories = 1;
  let copiedBytes = 0;

  await onLog?.("Compression cPanel: création de l'archive ZIP optimisée (sans cache/backup)...");
  
  // Perform chunked compression if needed, but usually ~50 items is totally fine for cPanel.
  const compressRes = await cpanelApi2(input.sourceAccount, "Fileman", "fileop", {
    op: "compress",
    metadata: "zip",
    sourcefiles: sourceRelativePaths.join(","), 
    destfiles: destZipRelativePath, 
    dir: `/home/${input.sourceAccount}`,
    doubledecode: "1"
  });
  const compressErr = parseApi2Error(compressRes);
  if (compressErr) throw new Error(`cPanel Compress API2 erreur: ${compressErr}`);

  await onLog?.("Archive prête ! Téléchargement vers le noeud de migration...");
  const zipBuffer = await downloadSourceFile(
    sourceSession, 
    `/home/${input.sourceAccount}/${destZipRelativePath}`, 
    250 * 1024 * 1024
  );
  await onLog?.(`Archive téléchargée (${formatSizeMiB(zipBuffer.byteLength)}). Transférée...`);

  await onLog?.("Envoi de l'archive vers le serveur de destination...");
  await uploadDestinationFile(
    destinationSession, 
    destinationPath, 
    tempZipName, 
    zipBuffer, 
    zipBuffer.byteLength
  );
  copiedBytes = zipBuffer.byteLength;

  await onLog?.("Extraction cPanel: décompression de l'archive ZIP...");
  const destRelativeDir = destinationPath.replace(new RegExp(`^/home/${input.destinationAccount}/`), ""); 
  const extractRes = await cpanelApi2(input.destinationAccount, "Fileman", "fileop", {
    op: "extract",
    sourcefiles: `${destRelativeDir}/${tempZipName}`,
    destfiles: destRelativeDir,
    doubledecode: "1"
  });
  const extractErr = parseApi2Error(extractRes);
  if (extractErr) throw new Error(`cPanel Extract API2 erreur: ${extractErr}`);

  await onLog?.("Réorganisation des fichiers (déplacement du contenu)...");
  const extractedFolderName = sourceRelativeDir.split('/').filter(Boolean).pop() || "";
  const nestedDirPath = `${destinationPath}/${extractedFolderName}`;
  const nestedEntries = await listDirectoryEntries(destinationSession, nestedDirPath);
  
  if (nestedEntries.length > 0) {
      const moveFiles = nestedEntries
         .filter(e => e.file !== "." && e.file !== "..")
         .map(e => e.fullpath.replace(new RegExp(`^/home/${input.destinationAccount}/`), ""));
         
      const chunksize = 40; 
      for (let i = 0; i < moveFiles.length; i += chunksize) {
         const chunk = moveFiles.slice(i, i + chunksize);
         await cpanelApi2(input.destinationAccount, "Fileman", "fileop", {
             op: "move", 
             sourcefiles: chunk.join(","),
             destfiles: destRelativeDir,
             doubledecode: "1"
         });
      }
      
      try {
         await cpanelApi2(input.destinationAccount, "Fileman", "fileop", {
            op: "unlink", 
            sourcefiles: `${destRelativeDir}/${extractedFolderName}`
         });
      } catch {
         // clean-up ignore
      }
  }

  await onLog?.("Nettoyage des archives temporaires...");
  try {
     await unlinkFile(input.sourceAccount, `/home/${input.sourceAccount}/${tempZipName}`);
  } catch { /* ignore */ }
  try {
     await unlinkFile(input.destinationAccount, `${destinationPath}/${tempZipName}`);
  } catch { /* ignore */ }

  await throwIfAborted(control);
  const sourceDb = parseWordPressConfigFromSoftaculous(sourceInstallation);
  const destinationDb = await createDestinationDatabase(destinationSession, input.destinationSubdomain);
  await onLog?.(`Base destination créée: ${destinationDb.database}`);

  const scriptFileName = `whm_migrate_${randomToken(6)}.php`;
  const scriptToken = randomToken(12);
  const scriptContent = buildWordPressDbClonePhp(scriptToken, sourceDb, destinationDb, input.targetUrl);

  let scriptUploaded = false;
  try {
    await throwIfAborted(control);
    await uploadDestinationFile(sourceSession, sourcePath, scriptFileName, Buffer.from(scriptContent, "utf8"));
    scriptUploaded = true;
    await onLog?.("Script de duplication DB déployé sur la source");

    const sourceUrlBase = input.sourceUrl.replace(/\/+$/, "");
    const triggerUrl = `${sourceUrlBase}/${scriptFileName}?token=${encodeURIComponent(scriptToken)}`;
    const triggerResponse = await fetchInsecure(
      triggerUrl,
      undefined,
      { timeoutMs: 20 * 60 * 1000, attempts: 1 },
    );
    const triggerText = await triggerResponse.text();
    let triggerJson: UnknownRecord | null = null;
    try {
      triggerJson = JSON.parse(triggerText) as UnknownRecord;
    } catch {
      triggerJson = null;
    }

    if (!triggerResponse.ok || !triggerJson || triggerJson.success !== true) {
      const errorMessage =
        (triggerJson && typeof triggerJson.error === "string" && triggerJson.error) ||
        `Script DB HTTP ${triggerResponse.status}`;
      throw new Error(`Duplication DB échouée: ${errorMessage}`);
    }

    await throwIfAborted(control);
    await onLog?.("Duplication DB source -> destination terminée");

    await updateDestinationWpConfig(destinationSession, destinationPath, destinationDb, sourceDb.host || "localhost");
    await onLog?.("wp-config.php destination mis à jour");
  } catch (error) {
    try {
      await executeCpanelJson(destinationSession, "Mysql", "delete_database", { name: destinationDb.database });
    } catch {
      // best effort
    }
    try {
      await executeCpanelJson(destinationSession, "Mysql", "delete_user", { name: destinationDb.user });
    } catch {
      // best effort
    }
    throw error;
  } finally {
    if (scriptUploaded) {
      await removeTemporaryScript(input.sourceAccount, sourcePath, scriptFileName);
    }
  }

  return {
    sourcePath,
    destinationPath,
    copiedFiles,
    copiedDirectories,
    copiedBytes,
    destinationDatabase: destinationDb.database,
    destinationDatabaseUser: destinationDb.user,
  };
}

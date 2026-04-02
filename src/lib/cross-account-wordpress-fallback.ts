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

async function fetchInsecure(url: string, init?: RequestInit): Promise<Response> {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const attempts = 3;
  let lastError: unknown = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetch(url, init);
      } catch (error: unknown) {
        lastError = error;
        if (attempt < attempts) {
          await sleep(250 * attempt);
          continue;
        }
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

function toViewerPath(absolutePath: string): string {
  return encodeURIComponent(absolutePath).replace(/%2F/g, "%2f");
}

async function downloadSourceFile(session: SessionContext, absolutePath: string): Promise<ArrayBuffer> {
  const viewerPath = toViewerPath(absolutePath);
  const res = await fetchInsecure(`${session.baseUrl}/viewer/${viewerPath}`, {
    headers: { Cookie: session.cookie },
  });
  if (!res.ok) {
    throw new Error(`Lecture source impossible (${absolutePath})`);
  }
  return res.arrayBuffer();
}

async function uploadDestinationFile(
  session: SessionContext,
  destinationDir: string,
  fileName: string,
  content: BlobPart,
): Promise<void> {
  const endpoint = `${session.baseUrl}/execute/Fileman/upload_files?dir=${encodeURIComponent(destinationDir)}`;
  const form = new FormData();
  form.append("file", new Blob([content]), fileName);

  const res = await fetchInsecure(endpoint, {
    method: "POST",
    headers: { Cookie: session.cookie },
    body: form,
  });
  const text = await res.text();
  let parsed: UnknownRecord | null = null;
  try {
    parsed = JSON.parse(text) as UnknownRecord;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new Error(`Upload destination invalide (${fileName})`);
  }
  if (parsed.status !== 1) {
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((item): item is string => typeof item === "string")
      : [];
    throw new Error(errors[0] ?? `Upload échoué (${fileName})`);
  }
}

function parseApi2Error(data: unknown): string {
  const root = asRecord(data);
  const cpanelResult = asRecord(root?.cpanelresult);
  if (!cpanelResult) return "";
  const error = cpanelResult.error;
  if (typeof error === "string") return error;
  const event = asRecord(cpanelResult.event);
  if (typeof event?.reason === "string") return event.reason;
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

  const stack: Array<{ sourceDir: string; destinationDir: string }> = [
    { sourceDir: sourcePath, destinationDir: destinationPath },
  ];

  let copiedFiles = 0;
  let copiedDirectories = 0;
  let copiedBytes = 0;

  while (stack.length > 0) {
    await throwIfAborted(control);
    const current = stack.pop();
    if (!current) break;

    const entries = await listDirectoryEntries(sourceSession, current.sourceDir);
    for (const entry of entries) {
      await throwIfAborted(control);
      const relative = normalizeRelativePath(
        entry.fullpath.startsWith(`${sourcePath}/`)
          ? entry.fullpath.slice(sourcePath.length + 1)
          : path.posix.basename(entry.fullpath),
      );
      if (shouldSkipRelative(relative)) {
        continue;
      }

      if (entry.type === "dir") {
        const childDestination = `${current.destinationDir}/${entry.file}`;
        await ensureDirectory(input.destinationAccount, childDestination);
        stack.push({
          sourceDir: entry.fullpath,
          destinationDir: childDestination,
        });
        copiedDirectories += 1;
        if (copiedDirectories % 50 === 0) {
          await onLog?.(`Dossiers copiés: ${copiedDirectories}`);
        }
        continue;
      }

      if (entry.type !== "file") continue;

      if (copiedFiles >= MAX_FILES_TO_COPY) {
        throw new Error(`Limite de sécurité atteinte: ${MAX_FILES_TO_COPY} fichiers`);
      }
      if (copiedBytes >= MAX_BYTES_TO_COPY) {
        throw new Error("Limite de sécurité atteinte: 1 GiB de fichiers");
      }

      const content = await downloadSourceFile(sourceSession, entry.fullpath);
      await uploadDestinationFile(destinationSession, current.destinationDir, entry.file, content);

      copiedFiles += 1;
      copiedBytes += content.byteLength;

      if (copiedFiles % 100 === 0) {
        await onLog?.(
          `Fichiers copiés: ${copiedFiles} (${Math.round((copiedBytes / 1024 / 1024) * 10) / 10} MiB)`,
        );
      }
    }
  }

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
    const triggerResponse = await fetchInsecure(triggerUrl);
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

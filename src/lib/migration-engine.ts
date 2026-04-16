/**
 * Migration Engine — Twin PHP Agents (P2P)
 *
 * Flow:
 * 1. Deploy whm-packer.php on source cPanel account (via UAPI Fileman upload)
 * 2. Call the packer to create a ZIP + SQL dump → gets a signed download token
 * 3. Deploy whm-unpacker.php on target cPanel account
 * 4. Call the unpacker — it downloads the ZIP directly from source (P2P via cURL)
 *    then extracts, imports SQL, patches wp-config.php
 * 5. Cleanup both agents
 */

import { cpanelApi } from "@/lib/whm";
import { appendMigrationLog, updateMigrationTarget } from "@/lib/migration-store";
import type { AppType } from "@/lib/migration-store";

// ─── Utilities ────────────────────────────────────────────────────────────────

function randomToken(length = 32): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5 * 60 * 1000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── cPanel file upload helper ────────────────────────────────────────────────

/**
 * Upload a text file to a cPanel account via UAPI Fileman.
 * Destination dir must already exist (usually the docroot).
 */
async function uploadFileToCpanel(
  user: string,
  destDir: string,
  fileName: string,
  content: string,
): Promise<void> {
  // cPanel Fileman expects home-relative paths (e.g. public_html/foo), not absolute paths
  const relDir = toHomeRelative(user, destDir);
  const result = await cpanelApi(user, "Fileman", "save_file_content", {
    dir: relDir,
    file: fileName,
    content,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errors = (result as any)?.result?.errors ?? (result as any)?.data?.result?.errors;
  if (errors && Array.isArray(errors) && errors.length > 0) {
    throw new Error(`cPanel upload error: ${errors[0]}`);
  }

  // Set permissions to 0644 to ensure it's readable and executable by the webserver
  try {
    await cpanelApi(user, "Fileman", "set_file_perms", {
      dir: destDir,
      file: fileName,
      perms: "0755",
    });
  } catch {
    // ignore if fails
  }
}

function splitPath(fullPath: string) {
  const sanitized = fullPath.replace(/\/+$/, "");
  const lastSlashIndex = sanitized.lastIndexOf("/");
  if (lastSlashIndex === -1) return { dir: "", name: sanitized };
  return {
    dir: sanitized.slice(0, lastSlashIndex),
    name: sanitized.slice(lastSlashIndex + 1),
  };
}

/**
 * Convert an absolute path to a cPanel home-relative path.
 * cPanel Fileman expects paths relative to the account home dir, not absolute.
 * e.g. /home/user/public_html/foo  →  public_html/foo
 */
function toHomeRelative(user: string, absolutePath: string): string {
  const prefix = `/home/${user}/`;
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }
  // Already relative or unexpected format — return as-is
  return absolutePath.replace(/^\//, "");
}

/**
 * Create a directory on a cPanel account via UAPI Fileman.
 */
async function createDirectoryCpanel(user: string, path: string): Promise<void> {
  try {
    const relPath = toHomeRelative(user, path);
    const { dir, name } = splitPath(relPath);
    await cpanelApi(user, "Fileman", "mkdir", {
      path: dir,
      name: name,
    });
  } catch {
    // ignore if already exists
  }
}

/**
 * Delete a file or directory from a cPanel account via UAPI Fileman.
 */
async function deleteFromCpanel(user: string, fullPath: string, type: "file" | "dir" = "file"): Promise<void> {
  try {
    const relPath = toHomeRelative(user, fullPath);
    const { dir, name } = splitPath(relPath);
    await cpanelApi(user, "Fileman", "delete_files", {
      "files-0-dir": dir,
      "files-0-file": name,
      "files-0-type": type,
      "files-0-path": relPath,
    });
  } catch {
    // best-effort
  }
}

// ─── PHP Agent templates ──────────────────────────────────────────────────────

/**
 * Generates the PHP "packer" agent.
 *
 * Architecture: chunked HTTP calls — no background process needed.
 * Each action completes well under PHP-FPM request_terminate_timeout (~15s).
 *
 * Web actions:
 *   ?action=pack       → read DB config + mysqldump + enumerate files → write WORK_FILE
 *                        → create ZIP with SQL dump → status {step:'zipping', offset:0, total:N}
 *   ?action=pack_batch → add next batch of files to ZIP → update status offset
 *                        → when offset >= total: status=done
 *   ?action=status     → read STATUS_FILE, return current state
 *   ?action=download   → serve ZIP from home dir
 *   ?action=cleanup    → delete ZIP + status file + work file + self
 */
function buildPackerPhp(token: string, sourceUser: string, sourcePath: string, appType: AppType): string {
  const e = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const escapedToken = e(token);
  const escapedUser = e(sourceUser);
  const escapedPath = e(sourcePath);
  const appLabel = appType === "wordpress" ? "wordpress" : "prestashop";

  return `<?php
// WHM Manager — Packer Agent (auto-generated, chunked mode)
error_reporting(0);
set_time_limit(60);
header('Content-Type: application/json');

define('AGENT_TOKEN', '${escapedToken}');
define('SOURCE_PATH', '${escapedPath}');
define('APP_TYPE',    '${appLabel}');
define('ZIP_NAME',    'whm_pack_' . substr(md5(SOURCE_PATH . AGENT_TOKEN), 0, 8) . '.zip');
define('HOME_DIR',    '/home/${escapedUser}/');
define('ZIP_PATH',    HOME_DIR . ZIP_NAME);
define('SQL_PATH',    HOME_DIR . 'whm_dump_' . substr(md5(AGENT_TOKEN), 0, 8) . '.sql');
define('STATUS_FILE', HOME_DIR . 'whm_status_' . substr(md5(AGENT_TOKEN), 0, 8) . '.json');
define('WORK_FILE',   HOME_DIR . 'whm_work_'   . substr(md5(AGENT_TOKEN), 0, 8) . '.json');
define('BATCH_SIZE',     500);             // theoretical max per call (data-bounded loop stops earlier)
define('MAX_BATCH_BYTES', 10 * 1024 * 1024); // stop when batch reaches 10MB — close() writes this in ~1-2s on NFS
define('MAX_BATCH_SECS',  5.0);            // hard time fallback (pre-read check)

function ws($data) { file_put_contents(STATUS_FILE, json_encode($data)); }

if (!isset($_GET['token']) || $_GET['token'] !== AGENT_TOKEN) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$action = $_GET['action'] ?? 'pack';

// ════════════════════════════════════════════════════════════
// ?action=pack — Step 1: read config + mysqldump + enumerate files
// ════════════════════════════════════════════════════════════
if ($action === 'pack') {
    // Idempotent: if already done or in progress, return current status
    if (file_exists(STATUS_FILE)) {
        $existing = @json_decode(file_get_contents(STATUS_FILE), true);
        $st = $existing['status'] ?? '';
        if (in_array($st, ['zipping', 'done', 'error'], true)) {
            echo json_encode(['started' => true, 'status' => $st,
                'offset' => $existing['offset'] ?? 0, 'total' => $existing['total'] ?? 0]);
            exit;
        }
    }

    ws(['status' => 'running', 'step' => 'reading_config', 'ts' => time()]);

    $dbHost = 'localhost'; $dbName = ''; $dbUser = ''; $dbPass = ''; $tablePrefix = 'wp_';

    if (APP_TYPE === 'wordpress') {
        $cf = SOURCE_PATH . '/wp-config.php';
        if (file_exists($cf)) {
            $c = file_get_contents($cf);
            if (preg_match("/define\\s*\\(\\s*'DB_NAME'\\s*,\\s*'([^']+)'/",     $c, $m)) $dbName      = $m[1];
            if (preg_match("/define\\s*\\(\\s*'DB_USER'\\s*,\\s*'([^']+)'/",     $c, $m)) $dbUser      = $m[1];
            if (preg_match("/define\\s*\\(\\s*'DB_PASSWORD'\\s*,\\s*'([^']+)'/", $c, $m)) $dbPass      = $m[1];
            if (preg_match("/define\\s*\\(\\s*'DB_HOST'\\s*,\\s*'([^']+)'/",     $c, $m)) $dbHost      = $m[1];
            if (preg_match("/\\\\$table_prefix\\s*=\\s*'([^']+)'/",              $c, $m)) $tablePrefix = $m[1];
        }
    } elseif (APP_TYPE === 'prestashop') {
        foreach ([SOURCE_PATH . '/app/config/parameters.php', SOURCE_PATH . '/config/settings.inc.php'] as $pf) {
            if (!file_exists($pf)) continue;
            $c = file_get_contents($pf);
            if (preg_match("/'database_host'\\s*=>\\s*'([^']+)'/",     $c, $m)) $dbHost = $m[1];
            if (preg_match("/'database_name'\\s*=>\\s*'([^']+)'/",     $c, $m)) $dbName = $m[1];
            if (preg_match("/'database_user'\\s*=>\\s*'([^']+)'/",     $c, $m)) $dbUser = $m[1];
            if (preg_match("/'database_password'\\s*=>\\s*'([^']+)'/", $c, $m)) $dbPass = $m[1];
            if (!$dbName) {
                if (preg_match("/_DB_NAME_\\s*,\\s*'([^']+)'/",   $c, $m)) $dbName = $m[1];
                if (preg_match("/_DB_USER_\\s*,\\s*'([^']+)'/",   $c, $m)) $dbUser = $m[1];
                if (preg_match("/_DB_PASSWD_\\s*,\\s*'([^']+)'/", $c, $m)) $dbPass = $m[1];
            }
            if ($dbName) break;
        }
    }

    if (!$dbName || !$dbUser) {
        ws(['status' => 'error', 'error' => 'Cannot read DB credentials from config', 'ts' => time()]);
        echo json_encode(['error' => 'Cannot read DB credentials from config']);
        exit;
    }

    // ── mysqldump
    ws(['status' => 'running', 'step' => 'dumping_db', 'ts' => time()]);
    @unlink(SQL_PATH);
    $dumpCmd = sprintf('mysqldump --single-transaction --quick -h %s -u %s -p%s %s > %s 2>&1',
        escapeshellarg($dbHost), escapeshellarg($dbUser), escapeshellarg($dbPass),
        escapeshellarg($dbName), escapeshellarg(SQL_PATH));
    exec($dumpCmd, $dOut, $dCode);
    if ($dCode !== 0 || !file_exists(SQL_PATH) || filesize(SQL_PATH) < 10) {
        @unlink(SQL_PATH);
        ws(['status' => 'error', 'error' => 'mysqldump failed (code ' . $dCode . '): ' . implode(' ', $dOut), 'ts' => time()]);
        echo json_encode(['error' => 'mysqldump failed (code ' . $dCode . ')']);
        exit;
    }

    // ── Enumerate files (store list in WORK_FILE for chunked processing)
    ws(['status' => 'running', 'step' => 'enumerating_files', 'ts' => time()]);
    $EXCL = ['wp-content/cache', 'wp-content/upgrade', 'var/cache', 'cache', 'var/logs', 'var/sessions'];
    $fileList = [];
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(SOURCE_PATH, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($iter as $file) {
        if ($file->isDir()) continue;
        $fp  = $file->getRealPath();
        if (!$fp || $fp === ZIP_PATH || $fp === SQL_PATH || $fp === STATUS_FILE || $fp === WORK_FILE) continue;
        $rel = ltrim(substr($fp, strlen(SOURCE_PATH)), DIRECTORY_SEPARATOR);
        foreach ($EXCL as $x) { if (strpos($rel, $x) === 0) continue 2; }
        $fileList[] = [$fp, $rel];
    }

    // ── Create ZIP, add SQL dump as first entry (addFromString so close() is bounded)
    @unlink(ZIP_PATH);
    $sqlContent = @file_get_contents(SQL_PATH);
    @unlink(SQL_PATH);
    if ($sqlContent === false || strlen($sqlContent) < 10) {
        ws(['status' => 'error', 'error' => 'Cannot read SQL dump', 'ts' => time()]);
        echo json_encode(['error' => 'Cannot read SQL dump']);
        exit;
    }
    $zip = new ZipArchive();
    if ($zip->open(ZIP_PATH, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        ws(['status' => 'error', 'error' => 'Cannot create ZIP file', 'ts' => time()]);
        echo json_encode(['error' => 'Cannot create ZIP file']);
        exit;
    }
    $zip->addFromString('_whm_export.sql', $sqlContent);
    $zip->setCompressionIndex(0, 0);
    unset($sqlContent);
    $zip->close();

    // ── Save work file with file list + DB info (immutable — never rewritten after this)
    // Offset is tracked separately in STATUS_FILE (small, fast to write on every batch)
    $total = count($fileList);
    file_put_contents(WORK_FILE, json_encode([
        'files'       => $fileList,
        'dbName'      => $dbName,
        'dbHost'      => $dbHost,
        'tablePrefix' => $tablePrefix,
    ]));

    ws(['status' => 'zipping', 'step' => 'creating_zip', 'offset' => 0, 'total' => $total, 'ts' => time()]);
    echo json_encode(['started' => true, 'status' => 'zipping', 'offset' => 0, 'total' => $total]);
    exit;
}

// ════════════════════════════════════════════════════════════
// ?action=pack_batch — Step 2 (repeated): add next batch of files to ZIP
// ════════════════════════════════════════════════════════════
if ($action === 'pack_batch') {
    $batchStartTime = microtime(true); // start timer before ALL I/O (WORK_FILE read included)

    if (!file_exists(WORK_FILE)) {
        // WORK_FILE is deleted on successful completion. If packer was killed by WP scanner
        // right after completing (before the HTTP response was sent), the STATUS_FILE still
        // holds the full done payload — return it so the caller gets the right result.
        $st = file_exists(STATUS_FILE)
            ? (@json_decode(file_get_contents(STATUS_FILE), true) ?? [])
            : [];
        if (($st['status'] ?? '') === 'done') {
            echo json_encode($st);
            exit;
        }
        echo json_encode(['error' => 'Work file not found — call ?action=pack first']);
        exit;
    }

    // Read offset from STATUS_FILE (small, a few KB — fast write/read every batch)
    // WORK_FILE is immutable (written once in pack_init) — avoid rewriting it
    $statusData = file_exists(STATUS_FILE)
        ? (@json_decode(file_get_contents(STATUS_FILE), true) ?? [])
        : [];
    $offset = (int)($statusData['offset'] ?? 0);

    $work = @json_decode(file_get_contents(WORK_FILE), true);
    if (!$work || !isset($work['files'])) {
        echo json_encode(['error' => 'Invalid work file']);
        exit;
    }

    $files = $work['files'];
    $total = count($files);

    if ($offset >= $total) {
        // Already done — just finalize
        $zipSize = file_exists(ZIP_PATH) ? filesize(ZIP_PATH) : 0;
        @unlink(WORK_FILE);
        $done = ['status' => 'done', 'zipName' => ZIP_NAME, 'zipSize' => $zipSize,
            'dbName' => $work['dbName'] ?? '', 'dbHost' => $work['dbHost'] ?? 'localhost',
            'tablePrefix' => $work['tablePrefix'] ?? 'wp_',
            'skipped_count' => $skippedCount ?? 0, 'skipped_bytes' => $skippedBytes ?? 0,
            'ts' => time()];
        ws($done);
        echo json_encode($done);
        exit;
    }

    // Open existing ZIP in append mode
    $zip = new ZipArchive();
    if ($zip->open(ZIP_PATH, ZipArchive::CREATE) !== true) {
        ws(['status' => 'error', 'error' => 'Cannot open ZIP for batch append', 'ts' => time()]);
        echo json_encode(['error' => 'Cannot open ZIP for batch append']);
        exit;
    }

    // Strategy: check filesize() BEFORE file_get_contents so we never read
    // a file that alone would overflow the batch budget.
    //
    // Limits per batch call:
    //   MAX_BATCH_BYTES (10MB) — stops before reading a file that would push
    //     total above budget. The very first file is still bounded because
    //     we skip files individually > MAX_BATCH_BYTES.
    //   MAX_BATCH_SECS (5s)    — hard time fallback (pre-read).
    //
    // Files individually > MAX_BATCH_BYTES are split into solo batches:
    //   one file per call, guaranteed ≤ 50MB → ≤ 5s read + 5s write at 10MB/s.
    //   Files > 50MB are skipped.
    $newOffset  = $offset;
    $batchBytes   = 0;
    $skippedBytes = (int)($statusData['skipped_bytes'] ?? 0);
    $skippedCount = (int)($statusData['skipped_count'] ?? 0);
    $batchEnd     = min($offset + BATCH_SIZE, $total);

    for ($i = $offset; $i < $batchEnd; $i++) {
        [$fp, $rel] = $files[$i];
        $newOffset = $i + 1; // always advance

        if (!file_exists($fp)) continue;

        $fileSize = (int)@filesize($fp);
        if ($fileSize <= 0) continue; // empty or unreadable

        // Skip files individually > MAX_BATCH_BYTES — a solo read+write of this file
        // must complete in ~3-4s on shared NFS. At 3MB/s NFS: 10MB read+write = 6s < 15s.
        if ($fileSize > MAX_BATCH_BYTES) {
            $skippedCount++;
            $skippedBytes += $fileSize;
            continue;
        }

        // If batch already has data and this file would overflow → stop, next call handles it
        if ($batchBytes > 0 && $batchBytes + $fileSize > MAX_BATCH_BYTES) break;

        // Time pre-check (only after at least one file has been read)
        if ($batchBytes > 0 && (microtime(true) - $batchStartTime) > MAX_BATCH_SECS) break;

        $content = @file_get_contents($fp);
        if ($content === false) continue;

        $zip->addFromString($rel, $content);
        $zip->setCompressionIndex($zip->numFiles - 1, 0); // CM_STORE
        $batchBytes += $fileSize;
        unset($content);

        // If first file was already at/above budget, stop here (solo large-file batch)
        if ($batchBytes >= MAX_BATCH_BYTES) break;
    }

    $zip->close(); // writes at most MAX_BATCH_BYTES of data

    if ($newOffset >= $total) {
        // All files added — done!
        $zipSize = file_exists(ZIP_PATH) ? filesize(ZIP_PATH) : 0;
        if ($zipSize < 100) {
            ws(['status' => 'error', 'error' => 'ZIP too small (' . $zipSize . ' bytes)', 'ts' => time()]);
            echo json_encode(['error' => 'ZIP too small (' . $zipSize . ' bytes)']);
            exit;
        }
        @unlink(WORK_FILE);
        $done = ['status' => 'done', 'zipName' => ZIP_NAME, 'zipSize' => $zipSize,
            'dbName' => $work['dbName'] ?? '', 'dbHost' => $work['dbHost'] ?? 'localhost',
            'tablePrefix' => $work['tablePrefix'] ?? 'wp_',
            'skipped_count' => $skippedCount ?? 0, 'skipped_bytes' => $skippedBytes ?? 0,
            'ts' => time()];
        ws($done);
        echo json_encode($done);
    } else {
        // More batches needed — update STATUS only (WORK_FILE is immutable, never rewritten)
        ws(['status' => 'zipping', 'step' => 'creating_zip',
            'offset' => $newOffset, 'total' => $total,
            'skipped_count' => $skippedCount, 'skipped_bytes' => $skippedBytes, 'ts' => time()]);
        echo json_encode(['status' => 'zipping', 'offset' => $newOffset, 'total' => $total,
            'skipped_count' => $skippedCount, 'skipped_bytes' => $skippedBytes]);
    }
    exit;
}

// ── Poll status
if ($action === 'status') {
    $data = file_exists(STATUS_FILE)
        ? (@json_decode(file_get_contents(STATUS_FILE), true) ?? ['status' => 'unknown'])
        : ['status' => 'not_started'];
    echo json_encode($data);
    exit;
}

// ── Download ZIP size (for chunked download by unpacker)
if ($action === 'download_size') {
    if (!file_exists(ZIP_PATH)) {
        http_response_code(404);
        echo json_encode(['error' => 'ZIP not found']);
        exit;
    }
    echo json_encode(['size' => filesize(ZIP_PATH), 'name' => ZIP_NAME]);
    exit;
}

// ── Download ZIP (supports HTTP Range for chunked download)
if ($action === 'download') {
    if (!file_exists(ZIP_PATH)) {
        http_response_code(404);
        echo json_encode(['error' => 'ZIP not found']);
        exit;
    }
    $fileSize = filesize(ZIP_PATH);
    $start = 0;
    $end   = $fileSize - 1;

    if (!empty($_SERVER['HTTP_RANGE'])) {
        preg_match('/bytes=(\d+)-(\d*)/', $_SERVER['HTTP_RANGE'], $rm);
        $start = (int)$rm[1];
        $end   = ($rm[2] !== '') ? (int)$rm[2] : $fileSize - 1;
        $end   = min($end, $fileSize - 1);
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $fileSize);
    }
    $length = $end - $start + 1;
    header('Content-Type: application/zip');
    header('Content-Length: ' . $length);
    header('Accept-Ranges: bytes');
    header('Content-Disposition: attachment; filename="' . ZIP_NAME . '"');
    ob_end_clean();
    $fp = fopen(ZIP_PATH, 'rb');
    fseek($fp, $start);
    $rem = $length;
    while ($rem > 0 && !feof($fp)) {
        $buf = min(65536, $rem);
        echo fread($fp, $buf);
        $rem -= $buf;
        flush();
    }
    fclose($fp);
    exit;
}

// ── Cleanup
if ($action === 'cleanup') {
    @unlink(ZIP_PATH);
    @unlink(STATUS_FILE);
    @unlink(WORK_FILE);
    @unlink(__FILE__);
    echo json_encode(['success' => true, 'action' => 'cleanup']);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Unknown action']);
`;
}

/**
 * Generates the PHP "unpacker" agent — chunked multi-step architecture.
 *
 * Actions (called sequentially by TS orchestrator):
 *   ?action=download_init   → get ZIP size from packer, create local ZIP file
 *   ?action=download_chunk  → fetch 5 MB via cURL Range, append to local ZIP
 *                             Pass &packer_url=... to override when packer was redeployed.
 *   ?action=extract_batch   → extract up to N entries per call (time-bounded, <10s each)
 *   ?action=import_sql      → exec mysql to import _whm_export.sql
 *   ?action=patch_config    → patch wp-config / PrestaShop config + URL search-replace in DB
 *   ?action=cleanup         → delete local ZIP + self-delete + signal packer cleanup
 *
 * The unpacker is deployed to the target account's main public_html (not the subdomain dir)
 * to avoid the subdomain vhost not-yet-ready 502. DEST_PATH is still the subdomain dir.
 */
function buildUnpackerPhp(params: {
  token: string;
  packerUrl: string;
  packerToken: string;
  destPath: string;
  appType: AppType;
  newDbName: string;
  newDbUser: string;
  newDbPass: string;
  newSiteUrl: string;
  oldSiteUrl: string;
  targetUser: string;
}): string {
  const e = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `<?php
error_reporting(0);
set_time_limit(30);
ini_set('memory_limit', '512M');

define('AGENT_TOKEN',  '${e(params.token)}');
define('PACKER_URL',   '${e(params.packerUrl)}');
define('PACKER_TOKEN', '${e(params.packerToken)}');
define('DEST_PATH',    '${e(params.destPath)}');
define('APP_TYPE',     '${params.appType}');
define('NEW_DB_NAME',  '${e(params.newDbName)}');
define('NEW_DB_USER',  '${e(params.newDbUser)}');
define('NEW_DB_PASS',  '${e(params.newDbPass)}');
define('NEW_SITE_URL', '${e(params.newSiteUrl)}');
define('OLD_SITE_URL', '${e(params.oldSiteUrl)}');
define('HOME_DIR',     '/home/${e(params.targetUser)}/');
define('LOCAL_ZIP',    HOME_DIR . 'whm_dl_' . substr(md5(AGENT_TOKEN), 0, 8) . '.zip');
define('DL_CHUNK',     5 * 1024 * 1024); // 5 MB per download chunk

header('Content-Type: application/json');

if (!isset($_GET['token']) || $_GET['token'] !== AGENT_TOKEN) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$action = $_GET['action'] ?? 'download_init';

// ════════════════════════════════════════════════════════════
// ?action=cleanup
// ════════════════════════════════════════════════════════════
if ($action === 'cleanup') {
    @unlink(LOCAL_ZIP);
    // Signal packer to delete its ZIP + status files
    $cu = PACKER_URL . '?action=cleanup&token=' . urlencode(PACKER_TOKEN);
    @file_get_contents($cu);
    @unlink(__FILE__);
    echo json_encode(['success' => true, 'action' => 'cleanup']);
    exit;
}

// ════════════════════════════════════════════════════════════
// ?action=download_init — get ZIP total size, create local file
// ════════════════════════════════════════════════════════════
if ($action === 'download_init') {
    @unlink(LOCAL_ZIP);
    file_put_contents(LOCAL_ZIP, ''); // create/reset

    $sizeUrl = PACKER_URL . '?action=download_size&token=' . urlencode(PACKER_TOKEN);
    $ctx = stream_context_create(['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]]);
    $resp = @file_get_contents($sizeUrl, false, $ctx);
    $data = $resp ? @json_decode($resp, true) : null;
    if (!$data || empty($data['size'])) {
        echo json_encode(['error' => 'Cannot get ZIP size from packer: ' . substr((string)$resp, 0, 200)]);
        exit;
    }
    echo json_encode(['total_size' => (int)$data['size'], 'downloaded' => 0]);
    exit;
}

// ════════════════════════════════════════════════════════════
// ?action=download_chunk&downloaded=N&total=T[&packer_url=URL]
// ════════════════════════════════════════════════════════════
if ($action === 'download_chunk') {
    $downloaded = (int)($_GET['downloaded'] ?? 0);
    $totalSize  = (int)($_GET['total']      ?? 0);
    // Allow packer URL override (packer may have been redeployed by TS orchestrator)
    $dlBase     = !empty($_GET['packer_url']) ? $_GET['packer_url'] : PACKER_URL;

    if ($downloaded >= $totalSize) {
        echo json_encode(['downloaded' => $downloaded, 'total' => $totalSize, 'done' => true]);
        exit;
    }

    $rangeEnd = min($downloaded + DL_CHUNK - 1, $totalSize - 1);
    $dlUrl = $dlBase . '?action=download&token=' . urlencode(PACKER_TOKEN);

    $fp = fopen(LOCAL_ZIP, 'ab');
    $ch = curl_init($dlUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FILE           => $fp,
        CURLOPT_RANGE          => $downloaded . '-' . $rangeEnd,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 30,
    ]);
    curl_exec($ch);
    $curlErr  = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    fclose($fp);

    if ($curlErr || ($httpCode !== 206 && $httpCode !== 200)) {
        // Packer may have been deleted by WP scanner — signal TS to redeploy
        echo json_encode(['packer_gone' => true,
            'error' => 'Download chunk failed HTTP ' . $httpCode . ': ' . $curlErr]);
        exit;
    }

    $newDl = file_exists(LOCAL_ZIP) ? filesize(LOCAL_ZIP) : 0;
    echo json_encode(['downloaded' => $newDl, 'total' => $totalSize, 'done' => ($newDl >= $totalSize)]);
    exit;
}

// ════════════════════════════════════════════════════════════
// ?action=extract_batch&start=N — extract next batch of ZIP entries
// ════════════════════════════════════════════════════════════
if ($action === 'extract_batch') {
    $start = (int)($_GET['start'] ?? 0);

    if (!file_exists(LOCAL_ZIP)) {
        echo json_encode(['error' => 'Local ZIP not found — download first']);
        exit;
    }
    $zip = new ZipArchive();
    if ($zip->open(LOCAL_ZIP) !== true) {
        echo json_encode(['error' => 'Cannot open downloaded ZIP']);
        exit;
    }

    $total = $zip->numFiles;
    $t0 = microtime(true);
    $i  = $start;

    for (; $i < $total; $i++) {
        // Stop before PHP-FPM kills us (leave 2s buffer)
        if ($i > $start && (microtime(true) - $t0) > 8.0) break;

        $name = $zip->getNameIndex($i);
        if ($name === false) continue;

        // Directory entry
        if (substr($name, -1) === '/') {
            @mkdir(DEST_PATH . '/' . $name, 0755, true);
            continue;
        }

        $dst = DEST_PATH . '/' . $name;
        @mkdir(dirname($dst), 0755, true);
        $content = $zip->getFromIndex($i);
        if ($content !== false) {
            file_put_contents($dst, $content);
            unset($content);
        }
    }

    $zip->close();
    $done = ($i >= $total);
    if ($done) @unlink(LOCAL_ZIP);

    echo json_encode(['extracted' => $i, 'total' => $total, 'done' => $done]);
    exit;
}

// ════════════════════════════════════════════════════════════
// ?action=import_sql — exec mysql import
// ════════════════════════════════════════════════════════════
if ($action === 'import_sql') {
    $sqlPath = DEST_PATH . '/_whm_export.sql';
    if (!file_exists($sqlPath)) {
        echo json_encode(['error' => 'SQL dump not found: ' . $sqlPath]);
        exit;
    }
    $cmd = sprintf('mysql -h %s -u %s -p%s %s < %s 2>&1',
        escapeshellarg('localhost'),
        escapeshellarg(NEW_DB_USER),
        escapeshellarg(NEW_DB_PASS),
        escapeshellarg(NEW_DB_NAME),
        escapeshellarg($sqlPath));
    exec($cmd, $out, $code);
    @unlink($sqlPath);
    if ($code !== 0) {
        echo json_encode(['error' => 'mysql import failed (' . $code . '): ' . implode(' ', $out)]);
        exit;
    }
    echo json_encode(['success' => true, 'action' => 'import_sql']);
    exit;
}

// ════════════════════════════════════════════════════════════
// ?action=patch_config — patch config files + URL search-replace in DB
// ════════════════════════════════════════════════════════════
if ($action === 'patch_config') {
    $tablePrefix = 'wp_';

    if (APP_TYPE === 'wordpress') {
        $cf = DEST_PATH . '/wp-config.php';
        if (file_exists($cf)) {
            $c = file_get_contents($cf);
            if (preg_match('/\\$table_prefix\\s*=\\s*\'([^\']+)\'/', $c, $m)) $tablePrefix = $m[1];
            $c = preg_replace("/define\\s*\\(\\s*'DB_NAME'\\s*,\\s*'[^']*'/",     "define('DB_NAME', '"     . addslashes(NEW_DB_NAME) . "'", $c);
            $c = preg_replace("/define\\s*\\(\\s*'DB_USER'\\s*,\\s*'[^']*'/",     "define('DB_USER', '"     . addslashes(NEW_DB_USER) . "'", $c);
            $c = preg_replace("/define\\s*\\(\\s*'DB_PASSWORD'\\s*,\\s*'[^']*'/", "define('DB_PASSWORD', '" . addslashes(NEW_DB_PASS) . "'", $c);
            $c = preg_replace("/define\\s*\\(\\s*'DB_HOST'\\s*,\\s*'[^']*'/",     "define('DB_HOST', 'localhost'",                            $c);
            file_put_contents($cf, $c);
        }
        try {
            $pdo = new PDO('mysql:host=localhost;dbname=' . NEW_DB_NAME, NEW_DB_USER, NEW_DB_PASS);
            $old = rtrim(OLD_SITE_URL, '/');
            $new = rtrim(NEW_SITE_URL, '/');
            $pdo->exec("UPDATE {$tablePrefix}options SET option_value = REPLACE(option_value, " . $pdo->quote($old) . ", " . $pdo->quote($new) . ") WHERE option_name IN ('siteurl','home')");
            $pdo->exec("UPDATE {$tablePrefix}posts SET guid = REPLACE(guid, "         . $pdo->quote($old) . ", " . $pdo->quote($new) . ")");
            $pdo->exec("UPDATE {$tablePrefix}posts SET post_content = REPLACE(post_content, " . $pdo->quote($old) . ", " . $pdo->quote($new) . ")");
            $pdo->exec("UPDATE {$tablePrefix}postmeta SET meta_value = REPLACE(meta_value, " . $pdo->quote($old) . ", " . $pdo->quote($new) . ")");
        } catch (Exception $ex) {
            echo json_encode(['error' => 'DB patch failed: ' . $ex->getMessage()]);
            exit;
        }
    } elseif (APP_TYPE === 'prestashop') {
        foreach ([DEST_PATH . '/app/config/parameters.php'] as $pf) {
            if (!file_exists($pf)) continue;
            $c = file_get_contents($pf);
            $c = preg_replace("/'database_name'\\s*=>\\s*'[^']*'/",     "'database_name' => '"     . addslashes(NEW_DB_NAME) . "'", $c);
            $c = preg_replace("/'database_user'\\s*=>\\s*'[^']*'/",     "'database_user' => '"     . addslashes(NEW_DB_USER) . "'", $c);
            $c = preg_replace("/'database_password'\\s*=>\\s*'[^']*'/", "'database_password' => '" . addslashes(NEW_DB_PASS) . "'", $c);
            $c = preg_replace("/'database_host'\\s*=>\\s*'[^']*'/",     "'database_host' => 'localhost'",                           $c);
            file_put_contents($pf, $c);
        }
        try {
            $pdo = new PDO('mysql:host=localhost;dbname=' . NEW_DB_NAME, NEW_DB_USER, NEW_DB_PASS);
            $parsed = parse_url(NEW_SITE_URL);
            $newDomain = $parsed['host'] ?? '';
            if ($newDomain) {
                $pdo->exec("UPDATE ps_configuration SET value = " . $pdo->quote($newDomain) . " WHERE name IN ('PS_SHOP_DOMAIN','PS_SHOP_DOMAIN_SSL')");
                $pdo->exec("UPDATE ps_shop_url SET domain = " . $pdo->quote($newDomain) . ", domain_ssl = " . $pdo->quote($newDomain));
            }
        } catch (Exception $ex) { /* non-fatal */ }
    }

    echo json_encode(['success' => true, 'targetUrl' => NEW_SITE_URL]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Unknown action: ' . htmlspecialchars($action ?? '')]);
`;
}

// ─── Main migration runner ────────────────────────────────────────────────────

export interface MigrationRunParams {
  jobId: string;
  sourceUser: string;
  sourcePath: string;        // absolute path on server e.g. /home/user/public_html
  sourceUrl: string;         // https://source.example.com
  packerPublicUrl: string;   // https://source.example.com/whm-packer-XXXX.php
  appType: AppType;
  target: {
    user: string;
    destPath: string;        // absolute path on target e.g. /home/target/public_html/subdomain
    subdomain: string;
    domain: string;
    newDbName: string;
    newDbUser: string;
    newDbPass: string;
    newSiteUrl: string;      // https://subdomain.target.example.com
  };
}

export interface DeployPackerResult {
  packerFileName: string;
  packerToken: string;
  packerPublicUrl: string;
}

/**
 * Deploy the packer agent to the source account.
 * The PHP file is placed directly in sourcePath (no subdirectory needed).
 * Returns the public URL to call the packer.
 *
 * Pass existingToken to redeploy with the same token (e.g. after the file was
 * deleted by a WordPress security scanner) — the existing WORK_FILE, STATUS_FILE
 * and ZIP in /home/user/ are keyed by md5(token) and will be reused seamlessly.
 */
export async function deployPackerAgent(
  sourceUser: string,
  sourcePath: string,
  sourceBaseUrl: string,
  appType: AppType,
  existingToken?: string,
): Promise<DeployPackerResult> {
  const token = existingToken ?? randomToken(32);
  const fileName = `whm_packer_${randomToken(8)}.php`;
  const relDir = toHomeRelative(sourceUser, sourcePath);

  // Upload agent directly into the existing installation directory
  const content = buildPackerPhp(token, sourceUser, sourcePath, appType);
  await uploadFileToCpanel(sourceUser, relDir, fileName, content);

  const base = sourceBaseUrl.replace(/\/$/, "");
  const packerPublicUrl = `${base}/${fileName}`;

  return { packerFileName: fileName, packerToken: token, packerPublicUrl };
}

/**
 * Drive the chunked packer: call ?action=pack (init), then loop ?action=pack_batch
 * until status=done. Each call completes in seconds — no background process needed.
 *
 * onProgress: called with each batch progress message.
 * onRedeploy: called when the packer PHP file is detected as deleted (WordPress security
 *   scanner removes unknown PHP files). Should re-upload the packer with the SAME token
 *   and return the new URL. State files (WORK_FILE, STATUS_FILE, ZIP) survive in /home/user/.
 */
export async function callPackerPack(
  packerUrl: string,
  packerToken: string,
  timeoutMs = 15 * 60 * 1000,
  onProgress?: (msg: string) => void | Promise<void>,
  onRedeploy?: () => Promise<string>,
): Promise<{
  dbName: string;
  dbHost: string;
  tablePrefix: string;
  zipName: string;
  zipSize: number;
}> {
  const tokenParam = encodeURIComponent(packerToken);

  // 1. Init: read config + mysqldump + enumerate files → creates ZIP with SQL dump
  const initRes = await fetchWithTimeout(
    `${packerUrl}?token=${tokenParam}&action=pack`,
    {},
    60_000,
  );
  const initText = await initRes.text();
  let initJson: Record<string, unknown>;
  try {
    initJson = JSON.parse(initText) as Record<string, unknown>;
  } catch {
    throw new Error(`Packer init returned non-JSON (HTTP ${initRes.status}) — ${initText.slice(0, 300)}`);
  }
  if (initJson.error) throw new Error(`Packer init error: ${initJson.error}`);

  // If already done (idempotent re-call), return immediately
  if (initJson.status === "done") {
    return {
      dbName:      String(initJson.dbName ?? ""),
      dbHost:      String(initJson.dbHost ?? "localhost"),
      tablePrefix: String(initJson.tablePrefix ?? "wp_"),
      zipName:     String(initJson.zipName ?? ""),
      zipSize:     Number(initJson.zipSize ?? 0),
    };
  }
  if (initJson.error) throw new Error(`Packer init error: ${initJson.error}`);

  // 2. Loop pack_batch until done
  const deadline = Date.now() + timeoutMs;
  let lastOffset = -1;
  let currentPackerUrl = packerUrl;
  let redeployCount = 0;
  const MAX_REDEPLOYS = 20;

  while (Date.now() < deadline) {
    const batchRes = await fetchWithTimeout(
      `${currentPackerUrl}?token=${tokenParam}&action=pack_batch`,
      {},
      60_000,
    );
    const batchText = await batchRes.text();

    // Detect packer file deletion: WordPress security scanners (Wordfence etc.)
    // delete unknown PHP files in public_html after ~30s. The response then
    // becomes the WordPress 404 page (HTML, HTTP 200).
    // Recovery: redeploy with same token → WORK_FILE + STATUS_FILE + ZIP survive
    // in /home/user/ and are keyed by md5(token), so we resume at the right offset.
    if (batchText.trimStart().startsWith("<")) {
      if (!onRedeploy || redeployCount >= MAX_REDEPLOYS) {
        throw new Error(
          `Packer batch returned non-JSON (HTTP ${batchRes.status}) — ${batchText.slice(0, 300)}`,
        );
      }
      redeployCount++;
      if (onProgress) await onProgress(`Packer supprimé par scanner WP, re-déploiement #${redeployCount}…`);
      currentPackerUrl = await onRedeploy();
      continue; // retry batch with new URL, same offset
    }

    let batchJson: Record<string, unknown>;
    try {
      batchJson = JSON.parse(batchText) as Record<string, unknown>;
    } catch {
      throw new Error(`Packer batch returned non-JSON (HTTP ${batchRes.status}) — ${batchText.slice(0, 300)}`);
    }

    if (batchJson.error) throw new Error(`Packer batch error: ${batchJson.error}`);

    const offset = Number(batchJson.offset ?? 0);
    const total  = Number(batchJson.total ?? 0);

    // Log progress only when offset changes (avoid spamming)
    if (offset !== lastOffset && onProgress) {
      onProgress(`Compression ${offset}/${total} fichiers…`);
      lastOffset = offset;
    }

    if (batchJson.status === "done") {
      return {
        dbName:      String(batchJson.dbName ?? ""),
        dbHost:      String(batchJson.dbHost ?? "localhost"),
        tablePrefix: String(batchJson.tablePrefix ?? "wp_"),
        zipName:     String(batchJson.zipName ?? ""),
        zipSize:     Number(batchJson.zipSize ?? 0),
      };
    }
    if (batchJson.status === "error") {
      throw new Error(`Packer error: ${batchJson.error ?? "unknown"}`);
    }

    // Small pause to avoid hammering the server
    await sleep(500);
  }

  throw new Error(`Packer timed out after ${Math.round(timeoutMs / 60000)} min`);
}

/**
 * Deploy the unpacker agent to the target account.
 */
export async function deployUnpackerAgent(params: {
  targetUser: string;
  destPath: string;
  appType: AppType;
  packerUrl: string;
  packerToken: string;
  newDbName: string;
  newDbUser: string;
  newDbPass: string;
  newSiteUrl: string;
  oldSiteUrl: string;
  unpackerBaseUrl: string;
}): Promise<{ unpackerFileName: string; unpackerToken: string }> {
  const token = randomToken(32);
  const fileName = `whm_unpacker_${randomToken(8)}.php`;

  // Ensure destination directory exists (subdomain dir may not be created yet)
  await createDirectoryCpanel(params.targetUser, params.destPath);

  // Deploy to main domain public_html root (NOT the subdomain dir).
  // The subdomain vhost is freshly created and may not be ready yet — accessing
  // public_html/subdir/ via the main domain returns 502 until the vhost is live.
  // The unpacker writes files to DEST_PATH (subdomain dir) but is itself served
  // from the main domain root where PHP-FPM is always available.
  const mainPublicHtml = `public_html`;

  const content = buildUnpackerPhp({
    token,
    packerUrl: params.packerUrl,
    packerToken: params.packerToken,
    destPath: params.destPath,
    appType: params.appType,
    newDbName: params.newDbName,
    newDbUser: params.newDbUser,
    newDbPass: params.newDbPass,
    newSiteUrl: params.newSiteUrl,
    oldSiteUrl: params.oldSiteUrl,
    targetUser: params.targetUser,
  });

  await uploadFileToCpanel(params.targetUser, mainPublicHtml, fileName, content);

  return { unpackerFileName: fileName, unpackerToken: token };
}

/**
 * Drive the chunked unpacker: download → extract → import → patch → cleanup.
 *
 * Each step is a separate HTTP call to the unpacker agent, all completing in <15s.
 * onProgress: called with each step message.
 * onPackerRedeploy: called when download_chunk signals packer_gone (WP scanner deleted
 *   the packer during the download phase). Returns new packer URL so next chunk can use it.
 */
export async function callUnpackerUnpack(
  unpackerUrl: string,
  unpackerToken: string,
  timeoutMs = 30 * 60 * 1000,
  onProgress?: (msg: string) => void | Promise<void>,
  onPackerRedeploy?: () => Promise<string>,
): Promise<{ targetUrl: string }> {
  const tp = encodeURIComponent(unpackerToken);
  const deadline = Date.now() + timeoutMs;
  const MAX_REDEPLOYS = 20;

  async function call(action: string, extra = ""): Promise<Record<string, unknown>> {
    const res = await fetchWithTimeout(`${unpackerUrl}?token=${tp}&action=${action}${extra}`, {}, 60_000);
    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      throw new Error(`Unpacker returned HTML (HTTP ${res.status}) for action=${action} — ${text.slice(0, 200)}`);
    }
    let j: Record<string, unknown>;
    try { j = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error(`Unpacker non-JSON for action=${action}: ${text.slice(0, 200)}`); }
    return j;
  }

  // ── 1. Init download
  const init = await call("download_init");
  if (init.error) throw new Error(`Unpacker download_init: ${init.error}`);
  const totalSize = Number(init.total_size ?? 0);
  if (onProgress) await onProgress(`Téléchargement ZIP (${(totalSize / 1024 / 1024).toFixed(1)} Mo)…`);

  // ── 2. Download chunks
  let downloaded = 0;
  let redeployCount = 0;
  let currentPackerUrl = ""; // empty = use PACKER_URL hardcoded in PHP

  while (downloaded < totalSize && Date.now() < deadline) {
    const packerParam = currentPackerUrl
      ? `&packer_url=${encodeURIComponent(currentPackerUrl)}`
      : "";
    const chunk = await call(
      "download_chunk",
      `&downloaded=${downloaded}&total=${totalSize}${packerParam}`,
    );

    if (chunk.packer_gone) {
      if (!onPackerRedeploy || redeployCount >= MAX_REDEPLOYS) {
        throw new Error(`Packer unreachable during download (${redeployCount} redeploys tried)`);
      }
      redeployCount++;
      if (onProgress) await onProgress(`Packer supprimé (download), re-déploiement #${redeployCount}…`);
      currentPackerUrl = await onPackerRedeploy();
      continue;
    }

    if (chunk.error) throw new Error(`Unpacker download_chunk: ${chunk.error}`);
    downloaded = Number(chunk.downloaded ?? downloaded);
    if (onProgress) {
      await onProgress(
        `Téléchargement ${(downloaded / 1024 / 1024).toFixed(1)}/${(totalSize / 1024 / 1024).toFixed(1)} Mo…`,
      );
    }
    if (chunk.done) break;
  }
  if (downloaded < totalSize) {
    throw new Error(`Download incomplete: ${downloaded}/${totalSize} bytes`);
  }

  // ── 3. Extract batch loop
  if (onProgress) await onProgress("Extraction des fichiers…");
  let extractStart = 0;
  while (Date.now() < deadline) {
    const ex = await call("extract_batch", `&start=${extractStart}`);
    if (ex.error) throw new Error(`Unpacker extract_batch: ${ex.error}`);
    extractStart = Number(ex.extracted ?? extractStart);
    const exTotal = Number(ex.total ?? 0);
    if (onProgress) await onProgress(`Extraction ${extractStart}/${exTotal} fichiers…`);
    if (ex.done) break;
  }

  // ── 4. Import SQL
  if (onProgress) await onProgress("Import SQL…");
  const sql = await call("import_sql");
  if (sql.error) throw new Error(`Unpacker import_sql: ${sql.error}`);

  // ── 5. Patch config
  if (onProgress) await onProgress("Patch configuration + URLs…");
  const patch = await call("patch_config");
  if (patch.error) throw new Error(`Unpacker patch_config: ${patch.error}`);
  const targetUrl = String(patch.targetUrl ?? "");

  // ── 6. Cleanup (best-effort)
  await call("cleanup").catch(() => null);

  return { targetUrl };
}

/**
 * Cleanup both agents after migration.
 */
export async function cleanupAgents(params: {
  sourceUser: string;
  sourcePath: string;
  packerDir: string;
  packerUrl: string;
  packerToken: string;
  targetUser: string;
  destPath: string;
  unpackerDir: string;
}): Promise<void> {
  await Promise.allSettled([
    // Try cleanup via HTTP first (packer self-deletes its ZIP)
    fetch(`${params.packerUrl}?token=${params.packerToken}&action=cleanup`).catch(() => null),
    // Delete full directories via cPanel API
    deleteFromCpanel(params.sourceUser, `${params.sourcePath}/${params.packerDir}`, "dir"),
    deleteFromCpanel(params.targetUser, `${params.destPath}/${params.unpackerDir}`, "dir"),
  ]);
}

// ─── Orchestrator (runs a single target migration end-to-end) ─────────────────

export interface RunMigrationTargetParams {
  jobId: string;
  sourceUser: string;
  sourcePath: string;
  sourceUrl: string;
  appType: AppType;
  target: {
    user: string;
    destPath: string;
    subdomain: string;
    domain: string;
    newDbName: string;
    newDbUser: string;
    newDbPass: string;
    newSiteUrl: string;
    unpackerBaseUrl?: string; // URL via domaine principal (sans DNS du sous-domaine)
  };
}

async function log(jobId: string, user: string, msg: string) {
  console.log(`[migration:${jobId}:${user}] ${msg}`);
  await appendMigrationLog(jobId, user, msg);
}

export async function runMigrationForTarget(params: RunMigrationTargetParams): Promise<void> {
  const { jobId, sourceUser, appType, target } = params;
  const { user: targetUser } = target;

  // Normalize paths (no trailing slashes)
  const sourcePath = params.sourcePath.replace(/\/+$/, "");
  const sourceUrl = params.sourceUrl.replace(/\/+$/, "");
  const destPath = target.destPath.replace(/\/+$/, "");

  let packerToken = "";
  let packerUrl = "";
  let packerFileName = "";
  let unpackerToken = "";
  let unpackerFileName = "";

  const unpackerBaseUrl = (target.unpackerBaseUrl ?? target.newSiteUrl).replace(/\/$/, "");

  try {
    await updateMigrationTarget(jobId, targetUser, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    // 1. Deploy packer directly into source installation directory
    await log(jobId, targetUser, "Déploiement de l'agent packer sur le compte source…");
    const packer = await deployPackerAgent(sourceUser, sourcePath, sourceUrl, appType);
    packerFileName = packer.packerFileName;
    packerToken = packer.packerToken;
    packerUrl = packer.packerPublicUrl;
    await log(jobId, targetUser, `Agent packer déployé : ${packerFileName} → ${packerUrl}`);

    // 2. Call packer to create ZIP + SQL dump (background process + polling)
    await log(jobId, targetUser, "Lancement compression arrière-plan (poll toutes les 10s, ~1-10 min)…");
    const packResult = await callPackerPack(
      packerUrl,
      packerToken,
      15 * 60 * 1000,
      (msg) => log(jobId, targetUser, msg),
      // onRedeploy: redeploy packer with SAME token so WORK_FILE/STATUS_FILE/ZIP are reused
      async () => {
        const rePacker = await deployPackerAgent(sourceUser, sourcePath, sourceUrl, appType, packerToken);
        packerFileName = rePacker.packerFileName;
        packerUrl = rePacker.packerPublicUrl;
        await log(jobId, targetUser, `Packer re-déployé → ${packerUrl}`);
        return rePacker.packerPublicUrl;
      },
    );
    const zipMb = (packResult.zipSize / 1024 / 1024).toFixed(1);
    await log(jobId, targetUser, `Archive créée — ${zipMb} Mo (${packResult.zipName})`);

    // 3. Re-deploy packer to ensure it's alive for the P2P download phase
    // (WP scanner may have deleted the PHP file during packing)
    {
      const dlPacker = await deployPackerAgent(sourceUser, sourcePath, sourceUrl, appType, packerToken);
      packerFileName = dlPacker.packerFileName;
      packerUrl = dlPacker.packerPublicUrl;
      await log(jobId, targetUser, `Packer re-déployé pour la phase download → ${packerUrl}`);
    }

    // 4. Deploy unpacker to target account's main domain public_html root
    // (deployed there to avoid 502 from not-yet-ready subdomain vhost)
    await log(jobId, targetUser, "Déploiement de l'agent unpacker sur le compte cible…");
    const unpacker = await deployUnpackerAgent({
      targetUser,
      destPath: target.destPath,
      appType,
      packerUrl,
      packerToken,
      newDbName: target.newDbName,
      newDbUser: target.newDbUser,
      newDbPass: target.newDbPass,
      newSiteUrl: target.newSiteUrl,
      oldSiteUrl: sourceUrl,
      unpackerBaseUrl,
    });
    unpackerFileName = unpacker.unpackerFileName;
    unpackerToken = unpacker.unpackerToken;
    await log(jobId, targetUser, `Agent unpacker déployé : ${unpackerFileName}`);

    // 5. Drive chunked unpacker: download → extract → import SQL → patch → cleanup
    // Unpacker is at main domain root, not subdomain path
    const unpackerPublicUrl = `${unpackerBaseUrl}/${unpackerFileName}`;
    const { targetUrl } = await callUnpackerUnpack(
      unpackerPublicUrl,
      unpackerToken,
      30 * 60 * 1000,
      (msg) => log(jobId, targetUser, msg),
      // onPackerRedeploy: redeploy with same token if WP scanner deletes it during download
      async () => {
        const rePacker = await deployPackerAgent(sourceUser, sourcePath, sourceUrl, appType, packerToken);
        packerFileName = rePacker.packerFileName;
        packerUrl = rePacker.packerPublicUrl;
        await log(jobId, targetUser, `Packer re-déployé (download) → ${packerUrl}`);
        return rePacker.packerPublicUrl;
      },
    );
    await log(jobId, targetUser, `✅ Migration terminée → ${targetUrl}`);

    await updateMigrationTarget(jobId, targetUser, {
      status: "done",
      finishedAt: new Date().toISOString(),
      targetUrl: targetUrl || target.newSiteUrl,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await log(jobId, targetUser, `❌ Erreur : ${msg}`);
    await updateMigrationTarget(jobId, targetUser, {
      status: "error",
      error: msg,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    // Best-effort cleanup of agent files
    if (packerFileName || unpackerFileName) {
      try {
        await Promise.allSettled([
          packerFileName
            ? fetch(`${packerUrl}?token=${packerToken}&action=cleanup`).catch(() => null)
            : Promise.resolve(),
          packerFileName
            ? deleteFromCpanel(sourceUser, `${sourcePath}/${packerFileName}`, "file")
            : Promise.resolve(),
          unpackerFileName
            ? deleteFromCpanel(targetUser, `/home/${targetUser}/public_html/${unpackerFileName}`, "file")
            : Promise.resolve(),
        ]);
      } catch {
        // best-effort
      }
    }
  }
}

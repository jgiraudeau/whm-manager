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
 * Architecture: background CLI process to bypass PHP-FPM request_terminate_timeout.
 *
 * Web actions:
 *   ?action=pack    → launch background PHP CLI process, return immediately {"started":true}
 *   ?action=status  → read status file, return current state (starting|running|done|error)
 *   ?action=download → serve ZIP from home dir
 *   ?action=cleanup  → delete ZIP + status file + self
 *
 * CLI mode (invoked by exec nohup): does the actual mysqldump + ZipArchive work,
 * writes progress to STATUS_FILE, writes final result when done.
 */
function buildPackerPhp(token: string, sourceUser: string, sourcePath: string, appType: AppType): string {
  const e = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const escapedToken = e(token);
  const escapedUser = e(sourceUser);
  const escapedPath = e(sourcePath);
  const appLabel = appType === "wordpress" ? "wordpress" : "prestashop";

  return `<?php
// WHM Manager — Packer Agent (auto-generated)
error_reporting(0);

define('AGENT_TOKEN', '${escapedToken}');
define('SOURCE_PATH', '${escapedPath}');
define('APP_TYPE',    '${appLabel}');
define('ZIP_NAME',    'whm_pack_' . substr(md5(SOURCE_PATH . AGENT_TOKEN), 0, 8) . '.zip');
define('HOME_DIR',    '/home/${escapedUser}/');
define('ZIP_PATH',    HOME_DIR . ZIP_NAME);
define('SQL_PATH',    HOME_DIR . 'whm_dump_' . substr(md5(AGENT_TOKEN), 0, 8) . '.sql');
define('STATUS_FILE', HOME_DIR . 'whm_status_' . substr(md5(AGENT_TOKEN), 0, 8) . '.json');

// ════════════════════════════════════════════════════════════
// CLI background mode — runs via: nohup php -f packer.php
// ════════════════════════════════════════════════════════════
if (php_sapi_name() === 'cli') {
    set_time_limit(0);
    ini_set('memory_limit', '512M');

    function ws($data) { file_put_contents(STATUS_FILE, json_encode($data)); }

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
        exit(1);
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
        ws(['status' => 'error', 'error' => 'mysqldump failed (code ' . $dCode . ')', 'ts' => time()]);
        exit(1);
    }

    // ── ZipArchive (no compression = CM_STORE, saves CPU)
    ws(['status' => 'running', 'step' => 'creating_zip', 'ts' => time()]);
    @unlink(ZIP_PATH);
    $zip = new ZipArchive();
    if ($zip->open(ZIP_PATH, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        @unlink(SQL_PATH);
        ws(['status' => 'error', 'error' => 'Cannot create ZIP file', 'ts' => time()]);
        exit(1);
    }

    $zip->addFile(SQL_PATH, '_whm_export.sql');
    $zip->setCompressionIndex(0, 0); // CM_STORE for SQL dump

    $EXCL = ['wp-content/cache', 'wp-content/upgrade', 'var/cache', 'cache', 'var/logs', 'var/sessions'];
    $iter = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(SOURCE_PATH, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($iter as $file) {
        if ($file->isDir()) continue;
        $fp  = $file->getRealPath();
        if (!$fp || $fp === ZIP_PATH || $fp === SQL_PATH || $fp === STATUS_FILE) continue;
        $rel = ltrim(substr($fp, strlen(SOURCE_PATH)), DIRECTORY_SEPARATOR);
        foreach ($EXCL as $x) { if (strpos($rel, $x) === 0) continue 2; }
        $zip->addFile($fp, $rel);
        $zip->setCompressionIndex($zip->numFiles - 1, 0); // CM_STORE — no CPU compression
    }

    $zip->close();
    @unlink(SQL_PATH);

    $zipSize = file_exists(ZIP_PATH) ? filesize(ZIP_PATH) : 0;
    if ($zipSize < 100) {
        ws(['status' => 'error', 'error' => 'ZIP too small (' . $zipSize . ' bytes)', 'ts' => time()]);
        exit(1);
    }

    ws([
        'status'      => 'done',
        'zipName'     => ZIP_NAME,
        'zipSize'     => $zipSize,
        'dbName'      => $dbName,
        'dbHost'      => $dbHost,
        'tablePrefix' => $tablePrefix,
        'ts'          => time(),
    ]);
    exit(0);
}

// ════════════════════════════════════════════════════════════
// WEB mode — short-lived HTTP requests only
// ════════════════════════════════════════════════════════════
set_time_limit(60);
header('Content-Type: application/json');

if (!isset($_GET['token']) || $_GET['token'] !== AGENT_TOKEN) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$action = $_GET['action'] ?? 'pack';

// ── Launch background pack process
if ($action === 'pack') {
    $existing = file_exists(STATUS_FILE) ? @json_decode(file_get_contents(STATUS_FILE), true) : null;
    if ($existing && in_array($existing['status'] ?? '', ['running', 'done', 'error'], true)) {
        echo json_encode(['started' => true, 'status' => $existing['status'] ?? 'unknown']);
        exit;
    }
    file_put_contents(STATUS_FILE, json_encode(['status' => 'starting', 'ts' => time()]));

    // Find PHP binary
    $phpBin = PHP_BINARY;
    if (!$phpBin || !is_executable($phpBin)) {
        foreach (['/usr/local/bin/php', '/usr/bin/php'] as $p) {
            if (is_executable($p)) { $phpBin = $p; break; }
        }
    }
    exec('nohup ' . escapeshellarg($phpBin) . ' -f ' . escapeshellarg(__FILE__) . ' > /dev/null 2>&1 &');
    echo json_encode(['started' => true, 'status' => 'starting']);
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

// ── Download ZIP
if ($action === 'download') {
    if (!file_exists(ZIP_PATH)) {
        http_response_code(404);
        echo json_encode(['error' => 'ZIP not found']);
        exit;
    }
    header('Content-Type: application/zip');
    header('Content-Length: ' . filesize(ZIP_PATH));
    header('Content-Disposition: attachment; filename="' . ZIP_NAME . '"');
    ob_end_clean();
    readfile(ZIP_PATH);
    exit;
}

// ── Cleanup
if ($action === 'cleanup') {
    @unlink(ZIP_PATH);
    @unlink(STATUS_FILE);
    @unlink(__FILE__);
    echo json_encode(['success' => true, 'action' => 'cleanup']);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Unknown action']);
`;
}

/**
 * Generates the PHP "unpacker" agent.
 * When called with ?token=TOKEN, it:
 *  1. Downloads the ZIP from the packer URL (P2P cURL)
 *  2. Creates a new MySQL database + user on the target cPanel (via php exec of mysqladmin or via pre-created DB info)
 *  3. Extracts the ZIP into destPath
 *  4. Imports the SQL
 *  5. Patches wp-config.php (or PrestaShop config) with new DB credentials and new siteUrl
 *  6. Cleans up + self-deletes
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
}): string {
  const e = (s: string) => s.replace(/'/g, "\\'");
  return `<?php
error_reporting(0);
set_time_limit(0);
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

header('Content-Type: application/json');

if (!isset($_GET['token']) || $_GET['token'] !== AGENT_TOKEN) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$action = $_GET['action'] ?? 'unpack';

if ($action === 'cleanup') {
    @unlink(__FILE__);
    echo json_encode(['success' => true, 'action' => 'cleanup']);
    exit;
}

if ($action !== 'unpack') {
    http_response_code(400);
    echo json_encode(['error' => 'Unknown action']);
    exit;
}

// ── Step 1: Download ZIP via packer download action (ZIP stored in home dir, served by packer)
$zipPath = sys_get_temp_dir() . '/whm_unpack_' . md5(AGENT_TOKEN) . '.zip';
$downloadUrl = PACKER_URL . '?action=download&token=' . urlencode(PACKER_TOKEN);
$ch = curl_init($downloadUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_FILE           => fopen($zipPath, 'wb'),
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_TIMEOUT        => 600,
]);
curl_exec($ch);
$curlError = curl_error($ch);
$httpCode  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$downloadedSize = file_exists($zipPath) ? filesize($zipPath) : 0;
if ($curlError || $httpCode !== 200 || $downloadedSize < 100) {
    @unlink($zipPath);
    echo json_encode(['error' => 'Failed to download ZIP from packer (HTTP ' . $httpCode . ', size=' . $downloadedSize . '): ' . $curlError]);
    exit;
}

// Verify ZIP magic bytes (PK = 50 4B 03 04)
$magic = file_get_contents($zipPath, false, null, 0, 4);
if ($magic !== "PK\x03\x04") {
    $preview = substr(file_get_contents($zipPath, false, null, 0, 500), 0, 500);
    @unlink($zipPath);
    echo json_encode(['error' => 'Downloaded file is not a valid ZIP (size=' . $downloadedSize . ', magic=' . bin2hex($magic) . '). Content preview: ' . $preview]);
    exit;
}

// ── Step 2: Validate destination dir
if (!is_dir(DEST_PATH)) {
    if (!mkdir(DEST_PATH, 0755, true)) {
        @unlink($zipPath);
        echo json_encode(['error' => 'Cannot create destination directory: ' . DEST_PATH]);
        exit;
    }
}

// ── Step 3: Extract ZIP
if (!class_exists('ZipArchive')) {
    @unlink($zipPath);
    echo json_encode(['error' => 'ZipArchive not available']);
    exit;
}
$zip = new ZipArchive();
if ($zip->open($zipPath) !== true) {
    @unlink($zipPath);
    echo json_encode(['error' => 'Cannot open downloaded ZIP']);
    exit;
}
$zip->extractTo(DEST_PATH);
$zip->close();
@unlink($zipPath);

// ── Step 4: Import SQL
$sqlPath = DEST_PATH . '/_whm_export.sql';
if (!file_exists($sqlPath)) {
    echo json_encode(['error' => 'SQL dump not found in archive (_whm_export.sql)']);
    exit;
}

// Get old DB credentials from the extracted config (for search-replace)
$oldDbName = '';
$oldDbUser = '';
$oldDbPass = '';
$oldDbHost = 'localhost';
$tablePrefix = 'wp_';

if (APP_TYPE === 'wordpress') {
    $configFile = DEST_PATH . '/wp-config.php';
    if (file_exists($configFile)) {
        $conf = file_get_contents($configFile);
        if (preg_match("/define\\s*\\(\\s*'DB_NAME'\\s*,\\s*'([^']+)'/", $conf, $m)) $oldDbName = $m[1];
        if (preg_match("/define\\s*\\(\\s*'DB_USER'\\s*,\\s*'([^']+)'/", $conf, $m)) $oldDbUser = $m[1];
        if (preg_match("/define\\s*\\(\\s*'DB_PASSWORD'\\s*,\\s*'([^']+)'/", $conf, $m)) $oldDbPass = $m[1];
        if (preg_match("/define\\s*\\(\\s*'DB_HOST'\\s*,\\s*'([^']+)'/", $conf, $m)) $oldDbHost = $m[1];
        if (preg_match("/\\\\$table_prefix\\s*=\\s*'([^']+)'/", $conf, $m)) $tablePrefix = $m[1];
    }
}

$importCmd = sprintf(
    'mysql -h %s -u %s %s %s < %s 2>&1',
    escapeshellarg('localhost'),
    escapeshellarg(NEW_DB_USER),
    '-p' . escapeshellarg(NEW_DB_PASS),
    escapeshellarg(NEW_DB_NAME),
    escapeshellarg($sqlPath)
);
exec($importCmd, $importOut, $importCode);
@unlink($sqlPath);

if ($importCode !== 0) {
    echo json_encode(['error' => 'mysql import failed (code ' . $importCode . '): ' . implode(' ', $importOut)]);
    exit;
}

// ── Step 5: Patch configuration files
if (APP_TYPE === 'wordpress') {
    $configFile = DEST_PATH . '/wp-config.php';
    if (file_exists($configFile)) {
        $conf = file_get_contents($configFile);
        $conf = preg_replace("/define\\s*\\(\\s*'DB_NAME'\\s*,\\s*'[^']*'/", "define('DB_NAME', '" . addslashes(NEW_DB_NAME) . "'", $conf);
        $conf = preg_replace("/define\\s*\\(\\s*'DB_USER'\\s*,\\s*'[^']*'/", "define('DB_USER', '" . addslashes(NEW_DB_USER) . "'", $conf);
        $conf = preg_replace("/define\\s*\\(\\s*'DB_PASSWORD'\\s*,\\s*'[^']*'/", "define('DB_PASSWORD', '" . addslashes(NEW_DB_PASS) . "'", $conf);
        $conf = preg_replace("/define\\s*\\(\\s*'DB_HOST'\\s*,\\s*'[^']*'/", "define('DB_HOST', 'localhost'", $conf);
        file_put_contents($configFile, $conf);
    }

    // Search-replace old siteurl → new siteurl in the DB
    $pdo = new PDO('mysql:host=localhost;dbname=' . NEW_DB_NAME, NEW_DB_USER, NEW_DB_PASS);
    $oldUrl = rtrim(OLD_SITE_URL, '/');
    $newUrl = rtrim(NEW_SITE_URL, '/');

    // Update wp_options (siteurl + home)
    $pdo->exec("UPDATE " . $tablePrefix . "options SET option_value = REPLACE(option_value, " . $pdo->quote($oldUrl) . ", " . $pdo->quote($newUrl) . ") WHERE option_name IN ('siteurl','home')");

    // Update wp_posts (guid + post_content)
    $pdo->exec("UPDATE " . $tablePrefix . "posts SET guid = REPLACE(guid, " . $pdo->quote($oldUrl) . ", " . $pdo->quote($newUrl) . ")");
    $pdo->exec("UPDATE " . $tablePrefix . "posts SET post_content = REPLACE(post_content, " . $pdo->quote($oldUrl) . ", " . $pdo->quote($newUrl) . ")");

    // Update wp_postmeta
    $pdo->exec("UPDATE " . $tablePrefix . "postmeta SET meta_value = REPLACE(meta_value, " . $pdo->quote($oldUrl) . ", " . $pdo->quote($newUrl) . ")");

} elseif (APP_TYPE === 'prestashop') {
    // PrestaShop: patch parameters.php and DB configuration table
    $paramFiles = [
        DEST_PATH . '/app/config/parameters.php',
    ];
    foreach ($paramFiles as $pf) {
        if (!file_exists($pf)) continue;
        $conf = file_get_contents($pf);
        $conf = preg_replace("/'database_name'\\s*=>\\s*'[^']*'/", "'database_name' => '" . addslashes(NEW_DB_NAME) . "'", $conf);
        $conf = preg_replace("/'database_user'\\s*=>\\s*'[^']*'/", "'database_user' => '" . addslashes(NEW_DB_USER) . "'", $conf);
        $conf = preg_replace("/'database_password'\\s*=>\\s*'[^']*'/", "'database_password' => '" . addslashes(NEW_DB_PASS) . "'", $conf);
        $conf = preg_replace("/'database_host'\\s*=>\\s*'[^']*'/", "'database_host' => 'localhost'", $conf);
        file_put_contents($pf, $conf);
    }
    // Also patch PS_SHOP_DOMAIN in DB
    try {
        $pdo = new PDO('mysql:host=localhost;dbname=' . NEW_DB_NAME, NEW_DB_USER, NEW_DB_PASS);
        $parsed = parse_url(NEW_SITE_URL);
        $newDomain = $parsed['host'] ?? '';
        if ($newDomain) {
            $pdo->exec("UPDATE ps_configuration SET value = " . $pdo->quote($newDomain) . " WHERE name IN ('PS_SHOP_DOMAIN','PS_SHOP_DOMAIN_SSL')");
            $pdo->exec("UPDATE ps_shop_url SET domain = " . $pdo->quote($newDomain) . ", domain_ssl = " . $pdo->quote($newDomain));
        }
    } catch (Exception $e) {
        // non-fatal
    }
}

// ── Step 6: Self delete + signal packer to cleanup
@unlink(__FILE__);

// Signal packer to cleanup its ZIP
$cleanupUrl = PACKER_URL . '&action=cleanup&token=' . PACKER_TOKEN;
@file_get_contents($cleanupUrl);

echo json_encode([
    'success'    => true,
    'targetUrl'  => NEW_SITE_URL,
    'message'    => 'Migration completed successfully',
]);
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
 */
export async function deployPackerAgent(
  sourceUser: string,
  sourcePath: string,
  sourceBaseUrl: string,
  appType: AppType,
): Promise<DeployPackerResult> {
  const token = randomToken(32);
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
 * Launch the packer background process, then poll until done.
 * The packer ?action=pack starts a nohup CLI PHP process and returns immediately.
 * We then poll ?action=status every 10 seconds until status=done or status=error.
 */
export async function callPackerPack(
  packerUrl: string,
  packerToken: string,
  timeoutMs = 15 * 60 * 1000,
): Promise<{
  dbName: string;
  dbHost: string;
  tablePrefix: string;
  zipName: string;
  zipSize: number;
}> {
  // 1. Launch background process (returns immediately)
  const startUrl = `${packerUrl}?token=${encodeURIComponent(packerToken)}&action=pack`;
  const startRes = await fetchWithTimeout(startUrl, {}, 30_000);
  const startText = await startRes.text();
  let startJson: Record<string, unknown>;
  try {
    startJson = JSON.parse(startText) as Record<string, unknown>;
  } catch {
    throw new Error(`Packer start returned non-JSON (HTTP ${startRes.status}) — ${startText.slice(0, 300)}`);
  }
  if (startJson.error) throw new Error(`Packer start error: ${startJson.error}`);

  // 2. Poll status every 10s
  const deadline = Date.now() + timeoutMs;
  let lastStep = "";
  while (Date.now() < deadline) {
    await sleep(10_000);
    const statusUrl = `${packerUrl}?token=${encodeURIComponent(packerToken)}&action=status`;
    let statusJson: Record<string, unknown>;
    try {
      const statusRes = await fetchWithTimeout(statusUrl, {}, 30_000);
      const statusText = await statusRes.text();
      statusJson = JSON.parse(statusText) as Record<string, unknown>;
    } catch {
      continue; // status file may not exist yet — keep polling
    }

    const status = String(statusJson.status ?? "");
    const step = String(statusJson.step ?? "");
    if (step && step !== lastStep) {
      lastStep = step;
      console.log(`[packer] status=${status} step=${step}`);
    }

    if (status === "done") {
      return {
        dbName: String(statusJson.dbName ?? ""),
        dbHost: String(statusJson.dbHost ?? "localhost"),
        tablePrefix: String(statusJson.tablePrefix ?? "wp_"),
        zipName: String(statusJson.zipName ?? ""),
        zipSize: Number(statusJson.zipSize ?? 0),
      };
    }
    if (status === "error") {
      throw new Error(`Packer background error: ${statusJson.error ?? "unknown"}`);
    }
    // starting / running — keep polling
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
  const relDestDir = toHomeRelative(params.targetUser, params.destPath);
  await createDirectoryCpanel(params.targetUser, params.destPath);

  // Upload agent directly into the destination directory
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
  });

  await uploadFileToCpanel(params.targetUser, relDestDir, fileName, content);

  return { unpackerFileName: fileName, unpackerToken: token };
}

/**
 * Call the unpacker to download + extract + import + patch.
 */
export async function callUnpackerUnpack(
  unpackerUrl: string,
  unpackerToken: string,
  timeoutMs = 20 * 60 * 1000,
): Promise<{ targetUrl: string }> {
  const url = `${unpackerUrl}?token=${encodeURIComponent(unpackerToken)}&action=unpack`;
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  const text = await res.text();

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unpacker returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (json.error) throw new Error(`Unpacker error: ${json.error}`);
  if (!json.success) throw new Error(`Unpacker failed: ${JSON.stringify(json)}`);

  return { targetUrl: String(json.targetUrl ?? "") };
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
    const packResult = await callPackerPack(packerUrl, packerToken, 15 * 60 * 1000);
    const zipMb = (packResult.zipSize / 1024 / 1024).toFixed(1);
    await log(jobId, targetUser, `Archive créée — ${zipMb} Mo (${packResult.zipName})`);

    // 3. Deploy unpacker directly into destination directory
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

    // 4. Call unpacker — P2P download + extract + import SQL + patch config
    await log(jobId, targetUser, "Transfert P2P + extraction + import SQL + patch config…");
    const unpackerPublicUrl = `${unpackerBaseUrl}/${unpackerFileName}`;
    const { targetUrl } = await callUnpackerUnpack(unpackerPublicUrl, unpackerToken, 20 * 60 * 1000);
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
            ? deleteFromCpanel(targetUser, `${target.destPath}/${unpackerFileName}`, "file")
            : Promise.resolve(),
        ]);
      } catch {
        // best-effort
      }
    }
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAuthSession, safeError } from "@/lib/auth";
import { cpanelApi } from "@/lib/whm";
import { isValidCpanelUsername } from "@/lib/validators";

// ─── PHP probe template ───────────────────────────────────────────────────────

function buildProbePhp(token: string): string {
  return `<?php
error_reporting(E_ALL);
set_time_limit(30);
header('Content-Type: application/json');

if (!isset($_GET['token']) || $_GET['token'] !== '${token}') {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$results = [];

// 1. PHP version
$results['php_version'] = PHP_VERSION;

// 2. exec() available
$disabledFunctions = array_map('trim', explode(',', ini_get('disable_functions')));
$results['exec_disabled'] = in_array('exec', $disabledFunctions) || in_array('shell_exec', $disabledFunctions);
$results['exec_test'] = null;
if (!$results['exec_disabled']) {
    $out = [];
    exec('echo hello_from_exec', $out, $code);
    $results['exec_test'] = ($code === 0 && isset($out[0]) && trim($out[0]) === 'hello_from_exec') ? 'ok' : 'failed (code '.$code.')';
}

// 3. mysqldump available
$results['mysqldump'] = null;
if (!$results['exec_disabled']) {
    $out2 = [];
    exec('which mysqldump 2>/dev/null', $out2, $c2);
    if ($c2 === 0 && !empty($out2[0])) {
        $results['mysqldump'] = trim($out2[0]);
    } else {
        // try common paths
        foreach (['/usr/bin/mysqldump', '/usr/local/bin/mysqldump', '/opt/cpanel/ea-mysql80/root/usr/bin/mysqldump'] as $p) {
            if (file_exists($p) && is_executable($p)) {
                $results['mysqldump'] = $p;
                break;
            }
        }
        if (!$results['mysqldump']) $results['mysqldump'] = 'not_found';
    }
}

// 4. mysql (import) available
$results['mysql_cli'] = null;
if (!$results['exec_disabled']) {
    $out3 = [];
    exec('which mysql 2>/dev/null', $out3, $c3);
    if ($c3 === 0 && !empty($out3[0])) {
        $results['mysql_cli'] = trim($out3[0]);
    } else {
        foreach (['/usr/bin/mysql', '/usr/local/bin/mysql', '/opt/cpanel/ea-mysql80/root/usr/bin/mysql'] as $p) {
            if (file_exists($p) && is_executable($p)) { $results['mysql_cli'] = $p; break; }
        }
        if (!$results['mysql_cli']) $results['mysql_cli'] = 'not_found';
    }
}

// 5. ZipArchive
$results['zip_archive'] = class_exists('ZipArchive');

// 6. PDO MySQL
$results['pdo_mysql'] = in_array('mysql', PDO::getAvailableDrivers());

// 7. cURL
$results['curl'] = function_exists('curl_init');

// 8. curl SSL (can we reach external HTTPS?)
$results['curl_ssl'] = null;
if (function_exists('curl_init')) {
    $ch = curl_init('https://example.com');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_SSL_VERIFYPEER => false]);
    $resp = curl_exec($ch);
    $results['curl_ssl'] = ($resp !== false) ? 'ok' : curl_error($ch);
    curl_close($ch);
}

// 9. tmp dir writable
$tmpDir = sys_get_temp_dir();
$results['tmp_dir'] = $tmpDir;
$results['tmp_writable'] = is_writable($tmpDir);

// 10. Memory limit
$results['memory_limit'] = ini_get('memory_limit');

// 11. max_execution_time
$results['max_execution_time'] = ini_get('max_execution_time');

// Self-delete
@unlink(__FILE__);

echo json_encode(['success' => true, 'probe' => $results]);
`;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { denied } = await requireAuthSession(req);
  if (denied) return denied;

  try {
    const body = (await req.json()) as { user?: string };
    const { user } = body;

    if (!user || !isValidCpanelUsername(user)) {
      return NextResponse.json({ error: "user invalide" }, { status: 400 });
    }

    // Generate a random token for security
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const fileName = `whm_probe_${token.slice(0, 8)}.php`;
    const probeContent = buildProbePhp(token);

    // 1. Upload probe to public_html — send raw content (no base64: some cPanel servers store it literally)
    await cpanelApi(user, "Fileman", "save_file_content", {
      dir: "public_html",
      file: fileName,
      content: probeContent,
    });

    // 2. Set permissions
    try {
      await cpanelApi(user, "Fileman", "set_file_perms", {
        dir: "public_html",
        file: fileName,
        perms: "0644",
      });
    } catch { /* ignore */ }

    // 3. Get domain for the account to build the URL
    const domainsRes = await cpanelApi(user, "DomainInfo", "list_domains", {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const domainData = (domainsRes as any)?.data ?? (domainsRes as any)?.result?.data ?? {};
    const mainDomain: string = domainData?.main_domain ?? "";

    if (!mainDomain) {
      // Cleanup and fail
      try { await cpanelApi(user, "Fileman", "delete_files", { "files-0-dir": "public_html", "files-0-file": fileName, "files-0-type": "file", "files-0-path": `public_html/${fileName}` }); } catch { /* ignore */ }
      return NextResponse.json({ error: "Impossible de récupérer le domaine du compte" }, { status: 500 });
    }

    const probeUrl = `https://${mainDomain}/${fileName}?token=${token}`;

    // 4. Call the probe (give it up to 30s)
    let probeResult: Record<string, unknown> | null = null;
    let probeError: string | null = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(probeUrl, { signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed.probe) {
          probeResult = parsed.probe as Record<string, unknown>;
        } else {
          probeError = `Réponse inattendue: ${text.slice(0, 300)}`;
        }
      } catch {
        probeError = `JSON invalide: ${text.slice(0, 300)}`;
      }
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
      // Try to cleanup
      try { await cpanelApi(user, "Fileman", "delete_files", { "files-0-dir": "public_html", "files-0-file": fileName, "files-0-type": "file", "files-0-path": `public_html/${fileName}` }); } catch { /* ignore */ }
    }

    // 5. Cleanup (probe auto-deletes, but ensure it's gone)
    try {
      await cpanelApi(user, "Fileman", "delete_files", {
        "files-0-dir": "public_html",
        "files-0-file": fileName,
        "files-0-type": "file",
        "files-0-path": `public_html/${fileName}`,
      });
    } catch { /* ignore */ }

    if (probeError) {
      return NextResponse.json({
        success: false,
        error: probeError,
        probeUrl,
        tip: "La sonde PHP n'a pas pu être appelée. Vérifiez que le domaine est actif et que PHP est disponible.",
      });
    }

    return NextResponse.json({ success: true, user, domain: mainDomain, probe: probeResult });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur diagnostic") },
      { status: 500 },
    );
  }
}

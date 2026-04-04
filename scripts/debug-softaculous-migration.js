// Diagnostics for Softaculous backup/restore flow across two cPanel accounts.
// Usage:
//   set -a && source .env.local && node scripts/debug-softaculous-migration.js <source_user> <dest_user> <source_insid_or_host>

const sourceUser = process.argv[2];
const destinationUser = process.argv[3];
const sourceRef = process.argv[4] || "";

if (!sourceUser || !destinationUser) {
  console.error("Usage: node scripts/debug-softaculous-migration.js <source_user> <dest_user> <source_insid_or_host>");
  process.exit(1);
}

const host = process.env.WHM_HOST;
const whmUser = process.env.WHM_USER;
const token = process.env.WHM_TOKEN;

if (!host || !whmUser || !token) {
  console.error("Missing WHM_HOST / WHM_USER / WHM_TOKEN in environment");
  process.exit(1);
}

function normalizeHost(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase()
      .replace(/^www\./, "");
  }
}

async function fetchInsecure(url, init = {}) {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await fetch(url, init);
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

async function whmFetch(endpoint, params = {}) {
  const url = new URL(`${host}/json-api/${endpoint}`);
  url.searchParams.set("api.version", "1");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetchInsecure(url.toString(), {
    headers: { Authorization: `whm ${whmUser}:${token}` },
  });

  if (!res.ok) {
    throw new Error(`WHM request failed ${res.status}`);
  }
  return res.json();
}

function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  const cookies = setCookieHeader.split(", ").map((c) => c.split(";")[0]);
  return cookies.find((c) => c.startsWith("cpsession=")) || "";
}

async function getCpanelContext(user) {
  const sess = await whmFetch("create_user_session", { user, service: "cpaneld" });
  const loginUrl = sess?.data?.url;
  if (!loginUrl) {
    throw new Error(`create_user_session returned no URL for ${user}`);
  }

  const loginResp = await fetchInsecure(loginUrl, { redirect: "manual" });
  const cookie = extractCookie(loginResp.headers.get("set-cookie"));
  if (!cookie) {
    throw new Error(`Could not extract cpsession cookie for ${user}`);
  }

  const match = loginUrl.match(/\/cpsess\d+\//);
  if (!match) {
    throw new Error(`Could not extract cpsess for ${user}`);
  }
  const cpsess = match[0].replace(/\//g, "");
  const cpanelHost = loginUrl.split("/")[2].split(":")[0];
  const baseUrl = `https://${cpanelHost}:2083/${cpsess}`;
  return { user, baseUrl, cookie };
}

function listControls(html) {
  const controls = [];
  const controlRe = /<(input|select|textarea)\b[^>]*>/gi;
  const nameRe = /\bname=["']([^"']+)["']/i;
  const valueRe = /\bvalue=["']([^"']*)["']/i;
  const typeRe = /\btype=["']([^"']+)["']/i;

  let match;
  while ((match = controlRe.exec(html))) {
    const tag = match[0];
    const control = match[1].toLowerCase();
    const nameMatch = tag.match(nameRe);
    if (!nameMatch) continue;
    const valueMatch = tag.match(valueRe);
    const typeMatch = tag.match(typeRe);
    controls.push({
      control,
      type: typeMatch ? typeMatch[1] : "",
      name: nameMatch[1],
      value: valueMatch ? valueMatch[1] : "",
    });
  }
  return controls;
}

function findInstallationId(payload, ref) {
  const root = payload?.data?.installations || payload?.installations || {};
  const normalizedRef = normalizeHost(ref);
  const entries = [];
  for (const [scriptId, nested] of Object.entries(root)) {
    if (!nested || typeof nested !== "object") continue;
    for (const [rawId, installation] of Object.entries(nested)) {
      if (!installation || typeof installation !== "object") continue;
      const composite = rawId.includes("_") ? rawId : `${scriptId}_${rawId}`;
      const softurl = installation.softurl || installation.domain || "";
      entries.push({ composite, softurl, app: installation.script_name || installation.softname || "" });
    }
  }
  if (!entries.length) return null;

  if (ref) {
    const byId = entries.find((item) => item.composite === ref.trim());
    if (byId) return byId;
    if (normalizedRef) {
      const byHost = entries.find((item) => normalizeHost(item.softurl) === normalizedRef);
      if (byHost) return byHost;
    }
  }
  return entries[0];
}

async function inspectAction(ctx, action, insid = "") {
  const url = `${ctx.baseUrl}/frontend/jupiter/softaculous/index.live.php?act=${action}${insid ? `&insid=${encodeURIComponent(insid)}` : ""}`;
  const res = await fetchInsecure(url, { headers: { Cookie: ctx.cookie } });
  const text = await res.text();
  const jsonRes = await fetchInsecure(`${url}&api=json`, { headers: { Cookie: ctx.cookie } });
  const jsonText = await jsonRes.text();
  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }

  console.log("----");
  console.log(`${ctx.user} action=${action} insid=${insid || "(none)"}`);
  console.log("html status:", res.status, "bytes:", text.length);
  const controls = listControls(text);
  console.log("controls:", controls.slice(0, 30).map((c) => `${c.control}:${c.name}`));
  console.log("preview:", text.slice(0, 220).replace(/\s+/g, " "));
  console.log("json status:", jsonRes.status, "bytes:", jsonText.length);
  if (parsed) {
    console.log("json keys:", Object.keys(parsed));
    console.log("json summary:", {
      done: parsed.done || null,
      done_msg: parsed.done_msg || null,
      error: parsed.error || null,
      errors: parsed.errors || null,
      insid: parsed.insid || null,
      taskid: parsed.taskid || parsed.task_id || null,
    });
    if (parsed.data && typeof parsed.data === "object") {
      console.log("data keys:", Object.keys(parsed.data));
    }
  } else {
    console.log("json preview:", jsonText.slice(0, 220).replace(/\s+/g, " "));
  }
}

async function main() {
  console.log("source user:", sourceUser);
  console.log("destination user:", destinationUser);
  console.log("source ref:", sourceRef || "(auto)");

  const [sourceCtx, destinationCtx] = await Promise.all([
    getCpanelContext(sourceUser),
    getCpanelContext(destinationUser),
  ]);
  console.log("source baseUrl:", sourceCtx.baseUrl);
  console.log("dest baseUrl:", destinationCtx.baseUrl);

  const sourceInstallationsRes = await fetchInsecure(
    `${sourceCtx.baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
    { headers: { Cookie: sourceCtx.cookie } },
  );
  const sourceInstallationsText = await sourceInstallationsRes.text();
  const sourceInstallations = JSON.parse(sourceInstallationsText);
  const sourceInstall = findInstallationId(sourceInstallations, sourceRef);
  if (!sourceInstall) {
    console.log("No source installation found.");
    return;
  }
  console.log("selected source install:", sourceInstall);

  await inspectAction(sourceCtx, "backup", sourceInstall.composite);
  await inspectAction(sourceCtx, "backups");
  await inspectAction(destinationCtx, "restore");
  await inspectAction(destinationCtx, "backups");
}

main().catch((err) => {
  console.error("Diagnostics failed:", err?.message || err);
  process.exit(1);
});

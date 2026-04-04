// Read-only diagnostics for Softaculous clone flow.
// Usage:
//   set -a && source .env.local && node scripts/debug-softaculous-clone.js <cpanel_user>

const inputUser = process.argv[2];
if (!inputUser) {
  console.error("Usage: node scripts/debug-softaculous-clone.js <cpanel_user> [target_fqdn]");
  process.exit(1);
}
const targetFqdn = process.argv[3] || "";

const host = process.env.WHM_HOST;
const whmUser = process.env.WHM_USER;
const token = process.env.WHM_TOKEN;

if (!host || !whmUser || !token) {
  console.error("Missing WHM_HOST / WHM_USER / WHM_TOKEN in environment");
  process.exit(1);
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

function extractCpsessionCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  const cookies = setCookieHeader.split(", ").map((c) => c.split(";")[0]);
  return cookies.find((c) => c.startsWith("cpsession=")) || "";
}

function findFirstInstallationId(rawInstallations) {
  for (const [scriptId, installs] of Object.entries(rawInstallations || {})) {
    if (!installs || typeof installs !== "object") continue;
    const ids = Object.keys(installs);
    if (!ids.length) continue;
    const rawId = ids[0];
    const composite = rawId.includes("_") ? rawId : `${scriptId}_${rawId}`;
    const item = installs[rawId] || {};
    const url = item.softurl || item.domain || "";
    return { rawId, composite, scriptId, url };
  }
  return null;
}

function listInputFields(html) {
  const fields = [];
  const inputRe = /<input\b[^>]*>/gi;
  const nameRe = /\bname=["']([^"']+)["']/i;
  const valueRe = /\bvalue=["']([^"']*)["']/i;

  let match;
  while ((match = inputRe.exec(html))) {
    const tag = match[0];
    const nameMatch = tag.match(nameRe);
    if (!nameMatch) continue;
    const valueMatch = tag.match(valueRe);
    fields.push({
      name: nameMatch[1],
      value: valueMatch ? valueMatch[1] : "",
    });
  }
  return fields;
}

function listNamedControls(html) {
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

function extractSelectOptions(html, selectName) {
  const selectRe = new RegExp(
    `<select\\b[^>]*name=["']${selectName}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const selectMatch = html.match(selectRe);
  if (!selectMatch) return [];

  const optionsHtml = selectMatch[1];
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  const valueRe = /\bvalue=["']([^"']*)["']/i;
  const selectedRe = /\bselected\b/i;
  const out = [];
  let match;
  while ((match = optionRe.exec(optionsHtml))) {
    const attrs = match[1] || "";
    const label = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const valueMatch = attrs.match(valueRe);
    out.push({
      value: valueMatch ? valueMatch[1] : "",
      label,
      selected: selectedRe.test(attrs),
    });
  }
  return out;
}

async function main() {
  console.log("Diagnosing user:", inputUser);

  const sess = await whmFetch("create_user_session", { user: inputUser, service: "cpaneld" });
  const loginUrl = sess?.data?.url;
  if (!loginUrl) {
    throw new Error("create_user_session returned no URL");
  }

  const loginResp = await fetchInsecure(loginUrl, { redirect: "manual" });
  const cookie = extractCpsessionCookie(loginResp.headers.get("set-cookie"));
  if (!cookie) {
    throw new Error("Could not extract cpsession cookie");
  }

  const match = loginUrl.match(/\/cpsess\d+\//);
  if (!match) {
    throw new Error("Could not extract cpsess from URL");
  }
  const cpsess = match[0].replace(/\//g, "");
  const cpanelHost = loginUrl.split("/")[2].split(":")[0];
  const baseUrl = `https://${cpanelHost}:2083/${cpsess}`;
  console.log("baseUrl:", baseUrl);

  const installationsRes = await fetchInsecure(
    `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
    { headers: { Cookie: cookie } },
  );
  const installationsText = await installationsRes.text();
  console.log("installations status:", installationsRes.status, "bytes:", installationsText.length);

  const parsed = JSON.parse(installationsText);
  const rawInstallations = parsed?.data?.installations || parsed?.installations || {};
  const first = findFirstInstallationId(rawInstallations);
  if (!first) {
    console.log("No installation found for user");
    return;
  }

  console.log("first installation:", first);

  const clonePages = [
    `${baseUrl}/frontend/jupiter/softaculous/index.php?act=sclone&insid=${encodeURIComponent(first.composite)}`,
    `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(first.composite)}`,
    `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(first.composite)}&api=json`,
  ];

  let softStatusKey = "";
  let softprotoOptionsFromForm = [];
  let softdomainOptionsFromForm = [];
  for (const url of clonePages) {
    const res = await fetchInsecure(url, { headers: { Cookie: cookie } });
    const text = await res.text();
    const hasSoftsubmit = /name=["']softsubmit["']/i.test(text);
    const hasInsid = /name=["']insid["']/i.test(text);
    const hasSoftdomain = /name=["']softdomain["']/i.test(text);
    const hasSoftdirectory = /name=["']softdirectory["']/i.test(text);
    const hasToken = /name=["']token["']/i.test(text) || /csrf/i.test(text);

    console.log("----");
    console.log("url:", url);
    console.log("status:", res.status, "bytes:", text.length);
    console.log({ hasSoftsubmit, hasInsid, hasSoftdomain, hasSoftdirectory, hasToken });
    console.log("preview:", text.slice(0, 260).replace(/\s+/g, " "));

    if (url.includes("index.live.php") && url.includes("api=json")) {
      try {
        const json = JSON.parse(text);
        console.log("json keys:", Object.keys(json));
        console.log("done:", json.done, "done-type:", typeof json.done, "insid:", json.insid);
        console.log("userins.insid:", json?.userins?.insid || null);
        console.log("userins.softdomain:", json?.userins?.softdomain || null);
        console.log("userins keys:", Object.keys(json.userins || {}));
        console.log("domains sample:", Object.keys(json.domains || {}).slice(0, 8));
        console.log("protocols:", json.protocols || null);
        console.log("data keys:", Object.keys(json.data || {}));
        console.log("error fields:", {
          error: json.error || null,
          errors: json.errors || null,
          error_msg: json.error_msg || null,
        });
      } catch {
        console.log("json parse failed for api response");
      }
    } else if (url.includes("index.live.php") && !url.includes("api=json")) {
      const fields = listInputFields(text);
      const controls = listNamedControls(text);
      const protoOptions = extractSelectOptions(text, "softproto");
      const domainOptions = extractSelectOptions(text, "softdomain");
      softprotoOptionsFromForm = protoOptions;
      softdomainOptionsFromForm = domainOptions;
      const statusField = fields.find((f) => f.name === "soft_status_key");
      if (statusField?.value) {
        softStatusKey = statusField.value;
      }
      console.log("form fields sample:", fields.slice(0, 20));
      console.log("control names:", controls.map((c) => `${c.control}:${c.name}`).slice(0, 40));
      console.log("softproto options:", protoOptions.slice(0, 10));
      console.log("softdomain options:", domainOptions.slice(0, 20));
    }
  }

  console.log("----");
  console.log("POST diagnostics (non-destructive with invalid target domain)");
  const insidCandidates = Array.from(
    new Set(
      [first.composite, first.rawId]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  const testPosts = [];
  for (const insidValue of insidCandidates) {
    testPosts.push({
      label: `live-current-insid-${insidValue}`,
      endpoint: `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&api=json`,
      params: {
        softsubmit: "1",
        insid: insidValue,
        softdomain: "example.invalid",
        softdirectory: "",
        softdb: "clndiag1",
      },
    });
    testPosts.push({
      label: `live-with-setupcontinue-insid-${insidValue}`,
      endpoint: `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&api=json`,
      params: {
        setupcontinue: "1",
        softsubmit: "1",
        insid: insidValue,
        softdomain: "example.invalid",
        softdirectory: "",
        softdb: "clndiag2",
      },
    });
    testPosts.push({
      label: `index-current-insid-${insidValue}`,
      endpoint: `${baseUrl}/frontend/jupiter/softaculous/index.php?act=sclone&api=json`,
      params: {
        softsubmit: "1",
        insid: insidValue,
        softdomain: "example.invalid",
        softdirectory: "",
        softdb: "clndiag3",
      },
    });
    testPosts.push({
      label: `live-insid-in-query-${insidValue}`,
      endpoint: `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(insidValue)}&api=json`,
      params: {
        softsubmit: "Cloner",
        softdomain: "example.invalid",
        softdirectory: "",
        softdb: "clndiag4",
        ...(softStatusKey ? { soft_status_key: softStatusKey } : {}),
      },
    });
    testPosts.push({
      label: `live-insid-query-setupcontinue-${insidValue}`,
      endpoint: `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(insidValue)}&api=json`,
      params: {
        setupcontinue: "1",
        softsubmit: "Cloner",
        softdomain: "example.invalid",
        softdirectory: "",
        softdb: "clndiag5",
        ...(softStatusKey ? { soft_status_key: softStatusKey } : {}),
      },
    });
  }

  for (const test of testPosts) {
    const body = new URLSearchParams(test.params).toString();
    const postUrl = test.endpoint;
    const res = await fetchInsecure(postUrl, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await res.text();
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();

    console.log("test:", test.label, "status:", res.status, "bytes:", text.length);
    if (parsed) {
      console.log("parsed keys:", Object.keys(parsed));
      console.log("error fields:", {
        error: parsed.error || null,
        errors: parsed.errors || null,
        done: parsed.done || null,
        done_msg: parsed.done_msg || null,
        insid: parsed.insid || null,
        taskid: parsed.taskid || parsed.task_id || null,
      });
    } else {
      console.log("non-json preview:", text.slice(0, 260).replace(/\s+/g, " "));
    }
  }

  if (targetFqdn) {
    console.log("----");
    console.log("REAL clone test target:", targetFqdn);
    const hostOnly = normalizeHost(targetFqdn);
    const sourceHasWww = /^https?:\/\/www\./i.test(first.url || "");
    const sourceProto = /^https:\/\//i.test(first.url || "") ? "https://" : "http://";
    const preferredLabel = `${sourceProto}${sourceHasWww ? "www." : ""}`;
    const proto =
      softprotoOptionsFromForm.find((o) => String(o.label).toLowerCase() === preferredLabel.toLowerCase()) ||
      softprotoOptionsFromForm.find((o) => o.selected) ||
      softprotoOptionsFromForm[0] ||
      null;

    console.log("chosen softproto:", proto);
    console.log("target present in softdomain options:", softdomainOptionsFromForm.some((d) => d.value === hostOnly));

    const body = new URLSearchParams({
      softsubmit: "Cloner",
      ...(proto?.value ? { softproto: String(proto.value) } : {}),
      softdomain: hostOnly,
      softdirectory: "",
      softdb: `diag${Date.now().toString().slice(-6)}`,
      ...(softStatusKey ? { soft_status_key: softStatusKey } : {}),
    }).toString();

    const postUrl = `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=sclone&insid=${encodeURIComponent(first.composite)}&api=json`;
    const res = await fetchInsecure(postUrl, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await res.text();
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();

    console.log("real clone POST status:", res.status, "bytes:", text.length);
    if (parsed) {
      console.log("real clone parsed keys:", Object.keys(parsed));
      console.log("real clone fields:", {
        error: parsed.error || null,
        errors: parsed.errors || null,
        done: parsed.done || null,
        done_msg: parsed.done_msg || null,
        insid: parsed.insid || null,
        taskid: parsed.taskid || parsed.task_id || null,
      });
    } else {
      console.log("real clone non-json preview:", text.slice(0, 260).replace(/\s+/g, " "));
    }

    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const checkRes = await fetchInsecure(
        `${baseUrl}/frontend/jupiter/softaculous/index.live.php?act=installations&api=json`,
        { headers: { Cookie: cookie } },
      );
      const checkText = await checkRes.text();
      let found = false;
      try {
        const checkJson = JSON.parse(checkText);
        const installs = checkJson?.data?.installations || checkJson?.installations || {};
        for (const inner of Object.values(installs)) {
          if (!inner || typeof inner !== "object") continue;
          for (const install of Object.values(inner)) {
            if (!install || typeof install !== "object") continue;
            const url = String(install.softurl || install.domain || "");
            if (normalizeHost(url) === hostOnly) {
              found = true;
              break;
            }
          }
          if (found) break;
        }
      } catch {
        // ignore
      }
      console.log(`target exists check #${i + 1}:`, found);
    }
  }
}

main().catch((err) => {
  console.error("Diagnostics failed:", err?.message || err);
  process.exit(1);
});

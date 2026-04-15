"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Copy,
  ChevronRight,
  ChevronLeft,
  PlayCircle,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  Trash2,
  Globe,
  ShoppingCart,
  Server,
  ExternalLink,
  AlertTriangle,
  Stethoscope,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Installation {
  id: string;
  name: string;
  app: "wordpress" | "prestashop" | "other";
  url: string;
  path: string;
  ver: string;
}

interface Account {
  user: string;
  domain: string;
}

type MigrationStatus = "pending" | "running" | "done" | "error";

interface MigrationTarget {
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

interface MigrationJob {
  id: string;
  sourceUser: string;
  sourceInstallId: string;
  sourceUrl: string;
  appType: "wordpress" | "prestashop";
  targets: MigrationTarget[];
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AppBadge = ({ app }: { app: "wordpress" | "prestashop" | "other" }) =>
  app === "wordpress" ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 text-[10px] font-bold uppercase tracking-wider">
      <Globe className="w-2.5 h-2.5" />WP
    </span>
  ) : app === "prestashop" ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-pink-900/40 text-pink-300 text-[10px] font-bold uppercase tracking-wider">
      <ShoppingCart className="w-2.5 h-2.5" />PS
    </span>
  ) : null;

const StatusIcon = ({ status }: { status: MigrationStatus }) => {
  switch (status) {
    case "pending": return <Clock className="w-4 h-4 text-gray-500" />;
    case "running": return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    case "done":    return <CheckCircle className="w-4 h-4 text-emerald-400" />;
    case "error":   return <XCircle className="w-4 h-4 text-red-400" />;
  }
};

const statusLabel: Record<MigrationStatus, string> = {
  pending: "En attente",
  running: "En cours…",
  done: "Terminé",
  error: "Erreur",
};

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MigrationsPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 state
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sourceUser, setSourceUser] = useState("");
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loadingInstalls, setLoadingInstalls] = useState(false);
  const [selectedInstall, setSelectedInstall] = useState<Installation | null>(null);

  // Step 2 state
  const [selectedTargets, setSelectedTargets] = useState<Map<string, string>>(new Map()); // user → subdomain
  const [defaultSubdomain, setDefaultSubdomain] = useState("wordpress");

  // Step 3 state
  const [activeJob, setActiveJob] = useState<MigrationJob | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Past jobs
  const [pastJobs, setPastJobs] = useState<MigrationJob[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

  // Diagnostic state
  const [diagUser, setDiagUser] = useState("");
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, unknown> | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  // Load accounts on mount
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d) => {
        const accts = (d.accounts as Account[]) ?? [];
        setAccounts(accts.sort((a, b) => a.user.localeCompare(b.user)));
      })
      .catch(() => {});

    // Load past jobs
    loadPastJobs();
  }, []);

  // Load installations when sourceUser changes
  useEffect(() => {
    if (!sourceUser) { setInstallations([]); return; }
    setLoadingInstalls(true);
    setSelectedInstall(null);
    fetch(`/api/accounts/installations?user=${encodeURIComponent(sourceUser)}`)
      .then((r) => r.json())
      .then((d) => {
        const installs = ((d.installations as Installation[]) ?? []).filter(
          (i) => i.app === "wordpress" || i.app === "prestashop"
        );
        setInstallations(installs);
      })
      .catch(() => setInstallations([]))
      .finally(() => setLoadingInstalls(false));
  }, [sourceUser]);

  // Update default subdomain from selected installation
  useEffect(() => {
    if (!selectedInstall) return;
    const url = selectedInstall.url;
    try {
      const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
      const parts = host.split(".");
      if (parts.length > 2) setDefaultSubdomain(parts[0]);
      else setDefaultSubdomain(selectedInstall.app === "wordpress" ? "wordpress" : "boutique");
    } catch {
      setDefaultSubdomain(selectedInstall.app === "wordpress" ? "wordpress" : "boutique");
    }
  }, [selectedInstall]);

  async function loadPastJobs() {
    try {
      const res = await fetch("/api/admin/migrations");
      const data = await res.json() as { jobs?: MigrationJob[] };
      setPastJobs(data.jobs ?? []);
    } catch { /* ignore */ }
  }

  // Polling active job
  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/admin/migrations/${jobId}`);
      const data = await res.json() as { job?: MigrationJob };
      if (data.job) {
        setActiveJob(data.job);
        const allDone = data.job.targets.every((t) => t.status === "done" || t.status === "error");
        if (!allDone) {
          setTimeout(() => pollJob(jobId), 3000);
        } else {
          loadPastJobs();
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (activeJob?.id) pollJob(activeJob.id);
  }, [activeJob?.id, pollJob]);

  // Target accounts = all accounts except source
  const targetAccounts = accounts.filter((a) => a.user !== sourceUser);

  function toggleTarget(user: string) {
    setSelectedTargets((prev) => {
      const next = new Map(prev);
      if (next.has(user)) {
        next.delete(user);
      } else {
        next.set(user, defaultSubdomain);
      }
      return next;
    });
  }

  function setTargetSubdomain(user: string, sub: string) {
    setSelectedTargets((prev) => {
      const next = new Map(prev);
      next.set(user, sub);
      return next;
    });
  }

  function selectAll() {
    setSelectedTargets(new Map(targetAccounts.map((a) => [a.user, defaultSubdomain])));
  }

  function deselectAll() {
    setSelectedTargets(new Map());
  }

  async function launch() {
    if (!selectedInstall || selectedTargets.size === 0) return;
    setLaunching(true);
    setLaunchError(null);

    try {
      const targets = Array.from(selectedTargets.entries()).map(([user, subdomain]) => ({
        user,
        subdomain,
      }));

      const res = await fetch("/api/admin/migrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUser,
          sourceInstallId: selectedInstall.id,
          targets,
        }),
      });
      const data = await res.json() as { jobId?: string; job?: MigrationJob; error?: string };
      if (data.error) throw new Error(data.error);
      setActiveJob(data.job ?? null);
      setStep(3);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally {
      setLaunching(false);
    }
  }

  async function deleteJob(id: string) {
    await fetch("/api/admin/migrations", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setPastJobs((prev) => prev.filter((j) => j.id !== id));
    if (activeJob?.id === id) setActiveJob(null);
  }

  function toggleLogs(key: string) {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const isJobRunning = (job: MigrationJob) =>
    job.targets.some((t) => t.status === "running" || t.status === "pending");

  async function runDiag() {
    if (!diagUser) return;
    setDiagRunning(true);
    setDiagResult(null);
    setDiagError(null);
    try {
      const res = await fetch("/api/accounts/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: diagUser }),
      });
      const data = await res.json() as { success?: boolean; probe?: Record<string, unknown>; error?: string; tip?: string };
      if (data.probe) setDiagResult(data.probe);
      else setDiagError(data.error ?? data.tip ?? "Erreur inconnue");
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setDiagRunning(false);
    }
  }

  // ─── Render steps ────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Copy className="w-6 h-6 text-violet-400" />
          Migration inter-comptes
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Clonez WordPress ou PrestaShop d&apos;un compte source vers N comptes cibles (P2P)
        </p>
      </div>

      {/* ── Diagnostic panel ──────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-bold text-white">Diagnostic PHP — capacités du serveur</h3>
        </div>
        <p className="text-xs text-gray-500">
          Déploie une sonde temporaire sur un compte pour vérifier si exec, ZipArchive, mysqldump, PDO et cURL sont disponibles.
        </p>
        <div className="flex items-center gap-3">
          <select
            value={diagUser}
            onChange={(e) => setDiagUser(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-white px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-amber-500 flex-1 max-w-xs"
          >
            <option value="">— Choisir un compte —</option>
            {accounts.map((a) => (
              <option key={a.user} value={a.user}>{a.user} ({a.domain})</option>
            ))}
          </select>
          <button
            onClick={runDiag}
            disabled={!diagUser || diagRunning}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all"
          >
            {diagRunning ? <><Loader2 className="w-4 h-4 animate-spin" /> Test…</> : <><Stethoscope className="w-4 h-4" /> Tester</>}
          </button>
        </div>

        {diagError && (
          <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/40 rounded-lg text-red-400 text-xs">
            <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{diagError}</span>
          </div>
        )}

        {diagResult && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs font-mono">
            {[
              { key: "php_version", label: "PHP" },
              { key: "exec_disabled", label: "exec() bloqué", invert: true },
              { key: "exec_test", label: "exec() test" },
              { key: "mysqldump", label: "mysqldump" },
              { key: "mysql_cli", label: "mysql cli" },
              { key: "zip_archive", label: "ZipArchive" },
              { key: "pdo_mysql", label: "PDO MySQL" },
              { key: "curl", label: "cURL" },
              { key: "curl_ssl", label: "cURL HTTPS" },
              { key: "tmp_writable", label: "/tmp writable" },
              { key: "memory_limit", label: "mémoire" },
              { key: "max_execution_time", label: "max exec time" },
            ].map(({ key, label, invert }) => {
              const val = diagResult[key];
              const isBool = typeof val === "boolean";
              const isOk = isBool ? (invert ? !val : val) : (val !== null && val !== "not_found" && val !== "failed");
              const display = isBool ? (val ? "oui" : "non") : (val === null ? "N/A" : String(val));
              return (
                <div key={key} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${isOk ? "border-emerald-800/40 bg-emerald-900/10" : "border-red-800/40 bg-red-900/10"}`}>
                  {isOk
                    ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    : <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-gray-500 text-[10px] uppercase tracking-wider">{label}</p>
                    <p className={`truncate ${isOk ? "text-emerald-300" : "text-red-300"}`}>{display}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {([1, 2, 3] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <ChevronRight className="w-4 h-4 text-gray-700" />}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all ${
                step === s
                  ? "bg-violet-600 text-white font-semibold"
                  : step > s
                    ? "bg-gray-800 text-emerald-400"
                    : "bg-gray-900 text-gray-600"
              }`}
            >
              <span className="font-mono text-xs">{s}</span>
              <span>{s === 1 ? "Source" : s === 2 ? "Cibles" : "Suivi"}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── STEP 1: Select source ────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-5">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <h2 className="font-semibold text-white">Sélectionner le compte source</h2>

            <div>
              <label className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-2 block">
                Compte cPanel source
              </label>
              <select
                id="select-source-user"
                value={sourceUser}
                onChange={(e) => setSourceUser(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-white px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-violet-500"
              >
                <option value="">— Choisir un compte —</option>
                {accounts.map((a) => (
                  <option key={a.user} value={a.user}>
                    {a.user} ({a.domain})
                  </option>
                ))}
              </select>
            </div>

            {sourceUser && (
              <div>
                <label className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-2 block">
                  Installation à cloner
                </label>
                {loadingInstalls ? (
                  <div className="flex items-center gap-2 py-4 text-gray-500 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Chargement des installations…
                  </div>
                ) : installations.length === 0 ? (
                  <div className="py-4 text-gray-600 text-sm">
                    Aucune installation WordPress ou PrestaShop sur ce compte.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {installations.map((install) => {
                      const selected = selectedInstall?.id === install.id;
                      return (
                        <button
                          key={install.id}
                          id={`install-${install.id}`}
                          onClick={() => setSelectedInstall(selected ? null : install)}
                          className={`w-full text-left p-4 rounded-xl border transition-all ${
                            selected
                              ? "border-violet-500 bg-violet-900/20"
                              : "border-gray-800 bg-gray-800/50 hover:border-gray-700"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <AppBadge app={install.app} />
                                <span className="text-white font-semibold text-sm">{install.name}</span>
                                <span className="text-gray-600 text-xs">v{install.ver}</span>
                              </div>
                              <p className="text-blue-400 text-xs font-mono">{install.url}</p>
                              <p className="text-gray-600 text-xs font-mono">{install.path}</p>
                            </div>
                            {selected && <CheckCircle className="w-5 h-5 text-violet-400 flex-shrink-0" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button
              id="btn-step1-next"
              disabled={!selectedInstall}
              onClick={() => setStep(2)}
              className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all"
            >
              Suivant <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2: Select targets ───────────────────────────────────────────── */}
      {step === 2 && selectedInstall && (
        <div className="space-y-5">
          {/* Source summary */}
          <div className="bg-violet-900/20 border border-violet-800/50 rounded-xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 bg-violet-700 rounded-lg flex items-center justify-center flex-shrink-0">
              <Copy className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-violet-400 font-bold uppercase tracking-wider">Source</p>
              <p className="text-white font-semibold truncate">{selectedInstall.url}</p>
              <p className="text-gray-500 text-xs">Compte: {sourceUser} • <AppBadge app={selectedInstall.app} /></p>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-white">Comptes cibles</h2>
              <div className="flex gap-2">
                <button
                  onClick={selectAll}
                  className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-all"
                >
                  Tout sélectionner
                </button>
                <button
                  onClick={deselectAll}
                  className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-all"
                >
                  Désélectionner
                </button>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-500 font-bold uppercase tracking-wider mb-2 block">
                Sous-domaine par défaut
              </label>
              <input
                id="default-subdomain"
                type="text"
                value={defaultSubdomain}
                onChange={(e) => setDefaultSubdomain(e.target.value)}
                placeholder="ex: wordpress"
                className="w-48 bg-gray-800 border border-gray-700 text-white px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-violet-500 font-mono"
              />
            </div>

            <div className="grid gap-2 max-h-96 overflow-y-auto pr-1">
              {targetAccounts.map((account) => {
                const isSelected = selectedTargets.has(account.user);
                const subdomain = selectedTargets.get(account.user) ?? defaultSubdomain;
                return (
                  <div
                    key={account.user}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                      isSelected
                        ? "border-violet-700/60 bg-violet-900/10"
                        : "border-gray-800 bg-gray-800/30"
                    }`}
                  >
                    <input
                      type="checkbox"
                      id={`target-${account.user}`}
                      checked={isSelected}
                      onChange={() => toggleTarget(account.user)}
                      className="w-4 h-4 rounded accent-violet-500 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-semibold">{account.user}</p>
                      <p className="text-gray-600 text-xs truncate">{account.domain}</p>
                    </div>
                    {isSelected && (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <input
                          type="text"
                          value={subdomain}
                          onChange={(e) => setTargetSubdomain(account.user, e.target.value)}
                          placeholder="sous-domaine"
                          className="w-36 bg-gray-700 border border-gray-600 text-white px-2.5 py-1.5 rounded-lg text-xs font-mono focus:outline-none focus:border-violet-500"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="text-gray-600 text-xs">.{account.domain}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-gray-600">
              {selectedTargets.size} compte{selectedTargets.size > 1 ? "s" : ""} sélectionné{selectedTargets.size > 1 ? "s" : ""}
            </p>
          </div>

          {launchError && (
            <div className="flex items-center gap-3 p-4 bg-red-900/20 border border-red-800/50 rounded-xl text-red-400 text-sm">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              {launchError}
            </div>
          )}

          <div className="flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-all"
            >
              <ChevronLeft className="w-4 h-4" /> Retour
            </button>
            <button
              id="btn-launch-migration"
              disabled={selectedTargets.size === 0 || launching}
              onClick={launch}
              className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-violet-900/30"
            >
              {launching ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Lancement…</>
              ) : (
                <><PlayCircle className="w-4 h-4" /> Lancer la migration ({selectedTargets.size})</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Live tracking ────────────────────────────────────────────── */}
      {step === 3 && activeJob && (
        <div className="space-y-5">
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-white">Migration en cours</h2>
                <p className="text-xs text-gray-500 font-mono mt-0.5">Job ID: {activeJob.id}</p>
              </div>
              <div className="flex items-center gap-3">
                {isJobRunning(activeJob) && (
                  <span className="flex items-center gap-1.5 text-blue-400 text-xs">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> En cours…
                  </span>
                )}
                <button
                  onClick={() => pollJob(activeJob.id)}
                  className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 transition-all"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="divide-y divide-gray-800">
              {activeJob.targets.map((target) => {
                const logKey = `${activeJob.id}-${target.user}`;
                const logsOpen = expandedLogs.has(logKey);
                return (
                  <div key={target.user} className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <StatusIcon status={target.status} />
                        <div className="min-w-0">
                          <p className="text-white font-semibold text-sm">{target.user}</p>
                          <p className="text-gray-600 text-xs font-mono truncate">
                            {target.subdomain}.{target.domain}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-xs font-medium px-2 py-1 rounded-lg ${
                          target.status === "done" ? "bg-emerald-900/30 text-emerald-400" :
                          target.status === "error" ? "bg-red-900/30 text-red-400" :
                          target.status === "running" ? "bg-blue-900/30 text-blue-400" :
                          "bg-gray-800 text-gray-500"
                        }`}>
                          {statusLabel[target.status]}
                        </span>
                        {target.targetUrl && (
                          <a
                            href={`${target.targetUrl}/wp-admin/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-emerald-400 transition-all"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {target.logs.length > 0 && (
                          <button
                            onClick={() => toggleLogs(logKey)}
                            className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-all"
                          >
                            {logsOpen ? "Cacher logs" : `Logs (${target.logs.length})`}
                          </button>
                        )}
                      </div>
                    </div>

                    {target.error && (
                      <p className="text-red-400 text-xs bg-red-900/20 border border-red-900/30 rounded-lg px-3 py-2">
                        {target.error}
                      </p>
                    )}

                    {logsOpen && target.logs.length > 0 && (
                      <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 font-mono text-xs text-gray-400 space-y-0.5 max-h-48 overflow-y-auto">
                        {target.logs.map((log, i) => (
                          <div key={i} className={log.includes("❌") ? "text-red-400" : log.includes("✅") ? "text-emerald-400" : ""}>
                            {log}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between">
            <button
              onClick={() => { setStep(1); setSelectedInstall(null); setSelectedTargets(new Map()); }}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-all"
            >
              <ChevronLeft className="w-4 h-4" /> Nouvelle migration
            </button>
          </div>
        </div>
      )}

      {/* ── Past jobs ────────────────────────────────────────────────────────── */}
      {pastJobs.length > 0 && step === 1 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">Historique</h3>
            <button
              onClick={loadPastJobs}
              className="p-1.5 rounded-lg text-gray-600 hover:text-gray-400 hover:bg-gray-800 transition-all"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-2">
            {pastJobs.slice(0, 10).map((job) => {
              const doneCount = job.targets.filter((t) => t.status === "done").length;
              const errCount = job.targets.filter((t) => t.status === "error").length;
              const running = isJobRunning(job);
              return (
                <div key={job.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <Server className="w-4 h-4 text-gray-600 flex-shrink-0" />
                        <p className="text-white text-sm font-semibold truncate">{job.sourceUrl}</p>
                        {running && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />}
                      </div>
                      <p className="text-gray-600 text-xs">
                        {new Date(job.createdAt).toLocaleString("fr-FR")} •
                        {job.targets.length} cible{job.targets.length > 1 ? "s" : ""} •
                        <span className="text-emerald-500 ml-1">{doneCount} OK</span>
                        {errCount > 0 && <span className="text-red-400 ml-1">{errCount} erreur{errCount > 1 ? "s" : ""}</span>}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={() => { setActiveJob(job); setStep(3); }}
                        className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-all"
                      >
                        Détails
                      </button>
                      <button
                        onClick={() => deleteJob(job.id)}
                        className="p-1.5 rounded-lg bg-gray-800 hover:bg-red-900/30 text-gray-600 hover:text-red-400 transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

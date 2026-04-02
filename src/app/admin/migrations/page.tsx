"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  GitBranchPlus,
  PlayCircle,
  Square,
  Trash2,
} from "lucide-react";

interface AccountItem {
  user: string;
  domain: string;
}

interface InstallationItem {
  id: string;
  name: string;
  app: "wordpress" | "prestashop" | "other";
  url: string;
}

interface MigrationPlan {
  id: string;
  status: "prepared" | "running" | "blocked" | "completed";
  createdAt: string;
  createdBy: string;
  sourceAccount: string;
  sourceInstallationId: string;
  sourceApp: "wordpress" | "prestashop" | "other";
  sourceUrl: string;
  destinationAccount: string;
  destinationDomain: string;
  destinationSubdomain: string;
  targetUrl: string;
  createdTargetSubdomain: boolean;
  checks: string[];
  nextActions: string[];
  execution?: {
    startedAt?: string;
    finishedAt?: string;
    backupTriggered?: boolean;
    backupMessage?: string;
    blockerReason?: string;
    fallbackUsed?: boolean;
    fallbackSummary?: string;
    stopRequestedAt?: string;
    stoppedAt?: string;
    stoppedBy?: string;
    logs?: string[];
  };
}

interface SessionUser {
  username: string;
  role: "superadmin" | "operator";
}

export default function AdminMigrationsPage() {
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [sourceInstallations, setSourceInstallations] = useState<InstallationItem[]>([]);
  const [plans, setPlans] = useState<MigrationPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [installationsLoading, setInstallationsLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [executingId, setExecutingId] = useState("");
  const [stoppingId, setStoppingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [clearingAll, setClearingAll] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preparedPlan, setPreparedPlan] = useState<MigrationPlan | null>(null);

  const [sourceAccount, setSourceAccount] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [destinationAccount, setDestinationAccount] = useState("");
  const [destinationSubdomain, setDestinationSubdomain] = useState("");
  const [createSubdomainIfMissing, setCreateSubdomainIfMissing] = useState(true);

  const destinationDomain = useMemo(() => {
    const account = accounts.find((item) => item.user === destinationAccount);
    return account?.domain ?? "";
  }, [accounts, destinationAccount]);

  const loadAccountsAndPlans = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [sessionRes, accountsRes, plansRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch("/api/accounts"),
        fetch("/api/admin/migrations/cross-account?limit=25"),
      ]);

      const sessionData = await sessionRes.json().catch(() => ({}));
      const accountsData = await accountsRes.json().catch(() => ({}));
      const plansData = await plansRes.json().catch(() => ({}));

      if (!sessionRes.ok || sessionData.error) {
        throw new Error(sessionData.error ?? "Session invalide");
      }
      setSessionUser(sessionData.user as SessionUser);

      if (!accountsRes.ok || accountsData.error) {
        throw new Error(accountsData.error ?? "Impossible de charger les comptes");
      }
      const loadedAccounts = Array.isArray(accountsData.accounts)
        ? (accountsData.accounts as AccountItem[]).sort((a, b) => a.user.localeCompare(b.user))
        : [];
      setAccounts(loadedAccounts);

      if (plansRes.ok && !plansData.error) {
        setPlans(Array.isArray(plansData.plans) ? (plansData.plans as MigrationPlan[]) : []);
      } else {
        setPlans([]);
      }

      if (!sourceAccount && loadedAccounts.length > 0) {
        setSourceAccount(loadedAccounts[0].user);
      }
      if (!destinationAccount && loadedAccounts.length > 1) {
        setDestinationAccount(loadedAccounts[1].user);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  }, [destinationAccount, sourceAccount]);

  const loadSourceInstallations = useCallback(async (user: string) => {
    if (!user) {
      setSourceInstallations([]);
      setSourceRef("");
      return;
    }

    setInstallationsLoading(true);
    try {
      const res = await fetch(`/api/accounts/installations?user=${user}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible de charger les installations source");
      }

      const installations = Array.isArray(data.installations)
        ? (data.installations as InstallationItem[])
        : [];
      setSourceInstallations(installations);
      setSourceRef((prev) => {
        if (prev && installations.some((item) => item.id === prev)) return prev;
        return installations[0]?.id ?? "";
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur lors du chargement des installations");
      setSourceInstallations([]);
      setSourceRef("");
    } finally {
      setInstallationsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccountsAndPlans();
  }, [loadAccountsAndPlans]);

  useEffect(() => {
    void loadSourceInstallations(sourceAccount);
  }, [sourceAccount, loadSourceInstallations]);

  const refreshPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/migrations/cross-account?limit=25");
      const data = await res.json();
      if (res.ok && !data.error && Array.isArray(data.plans)) {
        setPlans(data.plans as MigrationPlan[]);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!preparedPlan) return;
    const latest = plans.find((plan) => plan.id === preparedPlan.id);
    if (latest) {
      setPreparedPlan(latest);
    }
  }, [plans, preparedPlan]);

  const hasRunningPlan = useMemo(
    () => plans.some((plan) => plan.status === "running"),
    [plans],
  );

  useEffect(() => {
    if (!hasRunningPlan) return;

    const timer = window.setInterval(() => {
      void refreshPlans();
    }, 4000);

    return () => window.clearInterval(timer);
  }, [hasRunningPlan, refreshPlans]);

  async function prepareMigration() {
    if (!sourceAccount || !sourceRef || !destinationAccount || !destinationSubdomain || !destinationDomain) {
      setError("Merci de renseigner tous les champs de préparation");
      return;
    }
    setPreparing(true);
    setError("");
    setMessage("");
    setPreparedPlan(null);
    try {
      const res = await fetch("/api/admin/migrations/cross-account/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAccount,
          sourceRef,
          destinationAccount,
          destinationSubdomain,
          destinationDomain,
          createSubdomainIfMissing,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Échec de préparation de migration");
      }

      setPreparedPlan(data.plan as MigrationPlan);
      setMessage(data.message ?? "Migration préparée");
      setDestinationSubdomain("");
      await refreshPlans();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de préparation");
    } finally {
      setPreparing(false);
    }
  }

  async function executePlan(planId: string) {
    setExecutingId(planId);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/migrations/cross-account/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Échec d'exécution du plan");
      }

      const plan = data.plan as MigrationPlan | undefined;
      if (plan) {
        setPreparedPlan(plan);
      }

      if (data.success === false || data.blocked) {
        setError(data.message ?? "Le plan est bloqué");
      } else {
        setMessage(data.message ?? "Exécution lancée");
      }
      await refreshPlans();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur d'exécution");
    } finally {
      setExecutingId("");
    }
  }

  async function stopPlan(planId: string) {
    setStoppingId(planId);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/migrations/cross-account/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible d'arrêter la tentative");
      }

      const plan = data.plan as MigrationPlan | undefined;
      if (plan) {
        setPreparedPlan((prev) => (prev?.id === plan.id ? plan : prev));
      }
      setMessage(data.message ?? "Arrêt demandé");
      await refreshPlans();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur d'arrêt");
    } finally {
      setStoppingId("");
    }
  }

  async function deletePlan(planId: string) {
    if (!window.confirm("Supprimer cette tentative de migration ?")) return;
    setDeletingId(planId);
    setError("");
    setMessage("");
    try {
      const res = await fetch(
        `/api/admin/migrations/cross-account?planId=${encodeURIComponent(planId)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible de supprimer la tentative");
      }

      setPreparedPlan((prev) => (prev?.id === planId ? null : prev));
      setMessage(data.message ?? "Tentative supprimée");
      await refreshPlans();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de suppression");
    } finally {
      setDeletingId("");
    }
  }

  async function clearPlansHistory() {
    if (!window.confirm("Supprimer tout l'historique des tentatives ?")) return;
    setClearingAll(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/migrations/cross-account?all=1", {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible de vider l'historique");
      }

      setPreparedPlan((prev) => {
        if (!prev) return prev;
        const stillThere = plans.some((plan) => plan.id === prev.id && plan.status === "running");
        return stillThere ? prev : null;
      });
      setMessage(data.message ?? "Historique vidé");
      await refreshPlans();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de suppression globale");
    } finally {
      setClearingAll(false);
    }
  }

  function statusBadge(status: MigrationPlan["status"]): string {
    if (status === "completed") return "bg-green-900/40 text-green-300";
    if (status === "running") return "bg-blue-900/40 text-blue-300";
    if (status === "blocked") return "bg-red-900/40 text-red-300";
    return "bg-gray-700/60 text-gray-300";
  }

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6 text-sm text-gray-400">Chargement de la console migrations…</div>
    );
  }

  if (sessionUser?.role !== "superadmin") {
    return (
      <div className="max-w-xl mx-auto p-6">
        <div className="bg-gray-900 border border-red-900/50 rounded-xl p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-white">Accès refusé</h2>
          <p className="text-sm text-gray-400 mt-2">
            Cette fonctionnalité est réservée aux superadministrateurs.
          </p>
          <Link href="/" className="inline-block mt-4 text-sm text-blue-400 hover:text-blue-300">
            Retour au dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <Link href="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-white text-sm transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" /> Retour
        </Link>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Migration inter-compte</h1>
            <p className="text-gray-500 text-sm mt-1">
              Phase 1: préparation du plan. Phase 2: exécution (backup puis restauration).
            </p>
          </div>
          <button
            onClick={() => {
              void loadAccountsAndPlans();
              void loadSourceInstallations(sourceAccount);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium border border-gray-700"
          >
            <RefreshCw className={`w-4 h-4 ${(loading || installationsLoading) ? "animate-spin" : ""}`} />
            Actualiser
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-4 rounded-xl border bg-red-900/20 border-red-800/50 text-red-400">
          <AlertTriangle className="w-5 h-5" />
          <p className="text-sm">{error}</p>
        </div>
      )}
      {message && (
        <div className="flex items-center gap-2 p-4 rounded-xl border bg-green-900/20 border-green-800/50 text-green-400">
          <CheckCircle className="w-5 h-5" />
          <p className="text-sm">{message}</p>
        </div>
      )}

      <div className="p-4 rounded-xl border bg-blue-900/10 border-blue-800/40 text-blue-200 text-sm">
        Après « Préparer la migration », utilise le bouton « Lancer phase 2 » dans « Dernier plan préparé ».
        Si le statut passe à <span className="font-semibold">blocked</span> avec <span className="font-semibold">off_backup_restore</span>,
        l&apos;hébergeur doit activer Backup/Restore dans Softaculous.
      </div>

      <div className="grid lg:grid-cols-[1fr,1fr] gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold">
            <GitBranchPlus className="w-4 h-4 text-blue-400" />
            Préparer une migration
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Compte source</label>
            <select
              value={sourceAccount}
              onChange={(event) => setSourceAccount(event.target.value)}
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">Choisir un compte source</option>
              {accounts.map((account) => (
                <option key={account.user} value={account.user}>
                  {account.user}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Installation source</label>
            {installationsLoading ? (
              <div className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-500">
                Chargement des installations…
              </div>
            ) : (
              <select
                value={sourceRef}
                onChange={(event) => setSourceRef(event.target.value)}
                className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">Choisir une installation source</option>
                {sourceInstallations.map((installation) => (
                  <option key={installation.id} value={installation.id}>
                    {installation.name} ({installation.url})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Compte destination</label>
            <select
              value={destinationAccount}
              onChange={(event) => setDestinationAccount(event.target.value)}
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="">Choisir un compte destination</option>
              {accounts
                .filter((account) => account.user !== sourceAccount)
                .map((account) => (
                  <option key={account.user} value={account.user}>
                    {account.user}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Sous-domaine cible</label>
            <div className="flex items-center bg-gray-800 border border-gray-700 rounded-lg overflow-hidden focus-within:border-blue-500">
              <input
                type="text"
                value={destinationSubdomain}
                onChange={(event) =>
                  setDestinationSubdomain(
                    event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                  )
                }
                placeholder="ex: wp-migre"
                className="flex-1 px-3 py-2.5 bg-transparent text-white text-sm placeholder-gray-600 focus:outline-none"
              />
              <span className="px-3 py-2.5 text-gray-500 text-sm border-l border-gray-700 bg-gray-900/40">
                .{destinationDomain || "domaine-cible"}
              </span>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={createSubdomainIfMissing}
              onChange={(event) => setCreateSubdomainIfMissing(event.target.checked)}
              className="accent-blue-500"
            />
            Créer automatiquement le sous-domaine cible s&apos;il est absent
          </label>

          <button
            onClick={() => void prepareMigration()}
            disabled={preparing}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2"
          >
            {preparing ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranchPlus className="w-4 h-4" />}
            {preparing ? "Préparation en cours…" : "Préparer la migration"}
          </button>
        </div>

        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Dernier plan préparé</h2>
            {!preparedPlan ? (
              <p className="text-sm text-gray-500">Aucun plan préparé dans cette session.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <p className="text-gray-300">
                  <span className="text-gray-500">ID:</span> {preparedPlan.id}
                </p>
                <p className="text-gray-300">
                  <span className="text-gray-500">Source:</span> {preparedPlan.sourceAccount} ({preparedPlan.sourceUrl})
                </p>
                <p className="text-gray-300">
                  <span className="text-gray-500">Cible:</span> {preparedPlan.destinationAccount} ({preparedPlan.targetUrl})
                </p>
                <p className="text-gray-300">
                  <span className="text-gray-500">Statut:</span>{" "}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge(preparedPlan.status)}`}>
                    {preparedPlan.status}
                  </span>
                </p>
                {preparedPlan.execution?.backupMessage && (
                  <p className="text-gray-300">
                    <span className="text-gray-500">Backup:</span> {preparedPlan.execution.backupMessage}
                  </p>
                )}
                {preparedPlan.execution?.fallbackSummary && (
                  <p className="text-gray-300">
                    <span className="text-gray-500">Fallback:</span> {preparedPlan.execution.fallbackSummary}
                  </p>
                )}
                {preparedPlan.execution?.blockerReason && (
                  <p className="text-red-300">
                    <span className="text-red-400">Blocage:</span> {preparedPlan.execution.blockerReason}
                  </p>
                )}
                {preparedPlan.execution?.stoppedBy && (
                  <p className="text-amber-300">
                    <span className="text-amber-400">Arrêt:</span> demandé par {preparedPlan.execution.stoppedBy}
                  </p>
                )}
                <div>
                  <p className="text-gray-500 mb-1">Vérifications</p>
                  <ul className="space-y-1">
                    {preparedPlan.checks.map((check) => (
                      <li key={check} className="text-gray-300">• {check}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-gray-500 mb-1">Étapes suivantes</p>
                  <ul className="space-y-1">
                    {preparedPlan.nextActions.map((action) => (
                      <li key={action} className="text-gray-300">• {action}</li>
                    ))}
                  </ul>
                </div>
                {preparedPlan.execution?.logs && preparedPlan.execution.logs.length > 0 && (
                  <div>
                    <p className="text-gray-500 mb-1">Journal d&apos;exécution</p>
                    <div className="max-h-40 overflow-auto pr-1 space-y-1">
                      {preparedPlan.execution.logs.slice(-8).map((log) => (
                        <p key={log} className="text-xs text-gray-400">{log}</p>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void executePlan(preparedPlan.id)}
                    disabled={
                      executingId === preparedPlan.id
                      || stoppingId === preparedPlan.id
                      || preparedPlan.status === "running"
                    }
                    className="flex-1 min-w-[180px] py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    {executingId === preparedPlan.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                    {executingId === preparedPlan.id ? "Exécution…" : "Lancer phase 2"}
                  </button>

                  <button
                    onClick={() => void stopPlan(preparedPlan.id)}
                    disabled={
                      preparedPlan.status !== "running"
                      || stoppingId === preparedPlan.id
                      || deletingId === preparedPlan.id
                    }
                    className="px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    {stoppingId === preparedPlan.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                    Arrêter
                  </button>

                  <button
                    onClick={() => void deletePlan(preparedPlan.id)}
                    disabled={
                      preparedPlan.status === "running"
                      || deletingId === preparedPlan.id
                      || stoppingId === preparedPlan.id
                    }
                    className="px-4 py-2.5 bg-red-700/90 hover:bg-red-600 disabled:opacity-40 text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    {deletingId === preparedPlan.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    Supprimer
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-white">Historique des plans</h2>
              <button
                onClick={() => void clearPlansHistory()}
                disabled={plans.length === 0 || hasRunningPlan || clearingAll}
                className="px-3 py-1.5 rounded-md bg-red-700/80 hover:bg-red-600 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                {clearingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Vider
              </button>
            </div>
            {plans.length === 0 ? (
              <p className="text-sm text-gray-500">Aucun plan enregistré.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-auto pr-1">
                {plans.map((plan) => (
                  <div key={plan.id} className="bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-400">{new Date(plan.createdAt).toLocaleString("fr-FR")}</p>
                        <p className="text-sm text-gray-100">{plan.sourceAccount} → {plan.destinationAccount}</p>
                        <p className="text-xs text-gray-500 truncate">{plan.targetUrl}</p>
                        {plan.execution?.backupMessage && (
                          <p className="text-[11px] text-gray-400 mt-1">{plan.execution.backupMessage}</p>
                        )}
                        {plan.execution?.fallbackSummary && (
                          <p className="text-[11px] text-gray-400 mt-1">{plan.execution.fallbackSummary}</p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${statusBadge(plan.status)}`}>
                          {plan.status}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => void executePlan(plan.id)}
                            disabled={executingId === plan.id || plan.status === "running"}
                            className="px-2.5 py-1 rounded-md bg-indigo-600/90 hover:bg-indigo-500 disabled:opacity-40 text-white text-[11px] font-semibold"
                          >
                            {executingId === plan.id ? "Exécution…" : "Exécuter"}
                          </button>
                          <button
                            onClick={() => void stopPlan(plan.id)}
                            disabled={plan.status !== "running" || stoppingId === plan.id}
                            className="px-2.5 py-1 rounded-md bg-amber-600/90 hover:bg-amber-500 disabled:opacity-40 text-white text-[11px] font-semibold"
                          >
                            {stoppingId === plan.id ? "Arrêt…" : "Arrêter"}
                          </button>
                          <button
                            onClick={() => void deletePlan(plan.id)}
                            disabled={plan.status === "running" || deletingId === plan.id}
                            className="px-2.5 py-1 rounded-md bg-red-700/90 hover:bg-red-600 disabled:opacity-40 text-white text-[11px] font-semibold"
                          >
                            {deletingId === plan.id ? "Suppression…" : "Supprimer"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

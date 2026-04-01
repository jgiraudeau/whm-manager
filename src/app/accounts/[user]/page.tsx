"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
    ArrowLeft, Globe, Mail, HardDrive, Calendar, ExternalLink,
    Pause, Play, Trash2, LogIn, AlertTriangle, CheckCircle, Copy, Loader2, Plus, Copy as CopyIcon, RefreshCw
} from "lucide-react";

interface Account {
    user: string;
    domain: string;
    email: string;
    diskused: string;
    disklimit: string;
    plan: string;
    suspendreason: string;
    startdate: string;
    ip: string;
    maxsql: string;
    maxpop: string;
}

interface SoftInstall {
    id: string;
    name: string;
    url: string;
    path: string;
}

interface InstallResult {
    app: string;
    siteUrl: string;
    adminUrl: string;
    adminUser: string;
    adminPass: string;
    adminEmail: string;
}

function normalizeHost(input: string): string {
    const raw = input.trim();
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

export default function AccountDetailPage() {
    const { user } = useParams<{ user: string }>();
    const router = useRouter();
    const [account, setAccount] = useState<Account | null>(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState("");
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const [installResult, setInstallResult] = useState<InstallResult | null>(null);
    const [copiedKey, setCopiedKey] = useState("");
    const [installDomains, setInstallDomains] = useState<string[]>([]);
    const [selectedInstallDomain, setSelectedInstallDomain] = useState("");

    // AutoSSL state
    const [autoSSLStatus, setAutoSSLStatus] = useState<{ isRunning: boolean; lastLog: string; result: string } | null>(null);

    // Subdomain state
    const [subdomainName, setSubdomainName] = useState("");
    const [subdomainLoading, setSubdomainLoading] = useState(false);
    const [subdomainMsg, setSubdomainMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

    // Clone state
    const [cloneSourceUrl, setCloneSourceUrl] = useState("");
    const [cloneSubdomain, setCloneSubdomain] = useState("");
    const [cloneLoading, setCloneLoading] = useState(false);
    const [cloneStep, setCloneStep] = useState(0); // 0: idle, 1: preparation, 2: cloning, 3: finishing
    const [cloneMsg, setCloneMsg] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
    const [cloneChecking, setCloneChecking] = useState(false);
    const [installations, setInstallations] = useState<SoftInstall[]>([]);
    const [installationsLoading, setInstallationsLoading] = useState(false);

    const fetchAutoSSLStatus = useCallback(async () => {
        try {
            const res = await fetch(`/api/accounts/autossl-status?user=${user}`);
            const data = await res.json();
            if (!data.error) setAutoSSLStatus(data);
        } catch {
            // Silently fail for polling
        }
    }, [user]);

    const loadInstallations = useCallback(async (withLoader = false): Promise<SoftInstall[]> => {
        if (withLoader) setInstallationsLoading(true);
        try {
            const res = await fetch(`/api/accounts/installations?user=${user}`);
            const data = await res.json();
            const list = Array.isArray(data.installations) ? data.installations as SoftInstall[] : [];
            setInstallations(list);
            return list;
        } catch {
            return [];
        } finally {
            if (withLoader) setInstallationsLoading(false);
        }
    }, [user]);

    const monitorCloneCompletion = useCallback(async (targetHost: string) => {
        const normalizedTarget = normalizeHost(targetHost);
        if (!normalizedTarget) return;

        setCloneChecking(true);
        try {
            for (let attempt = 1; attempt <= 12; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                const latestInstallations = await loadInstallations(false);
                const found = latestInstallations.some((install) => normalizeHost(install.url) === normalizedTarget);
                if (found) {
                    setCloneMsg({ type: "success", text: `Clonage terminé : ${targetHost}` });
                    return;
                }
                setCloneMsg({ type: "info", text: `Clonage lancé en arrière-plan… vérification (${attempt}/12)` });
            }
            setCloneMsg({
                type: "info",
                text: `Clonage lancé en arrière-plan pour ${targetHost}. Vérifie dans 2 à 5 minutes puis rafraîchis.`,
            });
        } finally {
            setCloneChecking(false);
        }
    }, [loadInstallations]);

    useEffect(() => {
        setLoading(true);
        fetch("/api/accounts")
            .then(r => r.json())
            .then(data => {
                const found = data.accounts?.find((a: Account) => a.user === user);
                setAccount(found || null);
                setLoading(false);
            });

        // Fetch domains for installation
        fetch(`/api/accounts/domains?user=${user}`)
            .then(r => r.json())
            .then(data => {
                if (data.domains?.length) {
                    setInstallDomains(data.domains);
                    setSelectedInstallDomain(data.domains[0]);
                }
            })
            .catch(console.error);

        // Fetch installations for cloning
        void loadInstallations(true);

        // Initial AutoSSL status check
        fetchAutoSSLStatus();
    }, [user, fetchAutoSSLStatus, loadInstallations]);

    // Polling for AutoSSL
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (autoSSLStatus?.isRunning || actionLoading === "autossl") {
            interval = setInterval(fetchAutoSSLStatus, 5000);
        }
        return () => clearInterval(interval);
    }, [autoSSLStatus?.isRunning, actionLoading, fetchAutoSSLStatus]);

    const doAction = async (action: "suspend" | "unsuspend" | "delete") => {
        if (action === "delete" && !confirm(`Supprimer définitivement le compte "${user}" ?`)) return;
        setActionLoading(action);
        setMessage(null);
        try {
            const res = await fetch("/api/accounts/suspend", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user, action }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (action === "delete") { router.push("/"); return; }
            setMessage({ type: "success", text: action === "suspend" ? "Compte suspendu" : "Compte réactivé" });
            const r2 = await fetch("/api/accounts");
            const d2 = await r2.json();
            setAccount(d2.accounts?.find((a: Account) => a.user === user) || null);
        } catch (e: unknown) {
            const err = e as Error;
            setMessage({ type: "error", text: err.message });
        } finally {
            setActionLoading("");
        }
    };

    const runAutoSSL = async () => {
        setActionLoading("autossl");
        setMessage(null);
        try {
            const res = await fetch("/api/accounts/autossl", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setMessage({ type: "success", text: "Vérification AutoSSL lancée." });
            fetchAutoSSLStatus();
        } catch (e: unknown) {
            const err = e as Error;
            setMessage({ type: "error", text: err.message });
        } finally {
            setActionLoading("");
        }
    };

    const openCPanel = async () => {
        setActionLoading("login");
        try {
            const res = await fetch(`/api/accounts/login-url?user=${user}`);
            const data = await res.json();
            if (data.url) window.open(data.url, "_blank");
            else setMessage({ type: "error", text: "Impossible de générer le lien de connexion" });
        } catch (e: unknown) {
            const err = e as Error;
            setMessage({ type: "error", text: err.message });
        } finally {
            setActionLoading("");
        }
    };

    const installApp = async (app: "wordpress" | "prestashop") => {
        setActionLoading(`install_${app}`);
        setMessage(null);
        try {
            const res = await fetch("/api/accounts/install", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user, app, adminEmail: account?.email, targetDomain: selectedInstallDomain }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setInstallResult(data);
        } catch (e: unknown) {
            const err = e as Error;
            setMessage({ type: "error", text: err.message });
        } finally {
            setActionLoading("");
        }
    };

    const createSubdomain = async () => {
        if (!subdomainName) return;
        setSubdomainLoading(true);
        setSubdomainMsg(null);
        try {
            const res = await fetch("/api/accounts/subdomain", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user, subdomain: subdomainName, domain: account?.domain }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setSubdomainMsg({ type: "success", text: `Sous-domaine créé : ${subdomainName}.${account?.domain}` });
            setSubdomainName("");
        } catch (e: unknown) {
            const err = e as Error;
            setSubdomainMsg({ type: "error", text: err.message });
        } finally {
            setSubdomainLoading(false);
        }
    };

    const cloneSite = async () => {
        if (!cloneSourceUrl || !cloneSubdomain) return;
        const accountDomain = account?.domain;
        if (!accountDomain) return;

        setCloneLoading(true);
        setCloneMsg(null);
        setCloneStep(1); // Preparation

        try {
            await new Promise(r => setTimeout(r, 1000)); // Visual pause
            setCloneStep(2); // Cloning

            const res = await fetch("/api/accounts/clone", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user, sourceRef: cloneSourceUrl, targetSubdomain: cloneSubdomain, domain: accountDomain }),
            });
            const data = await res.json();
            if (!res.ok || data.error || data.success === false) {
                throw new Error(data.error || data.message || "Le clonage n'a pas été confirmé");
            }

            setCloneStep(3); // Finishing
            await new Promise(r => setTimeout(r, 2000)); // Mimic propagation

            if (data.pending) {
                const targetHost = `${cloneSubdomain}.${accountDomain}`;
                setCloneMsg({
                    type: "info",
                    text: data.message || `Clonage lancé vers ${targetHost}. Vérification automatique en cours…`,
                });
                setCloneSubdomain("");
                void monitorCloneCompletion(targetHost);
            } else {
                setCloneMsg({
                    type: "success",
                    text: data.message || `Site cloné vers ${cloneSubdomain}.${accountDomain}`,
                });
                setCloneSubdomain("");
                await loadInstallations(false);
            }
        } catch (e: unknown) {
            const err = e as Error;
            setCloneMsg({ type: "error", text: err.message });
        } finally {
            setCloneLoading(false);
            setCloneStep(0);
        }
    };

    const copyToClipboard = (key: string, value: string) => {
        navigator.clipboard.writeText(value);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(""), 2000);
    };

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
    );

    if (!account) return (
        <div className="text-center py-20">
            <p className="text-gray-500">Compte &quot;{user}&quot; introuvable.</p>
            <Link href="/" className="text-blue-400 text-sm mt-2 inline-block">← Retour</Link>
        </div>
    );

    const isSuspended = account.suspendreason !== "not suspended";

    // Disk usage calculation
    const diskUsedValue = parseFloat(account.diskused.replace(/[^\d.]/g, ""));
    const diskLimitValue = account.disklimit === "unlimited" ? 0 : parseFloat(account.disklimit.replace(/[^\d.]/g, ""));
    const diskPercent = diskLimitValue > 0 ? Math.min(100, (diskUsedValue / diskLimitValue) * 100) : 0;

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            {/* Header */}
            <div>
                <Link href="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-white text-sm transition-colors mb-4">
                    <ArrowLeft className="w-4 h-4" /> Retour au dashboard
                </Link>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 bg-blue-900/50 rounded-xl flex items-center justify-center text-blue-400 font-bold text-xl uppercase">
                            {account.user.slice(0, 2)}
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-white">{account.user}</h1>
                            <div className="flex items-center gap-2 mt-1">
                                {isSuspended ? (
                                    <span className="px-2 py-0.5 bg-red-900/40 text-red-400 text-xs rounded-full font-medium">Suspendu</span>
                                ) : (
                                    <span className="px-2 py-0.5 bg-green-900/40 text-green-400 text-xs rounded-full font-medium">Actif</span>
                                )}
                                <span className="text-gray-600 text-xs">{account.plan}</span>
                            </div>
                        </div>
                    </div>
                    {/* AutoSSL Floating Status */}
                    {autoSSLStatus && (
                        <div className={`px-4 py-2 rounded-xl border flex items-center gap-3 transition-all ${autoSSLStatus.isRunning ? "bg-blue-900/20 border-blue-800/50" : "bg-gray-900 border-gray-800"}`}>
                            {autoSSLStatus.isRunning ? (
                                <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                            ) : (
                                <div className={`w-2 h-2 rounded-full ${autoSSLStatus.result === "success" ? "bg-green-500" : "bg-gray-500"}`} />
                            )}
                            <div className="min-w-0">
                                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Statut SSL</p>
                                <p className="text-xs text-white font-medium truncate max-w-[150px]">{autoSSLStatus.isRunning ? "Analyse en cours..." : autoSSLStatus.lastLog.split('&prime;')[0].slice(0, 30)}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {message && (
                <div className={`flex items-center gap-2 p-4 rounded-xl border animate-in slide-in-from-top-2 duration-300 ${message.type === "success"
                    ? "bg-green-900/20 border-green-800/50 text-green-400"
                    : "bg-red-900/20 border-red-800/50 text-red-400"}`}>
                    {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                    <p className="text-sm font-medium">{message.text}</p>
                </div>
            )}

            {/* Install Result */}
            {installResult && (
                <div className="bg-gray-900 border border-green-700/50 rounded-xl overflow-hidden shadow-2xl shadow-green-900/20">
                    <div className="bg-green-900/20 px-6 py-4 border-b border-green-700/30 flex items-center gap-3">
                        <CheckCircle className="w-5 h-5 text-green-400" />
                        <div>
                            <h3 className="font-bold text-green-300">{installResult.app} installé !</h3>
                            <p className="text-xs text-green-500">Conservez ces identifiants.</p>
                        </div>
                    </div>
                    <div className="p-5 grid gap-2.5">
                        {[
                            { label: "🌐 URL du site", key: "siteUrl", value: installResult.siteUrl },
                            { label: "🔧 URL admin", key: "adminUrl", value: installResult.adminUrl },
                            { label: "👤 Login", key: "adminUser", value: installResult.adminUser },
                            { label: "🔑 Mot de passe", key: "adminPass", value: installResult.adminPass },
                        ].map(({ label, key, value }) => (
                            <div key={key} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2.5 group">
                                <div className="min-w-0">
                                    <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">{label}</p>
                                    <p className="text-sm font-mono text-white truncate">{value}</p>
                                </div>
                                <button onClick={() => copyToClipboard(key, value)}
                                    className={`p-2 rounded-lg transition-all ${copiedKey === key ? "bg-green-500/10 text-green-400" : "text-gray-500 hover:text-blue-400 hover:bg-gray-700"}`}>
                                    {copiedKey === key ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </button>
                            </div>
                        ))}
                        <div className="flex gap-3 mt-2">
                            <a href={installResult.adminUrl} target="_blank"
                                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold text-center transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30">
                                <ExternalLink className="w-4 h-4" /> Ouvrir l&apos;admin
                            </a>
                            <button onClick={() => setInstallResult(null)}
                                className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg text-sm font-medium transition-all border border-gray-700">
                                Fermer
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Info cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {[
                    { icon: Globe, label: "Domaine", value: account.domain, link: `http://${account.domain}` },
                    { icon: Mail, label: "Email", value: account.email, link: null },
                    {
                        icon: HardDrive,
                        label: "Espace disque",
                        value: account.disklimit === "unlimited" ? `${account.diskused} / ∞` : `${account.diskused} / ${account.disklimit}`,
                        link: null,
                        progress: diskPercent
                    },
                    { icon: Calendar, label: "Créé le", value: account.startdate, link: null },
                    { icon: Globe, label: "IP", value: account.ip, link: null },
                    { icon: HardDrive, label: "Bases SQL", value: `${account.maxsql} max`, link: null },
                ].map(({ icon: Icon, label, value, link, progress }) => (
                    <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col justify-between">
                        <div>
                            <div className="flex items-center gap-2 mb-1.5">
                                <Icon className="w-3.5 h-3.5 text-gray-500" />
                                <span className="text-xs text-gray-500 uppercase font-bold tracking-tight">{label}</span>
                            </div>
                            {link ? (
                                <a href={link} target="_blank" className="text-sm text-blue-400 hover:underline flex items-center gap-1 font-medium truncate">
                                    {value} <ExternalLink className="w-3 h-3" />
                                </a>
                            ) : (
                                <p className="text-sm text-white font-medium truncate">{value}</p>
                            )}
                        </div>
                        {progress !== undefined && progress > 0 && (
                            <div className="mt-3">
                                <div className="w-full bg-gray-800 h-1.5 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full rounded-full transition-all duration-500 ${progress > 90 ? "bg-red-500" : progress > 70 ? "bg-yellow-500" : "bg-blue-500"}`}
                                        style={{ width: `${progress}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* One-click Install */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
                    <div>
                        <h2 className="font-semibold text-white">Installation en 1 clic</h2>
                        <p className="text-gray-500 text-xs mt-1">Softaculous installe et configure automatiquement l&apos;application sur le domaine de votre choix au niveau de la racine.</p>
                    </div>
                    {installDomains.length > 0 && (
                        <select
                            value={selectedInstallDomain}
                            onChange={(e) => setSelectedInstallDomain(e.target.value)}
                            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 min-w-[200px]"
                        >
                            {installDomains.map(d => (
                                <option key={d} value={d}>{d}</option>
                            ))}
                        </select>
                    )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => installApp("wordpress")} disabled={!!actionLoading}
                        className="flex flex-col items-center gap-3 p-5 bg-blue-950/20 hover:bg-blue-950/40 border border-blue-900/30 hover:border-blue-600/50 rounded-xl transition-all disabled:opacity-40 group relative overflow-hidden">
                        <div className="text-3xl group-hover:scale-110 transition-transform duration-300">🔵</div>
                        <div className="text-center z-10">
                            <p className="font-bold text-white text-sm">WordPress</p>
                            <p className="text-[10px] text-blue-400 uppercase tracking-wider font-bold mt-0.5">CMS · Blog</p>
                        </div>
                        {actionLoading === "install_wordpress"
                            ? <div className="flex items-center gap-1 text-xs text-blue-400 mt-1"><Loader2 className="w-3 h-3 animate-spin" /> Installation...</div>
                            : <span className="text-xs text-gray-500 group-hover:text-blue-400 transition-colors mt-1">Installer →</span>}
                    </button>
                    <button onClick={() => installApp("prestashop")} disabled={!!actionLoading}
                        className="flex flex-col items-center gap-3 p-5 bg-pink-950/20 hover:bg-pink-950/40 border border-pink-900/30 hover:border-pink-600/50 rounded-xl transition-all disabled:opacity-40 group relative overflow-hidden">
                        <div className="text-3xl group-hover:scale-110 transition-transform duration-300">🛒</div>
                        <div className="text-center z-10">
                            <p className="font-bold text-white text-sm">PrestaShop</p>
                            <p className="text-[10px] text-pink-400 uppercase tracking-wider font-bold mt-0.5">E-commerce</p>
                        </div>
                        {actionLoading === "install_prestashop"
                            ? <div className="flex items-center gap-1 text-xs text-pink-400 mt-1"><Loader2 className="w-3 h-3 animate-spin" /> Installation...</div>
                            : <span className="text-xs text-gray-500 group-hover:text-pink-400 transition-colors mt-1">Installer →</span>}
                    </button>
                </div>
            </div>

            {/* Subdomains */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
                <h2 className="font-semibold text-white mb-1">Créer un sous-domaine</h2>
                <p className="text-gray-500 text-xs mb-4">Ajoute un sous-domaine sur le compte <span className="text-gray-400 font-medium">{account.domain}</span>.</p>
                <div className="flex gap-3">
                    <div className="flex-1 flex items-center bg-gray-800 border border-gray-700 rounded-lg overflow-hidden focus-within:border-blue-500 transition-all shadow-inner">
                        <input
                            type="text"
                            placeholder="ex: thomas"
                            value={subdomainName}
                            onChange={e => setSubdomainName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                            className="flex-1 bg-transparent px-4 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none"
                        />
                        <span className="px-3 text-gray-500 text-sm border-l border-gray-700 py-2.5 bg-gray-900/30 font-medium">.{account.domain}</span>
                    </div>
                    <button
                        onClick={createSubdomain}
                        disabled={subdomainLoading || !subdomainName}
                        className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-indigo-900/30"
                    >
                        {subdomainLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                        Créer
                    </button>
                </div>
                {subdomainMsg && (
                    <div className={`flex items-center gap-2 mt-3 px-3 py-2 rounded-lg text-xs font-medium animate-in fade-in duration-300 ${subdomainMsg.type === "success" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                        {subdomainMsg.type === "success" ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                        {subdomainMsg.text}
                    </div>
                )}
            </div>

            {/* Clone site */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm overflow-hidden relative">
                {cloneLoading && (
                    <div className="absolute inset-0 bg-gray-900/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-300">
                        <div className="w-full max-w-xs space-y-6">
                            <div className="relative">
                                <RefreshCw className="w-10 h-10 text-purple-500 animate-spin mx-auto" />
                                <div className="absolute inset-0 bg-purple-500/20 blur-xl rounded-full" />
                            </div>
                            <div className="space-y-2">
                                <h3 className="text-lg font-bold text-white">Clonage du site</h3>
                                <p className="text-sm text-gray-400">Cette opération peut prendre quelques minutes.</p>
                            </div>
                            {/* Stepper */}
                            <div className="flex items-center justify-between relative px-2">
                                <div className="absolute top-4 left-0 right-0 h-0.5 bg-gray-800 -z-10" />
                                {[
                                    { step: 1, label: "Préparation" },
                                    { step: 2, label: "Clonage" },
                                    { step: 3, label: "Finalisation" }
                                ].map(({ step, label }) => (
                                    <div key={step} className="flex flex-col items-center gap-2">
                                        <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all ${cloneStep >= step ? "bg-purple-600 border-purple-500 text-white" : "bg-gray-800 border-gray-700 text-gray-500"
                                            }`}>
                                            {cloneStep > step ? <CheckCircle className="w-4 h-4" /> : step}
                                        </div>
                                        <span className={`text-[10px] font-bold uppercase tracking-wider ${cloneStep === step ? "text-purple-400" : "text-gray-500"}`}>{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                <h2 className="font-semibold text-white mb-1">Cloner un site</h2>
                <p className="text-gray-500 text-xs mb-4">Duplique un site existant vers un nouveau sous-domaine.</p>
                <div className="space-y-4">
                    <div>
                        <label className="block text-[10px] uppercase font-bold tracking-wider text-gray-500 mb-1.5">Site source à dupliquer</label>
                        {installationsLoading ? (
                            <div className="w-full h-10 bg-gray-800 animate-pulse rounded-lg" />
                        ) : installations.length > 0 ? (
                            <select
                                value={cloneSourceUrl}
                                onChange={e => setCloneSourceUrl(e.target.value)}
                                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500 transition-all cursor-pointer"
                            >
                                <option value="">--- Sélectionner une installation ---</option>
                                {installations.map(ins => (
                                    <option key={ins.id} value={ins.id}>{ins.name} ({ins.url})</option>
                                ))}
                            </select>
                        ) : (
                            <div className="relative">
                                <input
                                    type="url"
                                    placeholder="https://..."
                                    value={cloneSourceUrl}
                                    onChange={e => setCloneSourceUrl(e.target.value)}
                                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-purple-500 transition-all"
                                />
                                <p className="text-[10px] text-gray-600 mt-1">Aucune installation détectée automatiquement. Entrez l&apos;URL manuellement.</p>
                            </div>
                        )}
                    </div>
                    <div className="flex gap-3">
                        <div className="flex-1 flex items-center bg-gray-800 border border-gray-700 rounded-lg overflow-hidden focus-within:border-purple-500 transition-all shadow-inner">
                            <input
                                type="text"
                                placeholder="ex: clone"
                                value={cloneSubdomain}
                                onChange={e => setCloneSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                                className="flex-1 bg-transparent px-4 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none"
                            />
                            <span className="px-3 text-gray-500 text-sm border-l border-gray-700 py-2.5 bg-gray-900/30 font-medium">.{account.domain}</span>
                        </div>
                        <button
                            onClick={cloneSite}
                            disabled={cloneLoading || cloneChecking || !cloneSourceUrl || !cloneSubdomain}
                            className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-purple-900/30"
                        >
                            {cloneLoading || cloneChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <CopyIcon className="w-4 h-4" />}
                            {cloneChecking ? "Vérification..." : "Cloner"}
                        </button>
                    </div>
                </div>
                {cloneMsg && (
                    <div className={`flex items-center gap-2 mt-4 px-3 py-2 rounded-lg text-xs font-medium animate-in fade-in duration-300 ${cloneMsg.type === "success" ? "bg-green-500/10 text-green-400" : cloneMsg.type === "info" ? "bg-blue-500/10 text-blue-300" : "bg-red-500/10 text-red-400"}`}>
                        {cloneMsg.type === "success" ? <CheckCircle className="w-3 h-3" /> : cloneMsg.type === "info" ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlertTriangle className="w-3 h-3" />}
                        {cloneMsg.text}
                    </div>
                )}
            </div>

            {/* Admin Actions */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
                <h2 className="font-semibold text-white mb-4">Actions administrateur</h2>
                <div className="flex flex-wrap gap-3">
                    <button onClick={openCPanel} disabled={!!actionLoading}
                        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all shadow-md shadow-blue-950/40">
                        <LogIn className="w-4 h-4" />
                        {actionLoading === "login" ? "Connexion..." : "Ouvrir cPanel"}
                    </button>

                    <button onClick={runAutoSSL} disabled={!!actionLoading || autoSSLStatus?.isRunning}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all shadow-md ${autoSSLStatus?.isRunning
                            ? "bg-gray-800 text-gray-500 cursor-not-allowed border border-gray-700"
                            : "bg-teal-600 hover:bg-teal-500 text-white shadow-teal-950/40"
                            }`}>
                        <RefreshCw className={`w-4 h-4 ${actionLoading === "autossl" || autoSSLStatus?.isRunning ? "animate-spin" : ""}`} />
                        {autoSSLStatus?.isRunning ? "Analyse SSL..." : "Lancer AutoSSL"}
                    </button>

                    {isSuspended ? (
                        <button onClick={() => doAction("unsuspend")} disabled={!!actionLoading}
                            className="flex items-center gap-2 px-4 py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all shadow-md shadow-green-950/40">
                            <Play className="w-4 h-4" />
                            {actionLoading === "unsuspend" ? "Réactivation..." : "Réactiver le compte"}
                        </button>
                    ) : (
                        <button onClick={() => doAction("suspend")} disabled={!!actionLoading}
                            className="flex items-center gap-2 px-4 py-2.5 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all shadow-md shadow-yellow-950/40">
                            <Pause className="w-4 h-4" />
                            {actionLoading === "suspend" ? "Suspension..." : "Suspendre le compte"}
                        </button>
                    )}

                    <button onClick={() => doAction("delete")} disabled={!!actionLoading}
                        className="flex items-center gap-2 px-4 py-2.5 bg-red-900/40 hover:bg-red-800/60 disabled:opacity-40 text-red-400 border border-red-800/50 rounded-lg text-sm font-bold transition-all ml-auto">
                        <Trash2 className="w-4 h-4" />
                        {actionLoading === "delete" ? "Suppression..." : "Supprimer définitivement"}
                    </button>
                </div>
            </div>
        </div>
    );
}

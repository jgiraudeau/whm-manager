"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { HardDrive, Users, AlertCircle, ExternalLink, PlusCircle, RefreshCw, ChevronRight } from "lucide-react";

interface Account {
  user: string;
  domain: string;
  email: string;
  diskused: string;
  disklimit: string;
  plan: string;
  suspendreason: string;
  startdate: string;
}

interface SessionUser {
  username: string;
  role: "superadmin" | "operator";
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);

  const fetchAccounts = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAccounts(data.accounts);
    } catch (e: unknown) {
      const err = e as Error;
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAccounts(); }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.user) setSessionUser(data.user as SessionUser);
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const suspended = accounts.filter(a => a.suspendreason !== "not suspended");
  const active = accounts.filter(a => a.suspendreason === "not suspended");

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Gestion des comptes cPanel · o2switch</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={fetchAccounts}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-all border border-gray-700"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Actualiser
          </button>
          {sessionUser?.role === "superadmin" && (
            <Link href="/accounts/new">
              <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-blue-900/30">
                <PlusCircle className="w-4 h-4" />
                Nouveau compte
              </button>
            </Link>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">Comptes total</span>
            <div className="w-8 h-8 bg-blue-900/40 rounded-lg flex items-center justify-center">
              <Users className="w-4 h-4 text-blue-400" />
            </div>
          </div>
          <div className="text-3xl font-black text-white">{accounts.length}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">Actifs</span>
            <div className="w-8 h-8 bg-green-900/40 rounded-lg flex items-center justify-center">
              <HardDrive className="w-4 h-4 text-green-400" />
            </div>
          </div>
          <div className="text-3xl font-black text-green-400">{active.length}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">Suspendus</span>
            <div className="w-8 h-8 bg-red-900/40 rounded-lg flex items-center justify-center">
              <AlertCircle className="w-4 h-4 text-red-400" />
            </div>
          </div>
          <div className="text-3xl font-black text-red-400">{suspended.length}</div>
        </div>
      </div>

      {/* Accounts Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800">
          <h2 className="font-semibold text-white">Tous les comptes</h2>
        </div>

        {error && (
          <div className="p-6 text-center text-red-400 text-sm">
            <AlertCircle className="w-5 h-5 mx-auto mb-2" />
            {error}
          </div>
        )}

        {loading && !error && (
          <div className="p-12 text-center">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-gray-500 text-sm">Chargement des comptes...</p>
          </div>
        )}

        {!loading && !error && accounts.length > 0 && (
          <div className="divide-y divide-gray-800">
            {accounts.map((account) => {
              const isSuspended = account.suspendreason !== "not suspended";
              return (
                <Link key={account.user} href={`/accounts/${account.user}`}>
                  <div className="flex items-center px-6 py-4 hover:bg-gray-800/50 transition-all group cursor-pointer">
                    {/* Avatar */}
                    <div className="w-10 h-10 rounded-full bg-blue-900/50 text-blue-400 flex items-center justify-center font-bold text-sm mr-4 flex-shrink-0 uppercase">
                      {account.user.slice(0, 2)}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white text-sm">{account.user}</span>
                        {isSuspended ? (
                          <span className="px-2 py-0.5 rounded-full bg-red-900/40 text-red-400 text-xs font-medium">Suspendu</span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-green-900/40 text-green-400 text-xs font-medium">Actif</span>
                        )}
                      </div>
                      <p className="text-gray-500 text-xs truncate flex items-center gap-1 mt-0.5">
                        <ExternalLink className="w-3 h-3" />
                        {account.domain}
                      </p>
                    </div>
                    {/* Disk */}
                    <div className="text-right mr-6 hidden md:block w-32">
                      <div className="flex items-center justify-end gap-2 mb-1">
                        <p className="text-sm font-medium text-gray-300">{account.diskused}</p>
                        <p className="text-[10px] text-gray-600">/ {account.disklimit === "unlimited" ? "∞" : account.disklimit}</p>
                      </div>
                      {(() => {
                        const used = parseFloat(account.diskused.replace(/[^\d.]/g, ""));
                        const limit = account.disklimit === "unlimited" ? 0 : parseFloat(account.disklimit.replace(/[^\d.]/g, ""));
                        const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
                        return percent > 0 ? (
                          <div className="w-full bg-gray-800 h-1 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${percent > 90 ? "bg-red-500" : percent > 70 ? "bg-yellow-500" : "bg-blue-500"}`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        ) : null;
                      })()}
                    </div>
                    {/* Email */}
                    <div className="text-right mr-6 hidden lg:block">
                      <p className="text-xs text-gray-500">{account.email}</p>
                      <p className="text-xs text-gray-600">{account.plan}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors flex-shrink-0" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

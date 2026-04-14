"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Copy, FileSpreadsheet, LayoutDashboard, LogOut, PlusCircle, Server, ShieldCheck } from "lucide-react";

interface AppShellProps {
  children: ReactNode;
}

interface SessionUser {
  username: string;
  role: "superadmin" | "operator";
  source: "env" | "managed";
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const isLoginPage = pathname === "/login";

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.user) setSessionUser(data.user as SessionUser);
      })
      .catch(() => {
        // ignore
      });
  }, [isLoginPage]);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setLoggingOut(false);
      router.replace("/login");
      router.refresh();
    }
  }

  if (isLoginPage) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center p-6 bg-gray-950">
        {children}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col fixed inset-y-0 left-0">
        <div className="p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
              <Server className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold text-white text-sm">WHM Manager</p>
              <p className="text-xs text-gray-500">campus01.o2switch.net</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          <Link
            href="/"
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-all text-sm font-medium"
          >
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </Link>
          {sessionUser?.role === "superadmin" && (
            <Link
              href="/accounts/new"
              className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-all text-sm font-medium"
            >
              <PlusCircle className="w-4 h-4" />
              Nouveau compte
            </Link>
          )}
          <Link
            href="/admin/export"
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-all text-sm font-medium"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Export sites
          </Link>
          <Link
            href="/admin/migrations"
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-all text-sm font-medium"
          >
            <Copy className="w-4 h-4" />
            Migrations
          </Link>
          {sessionUser?.role === "superadmin" && (
            <Link
              href="/admin/access"
              className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-all text-sm font-medium"
            >
              <ShieldCheck className="w-4 h-4" />
              Droits d&apos;accès
            </Link>
          )}

        </nav>

        <div className="p-4 border-t border-gray-800">
          {sessionUser && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-xs">
              <p className="text-gray-400">Connecté: <span className="text-gray-200 font-semibold">{sessionUser.username}</span></p>
              <p className="text-gray-500 capitalize">Rôle: {sessionUser.role}</p>
            </div>
          )}
          <button
            onClick={logout}
            disabled={loggingOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300 rounded-lg text-sm font-medium transition-all border border-gray-700"
          >
            <LogOut className="w-4 h-4" />
            {loggingOut ? "Déconnexion..." : "Déconnexion"}
          </button>
        </div>
      </aside>

      <main className="flex-1 ml-64 p-8">{children}</main>
    </div>
  );
}

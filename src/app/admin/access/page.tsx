"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle, AlertTriangle, ShieldCheck, Save, Trash2, RefreshCw } from "lucide-react";

interface ManagedUser {
  username: string;
  role: "superadmin" | "operator";
  allowedAccounts: string[];
  createdAt: string;
  updatedAt: string;
}

interface AccessResponse {
  users: ManagedUser[];
  accounts: string[];
  currentUser: { username: string; role: "superadmin" | "operator"; source: "env" | "managed" };
}

const EMPTY_FORM = {
  username: "",
  role: "operator" as "superadmin" | "operator",
  password: "",
  allowedAccounts: [] as string[],
};

export default function AccessAdminPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingUser, setEditingUser] = useState<string>("");

  const isEdit = Boolean(editingUser);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/access");
      const data = (await res.json()) as Partial<AccessResponse> & { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible de charger la console d'accès");
      }
      setUsers(Array.isArray(data.users) ? data.users : []);
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.localeCompare(b)),
    [accounts],
  );

  function toggleAccount(account: string) {
    setForm((prev) => {
      const exists = prev.allowedAccounts.includes(account);
      const allowedAccounts = exists
        ? prev.allowedAccounts.filter((item) => item !== account)
        : [...prev.allowedAccounts, account];
      return { ...prev, allowedAccounts };
    });
  }

  function startEdit(user: ManagedUser) {
    setEditingUser(user.username);
    setForm({
      username: user.username,
      role: user.role,
      password: "",
      allowedAccounts: user.allowedAccounts,
    });
    setMessage("");
    setError("");
  }

  function resetForm() {
    setEditingUser("");
    setForm(EMPTY_FORM);
  }

  async function saveUser() {
    if (!form.username) {
      setError("Le username est requis");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username,
          role: form.role,
          password: form.password || undefined,
          allowedAccounts: form.allowedAccounts,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible d'enregistrer l'utilisateur");
      }
      setMessage(isEdit ? "Utilisateur mis à jour" : "Utilisateur créé");
      resetForm();
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur d'enregistrement");
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(username: string) {
    if (!confirm(`Supprimer l'utilisateur "${username}" ?`)) return;
    setDeleting(username);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/admin/access", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? "Impossible de supprimer l'utilisateur");
      }
      setMessage("Utilisateur supprimé");
      if (editingUser === username) {
        resetForm();
      }
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur de suppression");
    } finally {
      setDeleting("");
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-white text-sm transition-colors mb-3">
            <ArrowLeft className="w-4 h-4" />
            Retour
          </Link>
          <h1 className="text-2xl font-bold text-white">Console des droits d&apos;accès</h1>
          <p className="text-gray-500 text-sm mt-1">Assigne les comptes WHM accessibles par chaque utilisateur de l&apos;application.</p>
        </div>
        <button
          onClick={() => void loadData()}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-all border border-gray-700"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Actualiser
        </button>
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

      <div className="grid lg:grid-cols-[360px,1fr] gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-gray-300">
            <ShieldCheck className="w-4 h-4 text-blue-400" />
            <h2 className="font-semibold">{isEdit ? `Modifier ${editingUser}` : "Nouvel utilisateur"}</h2>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Username</label>
            <input
              type="text"
              value={form.username}
              onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value.toLowerCase().trim() }))}
              disabled={isEdit}
              placeholder="ex: thomas"
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Rôle</label>
            <select
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as "superadmin" | "operator" }))}
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="operator">Operator (accès limité)</option>
              <option value="superadmin">Superadmin (tous les comptes)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">
              {isEdit ? "Nouveau mot de passe (optionnel)" : "Mot de passe"}
            </label>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              placeholder="8 caractères minimum"
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-2 font-medium">Comptes autorisés</label>
            {form.role === "superadmin" ? (
              <p className="text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded-lg p-3">
                Le rôle superadmin a automatiquement accès à tous les comptes.
              </p>
            ) : (
              <div className="max-h-52 overflow-auto border border-gray-700 rounded-lg divide-y divide-gray-800 bg-gray-800/40">
                {sortedAccounts.length === 0 && (
                  <p className="text-xs text-gray-500 px-3 py-2">Aucun compte disponible.</p>
                )}
                {sortedAccounts.map((account) => (
                  <label key={account} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={form.allowedAccounts.includes(account)}
                      onChange={() => toggleAccount(account)}
                      className="accent-blue-500"
                    />
                    {account}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => void saveUser()}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-bold transition-all"
            >
              <Save className="w-4 h-4" />
              {saving ? "Enregistrement..." : isEdit ? "Mettre à jour" : "Créer"}
            </button>
            {isEdit && (
              <button
                onClick={resetForm}
                className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-all border border-gray-700"
              >
                Annuler
              </button>
            )}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h2 className="font-semibold text-white">Utilisateurs configurés</h2>
          </div>

          {loading ? (
            <div className="p-8 text-center text-gray-500 text-sm">Chargement…</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-gray-500 text-sm">Aucun utilisateur secondaire configuré.</div>
          ) : (
            <div className="divide-y divide-gray-800">
              {users.map((user) => (
                <div key={user.username} className="px-5 py-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-white font-semibold">{user.username}</p>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${user.role === "superadmin" ? "bg-purple-900/40 text-purple-300" : "bg-blue-900/40 text-blue-300"}`}>
                        {user.role}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Comptes: {user.role === "superadmin" ? "Tous les comptes" : user.allowedAccounts.join(", ") || "Aucun"}
                    </p>
                    <p className="text-[11px] text-gray-600 mt-1">
                      MAJ: {new Date(user.updatedAt).toLocaleString("fr-FR")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => startEdit(user)}
                      className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs border border-gray-700"
                    >
                      Modifier
                    </button>
                    <button
                      onClick={() => void removeUser(user.username)}
                      disabled={deleting === user.username}
                      className="px-3 py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-300 text-xs border border-red-800/60 disabled:opacity-40"
                    >
                      <span className="inline-flex items-center gap-1">
                        <Trash2 className="w-3 h-3" />
                        {deleting === user.username ? "Suppression..." : "Supprimer"}
                      </span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

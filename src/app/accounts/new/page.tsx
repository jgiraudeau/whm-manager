"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, User, Globe, Mail, KeyRound, CheckCircle, Copy, AlertCircle } from "lucide-react";

function generateUsername(firstName: string, lastName: string): string {
    const clean = (s: string) =>
        s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    return `${clean(firstName).slice(0, 4)}${clean(lastName).slice(0, 4)}`.slice(0, 8);
}

export default function NewAccountPage() {
    const [canCreate, setCanCreate] = useState(false);
    const [authLoading, setAuthLoading] = useState(true);
    const [form, setForm] = useState({ firstName: "", lastName: "", email: "", plan: "default" });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<{ user: string; domain: string; password: string } | null>(null);

    const username = generateUsername(form.firstName, form.lastName);
    const domain = username ? `${username}.ltpsully.o2switch.site` : "";

    useEffect(() => {
        fetch("/api/auth/me")
            .then(async (res) => {
                if (!res.ok) return null;
                return res.json();
            })
            .then((data) => {
                const role = data?.user?.role;
                setCanCreate(role === "superadmin");
            })
            .finally(() => setAuthLoading(false));
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");
        try {
            const res = await fetch("/api/accounts/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user: username, domain, email: form.email }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setResult(data);
        } catch (e: unknown) {
            const err = e as Error;
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    if (authLoading) {
        return (
            <div className="max-w-lg mx-auto">
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center text-sm text-gray-500">
                    Vérification des droits…
                </div>
            </div>
        );
    }

    if (!canCreate) {
        return (
            <div className="max-w-lg mx-auto">
                <div className="bg-gray-900 border border-red-800/40 rounded-2xl p-8 text-center">
                    <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-3" />
                    <h2 className="text-lg font-bold text-white">Accès refusé</h2>
                    <p className="text-sm text-gray-400 mt-2">La création de comptes est réservée aux superadministrateurs.</p>
                    <Link href="/">
                        <button className="mt-5 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm border border-gray-700">
                            Retour au dashboard
                        </button>
                    </Link>
                </div>
            </div>
        );
    }

    if (result) {
        return (
            <div className="max-w-lg mx-auto">
                <div className="bg-gray-900 border border-green-800/50 rounded-2xl p-8 text-center">
                    <div className="w-16 h-16 bg-green-900/40 rounded-full flex items-center justify-center mx-auto mb-4">
                        <CheckCircle className="w-8 h-8 text-green-400" />
                    </div>
                    <h2 className="text-xl font-bold text-white mb-2">Compte créé avec succès !</h2>
                    <p className="text-gray-500 text-sm mb-8">Le compte cPanel est prêt à l&apos;utilisation.</p>

                    <div className="space-y-3 text-left mb-8">
                        {[
                            { label: "Utilisateur", value: result.user },
                            { label: "Domaine", value: result.domain },
                            { label: "Mot de passe", value: result.password },
                            { label: "URL cPanel", value: `https://campus01.o2switch.net:2083` },
                        ].map(({ label, value }) => (
                            <div key={label} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3">
                                <div>
                                    <p className="text-xs text-gray-500">{label}</p>
                                    <p className="text-sm font-mono text-white">{value}</p>
                                </div>
                                <button
                                    onClick={() => copyToClipboard(value)}
                                    className="text-gray-500 hover:text-blue-400 transition-colors p-1"
                                >
                                    <Copy className="w-4 h-4" />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-3">
                        <Link href={`/accounts/${result.user}`} className="flex-1">
                            <button className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold transition-all">
                                Voir le compte
                            </button>
                        </Link>
                        <Link href="/" className="flex-1">
                            <button className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition-all border border-gray-700">
                                Dashboard
                            </button>
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-lg mx-auto">
            <div className="mb-6">
                <Link href="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-white text-sm transition-colors mb-4">
                    <ArrowLeft className="w-4 h-4" /> Retour
                </Link>
                <h1 className="text-2xl font-bold text-white">Nouveau compte cPanel</h1>
                <p className="text-gray-500 text-sm mt-1">Le domaine et l&apos;identifiant sont générés automatiquement.</p>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs text-gray-400 mb-1.5 font-medium">Prénom</label>
                        <div className="relative">
                            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                            <input
                                type="text"
                                placeholder="Thomas"
                                value={form.firstName}
                                onChange={e => setForm({ ...form, firstName: e.target.value })}
                                className="w-full pl-9 pr-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-xs text-gray-400 mb-1.5 font-medium">Nom</label>
                        <input
                            type="text"
                            placeholder="Dupont"
                            value={form.lastName}
                            onChange={e => setForm({ ...form, lastName: e.target.value })}
                            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-xs text-gray-400 mb-1.5 font-medium">Email de contact</label>
                    <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                        <input
                            type="email"
                            placeholder="thomas@example.com"
                            value={form.email}
                            onChange={e => setForm({ ...form, email: e.target.value })}
                            className="w-full pl-9 pr-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                </div>

                {/* Preview */}
                {username && (
                    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-2">
                        <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Aperçu du compte</p>
                        <div className="flex items-center gap-2">
                            <KeyRound className="w-4 h-4 text-blue-400" />
                            <span className="text-sm text-white font-mono">{username}</span>
                            <span className="text-xs text-gray-600">(identifiant cPanel)</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Globe className="w-4 h-4 text-blue-400" />
                            <span className="text-sm text-white font-mono">{domain}</span>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="flex items-center gap-2 bg-red-900/20 border border-red-800/50 rounded-lg p-3">
                        <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        <p className="text-red-400 text-sm">{error}</p>
                    </div>
                )}

                <button
                    onClick={handleSubmit}
                    disabled={loading || !form.firstName || !form.lastName || !form.email}
                    className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-bold text-sm transition-all shadow-lg shadow-blue-900/30"
                >
                    {loading ? (
                        <span className="flex items-center justify-center gap-2">
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Création en cours...
                        </span>
                    ) : "Créer le compte cPanel"}
                </button>
            </div>
        </div>
    );
}

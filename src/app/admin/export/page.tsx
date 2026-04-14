"use client";

import { useState } from "react";
import {
  Download,
  RefreshCw,
  FileSpreadsheet,
  Globe,
  ShoppingCart,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
} from "lucide-react";

interface ExportRow {
  cpanelUser: string;
  domain: string;
  appType: "wordpress" | "prestashop" | "other";
  appName: string;
  siteUrl: string;
  adminUrl: string;
  version: string;
  subdomain: string;
}

// ─── Excel SpreadsheetML generator (Excel 2003 XML — no ZIP, no binary, 100% reliable) ───

function escapeXml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildXls(rows: ExportRow[]): Blob {
  const headers = [
    "Compte cPanel",
    "Domaine principal",
    "Type",
    "Sous-domaine",
    "URL du site",
    "URL Admin",
    "Version",
  ];

  const dataRows: string[][] = rows.map((r) => [
    r.cpanelUser,
    r.domain,
    r.appType === "wordpress" ? "WordPress" : r.appType === "prestashop" ? "PrestaShop" : r.appType,
    r.subdomain || "(racine)",
    r.siteUrl,
    r.adminUrl,
    r.version || "",
  ]);

  function row(cells: string[], isHeader = false): string {
    const style = isHeader ? ` ss:StyleID="Header"` : "";
    const cellsXml = cells
      .map((c) => `      <Cell><Data ss:Type="String">${escapeXml(c)}</Data></Cell>`)
      .join("\n");
    return `    <Row${style}>\n${cellsXml}\n    </Row>`;
  }

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<?mso-application progid="Excel.Sheet"?>`,
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"`,
    `  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"`,
    `  xmlns:x="urn:schemas-microsoft-com:office:excel">`,
    `  <Styles>`,
    `    <Style ss:ID="Header">`,
    `      <Font ss:Bold="1"/>`,
    `      <Interior ss:Color="#1F2937" ss:Pattern="Solid"/>`,
    `      <Font ss:Color="#FFFFFF" ss:Bold="1"/>`,
    `    </Style>`,
    `  </Styles>`,
    `  <Worksheet ss:Name="Inventaire Sites">`,
    `    <Table>`,
    `      <Column ss:Width="120"/>`,
    `      <Column ss:Width="200"/>`,
    `      <Column ss:Width="100"/>`,
    `      <Column ss:Width="160"/>`,
    `      <Column ss:Width="300"/>`,
    `      <Column ss:Width="300"/>`,
    `      <Column ss:Width="80"/>`,
    row(headers, true),
    ...dataRows.map((r) => row(r, false)),
    `    </Table>`,
    `  </Worksheet>`,
    `</Workbook>`,
  ].join("\n");

  return new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExportPage() {
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wordpressRows = rows?.filter((r) => r.appType === "wordpress") ?? [];
  const prestashopRows = rows?.filter((r) => r.appType === "prestashop") ?? [];

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/export");
      const data = await res.json() as { rows?: ExportRow[]; error?: string };
      if (data.error) throw new Error(data.error);
      setRows(data.rows ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  function downloadExcel() {
    if (!rows || rows.length === 0) return;
    const blob = buildXls(rows);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `inventaire-sites-${date}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (!rows || rows.length === 0) return;
    const headers = ["Compte cPanel", "Domaine", "Type", "Sous-domaine", "URL du site", "URL Admin", "Version"];
    const lines = [
      headers.join(";"),
      ...rows.map((r) =>
        [
          r.cpanelUser,
          r.domain,
          r.appType === "wordpress" ? "WordPress" : "PrestaShop",
          r.subdomain || "(racine)",
          r.siteUrl,
          r.adminUrl,
          r.version || "",
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(";")
      ),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `inventaire-sites-${date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const AppBadge = ({ type }: { type: "wordpress" | "prestashop" }) =>
    type === "wordpress" ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 text-[10px] font-bold uppercase tracking-wider">
        <Globe className="w-2.5 h-2.5" />WP
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-pink-900/40 text-pink-300 text-[10px] font-bold uppercase tracking-wider">
        <ShoppingCart className="w-2.5 h-2.5" />PS
      </span>
    );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <FileSpreadsheet className="w-6 h-6 text-emerald-400" />
            Export inventaire sites
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            URLs admin de tous les WordPress &amp; PrestaShop par compte cPanel
          </p>
        </div>
        <div className="flex gap-3">
          <button
            id="btn-load-export"
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300 rounded-lg text-sm font-medium transition-all border border-gray-700"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Chargement…" : rows === null ? "Charger les données" : "Actualiser"}
          </button>
          {rows && rows.length > 0 && (
            <>
              <button
                id="btn-export-csv"
                onClick={downloadCsv}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-all border border-gray-600"
              >
                <Download className="w-4 h-4" />
                CSV
              </button>
              <button
                id="btn-export-xlsx"
                onClick={downloadExcel}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-emerald-900/30"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Excel (.xlsx)
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-900/20 border border-red-800/50 rounded-xl text-red-400 text-sm">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Empty state */}
      {rows === null && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-24 bg-gray-900/50 border border-gray-800 rounded-2xl">
          <FileSpreadsheet className="w-16 h-16 text-gray-700 mb-4" />
          <p className="text-gray-500 font-medium">Aucune donnée chargée</p>
          <p className="text-gray-600 text-sm mt-1">Cliquez sur &quot;Charger les données&quot; pour lancer la récupération.</p>
          <button
            onClick={loadData}
            className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-emerald-900/30"
          >
            <RefreshCw className="w-4 h-4" />
            Charger les données
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-gray-800 flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-gray-400 text-sm">Connexion aux comptes cPanel et lecture des installations…</span>
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-gray-800 animate-pulse">
              <div className="h-3 bg-gray-800 rounded w-20" />
              <div className="h-3 bg-gray-800 rounded w-32" />
              <div className="h-3 bg-gray-800 rounded w-12" />
              <div className="h-3 bg-gray-800 rounded flex-1" />
              <div className="h-3 bg-gray-800 rounded flex-1" />
            </div>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {rows !== null && !loading && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase font-bold tracking-wider">Total sites</p>
              <p className="text-3xl font-black text-white mt-2">{rows.length}</p>
            </div>
            <div className="bg-gray-900 border border-blue-900/40 rounded-xl p-4">
              <p className="text-xs text-blue-500 uppercase font-bold tracking-wider">WordPress</p>
              <p className="text-3xl font-black text-blue-300 mt-2">{wordpressRows.length}</p>
            </div>
            <div className="bg-gray-900 border border-pink-900/40 rounded-xl p-4">
              <p className="text-xs text-pink-500 uppercase font-bold tracking-wider">PrestaShop</p>
              <p className="text-3xl font-black text-pink-300 mt-2">{prestashopRows.length}</p>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="flex items-center gap-3 p-6 bg-gray-900 border border-gray-800 rounded-xl text-gray-500">
              <CheckCircle className="w-5 h-5 text-gray-600" />
              Aucune installation WordPress ou PrestaShop détectée sur les comptes accessibles.
            </div>
          ) : (
            /* Main Table */
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
                <h2 className="font-semibold text-white">Inventaire des installations</h2>
                <span className="text-xs text-gray-500">{rows.length} entrée{rows.length > 1 ? "s" : ""}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">Compte</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">Type</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">Sous-domaine</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">URL du site</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">URL Admin</th>
                      <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">Version</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {rows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-gray-800/50 transition-colors group">
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-white font-semibold text-sm">{row.cpanelUser}</p>
                            <p className="text-gray-600 text-xs">{row.domain}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <AppBadge type={row.appType as "wordpress" | "prestashop"} />
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-mono ${row.subdomain ? "text-gray-300" : "text-gray-600"}`}>
                            {row.subdomain || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-[220px]">
                          <a
                            href={row.siteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 transition-colors truncate text-xs font-mono"
                          >
                            <span className="truncate">{row.siteUrl}</span>
                            <ExternalLink className="w-3 h-3 flex-shrink-0" />
                          </a>
                        </td>
                        <td className="px-4 py-3 max-w-[220px]">
                          <a
                            href={row.adminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 transition-colors truncate text-xs font-mono"
                          >
                            <span className="truncate">{row.adminUrl}</span>
                            <ExternalLink className="w-3 h-3 flex-shrink-0" />
                          </a>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-gray-500 text-xs font-mono">{row.version || "—"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { filterAccountsForSession, requireAuthSession, safeError } from "@/lib/auth";
import { listAccounts } from "@/lib/whm";
import { listSoftaculousInstallationsForUser, detectSoftAppType } from "@/lib/softaculous-client";

export interface ExportRow {
  cpanelUser: string;
  domain: string;
  appType: "wordpress" | "prestashop" | "other";
  appName: string;
  siteUrl: string;
  adminUrl: string;
  version: string;
  subdomain: string;
}

export async function GET(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  try {
    const allAccounts = await listAccounts();
    const accounts = filterAccountsForSession(session, allAccounts);

    // Fetch installations for all accounts in parallel (cap concurrency at 5)
    const CONCURRENCY = 5;
    const rows: ExportRow[] = [];

    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
      const slice = accounts.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        slice.map(async (account) => {
          const installations = await listSoftaculousInstallationsForUser(account.user);
          return { account, installations };
        }),
      );

      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { account, installations } = result.value;

        for (const install of installations) {
          const appType = install.app ?? detectSoftAppType(install.name);
          if (appType !== "wordpress" && appType !== "prestashop") continue;

          // Derive admin URL from site URL
          let adminUrl = "";
          const siteUrl = install.url.replace(/\/$/, "");
          if (appType === "wordpress") {
            adminUrl = `${siteUrl}/wp-admin/`;
          } else if (appType === "prestashop") {
            // PrestaShop admin folder is in the raw installation data
            const rawAdminUrl = install.raw?.adminurl;
            if (typeof rawAdminUrl === "string" && rawAdminUrl) {
              adminUrl = rawAdminUrl;
            } else {
              adminUrl = `${siteUrl}/admin/`;
            }
          }

          // Derive subdomain (everything before mainDomain)
          const host = install.host;
          const mainDomain = account.domain;
          const subdomain = host === mainDomain
            ? ""
            : host.endsWith(`.${mainDomain}`)
              ? host.slice(0, -(mainDomain.length + 1))
              : host;

          rows.push({
            cpanelUser: account.user,
            domain: account.domain,
            appType,
            appName: install.name,
            siteUrl: install.url,
            adminUrl,
            version: install.ver,
            subdomain,
          });
        }
      }
    }

    // Sort: by account user, then by appType
    rows.sort((a, b) => {
      const u = a.cpanelUser.localeCompare(b.cpanelUser);
      if (u !== 0) return u;
      return a.appType.localeCompare(b.appType);
    });

    return NextResponse.json({ rows, total: rows.length });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la génération de l'export") },
      { status: 500 },
    );
  }
}

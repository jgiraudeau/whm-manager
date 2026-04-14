import { NextRequest, NextResponse } from "next/server";
import { ensureSuperAdmin, filterAccountsForSession, requireAuthSession, safeError } from "@/lib/auth";
import { listAccounts, cpanelApi } from "@/lib/whm";
import { listSoftaculousInstallationsForUser } from "@/lib/softaculous-client";
import { createMigrationJob, listMigrationJobs, deleteMigrationJob } from "@/lib/migration-store";
import { runMigrationForTarget } from "@/lib/migration-engine";
import { isValidCpanelUsername } from "@/lib/validators";
import { generatePassword } from "@/lib/whm";

// ─── GET: list all migration jobs ─────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  try {
    const jobs = await listMigrationJobs();
    return NextResponse.json({ jobs });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la lecture des migrations") },
      { status: 500 },
    );
  }
}

// ─── POST: create and launch a migration job ──────────────────────────────────

interface MigrationTarget {
  user: string;
  subdomain: string;
}

interface LaunchBody {
  sourceUser?: string;
  sourceInstallId?: string;  // Softaculous install ID
  targets?: MigrationTarget[];
}

export async function POST(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  // Allowed for both roles

  try {
    const body = (await req.json()) as LaunchBody;
    const { sourceUser, sourceInstallId, targets } = body;

    if (!sourceUser || !sourceInstallId || !targets || targets.length === 0) {
      return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
    }
    if (!isValidCpanelUsername(sourceUser)) {
      return NextResponse.json({ error: "sourceUser invalide" }, { status: 400 });
    }

    // 1. Get source installation details
    const installations = await listSoftaculousInstallationsForUser(sourceUser);
    const sourceInstall = installations.find((i) => i.id === sourceInstallId);
    if (!sourceInstall) {
      return NextResponse.json(
        { error: `Installation source introuvable (id: ${sourceInstallId})` },
        { status: 404 },
      );
    }

    const sourceUrl = sourceInstall.url.replace(/\/$/, "");
    const sourcePath = sourceInstall.path; // e.g. /home/user/public_html or /home/user/public_html/subdir
    const appType = sourceInstall.app === "prestashop" ? "prestashop" : "wordpress";

    // Validate targets and filter for this session
    let accounts = await listAccounts();
    accounts = filterAccountsForSession(session, accounts);
    const resolvedTargets: Array<{
      user: string;
      subdomain: string;
      domain: string;
      destPath: string;
      newDbName: string;
      newDbUser: string;
      newDbPass: string;
      newSiteUrl: string;
    }> = [];

    for (const t of targets) {
      if (!isValidCpanelUsername(t.user)) continue;
      if (t.user === sourceUser) continue; // can't clone to self
      const account = accounts.find((a) => a.user === t.user);
      if (!account) continue;

      // Determine destination path
      const destPath = t.subdomain
        ? `/home/${t.user}/public_html/${t.subdomain}`
        : `/home/${t.user}/public_html`;

      // Create MySQL DB + user on the target account via cPanel API
      const dbSuffix = t.subdomain.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "wp";
      const newDbName = `${t.user}_${dbSuffix}`;
      const newDbUser = `${t.user}_${dbSuffix}`;
      const newDbPass = generatePassword(16);
      const newSiteUrl = `https://${t.subdomain}.${account.domain}`;

      // Provision DB via cPanel (best-effort — may already exist)
      try {
        await cpanelApi(t.user, "Mysql", "create_database", { name: newDbName });
        await cpanelApi(t.user, "Mysql", "create_user", {
          name: newDbUser,
          password: newDbPass,
          password2: newDbPass,
        });
        await cpanelApi(t.user, "Mysql", "set_privileges_on_database", {
          user: newDbUser,
          database: newDbName,
          privileges: "ALL PRIVILEGES",
        });
      } catch {
        // DB may already exist — migration engine will handle it
      }

      // Also create subdomain if needed
      if (t.subdomain) {
        try {
          await cpanelApi(t.user, "SubDomain", "addsubdomain", {
            domain: t.subdomain,
            rootdomain: account.domain,
            dir: `public_html/${t.subdomain}`,
          });
        } catch {
          // Subdomain may already exist
        }
      }

      resolvedTargets.push({
        user: t.user,
        subdomain: t.subdomain,
        domain: account.domain,
        destPath,
        newDbName,
        newDbUser,
        newDbPass,
        newSiteUrl,
      });
    }

    if (resolvedTargets.length === 0) {
      return NextResponse.json({ error: "Aucune cible valide" }, { status: 400 });
    }

    // 2. Create the job record
    const job = await createMigrationJob({
      sourceUser,
      sourceInstallId,
      sourceUrl,
      appType,
      targets: resolvedTargets.map((t) => ({
        user: t.user,
        subdomain: t.subdomain,
        domain: t.domain,
      })),
    });

    // 3. Run migrations in background (no await — fire and forget)
    // We run up to 3 targets in parallel, then the next batch
    void (async () => {
      const CONCURRENCY = 3;
      for (let i = 0; i < resolvedTargets.length; i += CONCURRENCY) {
        const batch = resolvedTargets.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map((t) =>
            runMigrationForTarget({
              jobId: job.id,
              sourceUser,
              sourcePath,
              sourceUrl,
              appType,
              target: t,
            }),
          ),
        );
      }
    })();

    return NextResponse.json({ success: true, jobId: job.id, job });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors du lancement de la migration") },
      { status: 500 },
    );
  }
}

// ─── DELETE: remove a job record ─────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  // Allowed for both roles

  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
    await deleteMigrationJob(id);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la suppression") },
      { status: 500 },
    );
  }
}

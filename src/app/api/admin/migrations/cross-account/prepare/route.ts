import { NextRequest, NextResponse } from "next/server";
import { cpanelApi, listAccounts } from "@/lib/whm";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import { getCpanelDomainInfo } from "@/lib/domain-info";
import {
  listSoftaculousInstallationsForUser,
  resolveInstallationByRef,
} from "@/lib/softaculous-client";
import { savePreparedMigration } from "@/lib/migration-store";
import { normalizeHost } from "@/lib/softaculous";
import { isValidCpanelUsername } from "@/lib/validators";

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

interface PrepareBody {
  sourceAccount?: string;
  sourceRef?: string;
  destinationAccount?: string;
  destinationSubdomain?: string;
  destinationDomain?: string;
  createSubdomainIfMissing?: boolean;
}

function normalizeValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function POST(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;
  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as PrepareBody;
    const sourceAccount = normalizeValue(body.sourceAccount);
    const sourceRef = typeof body.sourceRef === "string" ? body.sourceRef.trim() : "";
    const destinationAccount = normalizeValue(body.destinationAccount);
    const destinationSubdomain = normalizeValue(body.destinationSubdomain);
    const requestedDomain = normalizeValue(body.destinationDomain);
    const createSubdomainIfMissing = Boolean(body.createSubdomainIfMissing);

    if (!sourceAccount || !sourceRef || !destinationAccount || !destinationSubdomain) {
      return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
    }
    if (!isValidCpanelUsername(sourceAccount) || !isValidCpanelUsername(destinationAccount)) {
      return NextResponse.json({ error: "Comptes source ou destination invalides" }, { status: 400 });
    }
    if (!SUBDOMAIN_RE.test(destinationSubdomain)) {
      return NextResponse.json({ error: "Sous-domaine cible invalide" }, { status: 400 });
    }
    if (requestedDomain && !DOMAIN_RE.test(requestedDomain)) {
      return NextResponse.json({ error: "Domaine cible invalide" }, { status: 400 });
    }
    if (sourceAccount === destinationAccount) {
      return NextResponse.json(
        { error: "La migration inter-compte requiert deux comptes différents" },
        { status: 400 },
      );
    }

    const accounts = await listAccounts();
    const sourceExists = accounts.some((account) => account.user === sourceAccount);
    const destinationExists = accounts.some((account) => account.user === destinationAccount);
    if (!sourceExists || !destinationExists) {
      return NextResponse.json({ error: "Compte source ou destination introuvable" }, { status: 404 });
    }

    const [sourceInstallations, destinationDomains, destinationInstallations] = await Promise.all([
      listSoftaculousInstallationsForUser(sourceAccount),
      getCpanelDomainInfo(destinationAccount),
      listSoftaculousInstallationsForUser(destinationAccount),
    ]);

    const sourceInstallation = resolveInstallationByRef(sourceInstallations, sourceRef);
    if (!sourceInstallation) {
      return NextResponse.json({ error: "Installation source introuvable" }, { status: 404 });
    }
    if (sourceInstallation.app === "other") {
      return NextResponse.json(
        { error: "Seules les installations WordPress et PrestaShop sont supportées en migration inter-compte (v1)." },
        { status: 400 },
      );
    }

    const destinationDomain = requestedDomain || destinationDomains.mainDomain;
    if (!destinationDomain) {
      return NextResponse.json({ error: "Impossible de déterminer le domaine cible principal" }, { status: 400 });
    }
    if (!destinationDomains.domains.includes(destinationDomain)) {
      return NextResponse.json(
        { error: `Le domaine ${destinationDomain} n'est pas disponible sur le compte destination` },
        { status: 400 },
      );
    }

    const targetHost = `${destinationSubdomain}.${destinationDomain}`;
    const targetHostNormalized = normalizeHost(targetHost);

    const subdomainAlreadyExists = destinationDomains.subDomains.includes(targetHost);
    const targetInstallAlreadyExists = destinationInstallations.some(
      (installation) => installation.host === targetHostNormalized,
    );
    if (targetInstallAlreadyExists) {
      return NextResponse.json(
        { error: `Une installation existe déjà sur ${targetHost}. Choisis un autre sous-domaine cible.` },
        { status: 409 },
      );
    }

    let createdTargetSubdomain = false;
    if (!subdomainAlreadyExists && createSubdomainIfMissing) {
      const subdomainResult = await cpanelApi(destinationAccount, "SubDomain", "addsubdomain", {
        domain: destinationSubdomain,
        rootdomain: destinationDomain,
        dir: `public_html/${destinationSubdomain}`,
      });

      if (subdomainResult?.metadata?.result === 0 || (subdomainResult?.errors && subdomainResult.errors.length > 0)) {
        const reason = subdomainResult?.metadata?.reason || "Création du sous-domaine cible impossible";
        return NextResponse.json({ error: reason }, { status: 400 });
      }
      createdTargetSubdomain = true;
    }

    if (!subdomainAlreadyExists && !createSubdomainIfMissing) {
      return NextResponse.json(
        {
          error: `Le sous-domaine cible ${targetHost} n'existe pas encore. Active l'option de création automatique.`,
        },
        { status: 400 },
      );
    }

    const checks = [
      `Source détectée: ${sourceInstallation.name} (${sourceInstallation.url}) sur ${sourceAccount}`,
      `Destination validée: ${destinationAccount} -> ${targetHost}`,
      createdTargetSubdomain
        ? `Sous-domaine créé automatiquement: ${targetHost}`
        : `Sous-domaine déjà présent: ${targetHost}`,
      "Collision d'installation cible: non détectée",
      "Permissions: superadmin confirmé",
    ];

    const nextActions = [
      "Étape 2: générer un backup Softaculous sur le compte source",
      "Étape 3: transférer l'archive vers le compte destination",
      "Étape 4: restaurer l'installation sur la cible puis reconfigurer les URLs",
      "Étape 5: vérifier SSL, accès admin et tâches cron",
    ];

    const plan = await savePreparedMigration({
      createdBy: session.username,
      sourceAccount,
      sourceInstallationId: sourceInstallation.id,
      sourceApp: sourceInstallation.app,
      sourceUrl: sourceInstallation.url,
      destinationAccount,
      destinationDomain,
      destinationSubdomain,
      targetUrl: `https://${targetHost}`,
      createdTargetSubdomain,
      checks,
      nextActions,
    });

    return NextResponse.json({
      success: true,
      mode: "prepared",
      message:
        "Plan de migration inter-compte préparé. La copie/restauration automatique sera branchée en phase 2.",
      plan,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeError(error, "Erreur lors de la préparation de migration inter-compte") },
      { status: 500 },
    );
  }
}

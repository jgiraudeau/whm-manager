import { NextRequest, NextResponse } from "next/server";
import { listAccounts } from "@/lib/whm";
import { ensureSuperAdmin, requireAuthSession, safeError } from "@/lib/auth";
import { deleteManagedUser, listManagedUsers, upsertManagedUser } from "@/lib/access-control";

export async function GET(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const [accounts, users] = await Promise.all([listAccounts(), listManagedUsers()]);
    return NextResponse.json({
      users,
      accounts: accounts.map((account) => account.user).sort((a, b) => a.localeCompare(b)),
      currentUser: {
        username: session.username,
        role: session.role,
        source: session.source,
      },
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeError(error, "Erreur lors du chargement des accès") }, { status: 500 });
  }
}

interface UpsertBody {
  username?: string;
  role?: "superadmin" | "operator";
  allowedAccounts?: string[];
  password?: string;
}

export async function POST(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as UpsertBody;
    if (!body.username || !body.role) {
      return NextResponse.json({ error: "Champs manquants (username, role)" }, { status: 400 });
    }

    const user = await upsertManagedUser({
      username: body.username,
      role: body.role,
      allowedAccounts: body.allowedAccounts ?? [],
      password: body.password,
    });

    return NextResponse.json({ success: true, user });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeError(error, "Erreur lors de l'enregistrement des droits") }, { status: 400 });
  }
}

interface DeleteBody {
  username?: string;
}

export async function DELETE(req: NextRequest) {
  const { denied, session } = await requireAuthSession(req);
  if (denied) return denied;

  const forbidden = ensureSuperAdmin(session);
  if (forbidden) return forbidden;

  try {
    const body = (await req.json()) as DeleteBody;
    if (!body.username) {
      return NextResponse.json({ error: "Username manquant" }, { status: 400 });
    }

    await deleteManagedUser(body.username);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeError(error, "Erreur lors de la suppression de l'utilisateur") }, { status: 400 });
  }
}

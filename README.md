# WHM Manager

Application Next.js pour piloter des comptes WHM/cPanel (o2switch):
- liste des comptes cPanel
- creation/suspension
- operations de domaines et sous-domaines
- actions Softaculous (install/clone)
- declenchement AutoSSL
- gestion des droits d'acces par utilisateur (RBAC)

## Prerequis

- Node.js 20+
- acces WHM API (host, user, token)
- variables d'environnement configurees

## Configuration locale

1. Copier les variables:

```bash
cp .env.example .env.local
```

2. Generer une valeur forte pour `AUTH_SECRET`:

```bash
openssl rand -base64 48
```

3. Installer les dependances et lancer:

```bash
npm install
npm run dev
```

## Variables d'environnement

Variables obligatoires:

```bash
ADMIN_USER=admin
ADMIN_PASSWORD=change-me-strong-password
AUTH_SECRET=replace-with-a-long-random-value
WHM_HOST=https://campus01.o2switch.net:2087
WHM_USER=root
WHM_TOKEN=replace-with-whm-api-token
```

Notes:
- fallback supporte: `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASSWORD`
- si la configuration auth est absente, l'app retourne `503 Authentication is not configured on the server.`
- si WHM utilise un certificat auto-signe, vous pouvez devoir definir `NODE_TLS_REJECT_UNAUTHORIZED=0`
- stockage RBAC (optionnel): `ACCESS_CONTROL_STORE_PATH=/chemin/persistant/access-control.json`

## Qualite

```bash
npm run lint
npm run build
```

Le script `build` utilise `webpack` pour eviter un crash Turbopack observe sur certains environnements limites.

## Deploiement Vercel (recommande)

1. Importer le repository GitHub dans Vercel.
2. Definir toutes les variables d'environnement ci-dessus dans le projet Vercel.
3. Conserver:
- Build Command: `npm run build`
- Install Command: `npm install`
- Start Command: `npm run start`
4. Deployer.
5. RBAC:
- par defaut Vercel ecrit le fichier d'acces dans `/tmp/whm-manager-access-control.json` (non persistant entre redemarrages)
- pour une persistence durable des droits, preferer Railway avec un volume disque et definir `ACCESS_CONTROL_STORE_PATH`

## Deploiement Railway (si necessaire)

Railway est utile si vous devez:
- controler plus finement l'environnement runtime
- contourner des contraintes reseau de Vercel vers votre WHM

Configuration:
1. Connecter le repository GitHub a Railway.
2. Definir les memes variables d'environnement que Vercel.
3. Commandes:
- Build: `npm run build`
- Start: `npm run start`
4. Exposer le service web sur le port `PORT` fourni par Railway.

## Securite

- Session admin via cookie `HttpOnly` signe (`/login`)
- routes API protegees via middleware
- entetes de defense (`X-Frame-Options`, `X-Content-Type-Options`, etc.)
- permissions par utilisateur:
  - `superadmin`: acces a tous les comptes + console des droits
  - `operator`: acces limite aux comptes explicitement autorises

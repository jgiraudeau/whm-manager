# Project Memory

Last update: April 6, 2026

## État actuel de l'application

L'application WHM Manager est **opérationnelle** sur Railway.
- Création de comptes cPanel ✅
- Clonage intra-compte (Softaculous) ✅
- **Installation sur sous-domaine personnalisé** (avec création auto du sous-domaine) ✅
- Gestion des droits d'accès (superadmin / operator) ✅
- Audit de sécurité complété ✅

## Ce qui a été fait (April 6, 2026)

### Installation sur sous-domaine (One-click Install)
- Mise à jour de l'API `/api/accounts/install` pour accepter un paramètre `subdomain`.
- Création automatique du sous-domaine via cPanel si nécessaire avant l'installation Softaculous.
- Ajout d'un champ de saisie dédié dans l'interface utilisateur [[user]/page.tsx].

## Ce qui a été fait (April 4, 2026)
... (reste inchangé)

### Suppression de la migration inter-comptes
- La fonctionnalité de migration WordPress inter-comptes a été **définitivement supprimée** (API cPanel trop instable).
- Fichiers supprimés : `cross-account-wordpress-fallback.ts`, `migration-store.ts`, toutes les routes `/api/admin/migrations/`, la page `/admin/migrations`, le lien dans le menu.
- Raison : L'API `Fileman::fileop compress` de cPanel est asynchrone mais o2switch ne permet pas de faire de polling fiable dessus. À reconsidérer si on change d'hébergeur.

### Audit de sécurité (commit `a5eb095`)
Corrections appliquées :
1. **Rate limiting** sur `/api/auth/login` : 5 tentatives échouées max par IP / 10 minutes → HTTP 429
2. **En-têtes HTTP de sécurité** dans `next.config.ts` : `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `HSTS` (prod), `Permissions-Policy`
3. **`.gitignore`** : `/data/` et `/scripts/` ajoutés pour ne pas commiter les stores JSON runtime

### Points de sécurité restants (faible urgence, usage interne)
- `NODE_TLS_REJECT_UNAUTHORIZED = "0"` global dans `whm.ts` — à remplacer par un `https.Agent` isolé si l'app s'ouvre à l'extérieur
- Mot de passe superadmin (`ADMIN_PASSWORD`) stocké en clair dans les vars d'env Railway — acceptable pour un usage fermé

## Checklist au prochain retour
1. Vérifier que le dernier déploiement Railway est bien `Deployment successful` (commit `a5eb095`)
2. Tester la page de login → vérifier que les en-têtes de sécurité sont bien présents (DevTools → Network → Response Headers)
3. Décider si on implémente une prochaine fonctionnalité (voir liste ci-dessous)

## Portabilité vers un autre hébergeur WHM
Si on perd l'accès au WHM actuel (campus01.o2switch.net), les options sont :
- ✅ **o2switch Offre Revendeur** (~15-20€/mois) → WHM complet, migration en 5 minutes (changer WHM_HOST, WHM_USER, WHM_TOKEN sur Railway)
- ⚠️ o2switch Pro (cPanel simple) → pas de WHM, refactoring important nécessaire
- ❌ Hostinger → panel propriétaire (hPanel), incompatible

## Fonctionnalités possibles pour la suite
- Rapport d'utilisation disque par compte (déjà dans l'API WHM : `diskused` / `disklimit`)
- Notifications email en cas d'erreur de migration ou d'expiration de session
- Migration inter-comptes via plugin WordPress (Duplicator) — si besoin à l'avenir

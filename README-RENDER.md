# Déploiement indépendant sur Render

Cette version conserve l'interface `public/` et les actions existantes de l'API (`/api/app`), mais remplace le SDK `hatchable` par Express et PostgreSQL (`pg`). L'application est protégée par une authentification HTTP Basic afin de ne pas exposer les soldes de congés publiquement.

## Prérequis
- Un dépôt GitHub contenant le projet.
- Un compte Render.
- Node.js 20+ pour les tests locaux.
- Une base PostgreSQL Render.

## Déployer
1. Dans Render, créez une base **PostgreSQL**. Pour conserver les données à long terme, vérifiez la durée de conservation et le tarif du plan choisi.
2. Dans Render, choisissez **New → Web Service** et connectez `tesnimSl/Suivi-cong-s-App`.
3. Branche : la branche principale de votre dépôt (souvent `main`).
4. Build Command : `npm install`.
5. Start Command : `npm start`.
6. Ajoutez ces variables d'environnement dans Render :
   - `DATABASE_URL` : URL interne de la base PostgreSQL Render (préférable si les services sont dans la même région).
   - `NODE_ENV` : `production`.
   - `APP_USER` : identifiant que vous choisissez.
   - `APP_PASSWORD` : mot de passe long, unique, d'au moins 14 caractères.
   - `DATABASE_SSL` : laissez non défini pour utiliser le réglage par défaut de production, ou définissez `true` si nécessaire.
7. Lancez le déploiement. Au démarrage, `server.js` applique automatiquement les fichiers SQL numérotés de `migrations/` qui ne sont pas encore enregistrés dans `schema_migrations`.
8. Ouvrez l'URL `onrender.com`. Le navigateur demandera l'identifiant et le mot de passe HTTP Basic. L'endpoint `/health` permet de vérifier l'état du serveur et de la base.

## Migrations et données initiales
- Ne lancez pas les migrations Hatchable sur une base qui contient déjà des tables non contrôlées sans avoir fait une sauvegarde.
- Les migrations `001` à `004` créent les tables utilisées par l'application. `005` ajoute des index.
- `seed.sql` n'est volontairement **pas exécuté automatiquement** : il contient un exemple pour 2026 avec un solde initial de 7,27 jours. Après le premier lancement, l'API crée automatiquement l'année courante si elle n'existe pas, avec 22 jours/an, 1,8333 jour/mois, 5 jours de maladie et un solde initial CP à 0.
- Les données stockées dans Hatchable ne sont pas transférées par ce déploiement. Si vous avez des opérations à conserver, exportez-les et importez-les séparément dans PostgreSQL avant d'utiliser la nouvelle instance.

## Test local (optionnel)
1. Installez Node.js 20+ et PostgreSQL.
2. Créez une base vide, puis copiez `.env.example` en `.env` et adaptez `DATABASE_URL`, `APP_USER` et `APP_PASSWORD`.
3. Exécutez `npm install`, puis `npm start`.
4. Ouvrez `http://localhost:3000`. Le navigateur demandera les identifiants HTTP Basic.

## Sécurité
- Ne commitez jamais `.env`, les identifiants PostgreSQL ou le mot de passe d'application.
- Utilisez un mot de passe unique et long.
- L'authentification HTTP Basic est adaptée à une application privée simple derrière HTTPS. Pour une application multi-utilisateur, ajoutez une vraie gestion des comptes et des rôles.
- Configurez des sauvegardes PostgreSQL et testez régulièrement la restauration.

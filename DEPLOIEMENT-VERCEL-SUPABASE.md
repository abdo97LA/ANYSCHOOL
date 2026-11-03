# UniTimetable en ligne — GitHub + Vercel + Supabase (version de test)

Ce guide met UniTimetable **en ligne**. Vous pourrez alors vous connecter à vos comptes depuis n'importe où (maison, téléphone, autre établissement) et tester toutes les fonctions.

- Le **même code** sert aux deux versions :
  - le **serveur local Windows** (`server/server.js`, données dans des fichiers) ;
  - la **version en ligne** (`api/index.js` sur Vercel, données dans Supabase).
- Les rôles, droits, la synchronisation, les conflits, l'audit, les absences et les alertes fonctionnent **de la même façon**.

> ⚠️ **Données personnelles** : la version en ligne est accessible depuis Internet. Pour les essais, utilisez des **données de test ou anonymisées**. Pour un usage réel avec des données d'étudiants, faites d'abord la déclaration auprès de la CNDP (loi 09-08) et validez l'hébergement avec l'établissement.

---

## 1. Supabase : la base de données (5 minutes)

1. Créez un compte sur https://supabase.com, puis cliquez sur **New project**.
   - **Name** : `unitimetable`
   - **Database password** : un mot de passe fort (gardez-le)
   - **Region** : *Europe West* ou *Europe Central*, les plus proches du Maroc.
2. Quand le projet est prêt : menu **SQL Editor** → **New query** → collez **tout** le fichier `supabase/schema.sql` → **Run**. Le résultat doit être « Success. No rows returned ».
3. Menu **Project Settings → API**, notez deux valeurs :
   - **Project URL** (ex. `https://abcdxyz.supabase.co`) → ce sera `SUPABASE_URL` ;
   - la clé **`service_role`** (section *Project API keys*, bouton *Reveal*) → ce sera `SUPABASE_SERVICE_ROLE_KEY`.

> 🔒 La clé `service_role` est **secrète**. Ne la mettez jamais dans le code, sur GitHub ni dans un message. Elle ne va que dans les variables d'environnement de Vercel (étape 3). Les tables ont la sécurité RLS activée sans aucune autorisation publique : la clé « anon » ne donne accès à rien.

## 2. GitHub : le code

1. Créez un dépôt **privé** sur https://github.com/new (ex. `unitimetable`).
2. Décompressez `UniTimetable-GitHub.zip` dans un dossier, puis envoyez son contenu sur GitHub :
   - **Avec GitHub Desktop** : *File → Add local repository* → choisissez le dossier → *Publish repository* (cochez *Keep this code private*).
   - **Ou en ligne de commande**, depuis le dossier :
     ```bash
     git init
     git add .
     git commit -m "UniTimetable v2.1"
     git branch -M main
     git remote add origin https://github.com/VOTRE-COMPTE/unitimetable.git
     git push -u origin main
     ```
3. **Facultatif** : copiez `xlsx.full.min.js` et `jspdf.umd.min.js` depuis `um6ss-server\um6ss-server\public\vendor` vers `server/public/vendor` avant l'envoi. Sinon, Vercel les télécharge lui-même pendant la compilation (`buildCommand`).

Le fichier `.gitignore` empêche d'envoyer les données (`data/`), journaux, certificats, `server.env` et clés.

## 3. Vercel : la mise en ligne

1. Créez un compte sur https://vercel.com avec votre compte GitHub, puis **Add New… → Project** → **Import** votre dépôt `unitimetable`.
2. **Framework Preset** : *Other*. Ne changez rien d'autre : `vercel.json` contient déjà la configuration.
3. **Environment Variables** :

   | Nom | Valeur |
   |---|---|
   | `SUPABASE_URL` | l'URL du projet Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | la clé `service_role` |
   | `ADMIN_PASSWORD` | mot de passe du premier administrateur (12 caractères ou plus) |

   Variables facultatives : `BACKUP_INTERVAL_HOURS=24`, `SESSION_IDLE_MINUTES=120`, `SESSION_MAX_HOURS=12`.
4. Cliquez sur **Deploy**. Au bout d'une minute environ, Vercel donne une adresse du type `https://unitimetable-xxxx.vercel.app`.

## 4. Premier accès

1. Ouvrez l'adresse Vercel et connectez-vous avec l'identifiant **`admin`** et le mot de passe `ADMIN_PASSWORD`.
2. **Changez immédiatement ce mot de passe** : en haut à droite, 👤 *Administrateur* → *Changer mon mot de passe*.
3. Dans Vercel : *Settings → Environment Variables* → **supprimez `ADMIN_PASSWORD`**. Il n'est utilisé qu'une fois, quand la base est vide.
4. Dans l'onglet **Administration**, créez les comptes de test : responsable emploi du temps, scolarité, enseignants reliés à leur fiche. Chaque compte reçoit un mot de passe temporaire à changer à la première connexion.

## 5. Ce qu'il faut tester

| Test | Comment | Résultat attendu |
|---|---|---|
| Connexion à distance | Ouvrir l'adresse sur un téléphone (4G) et un autre PC | Même données partout |
| Rôles | Se connecter avec chaque rôle | Onglets et droits limités (voir README-LOCAL-WINDOWS.md) |
| Synchronisation | Modifier une salle sur le PC A | Visible sur B en moins de 20 s |
| Conflit | Modifier la même séance sur A et B | Fenêtre « Conflit de modification » sur le second |
| Enseignant | Compte enseignant → séance → absences | Enregistrées et visibles par la scolarité |
| Lien WhatsApp | Scolarité → séance → *Envoyer la liste des absences* | Le lien s'ouvre sur le téléphone de l'enseignant, **même hors de l'établissement** |
| Journal d'audit | Administration → journal | Utilisateur, action, date, anciennes et nouvelles valeurs |
| Sauvegarde | Administration → *Créer une sauvegarde maintenant* | Nouvelle ligne dans la liste (table `unitt_backups`) |

**Application de bureau** : elle peut aussi utiliser la version en ligne. *Fichier → Configurer le serveur* → `https://` + l'adresse Vercel, port `443`.

## 6. Reprendre vos données locales (facultatif)

Les données du serveur local (`um6ss-server\um6ss-server\data`) peuvent être copiées dans Supabase. Les fichiers locaux ne sont pas modifiés.

```powershell
cd "C:\…\unitimetable\server"
$env:SUPABASE_URL="https://abcdxyz.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="…clé service_role…"
node tools\cloud-import.js --data "C:\Users\PC\Downloads\LAGHRAB Systems\um6ss-server\um6ss-server\data"
```

- Les comptes locaux, avec leurs mots de passe, sont copiés aussi. Pour recréer les comptes en ligne à la place, ajoutez `--sans-comptes`.
- Si la base Supabase n'est pas vide, ajoutez `--force`. Une sauvegarde Supabase est faite avant le remplacement.
- Le journal d'audit reste valide après la copie : le texte exact est conservé, grâce au type `json`.

## 7. Sauvegardes et restauration en ligne

- **Automatique** : une fois par jour, lors de la première requête qui suit le délai prévu.
- **Manuelle** : Administration → *Créer une sauvegarde maintenant*.
- Les 30 dernières sauvegardes sont gardées dans la table `unitt_backups`. Supabase sauvegarde aussi la base de son côté (selon votre offre).
- **Restaurer** : Supabase → SQL Editor :
  ```sql
  select id, created_at, reason from unitt_backups order by id desc;
  select unitt_restore(12);  -- 12 = numéro de la sauvegarde
  ```
  L'état actuel est sauvegardé d'abord, puis les postes rechargent les données.

## 8. Tester la version en ligne sur votre PC, avant Vercel

```powershell
$env:SUPABASE_URL="https://abcdxyz.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="…"; $env:ADMIN_PASSWORD="…"
node server\tools\cloud-dev.js
```
Puis ouvrez http://localhost:3000. C'est exactement le code qui tourne sur Vercel.

## 9. Différences avec la version locale (à savoir)

| Sujet | Version locale Windows | Version en ligne |
|---|---|---|
| Données | Fichiers `data\` | Supabase, en 2 documents JSON avec contrôle de version |
| Plusieurs serveurs en même temps | Non (verrou) | Oui. Plusieurs instances Vercel : écriture conditionnelle, et nouvel essai automatique en cas d'écriture simultanée |
| Alertes de non-déclaration | Vérifiées toutes les 30 s, même sans utilisateur | Vérifiées **à chaque requête** : Vercel n'a pas de tâche permanente |
| Limitation des tentatives par adresse IP | Globale | Par instance Vercel. Le verrouillage d'un compte après 5 échecs reste global, enregistré en base |
| Bouton « Gestion du serveur local » | Oui (application de bureau) | Sans objet : Vercel gère le serveur |
| Taille d'un envoi | 40 Mo | **4,5 Mo** au maximum par requête (limite Vercel). Évitez les très gros modèles .docx |
| Mise en veille | Non | Supabase gratuit : projet mis en pause après 7 jours sans activité (le relancer depuis Supabase) |

Le journal d'audit et les comptes sont dans un même document, envoyé en entier à chaque enregistrement. C'est adapté aux essais et à un établissement. Pour un grand volume, il faudra découper ce document en tables.

## 10. Tests automatiques (développeurs)

```bash
node server/tests/run-all.js
```
- Pour inclure la version en ligne, il faut un PostgreSQL de test : `PG="-h localhost -U postgres" node server/tests/cloud.test.js`. Ce test applique `supabase/schema.sql` à un vrai PostgreSQL, lance deux instances du serveur sur la même base (comme deux fonctions Vercel) et vérifie notamment 16 écritures simultanées sans perte.
- Le test de l'interface (`server/tests/e2e.ui.test.js`) s'exécute aussi en mode en ligne avec `E2E_CLOUD=1`.

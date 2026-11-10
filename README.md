# UniTimetable — UM6SS · FM6SIPS Dakhla

Gestion des emplois du temps, des étudiants, des absences, des attestations et du journal d'audit, avec des comptes individuels et des rôles vérifiés par le serveur.

| Dossier | Contenu |
|---|---|
| `server/` | Serveur Node.js (sans dépendance), interface web (`server/public`), outils, scripts Windows, tests |
| `api/index.js` + `vercel.json` | Mise en ligne sur **Vercel** (données dans **Supabase**) |
| `supabase/schema.sql` | Tables et fonctions de la base Supabase |
| `desktop/` | Application Windows (Electron) : client et gestion du serveur local |

## Plateforme multi-établissements (v3)
Un compte **Super Admin** (console `/platform`) gère plusieurs établissements totalement isolés, chacun avec ses comptes, ses données et son journal d'audit inaltérable. Voir **[PLATEFORME-MULTI-ETABLISSEMENTS.md](PLATEFORME-MULTI-ETABLISSEMENTS.md)**.

## Trois façons de l'utiliser
1. **En ligne (test, accès depuis partout)** : GitHub → Vercel → Supabase. Voir **[DEPLOIEMENT-VERCEL-SUPABASE.md](DEPLOIEMENT-VERCEL-SUPABASE.md)**.
2. **Réseau local de l'établissement, sans Internet** : PC serveur Windows. Voir **[server/README-LOCAL-WINDOWS.md](server/README-LOCAL-WINDOWS.md)**.
3. **Application de bureau** : se connecte à l'une ou l'autre version. Voir [desktop/README.md](desktop/README.md).

## Tests
```bash
node server/tests/run-all.js
```
Ce script lance les règles métier, le réseau local, la phase 1 et la version en ligne (si la variable `PG` est définie). Le test de l'interface demande Playwright.

## Sécurité
- Ne publiez jamais `server/data/`, `server.env`, les certificats ni la clé Supabase `service_role` : le fichier `.gitignore` les exclut.
- Aucun mot de passe par défaut. Le premier administrateur se crée avec `ADMIN_PASSWORD` (version en ligne) ou `windows\create-admin.ps1` (version locale).

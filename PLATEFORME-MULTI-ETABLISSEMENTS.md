# UniTimetable — plateforme multi-établissements (Super Admin)

Version 3.0 · phase 1 sur 3 (sections 21 et 22 du cahier des charges).

| Phase | Contenu | État |
|---|---|---|
| 1 | Établissements isolés, compte Super Admin, gestion des établissements et de leurs comptes, rôles, journal d'audit séparé et inaltérable, historique d'activité filtrable | **livrée** |
| 2 | Suppression logique partout, Corbeille, restauration avec détection des conflits | à venir |
| 3 | Identité visuelle par établissement (nom, logo, couleurs, documents PDF) | à venir |

## 1. Principe

- **Plateforme** : votre compte Super Admin, le registre des établissements, les paramètres globaux, le journal de la plateforme. Elle ne contient aucune donnée d'établissement.
- **Établissement** : un espace complètement séparé, avec ses comptes, rôles, étudiants, séances, absences, documents, journal et sauvegardes. Chaque établissement a un identifiant unique (`tenantId`) et un **code de connexion** (ex. `fm6sips-dakhla`).
- **Vos données actuelles** deviennent automatiquement le premier établissement (code `principal`), sans rien perdre. Une sauvegarde complète est faite avant la conversion. Les utilisateurs actuels continuent à se connecter **sans code** : c'est l'établissement par défaut.

## 2. Isolation des données

L'isolation est garantie par le serveur, pas par l'interface :

1. L'établissement d'une requête est déterminé **uniquement par le serveur** :
   - pour une session : préfixe du jeton de session ;
   - pour un lien WhatsApp : préfixe du jeton du lien ;
   - à la connexion : code saisi.
   Le jeton doit en plus exister dans le magasin de CET établissement. Un `tenantId` envoyé par le navigateur est ignoré.
2. Chaque établissement a ses propres documents de stockage :
   - en ligne : `store:<id>` et `state:<id>` dans Supabase ;
   - en local : dossier `data/tenants/<id>/`.
   Il a aussi ses propres journaux, historiques et sauvegardes.
3. Le serveur traite une requête à la fois : aucune requête ne peut lire l'établissement d'une autre.
4. Les routes Super Admin (`/api/platform/…`) utilisent une session distincte. Un compte d'établissement ne peut ni les appeler ni recevoir un rôle Super Admin.

Les tests automatiques (`tests/tenancy.test.js`, 178 vérifications sur fichiers et sur un vrai PostgreSQL) essaient notamment :

- jeton d'un établissement présenté avec le préfixe d'un autre ;
- `tenantId` forgé ;
- lien d'un établissement réutilisé pour un autre ;
- accès d'un administrateur d'établissement à la console ;
- modification du journal directement dans la base.

## 3. Journal d'audit inaltérable

- Le journal est **séparé** des données de travail :
  - en ligne : table `unitt_audit` ;
  - en local : fichier `audit.jsonl` de chaque établissement, et `platform-audit.jsonl`.
- **En ajout seul et chaîné** : chaque entrée contient l'empreinte de la précédente, et toute altération est détectée (bouton « Vérifier l'intégrité »).
- En ligne, la base de données **refuse** toute modification, suppression ou vidage de la table, grâce à des déclencheurs PostgreSQL. Ce refus s'applique même avec un accès direct à la base.
- Chaque entrée contient :
  - utilisateur, établissement, rubrique, action, élément concerné ;
  - date ;
  - anciennes et nouvelles valeurs ;
  - résultat (succès, refusé, échec) ;
  - motif, quand il existe.
- Une restauration de sauvegarde **ne restaure jamais le journal**. Elle est elle-même inscrite au journal.

## 4. Mise à jour de la version en ligne (Vercel + Supabase)

1. **Supabase** → SQL Editor → coller **tout** le fichier `supabase/schema.sql` → Run. Le script est ré-exécutable sans perte : il ajoute la table du journal, les colonnes et les fonctions.
2. **Vercel** → Settings → Environment Variables, ajouter :
   - `SUPERADMIN_USERNAME` : votre identifiant (ex. `proprietaire`) ;
   - `SUPERADMIN_PASSWORD` : mot de passe initial, 14 caractères minimum, au moins 3 types de caractères (minuscules, majuscules, chiffres, symboles).
   - (facultatif) `SUPERADMIN_NETWORKS` : adresses autorisées pour la console, ex. `196.200.0.0/16`.
3. Envoyer le nouveau code sur GitHub (Vercel redéploie).
4. Ouvrir **`https://<votre-site>/platform`**, se connecter, puis :
   - changer le mot de passe (demandé automatiquement) ;
   - Mon compte → **Activer la double authentification** (Google Authenticator, Microsoft Authenticator, 2FAS…).
5. **Retirer `SUPERADMIN_PASSWORD`** des variables Vercel. Il ne sert qu'à créer le compte la première fois.

## 5. Serveur local (Windows)

- Au premier démarrage de cette version, le dossier `data` est sauvegardé, puis converti. Le premier établissement reste dans `data`. Les suivants sont créés dans `data\tenants\<id>\`.
- Pour créer le compte Super Admin (serveur arrêté) : `node tools\create-superadmin.js`. Console : `https://<serveur>:8787/platform`.
- Les outils en ligne de commande acceptent `--etab <code>` pour viser un autre établissement que le premier. Exemples :
  - `node tools\reset-password.js --etab atlas --username admin` ;
  - `restore.js`, `backup.js`, `migrate.js` acceptent aussi cette option.

## 6. Console Super Admin (`/platform`)

- **Établissements** : créer (avec son administrateur et un mot de passe temporaire), modifier les informations et l'abonnement (formule, dates, nombre maximal de comptes), activer / suspendre / désactiver.
  - Le motif est obligatoire pour changer le statut.
  - Une suspension ou un abonnement expiré ferme immédiatement les sessions et les liens de l'établissement.
  - Aucune donnée n'est supprimée.
- **Comptes d'un établissement** : liste, création, réinitialisation du mot de passe, désactivation, historique complet d'un utilisateur dans l'ordre chronologique.
- **Journal d'activité** de chaque établissement. Filtres :
  - utilisateur, rubrique, type d'action, élément, résultat, période ;
  - détail des anciennes et nouvelles valeurs ;
  - vérification d'intégrité.
- **Entrer dans un espace** :
  - **Consultation** : lecture seule, le bandeau orange s'affiche.
  - **Intervention** : motif obligatoire, le bandeau rouge s'affiche.
  - La session est limitée à 2 h par défaut. L'entrée, les consultations et chaque modification sont inscrites dans le journal de l'établissement **et** dans celui de la plateforme.
- **Journal de la plateforme** et **Paramètres** :
  - nom de la plateforme ;
  - établissement par défaut ;
  - durées de session.

## 7. Côté établissement (administrateur de l'établissement)

- Connexion avec le **code de l'établissement**. Le lien `https://<site>/?etab=<code>` préremplit le code.
- Onglet **Administration** :
  - informations de l'établissement (nom en français et en arabe, contact) ;
  - comptes des employés (nom, poste, e-mail, rôle, autorisations accordées ou retirées) ;
  - rôles personnalisés ;
  - sauvegardes ;
  - journal filtrable.
- Rôles standards :
  - Administrateur de l'établissement ;
  - Responsable de la scolarité ;
  - Responsable de l'emploi du temps ;
  - Enseignant ;
  - **Direction** (lecture de tout) ;
  - **Finance**.
  Les rôles personnalisés n'ont jamais les droits d'administration.
- Un administrateur d'établissement ne voit jamais un autre établissement. Il ne peut pas modifier le statut ni l'abonnement de son établissement.

# UniTimetable — plateforme multi-établissements (Super Admin)

Version 3.1 · les 3 phases sont livrées (sections 21 et 22 du cahier des charges).

| Phase | Contenu | État |
|---|---|---|
| 1 | Établissements isolés, compte Super Admin, gestion des établissements et de leurs comptes, rôles, journal d'audit séparé et inaltérable, historique d'activité filtrable | **livrée** |
| 2 | Suppression logique partout, Corbeille, restauration avec détection des conflits | **livrée** |
| 3 | Identité visuelle par établissement (nom, logo, couleurs, documents PDF) | **livrée** |

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

## 8. Suppression logique et Corbeille (phase 2)

Le serveur applique cette règle, quelle que soit l'interface utilisée : **le bouton Supprimer n'efface jamais rien**.

- **Ce qui se passe à la suppression.** Quand un élément disparaît des données enregistrées par un poste, le serveur le place dans la **Corbeille** de l'établissement, avec :
  - son identifiant d'origine ;
  - toutes ses valeurs et ses liens ;
  - le statut « supprimé » ;
  - l'auteur, la date et l'heure ;
  - le motif.
  Un événement « suppression logique » est ajouté au journal d'audit.
- **Éléments concernés :** étudiants, enseignants, séances, groupes, matières, salles, filières, modèles de documents, volumes horaires, rôles personnalisés.
  - Les comptes utilisateurs ne se suppriment pas : ils se désactivent.
  - Les déclarations d'absence s'annulent, avec leur historique.
- **Motif.** Il est demandé à chaque suppression. L'administrateur peut le rendre **obligatoire** (Administration → Établissement). Dans ce cas, le serveur refuse toute suppression sans motif.
- **Onglet 🗑 Corbeille :**
  - recherche ;
  - filtres par type, état et période ;
  - détail des valeurs conservées et de l'historique ;
  - bouton **Restaurer**, réservé aux autorisations « Restaurer des éléments supprimés » : l'administrateur par défaut, ou un compte qui a reçu ce droit.
  - Chacun ne voit que les rubriques qu'il gère. Par exemple, la planification ne voit pas les étudiants supprimés.
- **Restauration.** L'élément revient avec le **même identifiant**, ses liens et, pour un étudiant, son historique de groupes. Il n'y a jamais de doublon.
  - Les conflits sont signalés clairement, et la restauration reste bloquée tant qu'ils ne sont pas résolus :
    - doublon (même matricule, même nom) ;
    - dépendance supprimée (« restaurez d'abord l'enseignant ») ;
    - conflit d'emploi du temps (salle, enseignant ou groupe déjà occupés sur le créneau).
  - Suppression et restauration sont **deux événements distincts** du journal. L'historique complet reste disponible.
- **Super Admin :**
  - menu **Corbeilles** : suppressions et restaurations de tous les établissements, avec filtres ;
  - restauration possible, inscrite dans le journal de l'établissement et dans celui de la plateforme.
- Aucune route ne permet de vider la Corbeille ni de supprimer définitivement un élément.

## 9. Identité visuelle (phase 3)

Elle se règle dans Administration → **Identité visuelle**, avec l'autorisation « Modifier les informations et l'identité visuelle ». Il n'y a aucun code à modifier et rien à recompiler.

- **Noms :**
  - nom affiché dans l'application ;
  - nom des rapports et des documents officiels ;
  - nom en arabe.
- **Logo :**
  - formats PNG, JPEG ou WEBP. Le SVG est refusé pour la sécurité, et le contenu du fichier est vérifié ;
  - réduction automatique, 400 Ko au maximum ;
  - aperçu avant d'enregistrer ;
  - emplacements à choisir : barre de navigation, page de connexion, tableau de bord, rapports et PDF, documents officiels.
- **Couleurs :**
  - six couleurs : principale, secondaire, fond, barre de navigation, boutons, texte ;
  - **aperçu en direct** sur la page ;
  - alerte si le contraste est insuffisant ;
  - texte de l'en-tête et des boutons calculé automatiquement pour rester lisible ;
  - bouton **Rétablir le thème par défaut**.
- **Où l'identité est appliquée :**
  - page de connexion (selon le code de l'établissement) ;
  - en-tête et barre de navigation, tableau de bord, toutes les pages ;
  - rapport PDF d'avancement (nom et logo) ;
  - impressions ;
  - feuille de suivi des absences ;
  - attestations Word : champs `{{etablissement}}` et `{{etablissement_ar}}` ;
  - formulaire de déclaration des enseignants (lien WhatsApp).
- **Limite :** le logo n'est pas inséré automatiquement dans les attestations Word. Placez-le directement dans le modèle `.docx`.
- **Établissement d'origine :** il garde ses logos UM6SS sur la feuille d'émargement tant qu'aucun logo n'est défini.
- **Séparation :** chaque établissement a sa propre identité. Une modification n'a aucun effet sur les autres. Le journal garde une empreinte du logo, pas l'image.
- **Super Admin :** voit l'identité de chaque établissement dans sa fiche. Il ne peut pas la modifier en mode consultation.
- **Thème par défaut de la plateforme :** le thème d'origine, plus le nom de la plateforme (Paramètres).

**Aucune nouvelle étape SQL** pour les phases 2 et 3 : tout est enregistré dans les documents de chaque établissement. Le `schema.sql` de la phase 1 suffit.

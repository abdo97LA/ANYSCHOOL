# UniTimetable sur le réseau local (Windows) — guide d'installation

Ce guide explique comment installer UniTimetable dans l'établissement **sans serveur Internet**. Un PC Windows principal héberge les données. Les autres PC s'y connectent par le réseau local (câble ou Wi-Fi).

> Les adresses de ce guide (`192.168.1.10`, port `8787`) sont des **exemples**. Remplacez-les par celles de votre réseau.

---

## 1. Comment ça fonctionne

```
 ┌──────────────── Réseau local de l'établissement (LAN / Wi-Fi) ────────────────┐
 │                                                                               │
 │   PC PRINCIPAL (serveur)                     POSTES CLIENTS                   │
 │   ┌───────────────────────────┐   http(s)    ┌───────────────────────────┐    │
 │   │ Node.js + server.js       │◄────────────►│ Application UniTimetable  │    │
 │   │ • interface (index.html)  │  192.168.1.10│ (Electron) ou navigateur  │    │
 │   │ • comptes et rôles        │    :8787     └───────────────────────────┘    │
 │   │ • données centrales       │              ┌───────────────────────────┐    │
 │   │ • absences, alertes       │◄────────────►│ Autre poste …             │    │
 │   │ • sauvegardes, journaux   │              └───────────────────────────┘    │
 │   └───────────────────────────┘                                               │
 │   Pare-feu : port 8787, profil Privé, sous-réseau local uniquement            │
 └───────────────────────────────────────────────────────────────────────────────┘
        ✖ Aucune redirection de port sur la box Internet  ✖ Aucun service cloud
```

- **Le serveur** garde toutes les données partagées : séances, matières, enseignants, salles, groupes, étudiants, modèles de documents, absences, comptes et journal d'audit. Il fonctionne **même si Internet est coupé**.
- **Les postes clients** affichent l'interface. Celle-ci est fournie par le serveur : si on la met à jour sur le serveur, tous les postes la reçoivent, sans réinstaller l'application.
- **Chaque personne a son propre compte.** Le serveur vérifie les droits à **chaque opération**. Masquer un bouton dans l'interface n'est qu'un confort : ce n'est pas ce qui protège les données.
- **Synchronisation** : chaque modification est envoyée au serveur, puis les autres postes la reçoivent en moins de 20 secondes. Si deux personnes modifient **des éléments différents** en même temps, le serveur fusionne les deux. Si elles modifient **le même élément**, l'application affiche un **conflit** et demande quoi garder. Rien n'est écrasé sans prévenir.
- Si le réseau est coupé, les modifications restent sur le poste. Elles sont envoyées automatiquement quand la connexion revient.

### Les rôles

| Rôle | Peut faire | Ne peut pas faire |
|---|---|---|
| **Administrateur système** | Tout : comptes, rôles, sauvegardes, journal d'audit, configuration, restauration | — |
| **Responsable de la scolarité** | Dossiers étudiants, modèles d'attestations et de certificats, absences (consulter, saisir, corriger, annuler), liens WhatsApp, délais des enseignants, alertes | Modifier les séances et l'emploi du temps, les comptes, les paramètres techniques |
| **Responsable de l'emploi du temps** | Séances, matières, salles, enseignants, groupes, filières, calendrier, détection des conflits ; voir les effectifs et les totaux d'absences | Voir les noms et données personnelles des étudiants, gérer les absences, les comptes |
| **Enseignant** | Voir **ses** séances et les étudiants de **ses** groupes (nom et matricule uniquement), saisir et corriger (sous 24 h) les absences de **ses** séances | Voir les dossiers administratifs, les autres séances, modifier l'emploi du temps ou les comptes |

L'administrateur peut aussi accorder une **autorisation supplémentaire** à un compte précis. Par exemple, permettre à un enseignant de consulter toutes les absences.

---

## 2. Installer le serveur (PC principal)

### 2.1 Prérequis
1. Un PC Windows 10 ou 11 qui reste allumé pendant les heures d'utilisation.
2. **Node.js LTS** (version 22 recommandée, 18 au minimum) : téléchargez-le sur https://nodejs.org, choisissez « LTS », puis installez-le avec les options par défaut.
   Pour vérifier : ouvrez **PowerShell** et tapez `node -v`. Le résultat doit ressembler à `v22.x.x`.
3. Copiez le dossier `um6ss-server\um6ss-server` sur le PC. Un chemin simple est conseillé, par exemple `C:\UniTimetable\serveur`.

> Le serveur n'a **aucune dépendance** à installer avec npm. Il n'a pas besoin de Docker.

### 2.2 Installation automatique
1. Ouvrez **PowerShell en tant qu'administrateur** (menu Démarrer → tapez « PowerShell » → clic droit → *Exécuter en tant qu'administrateur*).
2. Placez-vous dans le dossier du serveur :
   ```powershell
   cd C:\UniTimetable\serveur
   ```
3. Lancez l'installation :
   ```powershell
   powershell -ExecutionPolicy Bypass -File windows\install-server.ps1
   ```
   Ce script :
   - vérifie Node.js ;
   - crée `server.env` (la configuration) ;
   - télécharge **une seule fois** les bibliothèques Excel et PDF, si Internet est disponible à ce moment-là ;
   - réserve l'accès aux dossiers `data`, `logs` et `backups` au système et aux administrateurs ;
   - crée la **règle de pare-feu** ;
   - crée la **tâche planifiée** « UniTimetable Serveur », qui démarre le serveur à chaque allumage du PC, même si personne n'ouvre de session.

### 2.3 Créer le premier administrateur
Aucun compte ni mot de passe n'existe par défaut. Pour créer le premier administrateur, toujours dans PowerShell en administrateur :
```powershell
powershell -ExecutionPolicy Bypass -File windows\create-admin.ps1
```
Indiquez un identifiant (par exemple `admin.info`), un nom affiché et un mot de passe d'au moins 10 caractères. Le mot de passe ne s'affiche pas pendant la saisie et n'est enregistré nulle part en clair : il est haché avec scrypt.

### 2.4 Démarrer, arrêter, vérifier

| Action | Commande (PowerShell en administrateur, dans le dossier du serveur) |
|---|---|
| Démarrer | `powershell -ExecutionPolicy Bypass -File windows\start-server.ps1` |
| Arrêter | `powershell -ExecutionPolicy Bypass -File windows\stop-server.ps1` |
| Diagnostic complet | `powershell -ExecutionPolicy Bypass -File windows\status-server.ps1` |
| Lancer dans une fenêtre (test, dépannage) | double-clic sur `windows\run-console.bat` (en administrateur), Ctrl+C pour arrêter |
| Retirer la tâche et la règle (les données sont conservées) | `powershell -ExecutionPolicy Bypass -File windows\uninstall-server.ps1` |

Le diagnostic affiche notamment : l'état de la tâche, le processus, le port, la réponse de `/health`, les **adresses à donner aux postes**, la règle de pare-feu, le profil réseau, la dernière sauvegarde et les dernières lignes du journal.

**Redémarrage automatique** : la tâche lance `windows\run-server.ps1`. Ce script relance le serveur s'il s'arrête de façon anormale, en attendant de plus en plus longtemps entre deux essais (5 s, 15 s, 30 s, 60 s, 120 s), avec au plus 10 relances par heure. Il ne lance jamais deux serveurs en même temps : un verrou global est posé, et le fichier `data\server.lock` est vérifié par le serveur lui-même.

**Journaux** : `logs\server-AAAA-MM-JJ.log` (un fichier par jour, conservé 60 jours) et `logs\superviseur.log`. Ils ne contiennent ni mots de passe, ni jetons de session, ni données d'étudiants.

### 2.5 Configuration (`server.env`)
Le fichier `server.env` se trouve dans le dossier du serveur. Modèle commenté : `server.env.exemple`.

| Paramètre | Rôle | Défaut |
|---|---|---|
| `HOST` | interface d'écoute (`0.0.0.0` = toutes les cartes réseau) | `0.0.0.0` |
| `PORT` | port | `8787` |
| `DATA_DIR` | données (`store.json`, `state.json`, `secret.key`, historique) | `data` |
| `BACKUP_DIR` | sauvegardes (**mettez de préférence un autre disque**) | `data\backups` |
| `LOG_DIR` | journaux | `logs` |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | fréquence et nombre de sauvegardes automatiques | `24` / `30` |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | expiration des sessions | `120` / `12` |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | verrouillage après échecs | `5` / `15` |
| `ALLOWED_NETWORKS` | (optionnel) plages autorisées, ex. `192.168.1.0/24` | toutes |
| `TLS_PFX` / `TLS_PFX_PASSPHRASE` | HTTPS (voir § 5) | désactivé |

Après chaque modification : `stop-server.ps1`, puis `start-server.ps1`.

---

## 3. Réseau : adresse IP fixe et pare-feu

### 3.1 Adresse IP stable pour le serveur
Les postes se connectent par l'adresse IP du serveur. Cette adresse **ne doit pas changer**.
- **Méthode conseillée : une réservation DHCP sur le routeur ou la box.** Dans l'interface d'administration du routeur, cherchez « DHCP » → « Réservation », puis associez l'adresse MAC du PC serveur à une adresse, par exemple `192.168.1.10`. Pour connaître l'adresse MAC : `getmac /v` ou `ipconfig /all` (ligne « Adresse physique »).
- Autre méthode : une IP fixe dans Windows (Paramètres → Réseau → Propriétés → Attribution IP → Manuelle). Choisissez une adresse **hors** de la plage DHCP du routeur.
- `status-server.ps1` affiche les adresses actuelles et prévient si l'adresse vient du DHCP sans réservation.

### 3.2 Pare-feu Windows Defender
`install-server.ps1` crée déjà la règle. Pour la recréer :
```powershell
powershell -ExecutionPolicy Bypass -File windows\configure-firewall.ps1
# ou limiter à une plage précise :
powershell -ExecutionPolicy Bypass -File windows\configure-firewall.ps1 -RemoteAddress 192.168.1.0/24
```
La règle n'autorise que **TCP entrant sur le port du serveur**, pour **node.exe**, sur le **profil « Privé »**, depuis le **sous-réseau local**.
Le réseau de l'établissement doit donc être classé **« Privé »** sur le PC serveur. Le script le vérifie et propose de faire la modification. Sur un réseau classé « Public », la règle ne s'applique pas et les postes ne peuvent pas se connecter.

### 3.3 Ce qu'il ne faut PAS faire
- **Ne créez aucune redirection de port** (NAT, *port forwarding*, DMZ, UPnP) vers le PC serveur sur la box Internet. Le serveur ne doit pas être joignable depuis Internet.
- N'ouvrez pas le port sur le profil « Public ».
- Une adresse `192.168.x.x` n'est pas sûre pour autant : un appareil branché sur le Wi-Fi invités, par exemple, peut l'utiliser. La sécurité repose sur **les comptes, les droits vérifiés par le serveur et la règle de pare-feu**. Si le Wi-Fi invités partage le même réseau, définissez `ALLOWED_NETWORKS` sur la plage du réseau du personnel, ou séparez les réseaux sur le routeur.

### 3.4 Vérifier depuis un poste client
Sur un autre PC du réseau, dans PowerShell :
```powershell
powershell -ExecutionPolicy Bypass -File test-connexion-client.ps1 -IP 192.168.1.10 -Port 8787
```
Le script se trouve dans `windows\` sur le serveur ; copiez-le sur une clé USB. Vous pouvez aussi ouvrir `http://192.168.1.10:8787/health` dans un navigateur : la réponse doit contenir `"ok":true`.

---

## 4. Installer l'application sur les postes (client Windows)

### 4.1 Installation
1. Copiez `UniTimetable-Setup.exe` sur le poste et lancez-le. Le programme d'installation crée un raccourci sur le Bureau et dans le menu Démarrer. Pour désinstaller : Paramètres → Applications.
2. Au premier lancement, l'écran **Configuration du serveur** s'affiche :
   - choisissez `http://` (ou `https://`, voir § 5) ;
   - indiquez l'**adresse IP** et le **port**, par exemple `192.168.1.10` et `8787` ;
   - cliquez sur **Tester la connexion**, puis sur **Enregistrer et ouvrir**.
3. Connectez-vous avec votre compte personnel.

Pour changer l'adresse plus tard : menu **Fichier → Configurer le serveur…** (Ctrl+Maj+S).

**Imposer l'adresse sur un poste (administrateur), sans rien reconstruire** : sur le poste client, en administrateur :
```powershell
powershell -ExecutionPolicy Bypass -File set-client-server.ps1 -Url http://192.168.1.10:8787
```
Ce script écrit `%ProgramData%\UniTimetable\client.json`. Ordre de priorité : argument `--server=` du raccourci, puis choix de l'utilisateur, puis ce fichier.

**Si le serveur est indisponible**, l'application affiche la cause : délai dépassé, pare-feu, certificat… Elle propose « Réessayer » et se reconnecte d'elle-même toutes les 15 secondes.

**Sans installer l'application**, un navigateur récent (Edge ou Chrome) à l'adresse `http://192.168.1.10:8787` fonctionne aussi.

### 4.2 Sécurité du client
- L'application ne contient **aucune donnée** de l'établissement. Elle garde seulement l'adresse du serveur et un cache de la session en cours.
- À la **déconnexion**, le cache local est effacé, s'il ne reste rien à envoyer. Quand un **autre compte** se connecte sur le même poste, les données de l'ancien compte sont effacées du cache.
- Les pages n'ont aucun accès au système (isolation, sandbox). La navigation est limitée au serveur configuré. Les liens externes (WhatsApp) s'ouvrent dans le navigateur.
- La vérification des certificats HTTPS n'est **jamais** désactivée.

---

## 5. HTTP ou HTTPS sur le réseau local

**Par défaut, le serveur fonctionne en HTTP.** Sur le réseau, les échanges circulent **en clair** : une personne qui écoute le réseau, par exemple sur un Wi-Fi partagé, pourrait lire des données ou un cookie de session. Les risques sont limités par la règle de pare-feu (réseau privé uniquement), l'expiration des sessions et les cookies `HttpOnly` et `SameSite=Strict`. **Il est quand même recommandé de passer en HTTPS dès que l'installation fonctionne**, surtout en Wi-Fi.

### Mise en place du HTTPS (certificat local)
1. **Sur le serveur** (PowerShell en administrateur) :
   ```powershell
   powershell -ExecutionPolicy Bypass -File windows\new-certificate.ps1 -IP 192.168.1.10
   ```
   Ce script :
   - crée `certs\unitimetable.pfx`, qui contient la clé privée. Ce fichier reste sur le serveur, avec un accès limité au système et aux administrateurs ;
   - crée `certs\unitimetable.cer`, le certificat public ;
   - ajoute `TLS_PFX` et `TLS_PFX_PASSPHRASE` dans `server.env` ;
   - affiche l'**empreinte** du certificat. Notez-la.

   Redémarrez ensuite le serveur avec `stop-server.ps1` puis `start-server.ps1`.
2. **Sur chaque poste client** (en administrateur), copiez `unitimetable.cer` et `windows\trust-certificate.ps1`, puis :
   ```powershell
   powershell -ExecutionPolicy Bypass -File trust-certificate.ps1 -Path .\unitimetable.cer
   ```
   Vérifiez que l'empreinte affichée est **identique** à celle du serveur avant de confirmer. Le certificat est ajouté aux « Autorités racines de confiance » de l'ordinateur. L'application, Edge et Chrome l'acceptent alors, et **uniquement ce certificat-là**.
3. Dans l'application : **Fichier → Configurer le serveur** → `https://192.168.1.10:8787`.

Le certificat est lié à l'adresse IP. **Si l'IP du serveur change**, refaites l'étape 1, puis l'étape 2 sur les postes. Le certificat est valable 3 ans par défaut (paramètre `-Years`).

---

## 6. Comptes et rôles

### Créer un compte (administrateur)
1. Connectez-vous avec un compte administrateur.
2. Ouvrez l'onglet **Administration** → **+ Nouveau compte**.
3. Renseignez :
   - l'identifiant (par exemple `m.amrani`) ;
   - le nom affiché ;
   - le **rôle** ;
   - pour un **enseignant**, sa **fiche enseignant** (celle de l'onglet *Teachers*, obligatoire : c'est elle qui détermine ses séances).
4. Un **mot de passe temporaire** est proposé. Communiquez-le en main propre. La personne devra **choisir son propre mot de passe** à la première connexion.

### Gérer les comptes
Dans **Administration**, vous pouvez :
- **Modifier** un compte : nom, rôle, fiche enseignant, autorisations supplémentaires ;
- **Mot de passe** : réinitialiser. Toutes les sessions de la personne sont fermées et elle devra changer le mot de passe ;
- **Désactiver** ou **Réactiver** un compte. La désactivation prend effet immédiatement. Il n'y a pas de suppression : l'historique est conservé ;
- **Déverrouiller** un compte, après 5 échecs de connexion le compte est verrouillé 15 minutes.

Il reste toujours au moins un administrateur actif : le serveur refuse de désactiver ou de rétrograder le dernier.

### Mot de passe oublié
- Pour un utilisateur : l'administrateur le réinitialise dans **Administration**.
- **Si l'administrateur a oublié le sien**, sur le PC serveur, en administrateur :
  ```powershell
  powershell -ExecutionPolicy Bypass -File windows\reset-password.ps1 -Username admin.info
  ```
  Le script arrête puis redémarre le serveur. Le compte est réactivé et déverrouillé.

### Autorisations individuelles
Dans **Administration → Modifier**, la liste des autorisations montre l'état réel du compte :
- *(rôle)* : accordée par le rôle. **Décochez-la pour la retirer** à ce compte uniquement.
- *(accordée)* : ajoutée en plus du rôle.

Le changement prend effet dès l'action suivante de la personne, sans modifier le code. Les droits d'administration (comptes, sauvegardes, journal, restauration) ne peuvent pas être accordés individuellement, ni retirés à un administrateur. La permission **finance.read** (données financières) est réservée par défaut à l'administrateur.

### Journal d'audit
Dans **Administration → Journal d'audit du serveur**, chaque entrée indique la date, l'utilisateur, l'action et le poste (adresse IP). Exemples d'actions : connexions, échecs, comptes créés ou modifiés, données enregistrées (avec les collections touchées), refus de droits, conflits résolus, sauvegardes, absences.
Pour chaque enregistrement, le détail **anciennes → nouvelles valeurs** est consultable (100 éléments au plus par enregistrement, avec le nombre total).
Le journal de l'interface (onglet *Journal d'audit*) est en **ajout seul** : si un poste tente d'en supprimer ou d'en modifier une entrée, le serveur la conserve et inscrit la tentative au journal du serveur.
Le journal est **chaîné** : si quelqu'un modifie le fichier de données à la main, cela est détecté et signalé (« chaîne ROMPUE »).

---

## 7. Transférer vos données actuelles

Aujourd'hui, les séances, enseignants, étudiants et modèles sont enregistrés **dans l'ancienne application** de l'administrateur (stockage local). Pour les transférer **sans rien perdre** :

1. Dans **l'ancienne** application (avant de la désinstaller) : **💾 Sauvegarde → Exporter toutes les données (JSON)**. Vous obtenez un fichier `sauvegarde_um6ss_AAAA-MM-JJ.json`. Gardez-en une copie sur une clé USB.
2. Importez ce fichier sur le serveur, de l'une des deux façons suivantes :
   - **dans l'interface** : connectez-vous en administrateur, puis **💾 Sauvegarde → Restaurer un fichier de sauvegarde**. Cochez la confirmation, puis cliquez sur *Restaurer*. Une sauvegarde du serveur est faite avant ;
   - **ou en ligne de commande**, serveur arrêté :
     ```powershell
     powershell -ExecutionPolicy Bypass -File windows\stop-server.ps1
     node tools\import-data.js --file C:\chemin\sauvegarde_um6ss_2026-10-25.json
     powershell -ExecutionPolicy Bypass -File windows\start-server.ps1
     ```
3. Les déclarations d'absences, les liens et les alertes déjà présents dans `data\store.json` sont **repris automatiquement** par le nouveau serveur. Au premier démarrage, une copie est faite dans `backups\…-premier-demarrage`.
4. Créez les comptes (§ 6), puis installez le client sur les postes (§ 4).

---

## 8. Sauvegardes et restauration

- **Automatiques** : toutes les 24 h, en plus de celles faites avant chaque restauration, résolution de conflit ou import. Les 30 dernières sont conservées. Chacune contient `store.json`, `state.json`, `secret.key` et un `manifest.json` avec les empreintes SHA-256.
- **À la demande** : **Administration → Créer une sauvegarde maintenant**, ou :
  ```powershell
  powershell -ExecutionPolicy Bypass -File windows\backup-now.ps1 -Dest D:\Sauvegardes\UniTimetable
  ```
- **Sur un autre support (indispensable)** : réglez `BACKUP_DIR` sur un **autre disque**, un NAS ou un dossier synchronisé. Copiez aussi régulièrement ce dossier sur un support **hors du bâtiment**. Une sauvegarde sur le même disque ne protège pas d'une panne de ce disque.
- **Restaurer**, en administrateur :
  ```powershell
  powershell -ExecutionPolicy Bypass -File windows\restore.ps1 -List
  powershell -ExecutionPolicy Bypass -File windows\restore.ps1 -Name 20261025-020000-auto
  ```
  Le script :
  - arrête le serveur ;
  - **vérifie les empreintes** et refuse une sauvegarde altérée ;
  - sauvegarde l'état actuel (`…-avant-restauration`) ;
  - restaure les fichiers ;
  - ferme toutes les sessions ;
  - redémarre le serveur.

  Les postes rechargent automatiquement les données restaurées.

**Protéger les dossiers** : `data`, `backups`, `logs`, `certs` et `server.env` ne sont accessibles qu'au système et aux administrateurs (fait par `install-server.ps1`). Ne partagez pas ces dossiers sur le réseau.

---

## 8 bis. Migrations du modèle de données
Les migrations ne s'appliquent **jamais automatiquement** : soit `node tools\migrate.js --up` (serveur arrêté), soit `MIGRATIONS_AUTO=1` dans `server.env` pour qu'elles s'appliquent au prochain démarrage. Dans les deux cas, une **sauvegarde vérifiée** est faite d'abord (`backups\…-avant-migration`) ; sans sauvegarde valide, rien n'est modifié.
Ces migrations ajoutent seulement des champs :
- `001` : année universitaire des déclarations d'absences ;
- `002` : historique d'appartenance aux groupes des étudiants. Cet historique est géré uniquement par le serveur : il ajoute une entrée datée à chaque changement de filière, d'année ou de groupe, et la liste d'une séance passée utilise le groupe à la date de la séance.

Commandes utiles (PowerShell en administrateur, **serveur arrêté**) :
```powershell
node tools\migrate.js --status
node tools\migrate.js --down 001-annee-universitaire-absences
node tools\migrate.js --up --data-dir C:\copie\data
```
- `--status` : état des migrations ;
- `--down` : retour arrière ; une sauvegarde vérifiée est faite avant ;
- `--up --data-dir` : essai sur une **copie** des données.

**Retour arrière complet** :
1. Arrêtez le serveur.
2. Lancez `node tools\migrate.js --down 001-annee-universitaire-absences`.
3. Retirez `MIGRATIONS_AUTO=1` de `server.env` s'il y figure, pour qu'elles ne soient pas réappliquées au démarrage.

Si des étudiants ont changé de groupe depuis la migration 002, son annulation effacerait cet historique : la commande refuse, sauf avec `--force`.

## 9. Tests

Dans le dossier du serveur (Node.js uniquement, aucun accès Internet nécessaire) :
```powershell
node tests\rules.test.js     # 38 règles métier : délais, alertes, Ramadan, audit…
node tests\lan.test.js       # comptes, rôles, synchronisation entre deux postes, conflits, sauvegardes, journaux, HTTPS…
node tests\phase1.test.js    # migrations réversibles, permissions, statuts, historique des groupes, audit en ajout seul
# migration testée sur une copie de VOS données : set REAL_STORE=C:\…\data\store.json  puis  node tests\phase1.test.js
node tests\run-all.js        # tout, y compris le test de l'interface si Playwright est installé
```
Le test de l'interface réelle avec plusieurs navigateurs (`tests\e2e.ui.test.js`) nécessite Playwright :
`npm i -D playwright` puis `npx playwright install chromium`.

---

## 10. Compiler le client Windows (`UniTimetable-Setup.exe`)

Sur un PC Windows avec Node.js et Internet (pour télécharger Electron une seule fois) :
```bat
cd UniTimetable-Desktop
npm install
npx electron-builder --win nsis portable --x64
```
Vous pouvez aussi double-cliquer sur `build.bat`. Les fichiers produits sont :
- `dist\releases\UniTimetable-Setup.exe` (installateur) ;
- `dist\releases\UniTimetable-Portable.exe` (sans installation).

**En cas d'erreur « Cannot create symbolic link »** : activez le **Mode développeur** (Paramètres → Système → Pour les développeurs), ou lancez l'invite de commandes en administrateur, puis recommencez.

---

## 11. Dépannage rapide

| Symptôme | Vérification |
|---|---|
| Le poste affiche « Pas de réponse du serveur » | `status-server.ps1` sur le serveur ; IP et port corrects ; profil réseau « Privé » ; règle de pare-feu présente ; même réseau (pas le Wi-Fi invités) |
| « Certificat HTTPS non reconnu » | installer `unitimetable.cer` sur le poste (§ 5) ; l'IP du serveur a-t-elle changé ? |
| « Le port 8787 est déjà utilisé » (journal) | un autre programme ou une autre instance utilise le port : changez `PORT` ou arrêtez l'autre programme |
| « Aucun compte n'existe encore » | `windows\create-admin.ps1` |
| Compte verrouillé | attendre 15 min, ou **Administration → Déverrouiller** |
| Import Excel / PDF indisponible | `windows\fetch-vendor.ps1` (Internet nécessaire pendant la commande), ou copier `xlsx.full.min.js` et `jspdf.umd.min.js` dans `public\vendor` |
| « Conflit de modification » | choisir quelle version garder pour les éléments listés ; une copie de sécurité est faite dans les deux cas |
| « Modification refusée par le serveur » | votre rôle ne permet pas cette modification : cliquez sur « Recharger les données du serveur » |

---

## 12. Limites connues
- Le serveur stocke ses données dans des **fichiers JSON**, avec des écritures atomiques, une copie `.bak`, un historique des révisions et des sauvegardes. C'est adapté à un établissement (quelques dizaines de postes). Pour des volumes bien plus importants, il faudrait passer à une base de données.
- Les **mots de passe des enseignants** ne permettent pas de se connecter au formulaire mobile `/f/…`, qui reste accessible par **lien à usage unique** comme avant.
- Le **HTTPS** repose sur un certificat local auto-signé : il faut l'installer sur chaque poste et le refaire si l'IP du serveur change.
- Le client **Android** (`UniTimetable-Android`) n'a pas été adapté : sa configuration autorise encore des tunnels Internet (ngrok, trycloudflare). Elle doit être revue avant tout usage en production.
- Les modifications sont envoyées toutes les 1 à 2 s et reçues par les autres postes en moins de 20 s, par interrogation régulière du serveur. Il n'y a pas de notification instantanée.

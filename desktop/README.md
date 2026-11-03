# UniTimetable Desktop — client Windows (version 2, réseau local)

Ce client **ne contient plus l'interface ni les données** : il se connecte au serveur UniTimetable du réseau local
(par ex. `http://192.168.1.10:8787`) qui fournit l'interface, les comptes et les données centralisées.
Procédure complète (serveur, réseau, HTTPS, comptes, sauvegardes) : `README-LOCAL-WINDOWS.md` (dossier du serveur, copie dans `outils-poste`).

## Structure
```
UniTimetable-Desktop/
├── main.js          # processus principal : adresse du serveur, sécurité, navigation limitée
├── preload.js       # pont minimal (configuration du serveur uniquement depuis src/setup.html)
├── src/setup.html   # écran « Configuration du serveur » (test de connexion, messages d'erreur)
├── src/icon.ico
├── src/index.html   # ANCIENNE interface autonome (v1) — n'est plus incluse dans l'installateur
├── outils-poste/    # scripts pour les postes : adresse imposée, certificat HTTPS, test réseau
└── build.bat        # compilation
```

## Gestion du serveur local (Administrateur)
Sur le PC qui héberge le serveur, l'application peut **démarrer, redémarrer, arrêter** le serveur et **afficher ses journaux** :
- **Serveur arrêté** : écran « Configuration du serveur » → section *Gestion du serveur local*.
  1. Choisissez une fois le dossier du serveur, celui qui contient `data\store.json` (par exemple `…\um6ss-server\um6ss-server`). Il n'est jamais créé ni réinitialisé.
  2. Connectez-vous avec un compte **Administrateur** : identifiant et mot de passe sont vérifiés localement, en lecture seule.
  3. Cliquez sur **Démarrer le serveur**.
- **Serveur en marche** : onglet **Administration** → *Gestion du serveur local* (visible pour l'Administrateur uniquement).
- **Journaux** : bouton **Voir les journaux**, qui ouvre une fenêtre dédiée en lecture seule. Aucune invite de commandes n'est utilisée.
- **Ce que fait chaque action** :
  - le lancement se fait par le processus principal (`child_process.spawn`, exécutable explicite, aucun shell) ;
  - « En marche » n'est affiché qu'après une réponse de `/health` ;
  - une seule instance est possible (vérification de `/health`, du verrou `data\server.lock` et du port) ;
  - l'arrêt est propre (API locale protégée par jeton) et demande une confirmation, tout comme le redémarrage ;
  - fermer l'application ou se déconnecter **n'arrête pas** le serveur.
- **Moteur utilisé** : Node.js installé sur le PC (conseillé, fuseaux horaires à jour). À défaut, l'application utilise le Node intégré à Electron, dont les données de fuseaux horaires datent de 2024a.
- **Dossier de données protégé** : si l'accès au dossier `data` est restreint (`install-server.ps1`), lancez l'application en tant qu'administrateur Windows, ou utilisez `windows\start-server.ps1`.
- **Serveur lancé par la tâche planifiée (compte SYSTEM)** : l'application le détecte et peut l'arrêter proprement. S'il ne répond plus, l'arrêt forcé ne peut se faire qu'avec `windows\stop-server.ps1`.

## Compiler (Windows, Node.js LTS, Internet pour la 1re installation des dépendances)
```bat
npm install
npm run build:all
```
ou double-cliquer sur `build.bat`. `npm run build:win` copie d'abord le serveur (code uniquement, jamais `data`, `logs`, `certs` ni `server.env`) dans `server-bundle`, embarqué dans l'installateur sous `resources\server`. Résultat : `dist\releases\UniTimetable-Setup.exe` (installateur, raccourcis Bureau + menu Démarrer)
et `dist\releases\UniTimetable-Portable.exe`.

## Adresse du serveur
1. argument du raccourci `--server=http://192.168.1.10:8787`
2. choix de l'utilisateur : menu **Fichier > Configurer le serveur…** → `%APPDATA%\UniTimetable\config.json`
3. configuration du poste par l'administrateur : `outils-poste\set-client-server.ps1` → `%ProgramData%\UniTimetable\client.json`

## Test sans installer
`npm start` (ouvre l'écran de configuration ; outils de développement disponibles hors version compilée).

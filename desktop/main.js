/**
 * UniTimetable — client Windows (Electron).
 * L'interface est servie par le serveur central du réseau local (http(s)://IP:PORT/) : une mise à jour
 * de l'interface sur le serveur est visible sur tous les postes sans réinstaller le client.
 * Ce client ne contient aucune donnée de l'établissement ; il mémorise seulement l'adresse du serveur.
 *
 * Adresse du serveur, par ordre de priorité :
 *   1. argument --server=http://192.168.1.10:8787
 *   2. configuration de l'utilisateur   %APPDATA%\UniTimetable\config.json   (menu Fichier > Configurer le serveur)
 *   3. configuration du poste (admin)   %ProgramData%\UniTimetable\client.json   {"serverUrl": "..."}
 * Sécurité : isolation de contexte, sandbox, aucune intégration Node dans les pages, navigation limitée
 * à l'origine du serveur configuré, aucune désactivation de la vérification des certificats.
 */
const { app, BrowserWindow, shell, ipcMain, dialog, Menu, net, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('UniTimetable');
if (!app.requestSingleInstanceLock()) { app.quit(); }

const USER_CFG = path.join(app.getPath('userData'), 'config.json');
const MACHINE_CFG = path.join(process.env.ProgramData || 'C:\\ProgramData', 'UniTimetable', 'client.json');
const SETUP = path.join(__dirname, 'src', 'setup.html');
const LOGPAGE = path.join(__dirname, 'src', 'server-log.html');
const { ServerController, validateServerRoot, verifyLocalAdmin } = require('./server-control');
const { spawnSync } = require('child_process');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } };

function normUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (!['http:', 'https:'].includes(x.protocol) || !x.hostname || x.username || x.password) return '';
    return x.origin;   // seulement schéma + hôte + port
  } catch (e) { return ''; }
}
function argServer() { const a = process.argv.find(x => x.startsWith('--server=')); return a ? normUrl(a.slice(9)) : ''; }
function currentServer() {
  const a = argServer(); if (a) return { url: a, source: 'argument' };
  const u = readJson(USER_CFG); if (u && normUrl(u.serverUrl)) return { url: normUrl(u.serverUrl), source: 'utilisateur' };
  const m = readJson(MACHINE_CFG); if (m && normUrl(m.serverUrl)) return { url: normUrl(m.serverUrl), source: 'poste' };
  return { url: '', source: '' };
}
function saveUserServer(url) {
  const cfg = readJson(USER_CFG) || {};
  cfg.serverUrl = url; cfg.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(USER_CFG), { recursive: true });
  fs.writeFileSync(USER_CFG + '.tmp', JSON.stringify(cfg, null, 2), 'utf8'); fs.renameSync(USER_CFG + '.tmp', USER_CFG);
}

/* Test de connexion : /health doit répondre comme un serveur UniTimetable. */
async function probe(url, timeoutMs) {
  const base = normUrl(url); if (!base) return { ok: false, error: 'Adresse invalide. Exemple : http://192.168.1.10:8787' };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs || 5000);
  try {
    const r = await net.fetch(base + '/health', { signal: ctl.signal, cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (r.status === 403) return { ok: false, error: 'Le serveur refuse ce poste (adresse IP non autorisée : voir ALLOWED_NETWORKS).' };
    if (!r.ok || !j || j.app !== 'unitimetable') return { ok: false, error: 'Un service répond à cette adresse, mais ce n’est pas un serveur UniTimetable (code ' + r.status + ').' };
    return { ok: true, version: j.version, https: !!j.https, users: j.users, url: base };
  } catch (e) {
    const m = String(e && e.message || e);
    if (/CERT|certificate|SSL/i.test(m)) return { ok: false, error: 'Certificat HTTPS non reconnu par ce poste. Installez le certificat du serveur (voir README-LOCAL-WINDOWS.md, section HTTPS). Détail : ' + m };
    if (e.name === 'AbortError') return { ok: false, error: 'Pas de réponse du serveur (délai dépassé). Vérifiez l’adresse IP, le port, que le serveur est démarré et que le pare-feu autorise le port.' };
    return { ok: false, error: 'Connexion impossible : ' + m + '. Vérifiez l’adresse, le réseau et que le serveur est démarré.' };
  } finally { clearTimeout(t); }
}

let win = null, serverOrigin = '';
function showSetup(reason) {
  serverOrigin = '';
  const q = new URLSearchParams({ reason: reason || '', current: currentServer().url, source: currentServer().source });
  win.loadFile(SETUP, { search: q.toString() });
}
async function openServer() {
  const cur = currentServer();
  if (!cur.url) return showSetup('');
  const p = await probe(cur.url, 6000);
  if (!p.ok) return showSetup(p.error);
  serverOrigin = cur.url;
  win.loadURL(cur.url + '/');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 600,
    title: 'UniTimetable — UM6SS Dakhla',
    icon: path.join(__dirname, 'src', 'icon.ico'),
    backgroundColor: '#f5f6fa', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: path.join(__dirname, 'preload.js'), partition: 'persist:unitimetable', spellcheck: false }
  });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  const wc = win.webContents;
  // Liens externes (WhatsApp, etc.) : navigateur du système, uniquement en https ; jamais de nouvelle fenêtre Electron.
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url) && !(serverOrigin && url.startsWith(serverOrigin + '/'))) shell.openExternal(url); return { action: 'deny' }; });
  // Si le serveur devient injoignable au chargement : écran de configuration avec le motif.
  wc.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3 && !String(url).startsWith('file:')) showSetup('Le serveur ne répond pas (' + desc + '). Vérifiez qu’il est démarré et que ce poste est sur le réseau de l’établissement.'); });
  wc.on('render-process-gone', () => showSetup('L’affichage s’est arrêté de façon inattendue. Cliquez sur « Ouvrir ».'));
  buildMenu();
  openServer();
}

/* Navigation strictement limitée à l'origine du serveur configuré et à la page de configuration locale. */
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') && /\/src\/(setup|server-log)\.html$/.test(decodeURIComponent(new URL(url).pathname).toLowerCase())) return;
    if (serverOrigin && (url === serverOrigin || url.startsWith(serverOrigin + '/'))) return;
    event.preventDefault();
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  });
  contents.on('will-attach-webview', e => e.preventDefault());
  contents.on('did-navigate', () => { const g = grants.get(contents.id); if (g && g.kind !== 'log') grants.delete(contents.id); });   // changement de page : l'autorisation administrateur est retirée
});

function buildMenu() {
  const template = [
    { label: 'Fichier', submenu: [
      { label: 'Configurer le serveur…', accelerator: 'CmdOrCtrl+Shift+S', click: () => showSetup('') },
      { label: 'Reconnecter', accelerator: 'F5', click: () => openServer() },
      { type: 'separator' },
      { label: 'Imprimer', accelerator: 'CmdOrCtrl+P', click: () => win && win.webContents.print() },
      { type: 'separator' },
      { role: 'quit', label: 'Quitter' }
    ] },
    { label: 'Affichage', submenu: [
      { role: 'reload', label: 'Recharger la page' },
      { type: 'separator' }, { role: 'resetZoom', label: 'Zoom normal' }, { role: 'zoomIn', label: 'Zoom avant' }, { role: 'zoomOut', label: 'Zoom arrière' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Plein écran' }
    ] },
    { label: 'Aide', submenu: [
      { label: 'À propos de UniTimetable', click: () => showAbout() },
      { label: 'Ouvrir dans le navigateur', click: () => { const u = currentServer().url; if (u) shell.openExternal(u); } }
    ] }
  ];
  if (!app.isPackaged) template[1].submenu.push({ type: 'separator' }, { role: 'toggleDevTools', label: 'Outils de développement' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function showAbout() {
  const c = currentServer();
  dialog.showMessageBox(win, { type: 'info', title: 'À propos de UniTimetable', message: 'UniTimetable ' + app.getVersion(), detail: ['Gestion des emplois du temps — UM6SS · FM6SIPS Dakhla', '', 'Serveur : ' + (c.url || 'non configuré') + (c.source ? ' (configuration ' + c.source + ')' : ''), 'Configuration utilisateur : ' + USER_CFG, 'Configuration du poste : ' + MACHINE_CFG, '', 'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome].join('\n'), buttons: ['OK'] });
}

/* IPC : la page de configuration locale est la seule autorisée à tester / enregistrer l'adresse. */
const fromSetup = e => { try { const u = new URL(e.senderFrame.url); return u.protocol === 'file:' && decodeURIComponent(u.pathname).toLowerCase().endsWith('/src/setup.html'); } catch (x) { return false; } };
ipcMain.handle('setup:test', (e, url) => fromSetup(e) ? probe(url, 6000) : { ok: false, error: 'refusé' });
ipcMain.handle('setup:save', async (e, url) => {
  if (!fromSetup(e)) return { ok: false, error: 'refusé' };
  const p = await probe(url, 6000); if (!p.ok) return p;
  if (currentServer().source === 'argument') return { ok: false, error: 'L’adresse est imposée par le raccourci (--server=…).' };
  try { saveUserServer(p.url); } catch (x) { return { ok: false, error: 'Enregistrement impossible : ' + x.message }; }
  setTimeout(openServer, 50); return { ok: true };
});
ipcMain.handle('setup:open', e => { if (fromSetup(e)) openServer(); return true; });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), server: currentServer(), userConfig: USER_CFG, machineConfig: MACHINE_CFG }));
ipcMain.on('app:settings', () => showSetup(''));

/* ======================= Gestion du serveur local (Administrateur uniquement) ======================= */
const CTL_CFG = path.join(app.getPath('userData'), 'server-control.json');
/* Code du serveur : copie embarquée (resources\server) dans l'application installée ; en développement, le dossier voisin. */
function serverCodeDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server');
  // développement : code du serveur directement depuis son dossier (server-bundle ne sert qu'à la compilation)
  const dev = path.resolve(__dirname, '..', 'um6ss-server', 'um6ss-server');
  if (fs.existsSync(path.join(dev, 'server.js'))) return dev;
  return path.join(__dirname, 'server-bundle');
}
/* Exécutable : Node.js installé sur le PC (données de fuseaux horaires à jour), sinon le Node intégré à Electron. Chemins explicites, aucun shell. */
function nodeRuntime() {
  const cands = [];
  const c = readJson(CTL_CFG) || {};
  if (c.nodePath) cands.push(c.nodePath);
  if (process.platform === 'win32') {
    for (const b of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) if (b) cands.push(path.join(b, 'nodejs', 'node.exe'));
    for (const d of String(process.env.PATH || '').split(';')) if (d && path.isAbsolute(d)) cands.push(path.join(d, 'node.exe'));
  } else for (const d of String(process.env.PATH || '').split(':')) if (d && path.isAbsolute(d)) cands.push(path.join(d, 'node'));
  for (const exe of cands) {
    try {
      if (!fs.statSync(exe).isFile()) continue;
      const r = spawnSync(exe, ['-v'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
      const m = /^v(\d+)\./.exec((r.stdout || '').trim()); if (m && +m[1] >= 18) return { exe, args: [], env: {}, label: 'Node.js ' + r.stdout.trim() + ' (' + exe + ')' };
    } catch (e) { /* suivant */ }
  }
  return { exe: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'Node.js intégré à Electron ' + process.versions.node + ' (données de fuseaux horaires ' + (process.versions.tz || '?') + ')' };
}
let ctl = null;
function controller() {
  if (ctl) return ctl;
  ctl = new ServerController({ codeDir: serverCodeDir(), runtime: nodeRuntime(), onStatus: st => broadcastStatus(st) });
  const c = readJson(CTL_CFG) || {};
  let root = c.serverRoot;
  if (!root && !app.isPackaged) { const dev = path.resolve(__dirname, '..', 'um6ss-server', 'um6ss-server'); if (validateServerRoot(dev).ok) root = dev; }
  if (root) ctl.setServerRoot(root);
  return ctl;
}
const watchers = new Set();   // webContents abonnés à l'état (pages autorisées uniquement)
function broadcastStatus(st) { for (const wc of [...watchers]) { if (wc.isDestroyed()) { watchers.delete(wc); continue; } wc.send('srv:status', st); } }

/* Autorisation : (a) compte Administrateur vérifié localement (identifiant + mot de passe, lecture seule de store.json), valable 15 min pour cette fenêtre ;
   (b) ou session Administrateur ouverte dans l'interface servie par le serveur (vérifiée par /api/me avec le cookie de la session). */
const grants = new Map();          // webContents.id -> { user, until }
const loginTries = [];
const pageKind = e => { try { const u = new URL(e.senderFrame.url); if (u.protocol === 'file:') { const p = decodeURIComponent(u.pathname).toLowerCase(); if (p.endsWith('/src/setup.html')) return 'setup'; if (p.endsWith('/src/server-log.html')) return 'log'; return ''; } if (serverOrigin && u.origin === serverOrigin) return 'web'; } catch (x) { } return ''; };
async function authorize(e) {
  const kind = pageKind(e); if (!kind) return null;
  const g = grants.get(e.sender.id); if (g && g.until > Date.now() && g.kind === kind) return g.user;   // une autorisation reste liée à la page qui l'a obtenue
  if (kind === 'web') {
    try {
      const ses = session.fromPartition('persist:unitimetable'), ck = await ses.cookies.get({ url: serverOrigin, name: 'sid' });
      if (!ck.length) return null;
      const r = await net.fetch(serverOrigin + '/api/me', { headers: { Cookie: 'sid=' + ck[0].value }, cache: 'no-store' });
      const j = await r.json();
      if (j && j.auth && j.user && !j.user.mustChange && (j.user.perms || []).includes('server.manage')) { const user = { username: j.user.username, displayName: j.user.displayName }; grants.set(e.sender.id, { user, until: Date.now() + 60e3, kind: 'web' }); return user; }
    } catch (x) { /* serveur indisponible : pas d'autorisation web */ }
  }
  return null;
}
const denied = { ok: false, denied: true, error: 'Réservé à un compte Administrateur.' };
ipcMain.handle('srv:available', e => ({ available: !!pageKind(e), configured: !!controller().cfg, packaged: app.isPackaged }));
ipcMain.handle('srv:login', async (e, username, password) => {
  const kind = pageKind(e); if (kind !== 'setup' && kind !== 'log') return denied;
  const now = Date.now(); while (loginTries.length && now - loginTries[0] > 60e3) loginTries.shift();
  if (loginTries.length >= 5) return { ok: false, error: 'Trop de tentatives : patientez une minute.' };
  loginTries.push(now);
  const c = controller(); if (!c.cfg) return { ok: false, needFolder: true, error: 'Choisissez d’abord le dossier du serveur (celui qui contient data\store.json).' };
  const r = await verifyLocalAdmin(c.cfg, String(username || '').slice(0, 64), String(password || '').slice(0, 200));
  if (!r.ok) return r;
  grants.set(e.sender.id, { user: r.user, until: Date.now() + 15 * 60e3, kind });
  c.logLine('Accès administrateur local : ' + r.user.username);
  return { ok: true, user: r.user };
});
ipcMain.handle('srv:logout', e => { grants.delete(e.sender.id); watchers.delete(e.sender); return { ok: true }; });
ipcMain.handle('srv:status', async e => { const u = await authorize(e); if (!u) return denied; watchers.add(e.sender); return { ok: true, user: u, status: await controller().refresh() }; });
ipcMain.handle('srv:chooseFolder', async e => {
  const kind = pageKind(e); if (!kind) return denied;
  const c = controller();
  if (c.cfg && !(await authorize(e))) return denied;    // changer un dossier déjà configuré : administrateur uniquement
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Dossier du serveur UniTimetable (contenant data\store.json)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const v = validateServerRoot(r.filePaths[0]); if (!v.ok) return v;
  const cfg = readJson(CTL_CFG) || {}; cfg.serverRoot = r.filePaths[0];
  fs.mkdirSync(path.dirname(CTL_CFG), { recursive: true }); fs.writeFileSync(CTL_CFG, JSON.stringify(cfg, null, 2));
  c.setServerRoot(r.filePaths[0]); grants.clear();
  return { ok: true, status: await c.refresh() };
});
async function confirmBox(e, message, detail) {
  const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'warning', buttons: ['Annuler', 'Confirmer'], defaultId: 0, cancelId: 0, title: 'Gestion du serveur local', message, detail });
  return r.response === 1;
}
ipcMain.handle('srv:start', async e => { const u = await authorize(e); if (!u) return denied; const r = await controller().start(); controller().logLine('Démarrage demandé par ' + u.username + ' : ' + (r.ok ? (r.already ? 'déjà en marche' : 'en marche') : 'échec — ' + r.error)); return r; });
ipcMain.handle('srv:stop', async e => {
  const u = await authorize(e); if (!u) return denied;
  if (!(await confirmBox(e, 'Arrêter le serveur UniTimetable ?', 'Tous les postes perdront l’accès aux données jusqu’au redémarrage. Les modifications non envoyées restent sur chaque poste.'))) return { ok: false, canceled: true };
  return controller().stop(u.username);
});
ipcMain.handle('srv:restart', async e => {
  const u = await authorize(e); if (!u) return denied;
  if (!(await confirmBox(e, 'Redémarrer le serveur UniTimetable ?', 'Le serveur sera arrêté proprement puis relancé (quelques secondes d’interruption pour tous les postes).'))) return { ok: false, canceled: true };
  return controller().restart(u.username);
});
/* ---------- fenêtre dédiée aux journaux du serveur (lecture seule) ---------- */
let logWin = null, logTimer = null; const logPos = new Map();
function readNew(file, initial) {
  let st; try { st = fs.statSync(file); } catch (e) { return []; }
  let pos = logPos.get(file);
  if (pos === undefined || pos > st.size) pos = initial ? Math.max(0, st.size - 64 * 1024) : 0;
  if (st.size === pos) { logPos.set(file, pos); return []; }
  const fd = fs.openSync(file, 'r'), len = Math.min(st.size - pos, 512 * 1024), buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos); fs.closeSync(fd); logPos.set(file, pos + len);
  let t = buf.toString('utf8'); if (initial && pos > 0) t = t.slice(t.indexOf('\n') + 1);
  return t.split(/\r?\n/).filter(Boolean).map(l => ({ file: path.basename(file), line: l }));
}
function openLogWindow(user) {
  if (logWin && !logWin.isDestroyed()) { logWin.focus(); return; }
  logWin = new BrowserWindow({ width: 1000, height: 640, title: 'UniTimetable — journaux du serveur', icon: path.join(__dirname, 'src', 'icon.ico'), backgroundColor: '#10131b', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js'), partition: 'persist:unitimetable' } });
  logWin.setMenuBarVisibility(false);
  logWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const id = logWin.webContents.id; grants.set(id, { user, until: Date.now() + 8 * 3600e3, kind: 'log' });
  logWin.loadFile(LOGPAGE);
  logPos.clear();
  logWin.on('closed', () => { grants.delete(id); clearInterval(logTimer); logTimer = null; logWin = null; });   // fermer la fenêtre n'arrête PAS le serveur
  logTimer = setInterval(() => {
    if (!logWin || logWin.isDestroyed()) return;
    const lines = controller().logFiles().flatMap(f => readNew(f, false));
    if (lines.length) logWin.webContents.send('srv:log', lines);
  }, 1000);
}
ipcMain.handle('srv:openLogs', async e => { const u = await authorize(e); if (!u) return denied; openLogWindow(u); return { ok: true }; });
ipcMain.handle('srv:logInit', async e => {
  if (pageKind(e) !== 'log') return denied; const u = await authorize(e); if (!u) return denied;
  watchers.add(e.sender);
  const c = controller(); logPos.clear();
  return { ok: true, files: c.logFiles(), lines: c.logFiles().flatMap(f => readNew(f, true)).slice(-1500), status: await c.refresh() };
});
ipcMain.handle('srv:openLogFolder', async e => { const u = await authorize(e); if (!u) return denied; const c = controller(); if (c.cfg) shell.openPath(c.cfg.logDir); return { ok: true }; });
setInterval(() => { if (watchers.size && ctl) ctl.refresh().catch(() => { }); }, 5000).unref();

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  const ses = session.fromPartition('persist:unitimetable');
  // Autorisations du navigateur : seul l'accès au presse-papiers (copie du message WhatsApp) est accordé, et uniquement au serveur configuré.
  const allow = (perm, origin) => perm === 'clipboard-sanitized-write' && !!serverOrigin && String(origin || '').replace(/\/$/, '') === serverOrigin;
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allow(perm, details && details.requestingUrl ? new URL(details.requestingUrl).origin : '')));
  ses.setPermissionCheckHandler((wc, perm, origin) => allow(perm, origin));
  createWindow();
});
app.on('window-all-closed', () => app.quit());

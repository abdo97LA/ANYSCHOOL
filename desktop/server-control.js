'use strict';
/**
 * UniTimetable — contrôle du serveur local depuis le processus PRINCIPAL d'Electron.
 * Ce module ne dépend pas d'Electron (testable avec Node seul) : le processus principal lui fournit
 * les chemins (code du serveur, dossier du serveur) et l'exécutable à utiliser.
 *
 * Garanties :
 *  - lancement par child_process.spawn avec un exécutable explicite et une liste d'arguments fixe (aucun shell, aucune commande construite) ;
 *  - une seule instance : vérification /health + fichier data\server.lock + test du port avant tout lancement ;
 *  - « En marche » seulement après une vérification /health réussie du processus lancé ;
 *  - le serveur est détaché de l'application : fermer la fenêtre ou quitter l'application ne l'arrête pas ;
 *  - arrêt propre par l'API locale /api/server/shutdown (jeton data\control.token, boucle locale uniquement) ;
 *  - aucune donnée n'est créée, réinitialisée ni migrée par ce module (MIGRATIONS_AUTO=0 sauf choix explicite dans server.env).
 */
const fs = require('fs'), path = require('path'), net = require('net'), http = require('http'), https = require('https'), crypto = require('crypto');
const { spawn } = require('child_process');

const EXIT = {
  1: 'arrêt sur erreur interne (voir les journaux)',
  2: 'le port est déjà utilisé par un autre programme (ou accès refusé au port)',
  3: 'une autre instance du serveur utilise déjà ce dossier de données',
  4: 'fichier de données illisible : rien n’a été modifié, restaurez une sauvegarde (voir README)',
  5: 'certificat HTTPS illisible (TLS_PFX / TLS_CERT dans server.env)',
  6: 'sauvegarde préalable à une migration impossible : migration annulée'
};

/* ---------- configuration du serveur (server.env), chemins absolus ---------- */
function readEnvFile(file) {
  const o = {};
  let t; try { t = fs.readFileSync(file, 'utf8'); } catch (e) { return o; }
  for (const raw of t.replace(/^﻿/, '').split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('='); if (i < 1) continue;
    let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    const k = l.slice(0, i).trim(); if (/^[A-Z0-9_]+$/.test(k)) o[k] = v;
  }
  return o;
}
function resolveServer(serverRoot) {
  const envFile = path.join(serverRoot, 'server.env');
  const e = readEnvFile(envFile);
  const abs = p => path.isAbsolute(p) ? p : path.resolve(serverRoot, p);
  const dataDir = abs(e.DATA_DIR || 'data');
  const r = {
    serverRoot, envFile, envExists: fs.existsSync(envFile), env: e,
    host: e.HOST || '0.0.0.0', port: Number(e.PORT) || 8787,
    dataDir, logDir: abs(e.LOG_DIR || path.join(path.dirname(dataDir), 'logs')), backupDir: abs(e.BACKUP_DIR || path.join(dataDir, 'backups')),
    tlsPfx: e.TLS_PFX ? abs(e.TLS_PFX) : '', tlsCert: e.TLS_CERT ? abs(e.TLS_CERT) : '', tlsKey: e.TLS_KEY ? abs(e.TLS_KEY) : ''
  };
  r.https = !!(r.tlsPfx || (r.tlsCert && r.tlsKey));
  r.lockFile = path.join(dataDir, 'server.lock'); r.tokenFile = path.join(dataDir, 'control.token'); r.storeFile = path.join(dataDir, 'store.json');
  return r;
}
/* Un dossier de serveur valide contient des données existantes : on ne lance JAMAIS sur un dossier vide par erreur. */
function validateServerRoot(serverRoot) {
  if (!serverRoot || !path.isAbsolute(serverRoot) || !fs.existsSync(serverRoot)) return { ok: false, error: 'Dossier du serveur introuvable.' };
  const r = resolveServer(serverRoot);
  if (!fs.existsSync(r.storeFile)) return { ok: false, error: 'Aucune donnée UniTimetable dans ce dossier (fichier ' + r.storeFile + ' absent). Choisissez le dossier qui contient « data\\store.json ».' };
  return { ok: true, cfg: r };
}

/* ---------- vérification locale d'un compte administrateur (lecture seule de store.json) ---------- */
function verifyScrypt(pw, rec) {
  return new Promise(ok => {
    if (!rec || rec.alg !== 'scrypt' || typeof pw !== 'string') return ok(false);
    const salt = Buffer.from(rec.salt, 'base64'), want = Buffer.from(rec.hash, 'base64');
    crypto.scrypt(pw.normalize('NFC'), salt, want.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 256 * rec.N * rec.r }, (e, k) => ok(!e && crypto.timingSafeEqual(k, want)));
  });
}
async function verifyLocalAdmin(cfg, username, password) {
  let store; try { store = JSON.parse(fs.readFileSync(cfg.storeFile, 'utf8')); } catch (e) { return { ok: false, error: e.code === 'EACCES' || e.code === 'EPERM' ? 'Accès refusé au dossier de données : lancez l’application en tant qu’administrateur Windows, ou utilisez windows\\start-server.ps1.' : 'Lecture des comptes impossible : ' + e.message }; }
  const u = (store.users || []).find(x => x.username === String(username || '').trim().toLowerCase());
  const good = u ? await verifyScrypt(password, u.pw) : (await verifyScrypt(String(password || ''), { alg: 'scrypt', N: 16384, r: 8, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'A'.repeat(86) + '==' }), false);
  if (!u || !good) return { ok: false, error: 'Identifiant ou mot de passe incorrect.' };
  if (u.role !== 'admin') return { ok: false, error: 'Seul un compte Administrateur peut gérer le serveur.' };
  if (u.disabled) return { ok: false, error: 'Ce compte est désactivé.' };
  if (u.lockedUntil && Date.parse(u.lockedUntil) > Date.now()) return { ok: false, error: 'Compte temporairement verrouillé.' };
  return { ok: true, user: { username: u.username, displayName: u.displayName || u.username } };
}

/* ---------- sondes ---------- */
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function lockPid(cfg) { try { const p = +fs.readFileSync(cfg.lockFile, 'utf8').trim(); return pidAlive(p) ? p : 0; } catch (e) { return 0; } }
/* Certificat local (.cer DER ou .pem) placé à côté du .pfx, pour vérifier le HTTPS sans jamais désactiver la vérification */
function localCa(cfg) {
  const cands = [cfg.tlsCert, cfg.tlsPfx && cfg.tlsPfx.replace(/\.pfx$/i, '.cer')].filter(Boolean);
  for (const f of cands) { try { const b = fs.readFileSync(f); const t = b.toString('utf8'); if (t.includes('BEGIN CERTIFICATE')) return t; return '-----BEGIN CERTIFICATE-----\n' + b.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'; } catch (e) { /* */ } }
  return null;
}
function request(cfg, method, pathname, headers, timeoutMs) {
  return new Promise(res => {
    const mod = cfg.https ? https : http;
    const opt = { host: '127.0.0.1', port: cfg.port, path: pathname, method, headers: headers || {}, timeout: timeoutMs || 2500 };
    if (cfg.https) { const ca = localCa(cfg); if (ca) { opt.ca = ca; opt.servername = 'localhost'; opt.checkServerIdentity = () => undefined; } }   // identité vérifiée par l'adresse de bouclage ; la chaîne de certificat reste vérifiée
    const q = mod.request(opt, r => { let b = ''; r.setEncoding('utf8'); r.on('data', c => { if (b.length < 65536) b += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { } res({ status: r.statusCode, json: j }); }); });
    q.on('timeout', () => { q.destroy(); res({ error: 'timeout' }); });
    q.on('error', e => res({ error: e.code || e.message }));
    q.end();
  });
}
async function health(cfg) { const r = await request(cfg, 'GET', '/health', {}, 2500); return r.json && r.json.app === 'unitimetable' && r.json.ok ? { ok: true, info: r.json } : { ok: false, status: r.status, error: r.error }; }
function portFree(host, port) {
  return new Promise(res => { const s = net.createServer(); s.once('error', e => res({ free: false, code: e.code })); s.once('listening', () => s.close(() => res({ free: true }))); s.listen(port, host === '0.0.0.0' ? '0.0.0.0' : host); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- contrôleur ---------- */
class ServerController {
  /** opts: { codeDir, runtime: { exe, args:[], env:{} , label }, onStatus(status) } */
  constructor(opts) {
    this.codeDir = path.resolve(opts.codeDir); this.runtime = opts.runtime; this.onStatus = opts.onStatus || (() => {});
    this.cfg = null; this.state = 'stopped'; this.detail = ''; this.pid = 0; this.startedByApp = false; this.busy = false; this.child = null; this.version = ''; this.since = '';
  }
  setServerRoot(root) { const v = validateServerRoot(root); if (!v.ok) { this.cfg = null; return v; } this.cfg = v.cfg; return v; }
  snapshot() { return { state: this.state, detail: this.detail, pid: this.pid, startedByApp: this.startedByApp, version: this.version, since: this.since, configured: !!this.cfg, serverRoot: this.cfg ? this.cfg.serverRoot : '', port: this.cfg ? this.cfg.port : 0, https: this.cfg ? this.cfg.https : false, dataDir: this.cfg ? this.cfg.dataDir : '', logDir: this.cfg ? this.cfg.logDir : '', runtime: this.runtime ? this.runtime.label : '', codeDir: this.codeDir }; }
  set(state, detail) { this.state = state; this.detail = detail || ''; this.since = new Date().toISOString(); try { this.onStatus(this.snapshot()); } catch (e) { /* */ } }
  launchLog() { return this.cfg ? path.join(this.cfg.logDir, 'lancement-application.log') : ''; }
  logLine(m) { try { fs.mkdirSync(this.cfg.logDir, { recursive: true }); fs.appendFileSync(this.launchLog(), new Date().toISOString() + '  ' + m + '\n'); } catch (e) { /* */ } }

  /** Rafraîchit l'état réel (serveur lancé par l'application, par la tâche planifiée ou à la main). */
  async refresh() {
    if (!this.cfg) { if (this.state !== 'stopped' || this.detail !== 'non configuré') this.set('stopped', 'non configuré'); return this.snapshot(); }
    if (this.busy) return this.snapshot();
    const h = await health(this.cfg), lp = lockPid(this.cfg);
    if (h.ok) { this.version = h.info.version || ''; this.pid = lp || this.pid; if (this.state !== 'running') this.set('running', this.startedByApp ? 'lancé par cette application' : 'déjà en marche (lancé hors de cette application)'); }
    else if (lp) { if (this.state !== 'starting') this.set('error', 'Processus serveur présent (PID ' + lp + ') mais /health ne répond pas sur le port ' + this.cfg.port + '.'); }
    else if (this.state === 'running' || this.state === 'starting') this.set('stopped', 'le serveur ne répond plus');
    else if (this.state !== 'error' && this.state !== 'stopped') this.set('stopped', '');
    return this.snapshot();
  }

  async start() {
    if (!this.cfg) return { ok: false, error: 'Dossier du serveur non configuré.' };
    if (this.busy) return { ok: false, error: 'Une opération est déjà en cours.' };
    this.busy = true;
    try {
      // 1. déjà en marche ?
      const h = await health(this.cfg);
      if (h.ok) { this.busy = false; await this.refresh(); return { ok: true, already: true, status: this.snapshot() }; }
      const lp = lockPid(this.cfg);
      if (lp) { this.set('error', 'Un processus serveur (PID ' + lp + ') utilise déjà ce dossier de données mais ne répond pas. Vérifiez les journaux ou arrêtez-le avant de relancer.'); return { ok: false, error: this.detail }; }
      // 2. port libre ?
      const pf = await portFree(this.cfg.host, this.cfg.port);
      if (!pf.free) { this.set('error', pf.code === 'EADDRINUSE' ? 'Le port ' + this.cfg.port + ' est déjà utilisé par un autre programme (ce n’est pas UniTimetable). Libérez-le ou changez PORT dans server.env.' : 'Port ' + this.cfg.port + ' inutilisable (' + pf.code + ').'); return { ok: false, error: this.detail, portConflict: true }; }
      const serverJs = path.join(this.codeDir, 'server.js');
      if (!fs.existsSync(serverJs)) { this.set('error', 'Fichiers du serveur introuvables : ' + serverJs); return { ok: false, error: this.detail }; }
      // 3. lancement (exécutable explicite, arguments fixes, aucun shell)
      this.set('starting', 'lancement…');
      fs.mkdirSync(this.cfg.logDir, { recursive: true });
      const out = fs.openSync(this.launchLog(), 'a');
      const c = this.cfg, env = { ...process.env };
      for (const k of Object.keys(env)) if (/^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/.test(k)) delete env[k];
      Object.assign(env, this.runtime.env || {}, {
        UNITT_CONFIG: c.envFile, DATA_DIR: c.dataDir, LOG_DIR: c.logDir, BACKUP_DIR: c.backupDir, UNITT_QUIET: '1',
        MIGRATIONS_AUTO: c.env.MIGRATIONS_AUTO !== undefined ? c.env.MIGRATIONS_AUTO : '0'      // aucune migration de données sans choix explicite
      });
      if (c.tlsPfx) env.TLS_PFX = c.tlsPfx; if (c.tlsCert) env.TLS_CERT = c.tlsCert; if (c.tlsKey) env.TLS_KEY = c.tlsKey;
      this.logLine('Lancement : ' + this.runtime.label + ' ' + serverJs + ' (dossier : ' + c.serverRoot + ')');
      let exited = null;
      const child = spawn(this.runtime.exe, [...(this.runtime.args || []), serverJs], { cwd: c.serverRoot, env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', out, out] });
      fs.closeSync(out);
      this.child = child; this.pid = child.pid || 0; this.startedByApp = true;
      child.on('error', e => { exited = { code: -1, err: e.message }; });
      child.on('exit', (code, sig) => {
        exited = exited || { code, sig };
        this.logLine('Processus serveur terminé (code ' + code + (sig ? ', signal ' + sig : '') + ')');
        if (this.child === child) { this.child = null; this.pid = 0; if (!this.busy) this.set(code === 0 ? 'stopped' : 'error', code === 0 ? 'arrêté' : 'Arrêt inattendu du serveur : ' + (EXIT[code] || 'code ' + code) + '.'); }
      });
      child.unref();   // le serveur continue si l'application est fermée
      // 4. disponibilité : /health doit répondre ET le verrou doit appartenir au processus lancé
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        await sleep(400);
        if (exited) { const msg = exited.err ? 'Lancement impossible : ' + exited.err : 'Le serveur s’est arrêté au démarrage : ' + (EXIT[exited.code] || 'code ' + exited.code) + '.'; this.set('error', msg); return { ok: false, error: msg, exitCode: exited.code }; }
        const hh = await health(this.cfg);
        if (hh.ok && lockPid(this.cfg) === child.pid) { this.version = hh.info.version || ''; this.set('running', 'lancé par cette application'); this.logLine('Serveur prêt (PID ' + child.pid + ')'); return { ok: true, status: this.snapshot() }; }
      }
      this.set('error', 'Le serveur ne répond pas après 25 s (voir les journaux). Il n’a pas été arrêté.');
      return { ok: false, error: this.detail };
    } catch (e) { this.set('error', 'Erreur : ' + e.message); return { ok: false, error: this.detail }; }
    finally { this.busy = false; }
  }

  /** Arrêt propre via l'API locale (jeton). Ne tue un processus qu'en dernier recours et seulement s'il a été lancé par cette application. */
  async stop(actor) {
    if (!this.cfg) return { ok: false, error: 'Dossier du serveur non configuré.' };
    if (this.busy) return { ok: false, error: 'Une opération est déjà en cours.' };
    this.busy = true;
    try {
      const pid = lockPid(this.cfg);
      if (!(await health(this.cfg)).ok && !pid) { this.set('stopped', 'déjà arrêté'); return { ok: true, already: true }; }
      let token = ''; try { token = fs.readFileSync(this.cfg.tokenFile, 'utf8').trim(); } catch (e) { /* */ }
      if (token) {
        const r = await request(this.cfg, 'POST', '/api/server/shutdown', { 'X-Unitt-Control': token, 'X-Unitt-Actor': String(actor || '').slice(0, 40), 'Content-Type': 'application/json' }, 4000);
        if (r.status !== 200) this.logLine('Arrêt par API refusé ou impossible (' + (r.status || r.error) + ')');
      }
      for (let i = 0; i < 30; i++) { await sleep(250); if (!lockPid(this.cfg) && !(await health(this.cfg)).ok) { this.child = null; this.pid = 0; this.set('stopped', 'arrêté proprement'); this.logLine('Serveur arrêté proprement' + (actor ? ' (demande de ' + actor + ')' : '')); return { ok: true }; } }
      if (this.child && this.child.pid === pid) {   // dernier recours, uniquement notre propre processus
        try { process.kill(pid); } catch (e) { /* */ }
        await sleep(800); if (!pidAlive(pid)) { try { fs.unlinkSync(this.cfg.lockFile); } catch (e) { } this.set('stopped', 'arrêté (forcé)'); return { ok: true, forced: true }; }
      }
      this.set('error', 'Arrêt impossible depuis l’application (serveur lancé par un autre compte Windows, par exemple la tâche planifiée). Utilisez windows\\stop-server.ps1 en administrateur.');
      return { ok: false, error: this.detail };
    } finally { this.busy = false; }
  }
  async restart(actor) {
    const s = await this.stop(actor); if (!s.ok) return s;
    await sleep(500);
    return this.start();
  }

  /** Lignes de journal (lecture seule) : fichier du jour + journal de lancement. */
  logFiles() {
    if (!this.cfg) return [];
    const d = this.cfg.logDir, f = [];
    try { for (const n of fs.readdirSync(d).filter(n => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().slice(-2)) f.push(path.join(d, n)); } catch (e) { /* */ }
    if (fs.existsSync(this.launchLog())) f.push(this.launchLog());
    return f;
  }
}
module.exports = { ServerController, resolveServer, validateServerRoot, verifyLocalAdmin, health, portFree, readEnvFile, EXIT, today };

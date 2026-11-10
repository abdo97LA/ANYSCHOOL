'use strict';
/* Fonctions communes aux outils en ligne de commande (à exécuter sur le PC serveur). */
const fs = require('fs'), path = require('path'), readline = require('readline');
const cfg = require('../lib/config');
const { readJson, writeAtomic } = require('../lib/jsonfile');
const AL = require('../lib/auditlog');
const LOCK = path.join(cfg.DATA_DIR, 'server.lock');
function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }
/* Établissement visé : --etab <code> (voir la console Super Admin) ; par défaut le premier établissement (dossier data). */
const PLATFORM_FILE = path.join(cfg.DATA_DIR, 'platform.json');
function tenantTarget() {
  const code = String(arg('etab') || '').trim().toLowerCase();
  if (!code) return { dir: cfg.DATA_DIR, backupDir: cfg.BACKUP_DIR, tenant: null };
  const pf = readJson(PLATFORM_FILE, null, null), t = pf && (pf.tenants || []).find(x => x.slug === code);
  if (!t) { console.error('Établissement « ' + code + ' » introuvable dans ' + PLATFORM_FILE); process.exit(1); }
  return t.legacy ? { dir: cfg.DATA_DIR, backupDir: cfg.BACKUP_DIR, tenant: t } : { dir: path.join(cfg.DATA_DIR, 'tenants', t.id), backupDir: path.join(cfg.BACKUP_DIR, 'tenants', t.id), tenant: t };
}
const TARGET = tenantTarget();
const STORE_FILE = path.join(TARGET.dir, 'store.json'), STATE_FILE = path.join(TARGET.dir, 'state.json');

function serverRunning() {
  try { const pid = +fs.readFileSync(LOCK, 'utf8').trim(); if (!pid) return 0; try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : 0; } } catch (e) { return 0; }
}
function requireStopped(what) {
  const pid = serverRunning();
  if (pid) { console.error('Le serveur est en cours d’exécution (PID ' + pid + '). Arrêtez-le avant de ' + what + ' :\n  powershell -ExecutionPolicy Bypass -File windows\\stop-server.ps1'); process.exit(10); }
}
function loadStore() { const s = readJson(STORE_FILE, {}, null); s.users = s.users || []; s.logins = s.logins || {}; return s; }
function saveStore(s) { fs.mkdirSync(TARGET.dir, { recursive: true }); writeAtomic(STORE_FILE, s); }
/* Journal d'audit séparé (audit.jsonl, ajout seul). Un ancien journal encore présent dans store.json y est d'abord transféré. */
function auditCli(store, event, extra, dir) {
  const fa = new AL.FileAudit(path.join(dir || TARGET.dir, 'audit.jsonl'));
  if (store && Array.isArray(store.audit)) { if (store.audit.length) fa.importLegacy(store.audit); delete store.audit; }
  fa.append({ at: new Date().toISOString(), event, section: 'système', result: 'succès', ip: 'console serveur', user: 'console', ...(TARGET.tenant ? { tenantId: TARGET.tenant.id } : {}), ...extra });
}
/* Saisie masquée (rien n'est affiché) ; si l'entrée n'est pas un terminal, lit une ligne sur stdin. */
function ask(q, hidden) {
  return new Promise(ok => {
    if (!process.stdin.isTTY) {
      if (!ask._lines) { ask._lines = fs.readFileSync(0, 'utf8').split(/\r?\n/); }
      process.stdout.write(q + '\n'); return ok((ask._lines.shift() || '').trim());
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); }; }
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); ok(a.trim()); });
  });
}
module.exports = { cfg, TARGET, PLATFORM_FILE, AL, STORE_FILE, STATE_FILE, serverRunning, requireStopped, loadStore, saveStore, auditCli, ask, arg, readJson, writeAtomic };

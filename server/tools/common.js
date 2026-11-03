'use strict';
/* Fonctions communes aux outils en ligne de commande (à exécuter sur le PC serveur). */
const fs = require('fs'), path = require('path'), readline = require('readline');
const cfg = require('../lib/config');
const { readJson, writeAtomic } = require('../lib/jsonfile');
const STORE_FILE = path.join(cfg.DATA_DIR, 'store.json'), STATE_FILE = path.join(cfg.DATA_DIR, 'state.json'), LOCK = path.join(cfg.DATA_DIR, 'server.lock');

function serverRunning() {
  try { const pid = +fs.readFileSync(LOCK, 'utf8').trim(); if (!pid) return 0; try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : 0; } } catch (e) { return 0; }
}
function requireStopped(what) {
  const pid = serverRunning();
  if (pid) { console.error('Le serveur est en cours d’exécution (PID ' + pid + '). Arrêtez-le avant de ' + what + ' :\n  powershell -ExecutionPolicy Bypass -File windows\\stop-server.ps1'); process.exit(10); }
}
function loadStore() { const s = readJson(STORE_FILE, {}, null); s.users = s.users || []; s.logins = s.logins || {}; s.audit = s.audit || []; return s; }
function saveStore(s) { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); writeAtomic(STORE_FILE, s); }
function auditCli(store, event, extra) {
  const crypto = require('crypto'), GEN = '0'.repeat(64), prev = store.audit.length ? store.audit[store.audit.length - 1].h : GEN;
  const e = { at: new Date().toISOString(), event, ip: 'console serveur', user: 'console', ...extra, prev };
  e.h = crypto.createHash('sha256').update(prev + JSON.stringify(e)).digest('hex'); store.audit.push(e);
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
function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }
module.exports = { cfg, STORE_FILE, STATE_FILE, serverRunning, requireStopped, loadStore, saveStore, auditCli, ask, arg, readJson, writeAtomic };

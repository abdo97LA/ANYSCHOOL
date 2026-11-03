'use strict';
/* Configuration du serveur UniTimetable.
   Ordre de priorité : variables d'environnement > fichier server.env > valeurs par défaut.
   Le fichier server.env (KEY=VALEUR, une par ligne, # pour les commentaires) se trouve à côté de server.js
   ou à l'emplacement indiqué par UNITT_CONFIG. Il ne doit contenir aucun mot de passe. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

function loadEnvFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
  for (const raw of txt.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!/^[A-Z0-9_]+$/.test(k)) continue;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

const CONFIG_FILE = process.env.UNITT_CONFIG || path.join(ROOT, 'server.env');
const configLoaded = loadEnvFile(CONFIG_FILE);
const E = process.env;
const abs = p => path.isAbsolute(p) ? p : path.resolve(ROOT, p);
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= (min ?? -Infinity) && n <= (max ?? Infinity) ? n : d; };

const STORAGE = (E.UNITT_STORAGE || (E.VERCEL && E.SUPABASE_URL ? 'supabase' : 'files')).toLowerCase();
const DATA_DIR = abs(E.DATA_DIR || 'data');
const cfg = {
  ROOT, CONFIG_FILE, configLoaded,
  HOST: E.HOST || '0.0.0.0',
  PORT: num(E.PORT, 8787, 1, 65535),
  DATA_DIR,
  LOG_DIR: abs(E.LOG_DIR || path.join(path.dirname(DATA_DIR), 'logs')),
  BACKUP_DIR: abs(E.BACKUP_DIR || path.join(DATA_DIR, 'backups')),
  BACKUP_KEEP: num(E.BACKUP_KEEP, 30, 1, 1000),
  BACKUP_INTERVAL_HOURS: num(E.BACKUP_INTERVAL_HOURS, 24, 0, 24 * 31),
  HISTORY_KEEP: num(E.HISTORY_KEEP, 50, 2, 1000),
  LOG_KEEP_DAYS: num(E.LOG_KEEP_DAYS, 60, 1, 3650),
  SESSION_IDLE_MINUTES: num(E.SESSION_IDLE_MINUTES, 120, 5, 24 * 60),
  SESSION_MAX_HOURS: num(E.SESSION_MAX_HOURS, 12, 1, 24 * 7),
  STATE_MAX_MB: num(E.STATE_MAX_MB, 40, 1, 500),
  LOGIN_MAX_FAILS: num(E.LOGIN_MAX_FAILS, 5, 3, 100),
  LOGIN_RATE_PER_MIN: num(E.LOGIN_RATE_PER_MIN, 10, 1, 10000),
  LOGIN_LOCK_MINUTES: num(E.LOGIN_LOCK_MINUTES, 15, 1, 24 * 60),
  ALLOWED_NETWORKS: (E.ALLOWED_NETWORKS || '').split(',').map(s => s.trim()).filter(Boolean),
  TLS_PFX: E.TLS_PFX ? abs(E.TLS_PFX) : '',
  TLS_PFX_PASSPHRASE: E.TLS_PFX_PASSPHRASE || '',
  TLS_CERT: E.TLS_CERT ? abs(E.TLS_CERT) : '',
  TLS_KEY: E.TLS_KEY ? abs(E.TLS_KEY) : '',
  PUBLIC_URL: (E.PUBLIC_URL || '').replace(/\/$/, ''),
  TRUST_PROXY: E.TRUST_PROXY === '1' || (STORAGE === 'supabase' && E.TRUST_PROXY !== '0'),   // derrière Vercel : adresse réelle et https via les en-têtes du proxy
  STORAGE,
  ADMIN_PASSWORD: E.ADMIN_PASSWORD || '',          // héritage : crée le compte « admin » au premier démarrage uniquement
  // réservé aux tests automatisés — ne jamais activer en production
  ALLOW_TEST_CLOCK: E.ALLOW_TEST_CLOCK === '1',
  ALLOW_EARLY: E.ALLOW_EARLY === '1',
  ALERT_INTERVAL_MS: num(E.ALERT_INTERVAL_MS, 30000, 50, 3600e3),
  MIGRATIONS_AUTO: E.MIGRATIONS_AUTO === '1',      // migrations des données : uniquement sur choix explicite (server.env ou tools/migrate.js)
  SCRYPT_N: num(E.SCRYPT_N, 32768, 1024, 1048576)
};
cfg.TLS = !!(cfg.TLS_PFX || (cfg.TLS_CERT && cfg.TLS_KEY));
module.exports = cfg;

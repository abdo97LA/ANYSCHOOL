'use strict';
/* UniTimetable – serveur central pour réseau local (UM6SS – FM6SIPS Dakhla).
   Aucune dépendance externe (Node.js 18+, recommandé 22 LTS).
   - héberge l'interface (public/index.html), le formulaire mobile (public/form.html) et les bibliothèques locales (public/vendor) ;
   - comptes individuels, rôles et autorisations vérifiés côté serveur ;
   - état central partagé (/api/state) avec révisions, fusion par élément et détection des conflits ;
   - déclarations d'absences, liens par séance, alertes, notifications, journal d'audit chaîné ;
   - sauvegardes automatiques, journaux de diagnostic, HTTPS optionnel. Voir README-LOCAL-WINDOWS.md. */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const cfg = require('./lib/config');
const log = require('./lib/log');
const { writeAtomic, readJson } = require('./lib/jsonfile');
const { ROLES, PERMS, GRANTABLE, permsOf, can, writable, isWritable } = require('./lib/roles');
const ST = require('./lib/state');
const A = require('./lib/auth');
const BK = require('./lib/backup');
const MD = require('./lib/model');
const MIG = require('./lib/migrations');
const VERSION = require('./package.json').version;
const VENDOR = ['pdf.js', 'pdf.worker.js', 'xlsx.full.min.js', 'jspdf.umd.min.js'];
const vendorMissing = () => VENDOR.filter(f => { try { return fs.statSync(path.join(__dirname, 'public', 'vendor', f)).size < 10000; } catch (e) { return true; } });

const DATA = cfg.DATA_DIR, PUB = path.join(__dirname, 'public');
/* Mode « cloud » (Vercel + Supabase) : aucun fichier local persistant, données chargées depuis Supabase à chaque requête. */
const CLOUD = cfg.STORAGE === 'supabase';
const SB = CLOUD ? require('./lib/supabase') : null;
log.init(CLOUD ? null : cfg.LOG_DIR, cfg.LOG_KEEP_DAYS, { quiet: process.env.UNITT_QUIET === '1' });
if (!CLOUD) fs.mkdirSync(DATA, { recursive: true });

/* ----- instance unique : fichier verrou contenant le PID ----- */
const LOCK = path.join(DATA, 'server.lock');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function takeLock() {
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return; }
  catch (e) {
    const pid = +fs.readFileSync(LOCK, 'utf8').trim();
    if (pid && pid !== process.pid && pidAlive(pid)) { log.error('Une autre instance du serveur utilise déjà ce dossier de données (PID ' + pid + '). Arrêt.'); process.exit(3); }
    fs.writeFileSync(LOCK, String(process.pid));
  }
}
if (!CLOUD) takeLock();
const CONTROL = path.join(DATA, 'control.token');
const releaseLock = () => { if (CLOUD) return; try { if (fs.readFileSync(LOCK, 'utf8').trim() === String(process.pid)) { fs.unlinkSync(LOCK); try { fs.unlinkSync(CONTROL); } catch (x) { /* */ } } } catch (e) { /* */ } };
/* Jeton de contrôle local : permet à l'application de bureau (lancée sur CE PC, avec accès au dossier de données)
   de demander un arrêt propre. Recréé à chaque démarrage ; accepté uniquement depuis l'adresse de bouclage. */
const CONTROL_TOKEN = crypto.randomBytes(32).toString('hex');

/* ----- données ----- */
const SECRET_FILE = path.join(DATA, 'secret.key');
if (!CLOUD && !fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const STORE_FILE = path.join(DATA, 'store.json'), STATE_FILE = path.join(DATA, 'state.json'), HIST = path.join(DATA, 'history');
let store, state;
const emptyStore = () => ({ forms: {}, absences: [], audit: [], policies: {}, sessions: {}, alerts: {}, notifs: [], users: [], logins: {} });
const emptyState = () => ({ rev: 0, at: '', by: '', data: null });
function normalizeDocs() { if (!Array.isArray(store.users)) store.users = []; if (!store.logins || typeof store.logins !== 'object') store.logins = {}; }
if (!CLOUD) {
  try {
    store = Object.assign(emptyStore(), readJson(STORE_FILE, {}, log));
    state = Object.assign(emptyState(), readJson(STATE_FILE, {}, log));
  } catch (e) { log.error(e.message); releaseLock(); process.exit(4); }
} else { store = emptyStore(); state = emptyState(); }
normalizeDocs();
/* En mode cloud, persist() et persistState() marquent seulement le document comme modifié : l'écriture
   (atomique et conditionnelle) se fait à la fin de la requête, voir cloudHandler. */
const DIRTY = { store: false, state: false, hist: null, backups: [] };
function persist() { if (CLOUD) { DIRTY.store = true; return; } writeAtomic(STORE_FILE, store); }
function persistState() { if (CLOUD) { DIRTY.state = true; return; } writeAtomic(STATE_FILE, state); }
if (!CLOUD) fs.mkdirSync(HIST, { recursive: true });
function saveHistory(rev, data) {
  if (CLOUD) { DIRTY.hist = { rev, data }; return; }
  try {
    fs.writeFileSync(path.join(HIST, 'rev-' + rev + '.json.gz'), zlib.gzipSync(JSON.stringify(data)));
    const all = fs.readdirSync(HIST).map(f => +(/^rev-(\d+)\.json\.gz$/.exec(f) || [])[1]).filter(Boolean).sort((a, b) => a - b);
    for (const r of all.slice(0, Math.max(0, all.length - cfg.HISTORY_KEEP))) fs.unlinkSync(path.join(HIST, 'rev-' + r + '.json.gz'));
  } catch (e) { log.warn('Historique non enregistré', { err: e.message }); }
}
async function loadHistory(rev) {
  if (rev === state.rev) return state.data;
  if (CLOUD) { if (!(rev > 0)) return undefined; try { return await SB.history(rev); } catch (e) { log.warn('Historique Supabase indisponible', { err: e.message }); return undefined; } }
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HIST, 'rev-' + rev + '.json.gz')))); } catch (e) { return undefined; }
}
if (!CLOUD && state.data && !fs.existsSync(path.join(HIST, 'rev-' + state.rev + '.json.gz'))) saveHistory(state.rev, state.data);

/* ----- migrations du modèle de données : sauvegarde vérifiée AVANT, réversibles (tools/migrate.js) ----- */
function runMigrations() {
  const todo = MIG.pending(store); if (!todo.length) return;
  if (!cfg.MIGRATIONS_AUTO) { log.warn('Migrations en attente non appliquées (activer MIGRATIONS_AUTO=1 dans server.env, ou node tools/migrate.js --up serveur arrêté) : ' + todo.map(m => m.id).join(', ')); return; }
  const hasData = fs.existsSync(STORE_FILE) || fs.existsSync(STATE_FILE);
  if (hasData) {
    let b; try { b = BK.create(DATA, cfg.BACKUP_DIR, 'avant-migration', 0); } catch (e) { log.error('Migration annulée : sauvegarde impossible (' + e.message + ')'); releaseLock(); process.exit(6); }
    const v = BK.verify(b.dir); if (!v.ok) { log.error('Migration annulée : la sauvegarde ' + b.name + ' n’a pas pu être vérifiée.'); releaseLock(); process.exit(6); }
    log.info('Sauvegarde vérifiée avant migration : ' + b.name);
  }
  const ctx = { store, state, stateChanged: false };
  const done = MIG.applyAll(ctx);
  if (ctx.stateChanged && state.data) { state.rev += 1; state.at = new Date().toISOString(); state.by = 'migration'; persistState(); saveHistory(state.rev, state.data); }
  for (const id of done) audit('migration appliquée', null, { migration: id });
  persist();
  log.info('Migrations appliquées : ' + done.join(', '));
}

/* ----- horloge et fuseau (inchangé) ----- */
const CASA = 'Africa/Casablanca', ALLOW_EARLY = cfg.ALLOW_EARLY, TEST_CLOCK = cfg.ALLOW_TEST_CLOCK;
let FAKE = null; const nowMs = () => FAKE !== null ? FAKE : Date.now();
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: CASA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function tzOffset(ms) { const o = {}; for (const p of _fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000; }
/* heure murale Africa/Casablanca -> instant UTC (gère GMT+1 / GMT+0 via les données IANA, jamais de décalage fixe) */
function wallToUtc(date, hm) { const [y, m, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number), g = Date.UTC(y, m - 1, d, h, mi); let t = g - tzOffset(g); t = g - tzOffset(t); return t; }
const sha = A.sha;
const rid = n => crypto.randomBytes(n).toString('hex');

/* ----- journal d'audit chaîné ----- */
const GENESIS = '0'.repeat(64);
const audit = (event, req, extra) => {
  const prev = store.audit.length ? store.audit[store.audit.length - 1].h : GENESIS;
  const u = req && req.user;
  const e = { at: new Date(nowMs()).toISOString(), event, ip: req ? ip(req) : 'système', ...(u ? { user: u.username, role: u.role } : {}), ...extra, prev };
  e.h = sha(prev + JSON.stringify(e)); store.audit.push(e);
};
function auditValid() { let prev = GENESIS; for (const e of store.audit) { const { h, ...rest } = e; if (rest.prev !== prev || sha(prev + JSON.stringify(rest)) !== h) return false; prev = h; } return true; }
const notify = (kind, title, desc, sessionId, formId) => { store.notifs.push({ id: rid(6), at: new Date(nowMs()).toISOString(), kind, title, desc, sessionId: sessionId || '', formId: formId || '', read: false }); };

/* ----- réseau ----- */
function ip(req) { return String((cfg.TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?').replace(/^::ffff:/, ''); }
function ip4(s) { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); return m && m.slice(1).every(x => +x < 256) ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null; }
const NETS = cfg.ALLOWED_NETWORKS.map(c => { const [a, b] = c.split('/'), n = ip4(a), bits = b === undefined ? 32 : +b; if (n === null || !(bits >= 0 && bits <= 32)) { log.warn('ALLOWED_NETWORKS : entrée ignorée', { entree: c }); return null; } const mask = bits ? (~0 << (32 - bits)) >>> 0 : 0; return { n: (n & mask) >>> 0, mask }; }).filter(Boolean);
function allowedIp(addr) {
  if (!NETS.length) return true;
  if (addr === '::1') addr = '127.0.0.1';
  const n = ip4(addr); return n !== null && NETS.some(x => ((n & x.mask) >>> 0) === x.n);
}
const hits = new Map();
function limited(key, max, ms) { const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a); return a.length > max; }
if (!CLOUD) setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 600000)) hits.delete(k); }, 60000).unref();
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin' };
function send(res, code, body, type, extra) { res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8' }, SEC_HEADERS, extra || {})); res.end(body); }
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), null, extra);
const fail = (res, code, msg, extra) => json(res, code, Object.assign({ error: msg }, extra || {}));
function body(req, max) {
  return new Promise((ok, ko) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return ko({ code: 415, msg: 'JSON attendu' });
    const parse = buf => { try { ok(JSON.parse(buf.toString('utf8') || '{}')); } catch (e) { ko({ code: 400, msg: 'JSON invalide' }); } };
    if (req._rawBody !== undefined) { if (req._rawBody.length > max) return ko({ code: 413, msg: 'Requête trop volumineuse' }); return parse(req._rawBody); }   // nouvelle tentative (mode cloud)
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > max) { ko({ code: 413, msg: 'Requête trop volumineuse' }); req.destroy(); } else ch.push(c); });
    req.on('end', () => { req._rawBody = Buffer.concat(ch); parse(req._rawBody); });
    req.on('error', () => ko({ code: 400, msg: 'Erreur de lecture' }));
  });
}
function sameOrigin(req) { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } }

/* ----- comptes et sessions ----- */
const userById = id => store.users.find(u => u.id === id);
const userByName = n => store.users.find(u => u.username === String(n || '').trim().toLowerCase());
const activeAdmins = () => store.users.filter(u => u.role === 'admin' && !u.disabled);
function cookieFor(req, token, maxAge) {
  const secure = (cfg.TLS || (cfg.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https')) ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function openSession(req, user) {
  const token = A.newToken(), now = Date.now();
  store.logins[sha(token)] = { userId: user.id, createdAt: now, lastSeen: now, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  return cookieFor(req, token, Math.round(cfg.SESSION_MAX_HOURS * 3600));
}
function revokeSessions(userId, exceptHash) { let n = 0; for (const [h, s] of Object.entries(store.logins)) if (s.userId === userId && h !== exceptHash) { delete store.logins[h]; n++; } return n; }
let loginsDirty = false;
function sessionOf(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{40,64})(?:;|$)/.exec(req.headers.cookie || ''); if (!m) return null;
  const h = sha(m[1]), s = store.logins[h]; if (!s) return null;
  const now = Date.now();
  if (now - s.createdAt > cfg.SESSION_MAX_HOURS * 3600e3 || now - s.lastSeen > cfg.SESSION_IDLE_MINUTES * 60e3) { delete store.logins[h]; loginsDirty = true; return null; }
  const u = userById(s.userId); if (!u || u.disabled) { delete store.logins[h]; loginsDirty = true; return null; }
  if (now - s.lastSeen > 60e3) { s.lastSeen = now; loginsDirty = true; }
  return { hash: h, user: u };
}
function purgeLogins() {
  const now = Date.now();
  for (const [h, s] of Object.entries(store.logins)) if (now - s.createdAt > cfg.SESSION_MAX_HOURS * 3600e3 || now - s.lastSeen > cfg.SESSION_IDLE_MINUTES * 60e3) { delete store.logins[h]; loginsDirty = true; }
  if (loginsDirty) { loginsDirty = false; persist(); }
}
if (!CLOUD) setInterval(purgeLogins, 5 * 60e3).unref();
async function bootstrapAdmin() {
  if (store.users.length) { if (cfg.ADMIN_PASSWORD) log.warn('ADMIN_PASSWORD est défini mais des comptes existent déjà : la variable est ignorée. Supprimez-la de la configuration.'); return; }
  if (!cfg.ADMIN_PASSWORD) { log.warn('Aucun compte utilisateur. Créez le premier administrateur sur ce PC : node tools/create-admin.js'); return; }
  if (cfg.ADMIN_PASSWORD.length < 8) { log.error('ADMIN_PASSWORD trop court (8 caractères minimum) : aucun compte créé.'); return; }
  const now = new Date().toISOString();
  store.users.push({ id: rid(8), username: 'admin', displayName: 'Administrateur', role: 'admin', teacherId: '', extraPerms: [], disabled: false, mustChange: false, pw: await A.hashPassword(cfg.ADMIN_PASSWORD, cfg.SCRYPT_N), createdAt: now, failed: 0 });
  audit('compte administrateur créé depuis ADMIN_PASSWORD (compatibilité)', null, { username: 'admin' }); persist();
  log.warn('Compte « admin » créé à partir de ADMIN_PASSWORD. Retirez cette variable de la configuration et changez le mot de passe depuis l’interface.');
}

/* ----- validation (inchangé) ----- */
const str = (v, max) => typeof v === 'string' && v.length <= max ? v.trim() : '';
function cleanStudents(a) {
  if (!Array.isArray(a) || a.length > 500) return null; const seen = new Set(), out = [];
  for (const s of a) { const m = str(s && s.m, 40), n = str(s && s.n, 140); if (!m || !n || seen.has(m)) return null; seen.add(m); out.push({ m, n }); } return out;
}
const abList = a => Array.isArray(a) ? cleanStudents(a.map(x => ({ m: x && x.m, n: x && x.n }))) : null;
function formState(f) { return f.revokedAt ? 'revoked' : (Date.parse(f.expiresAt) < nowMs() ? 'expired' : 'open'); }
const pubSession = s => ({ subject: s.subject, teacher: s.teacher, date: s.date, start: s.start, end: s.end, program: s.program, year: s.year, group: s.group, room: s.room });
function findForm(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const h = sha(token); return Object.values(store.forms).find(f => f.tokenHash === h) || null;
}
function baseUrl(req) {
  if (cfg.PUBLIC_URL) return cfg.PUBLIC_URL;
  const proto = (cfg.TRUST_PROXY && req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + ((cfg.TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host);
}
function amendRule(teacherId, ex) {
  const pol = store.policies[teacherId || ''] || { mode: '24h' }, first = Date.parse(ex.firstAt || ex.submittedAt), h24 = first + 24 * 3600e3, n = nowMs();
  if (pol.mode === 'block') return { ok: false, msg: 'La modification est bloquée par l’administration.' };
  if (n <= h24) return { ok: true, until: h24 };
  if (pol.mode === 'exception' && pol.until && n <= Date.parse(pol.until)) return { ok: true, until: Date.parse(pol.until), exception: true };
  return { ok: false, msg: 'Le délai de modification de 24 heures est dépassé. Contactez l’administration.' };
}
const startMs = f => wallToUtc(f.session.date, f.session.start);
function absRecord(f, p, now) {
  return { id: rid(8), formId: f.id, sessionId: f.session.sessionId, ...pubSession(f.session), absent: p.absent, total: p.absent.length, enrolled: f.session.students.length, remark: p.remark, source: 'lien', status: 'soumise', signatureType: p.signatureType, signature: p.signature, signedBy: p.signedBy, submittedAt: now, firstAt: now, ay: MD.acy(f.session.date), teacherId: f.session.teacherId || '', versions: [] };
}
/* séance de l'état central (pour vérifier qu'un enseignant saisit bien pour SA séance) */
const centralSession = sid => state.data && (state.data.sessions || []).find(s => s.id === sid);
const absTeacher = a => a.teacherId || ((centralSession(a.sessionId) || {}).teacherId) || ((store.sessions[a.sessionId] || {}).teacherId) || '';

/* ----- surveillance : alerte de non-déclaration dès l'heure de fin (inchangé) ----- */
let derivedStatuses = {};
function refreshDerived() {
  if (!state.data) return;   // sans données centrales : ancienne synchronisation envoyée par l'interface (/api/sessions/sync)
  const d = MD.deriveSessions(state.data, store.absences, nowMs(), wallToUtc);
  store.sessions = d.sessions; derivedStatuses = d.statuses;
}
function runAlerts() {
  refreshDerived();
  const n = nowMs(); let ch = false; const iso = () => new Date(n).toISOString();
  for (const s of Object.values(store.sessions)) {
    const id = 'nd|' + s.id, al = store.alerts[id], decl = store.absences.some(a => a.sessionId === s.id && a.status !== 'annulée'), live = s.status === 'programmee' || s.status === 'realisee', due = n >= wallToUtc(s.date, s.end);
    if (al && !al.resolvedAt) { if (decl) { al.resolvedAt = iso(); al.resolvedBy = 'déclaration reçue'; ch = true; } else if (!live) { al.resolvedAt = iso(); al.resolvedBy = 'séance annulée ou reportée'; ch = true; } }
    else if (al && al.resolvedAt && live && !decl && due) { al.resolvedAt = null; al.resolvedBy = ''; al.reopenedAt = iso(); ch = true; }
    else if (!al && live && !decl && due) { store.alerts[id] = { id, sessionId: s.id, createdAt: iso(), resolvedAt: null, resolvedBy: '', subject: s.subject, teacher: s.teacher, teacherId: s.teacherId, date: s.date, start: s.start, end: s.end, program: s.program, year: s.year, group: s.group, room: s.room }; ch = true; }
  }
  if (ch) persist();
}
if (!CLOUD) setInterval(() => { try { runAlerts(); } catch (e) { log.error('runAlerts', { err: e.message }); } }, cfg.ALERT_INTERVAL_MS).unref();

/* ----- sauvegardes automatiques ----- */
let lastBackupAt = CLOUD ? '' : (BK.list(cfg.BACKUP_DIR).find(b => b.createdAt && !/avant-restauration/.test(b.reason || '')) || {}).createdAt || '';
/* Sauvegarde : dossier local, ou table unitt_backups (Supabase) en mode cloud — faite après l'enregistrement de la requête */
async function makeBackup(reason) {
  if (CLOUD) { DIRTY.backups.push(reason); store.lastCloudBackupAt = new Date().toISOString(); persist(); return { name: 'supabase (' + reason + ')', createdAt: store.lastCloudBackupAt }; }
  const b = BK.create(DATA, cfg.BACKUP_DIR, reason, cfg.BACKUP_KEEP); lastBackupAt = b.createdAt; return b;
}
function autoBackup(force, reason) {
  if (CLOUD) { if (cfg.BACKUP_INTERVAL_HOURS && (!store.lastCloudBackupAt || Date.now() - Date.parse(store.lastCloudBackupAt) > cfg.BACKUP_INTERVAL_HOURS * 3600e3) && (store.users.length || state.data)) makeBackup('auto'); return; }
  if (!cfg.BACKUP_INTERVAL_HOURS && !force) return;
  if (!force && lastBackupAt && Date.now() - Date.parse(lastBackupAt) < cfg.BACKUP_INTERVAL_HOURS * 3600e3) return;
  try { const b = BK.create(DATA, cfg.BACKUP_DIR, reason || 'auto', cfg.BACKUP_KEEP); lastBackupAt = b.createdAt; log.info('Sauvegarde automatique créée', { nom: b.name }); }
  catch (e) { log.error('Échec de la sauvegarde automatique', { err: e.message, dossier: cfg.BACKUP_DIR }); }
}
if (!CLOUD) setInterval(() => autoBackup(false), 15 * 60e3).unref();

/* ----- état central ----- */
const opDone = new Map();   // anti-doublon : opId -> réponse (nouvelle tentative après coupure réseau)
const opPending = [];
function remember(op, resp) { if (!op) return; if (CLOUD) { opPending.push([op, resp]); return; } opDone.set(op, resp); if (opDone.size > 500) opDone.delete(opDone.keys().next().value); }
function commitState(data, req, info) {
  const prev = state.data;
  const prot = MD.enforceAppendOnly(prev, data);            // journaux de l'interface : ajout seul
  MD.maintainGroupHistory(prev, data, MD.casaDate(nowMs()));  // historique des groupes géré par le serveur
  const diff = MD.diffForAudit(prev, data, 100);
  if (Object.keys(prot).length) audit('journal protégé : suppression ou modification d’entrées ignorée', req, { journaux: prot });
  info = { ...info, nbModifications: diff.total, modifications: diff.changes };
  const rev = state.rev + 1;
  state = { rev, at: new Date().toISOString(), by: req.user.username, data };
  persistState(); saveHistory(rev, data);
  audit('données centrales enregistrées', req, { rev, ...info });
  refreshDerived(); runAlerts();
  persist();
  return rev;
}

/* ----- routeur ----- */
const can_ = (req, p) => can(req.user, p);
function need(req, res, ...ps) { if (ps.some(p => can_(req, p))) return true; fail(res, 403, 'Action non autorisée pour votre rôle'); return false; }

async function route(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname, M = req.method;
  if (M === 'GET' && (p === '/' || p === '/index.html' || p === '/UniTimetable.html')) return file(res, 'index.html', { 'Content-Security-Policy': INDEX_CSP });
  if (M === 'GET' && /^\/f\/[A-Za-z0-9_-]+$/.test(p)) return file(res, 'form.html', { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  if (M === 'GET' && /^\/vendor\/[a-z0-9._-]+\.js$/.test(p)) return vendor(res, p.slice(8));
  if (M === 'GET' && p === '/favicon.ico') return send(res, 204, '', 'image/x-icon');
  if (M === 'GET' && p === '/health') return json(res, 200, { ok: true, app: 'unitimetable', version: VERSION, time: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), https: cfg.TLS, stateRev: state.rev, users: store.users.length > 0, vendorMissing: vendorMissing() });
  if (!p.startsWith('/api/')) return fail(res, 404, 'Introuvable');
  if (M === 'GET' && p === '/api/ping') return json(res, 200, { ok: true, app: 'um6ss-edt', version: VERSION, accounts: true });

  /* ---- API publique du formulaire (accès par jeton, inchangée) ---- */
  let m = /^\/api\/form\/([^/]+)(\/submit)?$/.exec(p);
  if (m) {
    if (limited('pub:' + ip(req), 90, 60000)) return fail(res, 429, 'Trop de requêtes');
    const f = findForm(m[1]);
    if (!f) { audit('lien inconnu', req); return fail(res, 404, 'Lien invalide'); }
    const st = formState(f); if (st !== 'open') return fail(res, 410, st === 'revoked' ? 'Ce lien a été révoqué.' : 'Ce lien a expiré.');
    if (M === 'GET' && !m[2]) {
      const ex = f.absenceId && store.absences.find(a => a.id === f.absenceId && a.status !== 'annulée');
      const ok = ALLOW_EARLY || nowMs() >= startMs(f), am = ex ? amendRule(f.session.teacherId, ex) : null;
      return json(res, 200, { session: pubSession(f.session), students: f.session.students, canDeclare: ok, startsAt: f.session.date + ' ' + f.session.start, submitted: ex ? { absent: ex.absent.map(a => a.m), total: ex.total, remark: ex.remark, submittedAt: ex.submittedAt, status: ex.status, canAmend: am.ok, amendMsg: am.msg || '', amendUntil: am.until ? new Date(am.until).toISOString() : '' } : null });
    }
    if (M === 'POST' && m[2]) {
      if (!sameOrigin(req)) return fail(res, 403, 'Origine refusée');
      let b; try { b = await body(req, 300 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg || 'Erreur'); }
      if (!ALLOW_EARLY && nowMs() < startMs(f)) return fail(res, 403, 'La séance n’a pas encore commencé : la déclaration sera possible à partir de ' + f.session.start + '.');
      const known = new Map(f.session.students.map(s => [s.m, s]));
      const abs = Array.isArray(b.absent) ? b.absent : null; if (!abs || abs.length > known.size) return fail(res, 400, 'Liste des absents invalide');
      const uniq = [...new Set(abs.map(x => typeof x === 'string' ? x : ''))]; if (uniq.length !== abs.length || uniq.some(x => !known.has(x))) return fail(res, 400, 'Un étudiant n’appartient pas à ce groupe');
      if (b.none === true && uniq.length) return fail(res, 400, 'Incohérence : « aucun absent » et absents sélectionnés');
      if (!uniq.length && b.none !== true) return fail(res, 400, 'Sélectionnez les absents ou confirmez qu’aucun étudiant n’est absent');
      const remark = str(b.remark, 1000); let signature = '', signedBy = '';
      if (b.signatureType === 'handwritten') { if (typeof b.signature !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) || b.signature.length > 160000 || b.signature.length < 300) return fail(res, 400, 'Signature manuscrite invalide'); signature = b.signature; signedBy = str(b.signedBy, 80); }
      else if (b.signatureType === 'electronic') { signedBy = str(b.signedBy, 80); if (signedBy.length < 2 || b.confirm !== true) return fail(res, 400, 'Confirmation électronique incomplète'); }
      else return fail(res, 400, 'Signature ou confirmation obligatoire');
      const now = new Date(nowMs()).toISOString(), ex = f.absenceId && store.absences.find(a => a.id === f.absenceId && a.status !== 'annulée');
      const pay = { absent: uniq.map(x => known.get(x)), remark, signatureType: b.signatureType, signature, signedBy };
      if (ex) {
        if (b.amend !== true) return fail(res, 409, 'Une déclaration a déjà été validée pour cette séance. Confirmez la modification.');
        const rule = amendRule(f.session.teacherId, ex); if (!rule.ok) { audit('modification refusée (délai/blocage)', req, { formId: f.id }); persist(); return fail(res, 403, rule.msg); }
        const why = str(b.reason, 300); if (why.length < 3) return fail(res, 400, 'Indiquez le motif de la modification');
        ex.versions.push({ at: now, by: 'enseignant', absent: ex.absent, total: ex.total, remark: ex.remark, reason: why });
        Object.assign(ex, { absent: pay.absent, total: pay.absent.length, remark, signatureType: pay.signatureType, signature, signedBy, status: 'corrigée', updatedAt: now });
        audit('déclaration corrigée', req, { formId: f.id, ancien: ex.versions[ex.versions.length - 1].total, nouveau: ex.total, motif: why }); notify('modification', 'Déclaration modifiée : ' + f.session.subject, ex.versions[ex.versions.length - 1].total + ' → ' + ex.total + ' absent(s) (' + f.session.teacher + ', motif : ' + why + ')', f.session.sessionId, f.id); runAlerts(); persist(); return json(res, 200, { ok: true, total: ex.total, amended: true });
      }
      const rec = absRecord(f, pay, now); store.absences.push(rec); f.absenceId = rec.id; f.submittedAt = now;
      audit('déclaration soumise', req, { formId: f.id, total: rec.total }); notify(rec.total ? 'declaration' : 'aucun_absent', (rec.total ? 'Absences enregistrées : ' : 'Aucun absent confirmé : ') + f.session.subject, (rec.total ? rec.total + ' absent(s)' : 'Aucun absent') + ' — ' + f.session.teacher + ', ' + f.session.date + ' ' + f.session.start, f.session.sessionId, f.id); runAlerts(); persist(); return json(res, 200, { ok: true, total: rec.total });
    }
    return fail(res, 405, 'Méthode non autorisée');
  }

  /* ---- connexion ---- */
  if (M === 'POST' && p === '/api/login') {
    if (!sameOrigin(req)) return fail(res, 403, 'Origine refusée');
    if (limited('login:' + ip(req), cfg.LOGIN_RATE_PER_MIN, 60000)) { log.warn('Trop de tentatives de connexion', { ip: ip(req) }); return fail(res, 429, 'Trop de tentatives, réessayez dans une minute'); }
    let b; try { b = await body(req, 4096); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const username = str(b.username, 64).toLowerCase() || 'admin';   // sans identifiant : compatibilité avec l'ancien écran (compte « admin »)
    const user = userByName(username);
    if (!user) { await A.dummyVerify(b.password, cfg.SCRYPT_N); audit('échec connexion', req, { username: username.slice(0, 32), motif: 'identifiant inconnu' }); persist(); return fail(res, 401, 'Identifiant ou mot de passe incorrect'); }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) { audit('connexion refusée (compte verrouillé)', req, { username }); persist(); return fail(res, 423, 'Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard ou contactez l’administrateur.'); }
    const ok = await A.verifyPassword(b.password, user.pw);
    if (!ok || user.disabled) {
      if (!ok) { user.failed = (user.failed || 0) + 1; if (user.failed >= cfg.LOGIN_MAX_FAILS) { user.lockedUntil = new Date(Date.now() + cfg.LOGIN_LOCK_MINUTES * 60e3).toISOString(); user.failed = 0; log.warn('Compte verrouillé après échecs répétés', { username }); } }
      audit('échec connexion', req, { username, motif: user.disabled && ok ? 'compte désactivé' : 'mot de passe incorrect' }); persist();
      return fail(res, 401, user.disabled && ok ? 'Ce compte est désactivé.' : 'Identifiant ou mot de passe incorrect');
    }
    user.failed = 0; user.lockedUntil = ''; user.lastLoginAt = new Date().toISOString();
    const ck = openSession(req, user); req.user = user;
    audit('connexion', req); persist();
    return json(res, 200, { ok: true, user: meOf(user) }, { 'Set-Cookie': ck });
  }
  const sess = sessionOf(req); req.user = sess ? sess.user : null;
  if (M === 'POST' && p === '/api/server/shutdown' && !CLOUD) {
    const loop = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress || '');
    const tok = String(req.headers['x-unitt-control'] || '');
    const byToken = loop && tok.length === CONTROL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(CONTROL_TOKEN));
    if (!byToken && !(req.user && !req.user.mustChange && can(req.user, 'server.manage') && sameOrigin(req))) { audit('arrêt du serveur refusé', req); persist(); return fail(res, 403, 'Action non autorisée'); }
    const actor = byToken ? str(String(req.headers['x-unitt-actor'] || ''), 40) : (req.user && req.user.username);
    audit('arrêt du serveur demandé', req, { par: actor || 'application de bureau', moyen: byToken ? 'application de bureau (jeton local)' : 'interface' }); persist();
    log.info('Arrêt demandé par ' + (actor || 'application de bureau'));
    json(res, 200, { ok: true });
    setTimeout(() => shutdown('arrêt demandé'), 100);
    return;
  }
  if (M === 'POST' && p === '/api/logout') {
    if (sess) { delete store.logins[sess.hash]; audit('déconnexion', req); persist(); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (M === 'GET' && p === '/api/me') return json(res, 200, { auth: !!req.user, user: req.user ? meOf(req.user) : null, setupRequired: !store.users.length, server: { version: VERSION, https: cfg.TLS } });

  /* ---- API protégée ---- */
  if (!req.user) return fail(res, 401, 'Authentification requise');
  if (M !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'Origine refusée');
  if (M === 'POST' && p === '/api/account/password') {
    if (limited('pw:' + req.user.id, 10, 600000)) return fail(res, 429, 'Trop de tentatives');
    let b; try { b = await body(req, 4096); } catch (e) { return fail(res, e.code || 400, e.msg); }
    if (!(await A.verifyPassword(b.current, req.user.pw))) { audit('échec changement de mot de passe', req); persist(); return fail(res, 400, 'Mot de passe actuel incorrect'); }
    const pb = A.passwordProblem(b.next, req.user.username); if (pb) return fail(res, 400, pb);
    if (b.next === b.current) return fail(res, 400, 'Le nouveau mot de passe doit être différent de l’ancien.');
    req.user.pw = await A.hashPassword(b.next, cfg.SCRYPT_N); req.user.mustChange = false; req.user.updatedAt = new Date().toISOString();
    const n = revokeSessions(req.user.id, sess.hash); audit('mot de passe changé', req, { autresSessionsFermees: n }); persist();
    return json(res, 200, { ok: true });
  }
  if (req.user.mustChange) return fail(res, 403, 'Vous devez d’abord changer votre mot de passe.', { mustChange: true });

  /* ---- comptes (administrateur) ---- */
  if (M === 'GET' && p === '/api/roles') return json(res, 200, { roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, perms: r.perms }])), perms: PERMS, grantable: GRANTABLE });
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!need(req, res, 'users.manage')) return;
    if (M === 'GET' && p === '/api/users') return json(res, 200, { items: store.users.map(x => ({ ...A.publicUser(x), sessions: Object.values(store.logins).filter(s => s.userId === x.id).length })) });
    let b; if (M !== 'GET') { try { b = await body(req, 8192); } catch (e) { return fail(res, e.code || 400, e.msg); } }
    const checkFields = (o, isNew) => {
      if (o.role !== undefined && !ROLES[o.role]) return 'Rôle invalide';
      if (o.displayName !== undefined && (typeof o.displayName !== 'string' || !o.displayName.trim() || o.displayName.length > 80)) return 'Nom affiché invalide (1 à 80 caractères)';
      if (o.teacherId !== undefined && (typeof o.teacherId !== 'string' || o.teacherId.length > 60)) return 'Enseignant invalide';
      if (o.extraPerms !== undefined && (!Array.isArray(o.extraPerms) || o.extraPerms.some(x => !GRANTABLE.includes(x)))) return 'Autorisation supplémentaire invalide';
      if (o.deniedPerms !== undefined && (!Array.isArray(o.deniedPerms) || o.deniedPerms.some(x => !GRANTABLE.includes(x)))) return 'Autorisation retirée invalide';
      if (isNew && (o.role === 'teacher') && !str(o.teacherId, 60)) return 'Un compte enseignant doit être relié à une fiche enseignant';
      return '';
    };
    if (M === 'POST' && p === '/api/users') {
      const username = str(b.username, 40).toLowerCase();
      if (!A.USERNAME_RE.test(username)) return fail(res, 400, 'Identifiant invalide : 3 à 32 caractères (lettres minuscules, chiffres, . _ -)');
      if (userByName(username)) return fail(res, 409, 'Cet identifiant existe déjà');
      const e = checkFields(b, true) || (!b.role ? 'Rôle obligatoire' : '') || A.passwordProblem(b.password, username); if (e) return fail(res, 400, e);
      const now = new Date().toISOString();
      const nu = { id: rid(8), username, displayName: str(b.displayName, 80) || username, role: b.role, teacherId: str(b.teacherId, 60), extraPerms: b.extraPerms || [], deniedPerms: b.deniedPerms || [], disabled: false, mustChange: true, pw: await A.hashPassword(b.password, cfg.SCRYPT_N), createdAt: now, failed: 0 };
      store.users.push(nu); audit('compte créé', req, { compte: username, roleAttribue: nu.role, enseignant: nu.teacherId }); persist();
      return json(res, 200, { ok: true, user: A.publicUser(nu) });
    }
    m = /^\/api\/users\/([a-f0-9]{16})(\/reset-password|\/unlock)?$/.exec(p);
    const tu = m && userById(m[1]); if (!tu) return fail(res, 404, 'Compte introuvable');
    if (M === 'PUT' && !m[2]) {
      const e = checkFields(b, false); if (e) return fail(res, 400, e);
      const nextRole = b.role !== undefined ? b.role : tu.role, nextDis = b.disabled !== undefined ? !!b.disabled : tu.disabled;
      if (tu.role === 'admin' && !tu.disabled && (nextRole !== 'admin' || nextDis) && activeAdmins().length <= 1) return fail(res, 400, 'Impossible : il doit rester au moins un administrateur actif.');
      if (tu.id === req.user.id && (nextDis || nextRole !== 'admin')) return fail(res, 400, 'Vous ne pouvez pas désactiver votre propre compte ni retirer votre rôle administrateur.');
      if (nextRole === 'teacher' && !str(b.teacherId !== undefined ? b.teacherId : tu.teacherId, 60)) return fail(res, 400, 'Un compte enseignant doit être relié à une fiche enseignant');
      const before = { role: tu.role, disabled: !!tu.disabled, teacherId: tu.teacherId || '', extraPerms: (tu.extraPerms || []).join(','), deniedPerms: (tu.deniedPerms || []).join(',') };
      if (b.displayName !== undefined) tu.displayName = b.displayName.trim();
      if (b.role !== undefined) tu.role = b.role;
      if (b.teacherId !== undefined) tu.teacherId = b.teacherId.trim();
      if (b.extraPerms !== undefined) tu.extraPerms = b.extraPerms;
      if (b.deniedPerms !== undefined) tu.deniedPerms = b.deniedPerms;
      if (b.disabled !== undefined) tu.disabled = !!b.disabled;
      tu.updatedAt = new Date().toISOString();
      let closed = 0; if (tu.disabled || before.role !== tu.role) closed = revokeSessions(tu.id);   // permissions individuelles : effet immédiat à la requête suivante
      audit('compte modifié', req, { compte: tu.username, avant: before, apres: { role: tu.role, disabled: !!tu.disabled, teacherId: tu.teacherId || '', extraPerms: (tu.extraPerms || []).join(','), deniedPerms: (tu.deniedPerms || []).join(',') }, sessionsFermees: closed }); persist();
      return json(res, 200, { ok: true, user: A.publicUser(tu) });
    }
    if (M === 'POST' && m[2] === '/reset-password') {
      const e = A.passwordProblem(b.password, tu.username); if (e) return fail(res, 400, e);
      tu.pw = await A.hashPassword(b.password, cfg.SCRYPT_N); tu.mustChange = true; tu.failed = 0; tu.lockedUntil = ''; tu.updatedAt = new Date().toISOString();
      const n = revokeSessions(tu.id); audit('mot de passe réinitialisé par l’administrateur', req, { compte: tu.username, sessionsFermees: n }); persist();
      return json(res, 200, { ok: true });
    }
    if (M === 'POST' && m[2] === '/unlock') { tu.failed = 0; tu.lockedUntil = ''; audit('compte déverrouillé', req, { compte: tu.username }); persist(); return json(res, 200, { ok: true }); }
    return fail(res, 405, 'Méthode non autorisée');
  }

  /* ---- serveur et sauvegardes (administrateur) ---- */
  if (M === 'GET' && p === '/api/server/info') {
    if (!need(req, res, 'server.manage')) return;
    return json(res, 200, { version: VERSION, node: process.version, platform: process.platform, host: cfg.HOST, port: cfg.PORT, https: cfg.TLS, dataDir: DATA, backupDir: cfg.BACKUP_DIR, logDir: cfg.LOG_DIR, uptimeSec: Math.round(process.uptime()), stateRev: state.rev, stateAt: state.at, stateBy: state.by, users: store.users.length, activeSessions: Object.keys(store.logins).length, lastBackupAt, backupKeep: cfg.BACKUP_KEEP, backupIntervalHours: cfg.BACKUP_INTERVAL_HOURS, allowedNetworks: cfg.ALLOWED_NETWORKS, vendorMissing: vendorMissing() });
  }
  if (p === '/api/backups') {
    if (!need(req, res, 'server.manage')) return;
    if (M === 'GET') { if (CLOUD) { try { return json(res, 200, { items: await SB.listBackups() }); } catch (e) { return fail(res, 500, e.message); } } return json(res, 200, { items: BK.list(cfg.BACKUP_DIR) }); }
    if (M === 'POST') { try { const bk = await makeBackup('manuelle'); audit('sauvegarde créée', req, { nom: bk.name }); persist(); return json(res, 200, { ok: true, backup: bk.name }); } catch (e) { log.error('Sauvegarde manuelle', { err: e.message }); return fail(res, 500, 'Échec de la sauvegarde : ' + e.message); } }
  }

  /* ---- état central partagé ---- */
  if (p === '/api/state') {
    if (M === 'GET') {
      if (!need(req, res, 'state.read', 'state.read.planning', 'state.read.own')) return;
      const since = u.searchParams.get('since');
      if (since !== null && +since === state.rev && state.data) return json(res, 200, { same: true, rev: state.rev });
      return json(res, 200, { rev: state.rev, at: state.at, by: state.by, data: ST.viewFor(req.user, state.data, can), writable: [...writable(req.user)] });
    }
    if (M === 'PUT') {
      const W = writable(req.user);
      if (!W.size) return fail(res, 403, 'Votre rôle ne permet pas de modifier les données de l’établissement (consultation seule).', { readOnly: true });
      let b; try { b = await body(req, cfg.STATE_MAX_MB * 1024 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
      const op = str(b.opId, 64); if (op && opDone.has(op)) return json(res, 200, opDone.get(op));
      const mine = b.data; if (!mine || typeof mine !== 'object' || Array.isArray(mine) || !Array.isArray(mine.sessions) || !Array.isArray(mine.teachers)) return fail(res, 400, 'Données invalides');
      const mineStr = ST.stable(mine);
      // si le serveur a complété ou protégé des données (historique des groupes, journaux), le poste reçoit la version finale
      const reply = (rev, merged, data) => { const changed = data && ST.stable(data) !== mineStr; return { ok: true, rev, merged: !!(merged || changed), ...((merged || changed) ? { data: ST.viewFor(req.user, data, can) } : {}) }; };
      const baseRev = Number.isInteger(b.baseRev) ? b.baseRev : -1;
      if (b.force === true) {
        if (!can_(req, 'state.force')) return fail(res, 403, 'Seul l’administrateur peut remplacer toutes les données');
        try { await makeBackup('avant-remplacement'); } catch (e) { return fail(res, 500, 'Sauvegarde préalable impossible : remplacement annulé'); }
        const rev = commitState(mine, req, { mode: 'remplacement complet', motif: str(b.reason, 200) });
        const r = reply(rev, false, state.data); remember(op, r); return json(res, 200, r);
      }
      if (!state.data) {
        if (!can_(req, 'state.force')) return fail(res, 409, 'Le serveur ne contient encore aucune donnée : l’administrateur doit d’abord les initialiser.', { empty: true });
        const rev = commitState(mine, req, { mode: 'initialisation' }); const r = reply(rev, false, state.data); remember(op, r); return json(res, 200, r);
      }
      const base = await loadHistory(baseRev);
      if (base === undefined) return fail(res, 409, 'Votre copie est trop ancienne pour être fusionnée automatiquement.', { rev: state.rev, conflicts: [{ collection: '*', id: '', label: 'toutes les données' }], data: ST.viewFor(req.user, state.data, can), needFull: true });
      const baseView = ST.viewFor(req.user, base, can), curView = ST.viewFor(req.user, state.data, can);
      const changed = ST.changedKeys(baseView, mine).filter(k => !isWritable(W, k) && ST.changedKeys({ [k]: curView[k] }, { [k]: mine[k] }).length);
      if (changed.length) { audit('modification refusée (droits)', req, { collections: changed.join(',') }); persist(); return fail(res, 403, 'Modification non autorisée pour votre rôle : ' + changed.join(', '), { forbidden: changed }); }
      if (baseRev === state.rev) {
        const merged = ST.merge3(base, mine, state.data, W, false).data;   // garde les collections non modifiables intactes
        const ks = ST.changedKeys(state.data, merged); if (!ks.length) { const r = { ok: true, rev: state.rev, merged: false, unchanged: true }; remember(op, r); return json(res, 200, r); }
        const rev = commitState(merged, req, { collections: ks.join(',') }); const r = reply(rev, false, state.data); remember(op, r); return json(res, 200, r);
      }
      const preferMine = b.resolve === 'mine';
      const { data, conflicts } = ST.merge3(base, mine, state.data, W, preferMine);
      if (conflicts.length && !preferMine) { log.info('Conflit de modification détecté', { user: req.user.username, baseRev, rev: state.rev, n: conflicts.length }); return fail(res, 409, 'Des éléments ont été modifiés en même temps sur un autre poste.', { rev: state.rev, conflicts: conflicts.slice(0, 200), data: curView }); }
      if (conflicts.length) { try { await makeBackup('avant-resolution-conflit'); } catch (e) { return fail(res, 500, 'Sauvegarde préalable impossible : résolution annulée'); } }
      const ks = ST.changedKeys(state.data, data);
      if (!ks.length) { const r = { ok: true, rev: state.rev, merged: true, data: curView }; remember(op, r); return json(res, 200, r); }
      const rev = commitState(data, req, { collections: ks.join(','), fusion: 'depuis rév. ' + baseRev, conflitsResolus: conflicts.length ? conflicts.map(c => c.collection + ':' + (c.label || c.id)).slice(0, 20).join('; ') : undefined });
      const r = reply(rev, true, state.data); remember(op, r); return json(res, 200, r);
    }
    return fail(res, 405, 'Méthode non autorisée');
  }

  /* ---- liens de déclaration ---- */
  if (M === 'POST' && p === '/api/forms') {
    if (!need(req, res, 'forms.manage')) return;
    let b; try { b = await body(req, 400 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const s = b.session || {}, students = cleanStudents(s.students), sid = str(s.sessionId, 60);
    if (!sid || !students || !students.length) return fail(res, 400, 'Séance ou liste d’étudiants invalide');
    const session = { sessionId: sid, teacherId: str(s.teacherId, 60), subject: str(s.subject, 200), teacher: str(s.teacher, 140), date: str(s.date, 10), start: str(s.start, 5), end: str(s.end, 5), program: str(s.program, 20), year: str(s.year, 2), group: str(s.group, 10), room: str(s.room, 100), students };
    if (!session.subject || !session.teacher || !/^\d{4}-\d{2}-\d{2}$/.test(session.date)) return fail(res, 400, 'Matière, enseignant et date sont obligatoires');
    const hrs = Math.min(24 * 14, Math.max(0.001, +b.expiresInHours || 72)), now = new Date(nowMs());
    for (const o of Object.values(store.forms)) if (o.session.sessionId === sid && formState(o) === 'open' && !o.submittedAt) o.revokedAt = now.toISOString();
    const token = crypto.randomBytes(24).toString('base64url'), id = rid(8);
    store.forms[id] = { id, tokenHash: sha(token), session, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + hrs * 3600e3).toISOString(), revokedAt: null, submittedAt: null, absenceId: null };
    audit('lien créé', req, { formId: id }); persist();
    return json(res, 200, { id, url: baseUrl(req) + '/f/' + token, expiresAt: store.forms[id].expiresAt });
  }
  if (M === 'GET' && p === '/api/forms') { if (!need(req, res, 'forms.manage')) return; return json(res, 200, { items: Object.values(store.forms).map(f => ({ id: f.id, session: pubSession(Object.assign({ sessionId: f.session.sessionId }, f.session)), sessionId: f.session.sessionId, students: f.session.students.length, createdAt: f.createdAt, expiresAt: f.expiresAt, revokedAt: f.revokedAt, submittedAt: f.submittedAt, state: formState(f) })) }); }
  m = /^\/api\/forms\/([a-f0-9]+)$/.exec(p);
  if (m && M === 'DELETE') { if (!need(req, res, 'forms.manage')) return; const f = store.forms[m[1]]; if (!f) return fail(res, 404, 'Introuvable'); f.revokedAt = f.revokedAt || new Date(nowMs()).toISOString(); audit('lien révoqué', req, { formId: f.id }); persist(); return json(res, 200, { ok: true }); }
  if (TEST_CLOCK && p === '/api/_test/clock' && M === 'POST') { let b; try { b = await body(req, 1024); } catch (e) { return fail(res, 400, 'x'); } FAKE = b.iso ? Date.parse(b.iso) : null; return json(res, 200, { now: new Date(nowMs()).toISOString() }); }
  if (M === 'GET' && p === '/api/audit') { if (!need(req, res, 'audit.read')) return; return json(res, 200, { valid: auditValid(), items: store.audit }); }
  if (M === 'GET' && p === '/api/policies') { if (!need(req, res, 'policies.manage')) return; return json(res, 200, { items: store.policies }); }
  m = /^\/api\/policies\/([A-Za-z0-9_:@.-]{1,60})$/.exec(p);
  if (m && M === 'PUT') {
    if (!need(req, res, 'policies.manage')) return;
    let b; try { b = await body(req, 2048); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const mode = b.mode, reason = str(b.reason, 300);
    if (!['24h', 'block', 'exception'].includes(mode)) return fail(res, 400, 'Mode invalide');
    let until = '';
    if (mode === 'exception') { until = new Date(b.until).toString() === 'Invalid Date' ? '' : new Date(b.until).toISOString(); if (!until || Date.parse(until) <= nowMs()) return fail(res, 400, 'Une date d’expiration future est obligatoire pour une exception'); }
    const old = store.policies[m[1]] || { mode: '24h' }; store.policies[m[1]] = { mode, until, reason, at: new Date(nowMs()).toISOString() };
    audit('politique de modification', req, { enseignant: m[1], ancien: old.mode, nouveau: mode, jusqua: until, motif: reason });
    if (mode === 'exception') notify('exception', 'Exception de modification accordée', m[1] + ' jusqu’au ' + until, '', '');
    persist(); return json(res, 200, { ok: true });
  }
  if (M === 'POST' && p === '/api/sessions/sync') {
    if (!need(req, res, 'sessions.sync')) return;
    if (state.data) { refreshDerived(); runAlerts(); return json(res, 200, { ok: true, count: Object.keys(store.sessions).length, source: 'données centrales' }); }   // les séances surveillées viennent du serveur, plus des postes
    let b; try { b = await body(req, 4 * 1024 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    if (!Array.isArray(b.sessions) || b.sessions.length > 20000) return fail(res, 400, 'Séances invalides');
    const out = {}, okSt = ['programmee', 'realisee', 'annulee', 'reportee', 'reportee_sans_date'];
    for (const x of b.sessions) {
      const id = str(x && x.id, 60), date = str(x && x.date, 10), st = str(x && x.start, 5), en = str(x && x.end, 5);
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(en) || !okSt.includes(x.status)) continue;
      out[id] = { id, date, start: st, end: en, status: x.status, teacherId: str(x.teacherId, 60), teacher: str(x.teacher, 140), subject: str(x.subject, 200), program: str(x.program, 20), year: str(x.year, 2), group: str(x.group, 10), room: str(x.room, 100) };
    }
    store.sessions = out; runAlerts(); persist(); return json(res, 200, { ok: true, count: Object.keys(out).length });
  }
  m = /^\/api\/sessions\/([A-Za-z0-9_-]{1,60})$/.exec(p);
  if (m && M === 'GET') {
    const s = centralSession(m[1]);
    const ownOnly = !can_(req, 'state.read') && !can_(req, 'state.read.planning');
    if (!ownOnly && !s) return fail(res, 404, 'Séance introuvable');
    if (ownOnly && (!can_(req, 'state.read.own') || !s || !req.user.teacherId || s.teacherId !== req.user.teacherId)) { audit('accès refusé à une séance', req, { sessionId: m[1] }); persist(); return fail(res, 403, 'Cette séance ne vous est pas attribuée.'); }
    if (!derivedStatuses[s.id]) refreshDerived();
    return json(res, 200, { session: s, info: MD.sessionInfo(state.data, s), ...(derivedStatuses[s.id] || {}) });
  }
  if (M === 'GET' && p === '/api/alerts') {
    if (can_(req, 'alerts.read')) return json(res, 200, { items: Object.values(store.alerts) });
    if (can_(req, 'alerts.read.own')) return json(res, 200, { items: Object.values(store.alerts).filter(a => req.user.teacherId && a.teacherId === req.user.teacherId) });
    return fail(res, 403, 'Action non autorisée pour votre rôle');
  }
  if (M === 'GET' && p === '/api/notifications') { if (!need(req, res, 'notifs.read')) return; return json(res, 200, { items: store.notifs.slice(-300).reverse() }); }
  if (M === 'POST' && p === '/api/notifications/read') {
    if (!need(req, res, 'notifs.read')) return;
    let b; try { b = await body(req, 20000); } catch (e) { return fail(res, e.code || 400, e.msg); }
    for (const n of store.notifs) if (b.all === true || (Array.isArray(b.ids) && b.ids.includes(n.id))) n.read = true; persist(); return json(res, 200, { ok: true });
  }

  /* ---- absences ---- */
  const ownAbs = a => !!req.user.teacherId && absTeacher(a) === req.user.teacherId;
  if (M === 'GET' && p === '/api/absences') {
    const strip = a => Object.assign({}, a, { signature: undefined, hasSig: !!a.signature });
    if (can_(req, 'absences.read')) return json(res, 200, { items: store.absences.map(strip) });
    if (can_(req, 'absences.read.own')) return json(res, 200, { items: store.absences.filter(ownAbs).map(strip) });
    if (can_(req, 'absences.read.summary')) return json(res, 200, { items: store.absences.map(a => ({ ...strip(a), absent: [], versions: [], remark: '' })) });
    return fail(res, 403, 'Action non autorisée pour votre rôle');
  }
  m = /^\/api\/absences\/([a-f0-9]+)\/signature$/.exec(p);
  if (m && M === 'GET') { const a = store.absences.find(x => x.id === m[1]); if (!a) return fail(res, 404, 'Introuvable'); if (!(can_(req, 'absences.read') || (can_(req, 'absences.read.own') && ownAbs(a)))) return fail(res, 403, 'Action non autorisée pour votre rôle'); return json(res, 200, { signature: a.signature || '' }); }
  if (M === 'POST' && p === '/api/absences') {
    if (!need(req, res, 'absences.write', 'absences.write.own')) return;
    let b; try { b = await body(req, 200 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const sid = str(b.sessionId, 60), absent = abList(b.absent);
    if (!sid || absent === null) return fail(res, 400, 'Données invalides');
    const asTeacher = !can_(req, 'absences.write');
    let cs = null;
    if (asTeacher) {
      cs = centralSession(sid);
      if (!cs || !req.user.teacherId || cs.teacherId !== req.user.teacherId) { audit('saisie d’absences refusée (séance non attribuée)', req, { sessionId: sid }); persist(); return fail(res, 403, 'Cette séance ne vous est pas attribuée.'); }
      if (!ALLOW_EARLY && cs.date && cs.startTime && nowMs() < wallToUtc(cs.date, cs.startTime)) return fail(res, 403, 'La séance n’a pas encore commencé.');
      if (cs.cancelled || cs.postponed) return fail(res, 400, 'Séance annulée ou reportée.');
    }
    if (store.absences.some(a => a.sessionId === sid && a.status !== 'annulée')) return fail(res, 409, 'Une déclaration existe déjà pour cette séance : utilisez la correction.');
    const now = new Date(nowMs()).toISOString();
    const rec = { id: rid(8), formId: null, sessionId: sid, subject: str(b.subject, 200), teacher: str(b.teacher, 140), date: str(b.date, 10), start: str(b.start, 5), end: str(b.end, 5), program: str(b.program, 20), year: str(b.year, 2), group: str(b.group, 10), room: str(b.room, 100), absent, total: absent.length, enrolled: +b.enrolled || 0, remark: str(b.remark, 1000), source: asTeacher ? 'enseignant' : 'papier', status: asTeacher ? 'soumise' : 'saisie_admin', signatureType: asTeacher ? 'compte' : 'administration', signature: '', signedBy: asTeacher ? 'Saisie par ' + req.user.displayName + ' (compte ' + req.user.username + ')' : 'Saisie par l’administration (' + req.user.username + ')', submittedAt: now, firstAt: now, ay: MD.acy(str(b.date, 10)), teacherId: asTeacher ? req.user.teacherId : str(b.teacherId, 60) || ((centralSession(sid) || {}).teacherId || ''), enteredBy: req.user.username, versions: [] };
    store.absences.push(rec); audit(asTeacher ? 'absences saisies (compte enseignant)' : 'absences saisies (papier)', req, { id: rec.id, sessionId: sid, total: rec.total });
    if (asTeacher) notify(rec.total ? 'declaration' : 'aucun_absent', (rec.total ? 'Absences enregistrées : ' : 'Aucun absent confirmé : ') + rec.subject, (rec.total ? rec.total + ' absent(s)' : 'Aucun absent') + ' — ' + req.user.displayName + ', ' + rec.date + ' ' + rec.start, sid, '');
    runAlerts(); persist(); return json(res, 200, { id: rec.id });
  }
  m = /^\/api\/absences\/([a-f0-9]+)\/(amend|cancel)$/.exec(p);
  if (m && M === 'POST') {
    const a = store.absences.find(x => x.id === m[1]); if (!a) return fail(res, 404, 'Introuvable');
    const admin = can_(req, 'absences.amend');
    if (!admin) {
      if (!(can_(req, 'absences.write.own') && ownAbs(a)) || m[2] === 'cancel') return fail(res, 403, 'Action non autorisée pour votre rôle');
      const rule = amendRule(req.user.teacherId, a); if (!rule.ok) return fail(res, 403, rule.msg);
    }
    let b; try { b = await body(req, 200 * 1024); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const why = str(b.reason, 300); if (why.length < 3) return fail(res, 400, 'Le motif est obligatoire');
    const by = admin ? 'administration (' + req.user.username + ')' : 'enseignant (' + req.user.username + ')';
    if (m[2] !== 'cancel' && abList(b.absent) === null) return fail(res, 400, 'Liste invalide');
    a.versions.push({ at: new Date(nowMs()).toISOString(), by, absent: a.absent, total: a.total, remark: a.remark, reason: m[2] === 'cancel' ? 'annulation : ' + why : why });
    if (m[2] === 'cancel') a.status = 'annulée';
    else { const ab = abList(b.absent); a.absent = ab; a.total = ab.length; a.remark = str(b.remark, 1000); a.status = 'corrigée'; a.updatedAt = new Date(nowMs()).toISOString(); }
    audit('déclaration ' + (m[2] === 'cancel' ? 'annulée' : 'corrigée') + (admin ? ' (admin)' : ' (enseignant)'), req, { id: a.id, motif: why });
    if (!admin) notify('modification', 'Déclaration modifiée : ' + a.subject, a.versions[a.versions.length - 1].total + ' → ' + a.total + ' absent(s) (' + req.user.displayName + ', motif : ' + why + ')', a.sessionId, '');
    runAlerts(); persist(); return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Introuvable');
}
function meOf(u) { return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, roleLabel: (ROLES[u.role] || {}).label || u.role, teacherId: u.teacherId || '', perms: permsOf(u), writable: [...writable(u)], mustChange: !!u.mustChange }; }
const INDEX_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const fileCache = new Map();
async function readPub(rel) { if (CLOUD && fileCache.has(rel)) return fileCache.get(rel); const d = await fs.promises.readFile(path.join(PUB, rel)); if (CLOUD) fileCache.set(rel, d); return d; }
async function file(res, name, extra) { let d; try { d = await readPub(name); } catch (e) { return fail(res, 404, 'Fichier manquant : ' + name); } send(res, 200, d, 'text/html; charset=utf-8', extra); }
async function vendor(res, name) {
  let d; try { d = await readPub(path.join('vendor', path.basename(name))); } catch (e) { return fail(res, 404, 'Introuvable'); }
  send(res, 200, d, 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
}

/* ----- serveur HTTP / HTTPS ----- */
function handler(req, res) {
  const t0 = Date.now(), addr = ip(req);
  res.on('finish', () => { if (req.url !== '/health' && !(req.url || '').startsWith('/api/state?since=') && !(req.url || '').startsWith('/vendor/')) log.info(req.method + ' ' + log.redactPath(req.url) + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms', { ip: addr, user: req.user ? req.user.username : undefined }); else if (res.statusCode >= 400) log.warn(req.method + ' ' + log.redactPath(req.url) + ' ' + res.statusCode, { ip: addr }); });
  if (!allowedIp(addr)) { log.warn('Requête refusée : adresse hors des réseaux autorisés', { ip: addr }); return fail(res, 403, 'Adresse non autorisée'); }
  route(req, res).catch(e => { log.error('Erreur interne', { err: e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e), path: log.redactPath(req.url) }); if (!res.headersSent) fail(res, 500, 'Erreur serveur'); });
}
let server;
let stopping = false;
function shutdown(sig, code) {
  if (stopping || CLOUD) return; stopping = true;
  log.info('Arrêt du serveur (' + sig + ')…');
  try { persist(); } catch (e) { log.error('Écriture finale impossible', { err: e.message }); }
  server.close(() => { releaseLock(); log.info('Serveur arrêté proprement.'); process.exit(code || 0); });
  if (server.closeAllConnections) setTimeout(() => server.closeAllConnections(), 300);
  setTimeout(() => { releaseLock(); process.exit(code || 0); }, 4000).unref();
}
if (!CLOUD) startLocalServer();
function startLocalServer() {
try {
  if (cfg.TLS) {
    const o = cfg.TLS_PFX ? { pfx: fs.readFileSync(cfg.TLS_PFX), passphrase: cfg.TLS_PFX_PASSPHRASE || undefined } : { cert: fs.readFileSync(cfg.TLS_CERT), key: fs.readFileSync(cfg.TLS_KEY) };
    server = https.createServer({ ...o, minVersion: 'TLSv1.2' }, handler);
  } else server = http.createServer(handler);
} catch (e) { log.error('Certificat HTTPS illisible : ' + e.message); releaseLock(); process.exit(5); }
server.requestTimeout = 120000; server.headersTimeout = 30000; server.keepAliveTimeout = 5000;
server.on('error', e => {
  if (e.code === 'EADDRINUSE') log.error('Le port ' + cfg.PORT + ' est déjà utilisé (autre instance ou autre logiciel). Changez PORT dans server.env ou arrêtez l’autre programme.');
  else if (e.code === 'EACCES') log.error('Accès refusé au port ' + cfg.PORT + '.');
  else log.error('Erreur serveur', { err: e.message });
  releaseLock(); process.exit(2);
});

['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].forEach(s => { try { process.on(s, () => shutdown(s)); } catch (e) { /* signal non pris en charge */ } });
process.on('uncaughtException', e => { log.error('Exception non gérée', { err: e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e) }); shutdown('exception', 1); });
process.on('unhandledRejection', e => { log.error('Promesse rejetée non gérée', { err: String(e && e.message || e) }); });
process.on('exit', releaseLock);
(async () => {
  runMigrations();
  if (!lastBackupAt && fs.existsSync(STORE_FILE)) autoBackup(true, 'premier-demarrage');   // copie des données existantes avant toute écriture de cette version
  await bootstrapAdmin();
  autoBackup(false);
  server.listen(cfg.PORT, cfg.HOST, () => {
    try { fs.writeFileSync(CONTROL, CONTROL_TOKEN, { mode: 0o600 }); } catch (e) { log.warn('Jeton de contrôle local non écrit', { err: e.message }); }
    const proto = cfg.TLS ? 'https' : 'http';
    const nets = Object.values(require('os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => proto + '://' + n.address + ':' + cfg.PORT);
    log.always('Serveur UniTimetable ' + VERSION + ' démarré : ' + proto + '://localhost:' + cfg.PORT + '  (écoute ' + cfg.HOST + ', données : ' + DATA + ')');
    if (nets.length) log.info('Adresses pour les postes clients : ' + nets.join('  '));
    if (!cfg.TLS) log.warn('HTTP sans chiffrement : à réserver à un réseau local de confiance. Voir README-LOCAL-WINDOWS.md (section HTTPS).');
    try { runAlerts(); } catch (e) { log.error('runAlerts', { err: e.message }); }   // première vérification immédiate
    const vm = vendorMissing(); if (vm.length) log.warn('Bibliothèques absentes de public/vendor : ' + vm.join(', ') + '. Import/export Excel ou PDF indisponibles. Exécutez une fois : node tools/fetch-vendor.js');
    if (cfg.configLoaded) log.info('Configuration lue : ' + cfg.CONFIG_FILE);
    if (TEST_CLOCK || ALLOW_EARLY) log.warn('Options de TEST actives (ALLOW_TEST_CLOCK / ALLOW_EARLY) : ne jamais utiliser en production.');
  });
})();
}

/* ======================= Mode cloud (Vercel + Supabase) =======================
   Chaque requête : chargement des documents depuis Supabase, traitement par le même routeur que le serveur local,
   puis enregistrement atomique et conditionnel (version). Si une autre instance a écrit entre-temps, la requête est
   rejouée sur les données à jour (la réponse n'est envoyée qu'après un enregistrement réussi). */
class BufRes {
  constructor() { this.statusCode = 200; this.headers = {}; this.body = ''; this.headersSent = false; }
  writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); this.headersSent = true; return this; }
  setHeader(k, v) { this.headers[k] = v; }
  end(b) { this.body = b === undefined ? '' : b; }
  on() { return this; }
}
async function cloudOnce(req) {
  const docs = await SB.load();
  store = Object.assign(emptyStore(), docs.store || {}); state = Object.assign(emptyState(), docs.state || {}); normalizeDocs();
  DIRTY.store = false; DIRTY.state = false; DIRTY.hist = null; DIRTY.backups = []; loginsDirty = false; opPending.length = 0;
  if (!store.users.length && cfg.ADMIN_PASSWORD) await bootstrapAdmin();
  purgeLogins();
  try { runAlerts(); } catch (e) { log.error('runAlerts', { err: e.message }); }   // surveillance des séances : à chaque requête (pas de tâche permanente sur Vercel)
  autoBackup(false);
  const res = new BufRes();
  if (!allowedIp(ip(req))) fail(res, 403, 'Adresse non autorisée'); else await route(req, res);
  if (loginsDirty) { loginsDirty = false; DIRTY.store = true; }
  for (const r of DIRTY.backups) { try { await SB.backup(r, cfg.BACKUP_KEEP); } catch (e) { log.error('Sauvegarde Supabase impossible', { err: e.message }); } }   // copie AVANT l'enregistrement
  if (DIRTY.store || DIRTY.state) {
    await SB.save({ store: DIRTY.store ? store : undefined, storeVersion: docs.storeVersion, state: DIRTY.state ? state : undefined, stateVersion: docs.stateVersion,
      histRev: DIRTY.hist ? DIRTY.hist.rev : null, histData: DIRTY.hist ? DIRTY.hist.data : undefined, histKeep: cfg.HISTORY_KEEP });
  }
  for (const [op, r] of opPending.splice(0)) { opDone.set(op, r); if (opDone.size > 500) opDone.delete(opDone.keys().next().value); }
  return res;
}
let cloudQueue = Promise.resolve();
function cloudHandler(req, res) {
  const run = async () => {
    const t0 = Date.now();
    let out;
    const pth = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && (pth === '/' || pth === '/index.html' || pth === '/favicon.ico' || pth === '/api/ping' || /^\/(vendor|f)\//.test(pth))) {   // fichiers et ping : aucun accès à la base
      out = new BufRes(); await route(req, out); res.writeHead(out.statusCode, out.headers); res.end(out.body); return;
    }
    for (let attempt = 1; ; attempt++) {
      try { out = await cloudOnce(req); break; }
      catch (e) {
        if (e && e.conflict && attempt < 5) { await new Promise(r => setTimeout(r, 30 * attempt + Math.random() * 60)); continue; }
        log.error('Erreur (cloud)', { err: e && e.message, path: log.redactPath(req.url) });
        out = new BufRes(); fail(out, e && e.conflict ? 503 : 500, e && e.conflict ? 'Serveur occupé, réessayez.' : 'Erreur serveur : ' + String(e && e.message || e).slice(0, 200)); break;
      }
    }
    if (!/^\/(health|vendor\/)/.test(req.url || '') && !(req.url || '').startsWith('/api/state?since=')) log.info(req.method + ' ' + log.redactPath(req.url) + ' ' + out.statusCode + ' ' + (Date.now() - t0) + 'ms', { user: req.user ? req.user.username : undefined });
    res.writeHead(out.statusCode, out.headers); res.end(out.body);
  };
  const p = cloudQueue.then(run, run); cloudQueue = p.catch(() => { }); return p;   // une requête à la fois par instance (variables globales partagées)
}
module.exports = { cloudHandler };

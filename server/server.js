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
const AL = require('./lib/auditlog');
const PF = require('./lib/platform');
const ROLESX = require('./lib/roles');
const TR = require('./lib/trash');
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

/* ----- données : plateforme + un contexte par établissement -----
   Plateforme (registre des établissements, Super Admin) : DATA/platform.json, journal DATA/platform-audit.jsonl.
   Établissement : premier établissement (données d'origine) directement dans DATA (store.json, state.json, history,
   audit.jsonl) ; les suivants dans DATA/tenants/<id>/. En mode cloud : documents Supabase « platform »,
   « store[:id] », « state[:id] » et table unitt_audit.
   Le serveur traite UNE requête à la fois (file d'attente) : les variables store / state ci-dessous désignent
   toujours l'établissement de la requête en cours (contexte « lié » par bind()). L'établissement est déterminé
   uniquement par le serveur (jeton de session, jeton de lien), jamais par un identifiant envoyé par le navigateur. */
const SECRET_FILE = path.join(DATA, 'secret.key');
if (!CLOUD && !fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const PLATFORM_FILE = path.join(DATA, 'platform.json');
let store, state, C = null;          // établissement lié à la requête en cours
const emptyStore = () => ({ forms: {}, absences: [], policies: {}, sessions: {}, alerts: {}, notifs: [], users: [], logins: {}, customRoles: {} });
const emptyState = () => ({ rev: 0, at: '', by: '', data: null });
function normalizeDocs() { if (!Array.isArray(store.users)) store.users = []; if (!store.logins || typeof store.logins !== 'object') store.logins = {}; if (!store.customRoles || typeof store.customRoles !== 'object') store.customRoles = {}; }
const tKey = t => t.legacy ? '' : t.id;
const tDir = t => t.legacy ? DATA : path.join(DATA, 'tenants', t.id);
const tBackupDir = t => t.legacy ? cfg.BACKUP_DIR : path.join(cfg.BACKUP_DIR, 'tenants', t.id);
const OPDONE = new Map();   // réponses déjà envoyées par établissement (anti-doublon), conservées en mémoire
/* contexte d'un établissement */
function makeCtx(t, sto, sta, ver) {
  return { tenant: t, key: tKey(t), dir: tDir(t), store: Object.assign(emptyStore(), sto || {}), state: Object.assign(emptyState(), sta || {}), derived: {}, ver: ver || { store: 0, state: 0 },
    dirty: { store: false, state: false }, hist: null, backups: [], auditPending: [], auditLast: AL.GENESIS, auditFile: CLOUD ? null : new AL.FileAudit(path.join(tDir(t), 'audit.jsonl')), opDone: OPDONE.get(t.id) || (OPDONE.set(t.id, new Map()), OPDONE.get(t.id)), lastBackupAt: '' };
}
function bind(ctx) { if (C && C !== ctx) sync(); C = ctx; store = ctx.store; state = ctx.state; derivedStatuses = ctx.derived; normalizeDocs(); ROLESX.setCustomRoles(store.customRoles); }
function sync() { if (C) { C.store = store; C.state = state; C.derived = derivedStatuses; } }
/* ancien journal d'audit (store.audit) : transféré dans le journal séparé, en conservant la chaîne */
function liftLegacyAudit(ctx) {
  const old = ctx.store.audit; if (!Array.isArray(old)) return; delete ctx.store.audit;
  if (!old.length) return;
  if (CLOUD) { if (ctx.auditLast === AL.GENESIS) { for (const e of old) { ctx.auditPending.push(e); } ctx.auditLast = old[old.length - 1].h || AL.GENESIS; } }
  else ctx.auditFile.importLegacy(old);
  ctx.dirty.store = true;
}
const CTX = new Map();   // mode fichiers : contextes chargés (id -> contexte)
function loadCtxLocal(t) {
  if (CTX.has(t.id)) return CTX.get(t.id);
  const dir = tDir(t); fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const ctx = makeCtx(t, readJson(path.join(dir, 'store.json'), {}, log), readJson(path.join(dir, 'state.json'), {}, log));
  liftLegacyAudit(ctx); if (ctx.dirty.store) { writeAtomic(path.join(dir, 'store.json'), ctx.store); ctx.dirty.store = false; }
  ctx.lastBackupAt = (BK.list(tBackupDir(t)).find(b => b.createdAt && !/avant-restauration/.test(b.reason || '')) || {}).createdAt || '';
  if (ctx.state.data && !fs.existsSync(path.join(dir, 'history', 'rev-' + ctx.state.rev + '.json.gz'))) { try { fs.writeFileSync(path.join(dir, 'history', 'rev-' + ctx.state.rev + '.json.gz'), zlib.gzipSync(JSON.stringify(ctx.state.data))); } catch (e) { /* */ } }
  CTX.set(t.id, ctx); return ctx;
}
/* mode cloud : contextes chargés pendant la requête en cours */
let REQ = null;   // { ctxs: Map, platformVersion, platformDirty }
async function loadCtxCloud(t) {
  if (REQ.ctxs.has(t.id)) return REQ.ctxs.get(t.id);
  const k = tKey(t), ids = [SB.docId('store', k), SB.docId('state', k)];
  const r = await SB.load(ids, [k]);
  const s = r.docs[ids[0]] || {}, st = r.docs[ids[1]] || {};
  const ctx = makeCtx(t, s.data, st.data, { store: s.version || 0, state: st.version || 0 });
  ctx.auditLast = r.last[k] || AL.GENESIS; liftLegacyAudit(ctx);
  ctx.lastBackupAt = ctx.store.lastCloudBackupAt || '';
  REQ.ctxs.set(t.id, ctx); return ctx;
}
const ctxOf = t => CLOUD ? loadCtxCloud(t) : Promise.resolve(loadCtxLocal(t));
function persist() { if (!C) return; sync(); if (CLOUD) { C.dirty.store = true; return; } writeAtomic(path.join(C.dir, 'store.json'), store); }
function persistState() { if (!C) return; sync(); if (CLOUD) { C.dirty.state = true; return; } writeAtomic(path.join(C.dir, 'state.json'), state); }
function saveHistory(rev, data) {
  if (CLOUD) { C.hist = { rev, data }; return; }
  const HIST = path.join(C.dir, 'history');
  try {
    fs.mkdirSync(HIST, { recursive: true });
    fs.writeFileSync(path.join(HIST, 'rev-' + rev + '.json.gz'), zlib.gzipSync(JSON.stringify(data)));
    const all = fs.readdirSync(HIST).map(f => +(/^rev-(\d+)\.json\.gz$/.exec(f) || [])[1]).filter(Boolean).sort((a, b) => a - b);
    for (const r of all.slice(0, Math.max(0, all.length - cfg.HISTORY_KEEP))) fs.unlinkSync(path.join(HIST, 'rev-' + r + '.json.gz'));
  } catch (e) { log.warn('Historique non enregistré', { err: e.message }); }
}
async function loadHistory(rev) {
  if (rev === state.rev) return state.data;
  if (CLOUD) { if (!(rev > 0)) return undefined; try { return await SB.history(C.key, rev); } catch (e) { log.warn('Historique Supabase indisponible', { err: e.message }); return undefined; } }
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(C.dir, 'history', 'rev-' + rev + '.json.gz')))); } catch (e) { return undefined; }
}

/* ----- plateforme ----- */
let platform = PF.emptyPlatform(), PAUDIT_FILE = CLOUD ? null : new AL.FileAudit(path.join(DATA, 'platform-audit.jsonl'));
const PAUDIT = { pending: [], last: AL.GENESIS };
function persistPlatform() { if (CLOUD) { REQ.platformDirty = true; return; } writeAtomic(PLATFORM_FILE, platform); }
const tenantById = id => platform.tenants.find(t => t.id === id) || null;
const tenantBySlug = s => platform.tenants.find(t => t.slug === String(s || '').trim().toLowerCase()) || null;
const legacyTenant = () => platform.tenants.find(t => t.legacy) || null;
const defaultTenant = () => (platform.settings.allowDefaultLogin && tenantById(platform.settings.defaultTenantId)) || null;
/* premier démarrage de cette version : l'établissement existant (ou vide) devient le premier établissement */
function ensurePlatform(existingName) {
  let ch = false;
  if (!platform.tenants.length) {
    const name = existingName || process.env.DEFAULT_TENANT_NAME || 'Établissement principal';
    const slug = (process.env.DEFAULT_TENANT_SLUG && PF.SLUG_RE.test(process.env.DEFAULT_TENANT_SLUG)) ? process.env.DEFAULT_TENANT_SLUG : 'principal';
    const t = PF.newTenant({ name, slug, legacy: true }, 'migration');
    platform.tenants.push(t); platform.settings.defaultTenantId = t.id; ch = true;
    paudit('établissement créé (données existantes reprises)', null, { tenantId: t.id, etablissement: name, code: slug });
  }
  return ch;
}
/* ----- migrations du modèle de données : sauvegarde vérifiée AVANT, réversibles (tools/migrate.js) — par établissement ----- */
function runMigrations() {
  const todo = MIG.pending(store); if (!todo.length) return;
  if (!cfg.MIGRATIONS_AUTO) { log.warn('Migrations en attente non appliquées pour « ' + C.tenant.name + ' » (activer MIGRATIONS_AUTO=1 dans server.env, ou node tools/migrate.js --up serveur arrêté) : ' + todo.map(m => m.id).join(', ')); return; }
  const hasData = !CLOUD && (fs.existsSync(path.join(C.dir, 'store.json')) || fs.existsSync(path.join(C.dir, 'state.json')));
  if (hasData) {
    let b; try { b = BK.create(C.dir, tBackupDir(C.tenant), 'avant-migration', 0); } catch (e) { log.error('Migration annulée : sauvegarde impossible (' + e.message + ')'); releaseLock(); process.exit(6); }
    const v = BK.verify(b.dir); if (!v.ok) { log.error('Migration annulée : la sauvegarde ' + b.name + ' n’a pas pu être vérifiée.'); releaseLock(); process.exit(6); }
    log.info('Sauvegarde vérifiée avant migration : ' + b.name);
  }
  const ctx = { store, state, stateChanged: false };
  const done = MIG.applyAll(ctx);
  if (ctx.stateChanged && state.data) { state.rev += 1; state.at = new Date().toISOString(); state.by = 'migration'; persistState(); saveHistory(state.rev, state.data); }
  for (const id of done) audit('migration appliquée', null, { migration: id });
  persist();
  log.info('Migrations appliquées (' + C.tenant.name + ') : ' + done.join(', '));
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

/* ----- journal d'audit : séparé, en ajout seul, chaîné (lib/auditlog.js) ----- */
const GENESIS = AL.GENESIS;
/* rubrique de l'application concernée par un événement (filtre « section » de l'historique d'activité) */
const COLL_SECTION = { students: 'étudiants', sessions: 'emploi du temps', subjects: 'emploi du temps', rooms: 'emploi du temps', teachers: 'enseignants', levels: 'groupes', programs: 'filières', cal: 'emploi du temps', volumes: 'volumes horaires', notCommon: 'emploi du temps', templates: 'documents', tplCats: 'documents', cfg: 'paramètres', absences: 'absences' };
function sectionOf(event, extra) {
  if (extra && extra.section) return extra.section;
  const e = String(event || '');
  if (/connexion|déconnexion|mot de passe|verrouill|double authentification/.test(e)) return 'authentification';
  if (/compte|rôle|autorisation/.test(e)) return 'comptes';
  if (/déclaration|absence/.test(e)) return 'absences';
  if (/lien/.test(e)) return 'liens de déclaration';
  if (/sauvegarde|restauration|migration|arrêt du serveur|remplacement/.test(e)) return 'système';
  if (/politique|exception/.test(e)) return 'règles de modification';
  if (/établissement|abonnement|identité/.test(e)) return 'établissement';
  if (/séance/.test(e)) return 'emploi du temps';
  if (/données centrales|journal protégé|modification refusée/.test(e)) {
    const cols = new Set([...(String((extra && extra.collections) || '').split(',').filter(Boolean)), ...(((extra && extra.modifications) || []).map(m => m.collection))]);
    const secs = [...new Set([...cols].map(c => COLL_SECTION[c] || c))];
    return secs.length === 1 ? secs[0] : secs.length ? 'plusieurs : ' + secs.join(', ') : 'données';
  }
  return 'autre';
}
const resultOf = event => /refus|non autoris/.test(event) ? 'refusé' : /échec|inconnu|invalide/.test(event) ? 'échec' : 'succès';
function auditEntry(event, req, extra) {
  const u = req && req.user;
  return { at: new Date(nowMs()).toISOString(), event, section: sectionOf(event, extra), result: (extra && extra.result) || resultOf(event), ip: req ? ip(req) : 'système',
    ...(u ? { user: u.username, userId: u.id, role: u.role, ...(u.superAdmin ? { superAdmin: true, superAdminMode: u.superAdminMode } : {}) } : {}), ...extra };
}
const audit = (event, req, extra) => {
  if (!C) return;
  const e = { ...auditEntry(event, req, extra), tenantId: C.tenant.id };
  if (CLOUD) { const x = AL.seal(C.auditLast, e); C.auditPending.push(x); C.auditLast = x.h; C.dirty.audit = true; }
  else C.auditFile.append(e);
};
/* journal de la plateforme (actions du Super Admin, création / suspension d'établissements…) */
function paudit(event, req, extra) {
  const a = req && req.admin;
  const e = { at: new Date(nowMs()).toISOString(), event, section: (extra && extra.section) || 'plateforme', result: (extra && extra.result) || resultOf(event), ip: req ? ip(req) : 'système', ...(a ? { user: a.username, userId: a.id, role: 'superadmin' } : {}), ...extra };
  if (CLOUD) { const x = AL.seal(PAUDIT.last, e); PAUDIT.pending.push(x); PAUDIT.last = x.h; }
  else PAUDIT_FILE.append(e);
}
async function auditRead(ctx, q, platformLog) {
  if (CLOUD) {
    const r = await SB.auditQuery(platformLog ? 'platform' : ctx.key, q);
    const pend = platformLog ? PAUDIT.pending : ctx.auditPending;   // événements de la requête en cours, pas encore enregistrés
    const extra = pend.filter(e => AL.matches(e, q.f));
    return { total: (r.total || 0) + extra.length, items: q.order === 'asc' ? (r.items || []).concat(extra) : extra.slice().reverse().concat(r.items || []) };
  }
  return (platformLog ? PAUDIT_FILE : ctx.auditFile).query(q);
}
async function auditValidOf(ctx, platformLog) {
  if (!CLOUD) return (platformLog ? PAUDIT_FILE : ctx.auditFile).valid();
  const all = await auditRead(ctx, { f: {}, limit: 1e9, offset: 0, order: 'asc' }, platformLog);
  return AL.chainValid(all.items);
}
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
  const token = PF.prefixed(C.tenant.id, A.newToken()), now = Date.now();
  store.logins[sha(token)] = { userId: user.id, createdAt: now, lastSeen: now, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  return cookieFor(req, token, Math.round(cfg.SESSION_MAX_HOURS * 3600));
}
function revokeSessions(userId, exceptHash) { let n = 0; for (const [h, s] of Object.entries(store.logins)) if (s.userId === userId && h !== exceptHash) { delete store.logins[h]; n++; } return n; }
let loginsDirty = false;
const sidOf = req => { const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{40,64})(?:;|$)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
/* Compte « virtuel » du Super Admin entré dans l'espace d'un établissement (jamais enregistré dans les comptes de l'établissement) */
function superUser(s) {
  const a = platform.admins.find(x => x.id === s.superAdmin); if (!a || a.disabled) return null;
  const view = s.mode !== 'intervene';
  return { id: 'sa:' + a.id, username: 'superadmin.' + a.username, displayName: a.displayName + ' (Super Admin)', role: view ? 'platform_view' : 'platform_intervene', teacherId: '', superAdmin: true, superAdminId: a.id, superAdminMode: view ? 'consultation' : 'intervention', reason: s.reason || '', mustChange: false };
}
function sessionOf(req) {
  const tok = sidOf(req); if (!tok) return null;
  const h = sha(tok), s = store.logins[h]; if (!s) return null;
  const now = Date.now(), maxH = s.superAdmin ? Math.min(cfg.SESSION_MAX_HOURS, platform.settings.workspaceMaxHours || 2) : cfg.SESSION_MAX_HOURS, idleM = s.superAdmin ? Math.min(cfg.SESSION_IDLE_MINUTES, platform.settings.superAdminIdleMinutes || 30) : cfg.SESSION_IDLE_MINUTES;
  if (now - s.createdAt > maxH * 3600e3 || now - s.lastSeen > idleM * 60e3) { delete store.logins[h]; loginsDirty = true; return null; }
  const u = s.superAdmin ? superUser(s) : userById(s.userId); if (!u || u.disabled) { delete store.logins[h]; loginsDirty = true; return null; }
  if (now - s.lastSeen > 60e3) { s.lastSeen = now; loginsDirty = true; }
  return { hash: h, user: u, rec: s };
}
function purgeLogins() {
  const now = Date.now();
  for (const [h, s] of Object.entries(store.logins)) if (now - s.createdAt > cfg.SESSION_MAX_HOURS * 3600e3 || now - s.lastSeen > cfg.SESSION_IDLE_MINUTES * 60e3) { delete store.logins[h]; loginsDirty = true; }
  if (loginsDirty) { loginsDirty = false; persist(); }
}
async function bootstrapAdmin() {
  if (!C || !C.tenant.legacy) return;   // compatibilité : ADMIN_PASSWORD ne concerne que le premier établissement
  if (store.users.length) { if (cfg.ADMIN_PASSWORD && !CLOUD) log.warn('ADMIN_PASSWORD est défini mais des comptes existent déjà : la variable est ignorée. Supprimez-la de la configuration.'); return; }
  if (!cfg.ADMIN_PASSWORD) { if (!CLOUD) log.warn('Aucun compte utilisateur. Créez le premier administrateur sur ce PC : node tools/create-admin.js'); return; }
  if (cfg.ADMIN_PASSWORD.length < 8) { log.error('ADMIN_PASSWORD trop court (8 caractères minimum) : aucun compte créé.'); return; }
  const now = new Date().toISOString();
  store.users.push({ id: rid(8), username: 'admin', displayName: 'Administrateur', role: 'admin', teacherId: '', extraPerms: [], disabled: false, mustChange: false, pw: await A.hashPassword(cfg.ADMIN_PASSWORD, cfg.SCRYPT_N), createdAt: now, failed: 0 });
  audit('compte administrateur créé depuis ADMIN_PASSWORD (compatibilité)', null, { username: 'admin' }); persist();
  log.warn('Compte « admin » créé à partir de ADMIN_PASSWORD. Retirez cette variable de la configuration et changez le mot de passe depuis l’interface.');
}
/* Super Admin initial (mode cloud, ou serveur local sans outil) : SUPERADMIN_USERNAME + SUPERADMIN_PASSWORD, seulement s'il n'en existe aucun */
async function bootstrapSuperAdmin() {
  if (platform.admins.length) return false;
  const un = String(process.env.SUPERADMIN_USERNAME || '').trim().toLowerCase(), pw = process.env.SUPERADMIN_PASSWORD || '';
  if (!un || !pw) return false;
  if (!A.USERNAME_RE.test(un)) { log.error('SUPERADMIN_USERNAME invalide (3 à 32 caractères : minuscules, chiffres, . _ -)'); return false; }
  const pb = PF.superPasswordProblem(pw, un); if (pb) { if (!bootstrapSuperAdmin.warned) { bootstrapSuperAdmin.warned = true; log.error('SUPERADMIN_PASSWORD refusé : ' + pb); } return false; }
  platform.admins.push({ id: rid(8), username: un, displayName: String(process.env.SUPERADMIN_NAME || 'Propriétaire de la plateforme').slice(0, 80), email: '', pw: await A.hashPassword(pw, cfg.SCRYPT_N), totp: null, failed: 0, lockedUntil: '', createdAt: new Date().toISOString(), mustChange: true, disabled: false });
  paudit('compte Super Admin créé depuis SUPERADMIN_PASSWORD', null, { compte: un }); persistPlatform();
  log.warn('Compte Super Admin « ' + un + ' » créé. Changez son mot de passe à la première connexion, activez la double authentification, puis retirez SUPERADMIN_PASSWORD de la configuration.');
  return true;
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

/* ----- sauvegardes automatiques ----- */
/* Sauvegarde : dossier local de l'établissement, ou table unitt_backups (Supabase) — faite après l'enregistrement de la requête */
async function makeBackup(reason) {
  if (CLOUD) { C.backups.push(reason); store.lastCloudBackupAt = new Date().toISOString(); C.lastBackupAt = store.lastCloudBackupAt; persist(); return { name: 'supabase (' + reason + ')', createdAt: store.lastCloudBackupAt }; }
  const b = BK.create(C.dir, tBackupDir(C.tenant), reason, cfg.BACKUP_KEEP); C.lastBackupAt = b.createdAt; return b;
}
function autoBackup(force, reason) {
  if (CLOUD) { if (cfg.BACKUP_INTERVAL_HOURS && (!store.lastCloudBackupAt || Date.now() - Date.parse(store.lastCloudBackupAt) > cfg.BACKUP_INTERVAL_HOURS * 3600e3) && (store.users.length || state.data)) makeBackup('auto'); return; }
  if (!cfg.BACKUP_INTERVAL_HOURS && !force) return;
  if (!force && C.lastBackupAt && Date.now() - Date.parse(C.lastBackupAt) < cfg.BACKUP_INTERVAL_HOURS * 3600e3) return;
  try { const b = BK.create(C.dir, tBackupDir(C.tenant), reason || 'auto', cfg.BACKUP_KEEP); C.lastBackupAt = b.createdAt; log.info('Sauvegarde automatique créée', { nom: b.name, etablissement: C.tenant.slug }); }
  catch (e) { log.error('Échec de la sauvegarde automatique', { err: e.message, dossier: tBackupDir(C.tenant) }); }
}
let lastPlatformBackupAt = '';
function platformBackup(force) {
  if (CLOUD || !fs.existsSync(PLATFORM_FILE)) return;
  if (!force && lastPlatformBackupAt && Date.now() - Date.parse(lastPlatformBackupAt) < Math.max(1, cfg.BACKUP_INTERVAL_HOURS || 24) * 3600e3) return;
  try { const b = BK.create(DATA, path.join(cfg.BACKUP_DIR, 'platform'), 'auto', cfg.BACKUP_KEEP, BK.PLATFORM_FILES); lastPlatformBackupAt = b.createdAt; } catch (e) { log.error('Sauvegarde de la plateforme impossible', { err: e.message }); }
}

/* ----- état central ----- */
// anti-doublon : opId -> réponse (nouvelle tentative après coupure réseau), par établissement (C.opDone)
const opPending = [];
function remember(op, resp) { if (!op) return; if (CLOUD) { opPending.push([C, op, resp]); return; } C.opDone.set(op, resp); if (C.opDone.size > 500) C.opDone.delete(C.opDone.keys().next().value); }
const shortVals = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return [k, t && t.length > 300 ? '[contenu volumineux : ' + t.length + ' caractères]' : v]; }));
function commitState(data, req, info) {
  const prev = state.data;
  const prot = MD.enforceAppendOnly(prev, data);            // journaux de l'interface : ajout seul
  MD.maintainGroupHistory(prev, data, MD.casaDate(nowMs()), info && info.trustedHistory);  // historique des groupes géré par le serveur
  if (info) delete info.trustedHistory;
  const diff = MD.diffForAudit(prev, data, 100);
  if (Object.keys(prot).length) audit('journal protégé : suppression ou modification d’entrées ignorée', req, { journaux: prot });
  info = { ...info, nbModifications: diff.total, modifications: diff.changes };
  const rev = state.rev + 1;
  const dels = TR.deletedBetween(prev, data), delReason = info.deleteReason || ''; delete info.deleteReason;
  state = { rev, at: new Date().toISOString(), by: req.user.username, data };
  sync(); persistState(); saveHistory(rev, data);
  audit('données centrales enregistrées', req, { rev, ...info, ...(dels.length ? { suppressionsLogiques: dels.length } : {}) });
  /* suppression logique : rien n'est perdu, chaque élément retiré part dans la corbeille de l'établissement */
  if (dels.length) {
    const entries = TR.makeEntries(dels, { at: new Date(nowMs()).toISOString(), by: req.user.username, byId: req.user.id, byName: req.user.displayName, reason: delReason, rev }, prev);
    (store.trash = store.trash || []).push(...entries);
    if (entries.length <= 30) for (const e of entries) audit('suppression logique', req, { section: TR.SECTION[e.collection], collection: e.collection, record: e.label, recordId: e.recordId, corbeille: e.id, motif: delReason || undefined, ancien: shortVals(e.data), rev });
    else audit('suppression logique (lot de ' + entries.length + ' éléments)', req, { section: 'plusieurs : ' + [...new Set(entries.map(e => TR.SECTION[e.collection]))].join(', '), elements: entries.map(e => ({ collection: e.collection, recordId: e.recordId, record: e.label, corbeille: e.id })), motif: delReason || undefined, rev });
  }
  refreshDerived(); runAlerts();
  persist();
  return rev;
}

/* ----- routeur ----- */
const can_ = (req, p) => can(req.user, p);
function need(req, res, ...ps) { if (ps.some(p => can_(req, p))) return true; fail(res, 403, 'Action non autorisée pour votre rôle'); return false; }

const today = () => MD.casaDate(nowMs());
const tenantInfo = t => t && ({ slug: t.slug, name: t.name, nameAr: t.nameAr || '', shortName: t.shortName || '', legacy: !!t.legacy });
/* Établissement de la requête — déterminé UNIQUEMENT côté serveur :
   lien de déclaration -> préfixe du jeton ; connexion -> code d'établissement saisi (ou établissement par défaut) ;
   sinon -> préfixe du jeton de session. Le jeton doit ensuite exister dans CET établissement (vérifié par empreinte). */
async function resolveTenant(req, u) {
  const p = u.pathname;
  let m = /^\/api\/form\/([^/]+)/.exec(p);
  if (m) { const id = PF.tenantOfToken(m[1], 32); return id === null ? null : id === '' ? legacyTenant() : tenantById(id); }
  if (req.method === 'POST' && p === '/api/login') {
    let b = {}; try { b = await body(req, 4096); } catch (e) { /* erreur traitée plus loin */ }
    const code = str(b && b.etab, 40).toLowerCase();
    return code ? tenantBySlug(code) : defaultTenant();
  }
  const tok = sidOf(req);
  if (tok) { const id = PF.tenantOfToken(tok, 43); return id === null ? null : id === '' ? legacyTenant() : tenantById(id); }
  return defaultTenant();
}
async function route(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname, M = req.method;
  if (M === 'GET' && (p === '/' || p === '/index.html' || p === '/UniTimetable.html')) return file(res, 'index.html', { 'Content-Security-Policy': INDEX_CSP });
  if (M === 'GET' && (p === '/platform' || p === '/platform/')) return file(res, 'platform.html', { 'Content-Security-Policy': PLATFORM_CSP });
  if (M === 'GET' && /^\/f\/[A-Za-z0-9_-]+$/.test(p)) return file(res, 'form.html', { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  if (M === 'GET' && /^\/vendor\/[a-z0-9._-]+\.js$/.test(p)) return vendor(res, p.slice(8));
  if (M === 'GET' && p === '/favicon.ico') return send(res, 204, '', 'image/x-icon');
  if (M === 'GET' && p === '/health') {
    const dt = defaultTenant() || legacyTenant(), dc = dt ? await ctxOf(dt) : null;
    return json(res, 200, { ok: true, app: 'unitimetable', version: VERSION, time: new Date().toISOString(), uptimeSec: Math.round(process.uptime()), https: cfg.TLS, stateRev: dc ? dc.state.rev : 0, users: !!(dc && dc.store.users && dc.store.users.length), tenants: platform.tenants.length, superAdmin: platform.admins.length > 0, vendorMissing: vendorMissing() });
  }
  if (!p.startsWith('/api/')) return fail(res, 404, 'Introuvable');
  if (M === 'GET' && p === '/api/ping') return json(res, 200, { ok: true, app: 'um6ss-edt', version: VERSION, accounts: true, multiTenant: true });
  if (p === '/api/platform' || p.startsWith('/api/platform/')) return platformRoute(req, res, u);

  const t = await resolveTenant(req, u);
  if (!t) {
    if (M === 'GET' && p === '/api/me') return json(res, 200, { auth: false, user: null, setupRequired: false, needCode: true, server: { version: VERSION, https: cfg.TLS } });
    if (M === 'POST' && p === '/api/login') { if (limited('login:' + ip(req), cfg.LOGIN_RATE_PER_MIN, 60000)) return fail(res, 429, 'Trop de tentatives, réessayez dans une minute'); await A.dummyVerify('x', cfg.SCRYPT_N); return fail(res, 401, 'Code d’établissement, identifiant ou mot de passe incorrect', { needCode: true }); }
    if (/^\/api\/form\//.test(p)) return fail(res, 404, 'Lien invalide');
    if (M === 'POST' && p === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return fail(res, 401, 'Authentification requise');
  }
  bind(await ctxOf(t));
  if (CLOUD) {   // pas de tâche permanente sur Vercel : maintenance de l'établissement à chaque requête
    if (!store.users.length && cfg.ADMIN_PASSWORD) await bootstrapAdmin();
    purgeLogins();
    try { runAlerts(); } catch (e) { log.error('runAlerts', { err: e.message }); }
    autoBackup(false);
  }
  return tenantRoute(req, res, u);
}
async function tenantRoute(req, res, u) {
  const p = u.pathname, M = req.method, T = C.tenant, blockedMsg = PF.blocked(T, today());

  /* ---- API publique du formulaire (accès par jeton, inchangée) ---- */
  let m = /^\/api\/form\/([^/]+)(\/submit)?$/.exec(p);
  if (m) {
    if (limited('pub:' + ip(req), 90, 60000)) return fail(res, 429, 'Trop de requêtes');
    if (blockedMsg) return fail(res, 410, blockedMsg);
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
    if (blockedMsg) { audit('connexion refusée (établissement suspendu ou abonnement expiré)', req, { username }); persist(); return fail(res, 403, blockedMsg, { blocked: true }); }
    user.failed = 0; user.lockedUntil = ''; user.lastLoginAt = new Date().toISOString();
    const ck = openSession(req, user); req.user = user;
    audit('connexion', req); persist();
    return json(res, 200, { ok: true, user: meOf(user) }, { 'Set-Cookie': ck });
  }
  const sess = sessionOf(req); req.user = sess ? sess.user : null;
  if (req.user && blockedMsg && !req.user.superAdmin && p !== '/api/logout') {
    if (M === 'GET' && p === '/api/me') return json(res, 200, { auth: false, user: null, blocked: blockedMsg, tenant: tenantInfo(T), server: { version: VERSION, https: cfg.TLS } });
    return fail(res, 403, blockedMsg, { blocked: true });
  }
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
    if (sess) { delete store.logins[sess.hash]; audit(req.user.superAdmin ? 'sortie de l’espace de l’établissement (Super Admin)' : 'déconnexion', req); persist(); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (M === 'GET' && p === '/api/me') return json(res, 200, { auth: !!req.user, user: req.user ? meOf(req.user) : null, setupRequired: !store.users.length, tenant: tenantInfo(T), prefs: store.prefs || {}, server: { version: VERSION, https: cfg.TLS } });

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
  /* Super Admin en consultation : lecture seule, quelle que soit la route */
  if (req.user.superAdmin && req.user.superAdminMode === 'consultation' && M !== 'GET') { audit('modification refusée (Super Admin en consultation)', req, { chemin: p }); persist(); return fail(res, 403, 'Mode consultation : aucune modification possible. Entrez en mode intervention depuis la console Super Admin.', { readOnly: true }); }

  /* ---- comptes et rôles (administrateur de l'établissement) ---- */
  if (M === 'GET' && p === '/api/roles') {
    const assignableRoles = Object.fromEntries(Object.entries(ROLES).filter(([k]) => ROLESX.assignable(k)).map(([k, r]) => [k, { label: r.label, perms: r.perms }]));
    const custom = Object.fromEntries(Object.entries(store.customRoles || {}).map(([k, r]) => [k, { label: r.label, perms: (r.perms || []).filter(x => GRANTABLE.includes(x)), custom: true }]));
    return json(res, 200, { roles: { ...assignableRoles, ...custom }, perms: PERMS, grantable: GRANTABLE });
  }
  m = /^\/api\/roles\/custom\/([a-z0-9_]{1,40})$/.exec(p);
  if (m && (M === 'PUT' || M === 'DELETE')) {
    if (!need(req, res, 'users.manage')) return;
    const key = m[1]; if (!ROLESX.CUSTOM_KEY_RE.test(key)) return fail(res, 400, 'Clé de rôle invalide (préfixe c_ puis 2 à 30 caractères : minuscules, chiffres, _)');
    const cur = store.customRoles[key];
    if (M === 'DELETE') {
      if (!cur) return fail(res, 404, 'Rôle introuvable');
      const users = store.users.filter(x => x.role === key && !x.disabled); if (users.length) return fail(res, 409, 'Rôle encore attribué à ' + users.length + ' compte(s) actif(s) : changez d’abord leur rôle.');
      const now = new Date(nowMs()).toISOString(), te = { id: rid(8), collection: 'customRoles', type: 'Rôle personnalisé', recordId: key, label: cur.label, data: { key, def: cur }, status: 'deleted', deletedAt: now, deletedBy: req.user.username, deletedById: req.user.id, deletedByName: req.user.displayName, reason: str(u.searchParams.get('reason') || '', 300), history: [{ at: now, action: 'suppression', by: req.user.username }] };
      (store.trash = store.trash || []).push(te);
      delete store.customRoles[key]; ROLESX.setCustomRoles(store.customRoles); audit('suppression logique', req, { section: 'comptes', collection: 'customRoles', record: cur.label, recordId: key, corbeille: te.id, avant: cur }); persist(); return json(res, 200, { ok: true });
    }
    let b; try { b = await body(req, 8192); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const label = str(b.label, 60), perms = Array.isArray(b.perms) ? [...new Set(b.perms)] : null;
    if (!label) return fail(res, 400, 'Nom du rôle obligatoire');
    if (!perms || perms.some(x => !GRANTABLE.includes(x))) return fail(res, 400, 'Autorisations invalides (les droits d’administration ne peuvent pas être attribués à un rôle personnalisé)');
    store.customRoles[key] = { label, perms, updatedAt: new Date().toISOString(), ...(cur ? { createdAt: cur.createdAt } : { createdAt: new Date().toISOString() }) };
    ROLESX.setCustomRoles(store.customRoles);
    audit(cur ? 'rôle personnalisé modifié' : 'rôle personnalisé créé', req, { role: key, recordId: key, avant: cur || null, apres: store.customRoles[key] }); persist();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/users' || p.startsWith('/api/users/')) return usersApi(req, res, p, M);
  /* ---- informations de l'établissement (son administrateur ; jamais statut / abonnement) ---- */
  if (p === '/api/institution') {
    if (M === 'GET') return json(res, 200, { tenant: PF.publicTenant(T) });
    if (M === 'PUT') {
      if (!need(req, res, 'institution.manage')) return;
      let b; try { b = await body(req, 8192); } catch (e) { return fail(res, e.code || 400, e.msg); }
      const o = PF.cleanTenantFields({ name: b.name, nameAr: b.nameAr, shortName: b.shortName, contact: b.contact }, T);
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
      if (o.name !== undefined && !o.name) return fail(res, 400, 'Le nom de l’établissement est obligatoire');
      const before = { name: T.name, nameAr: T.nameAr, shortName: T.shortName, contact: T.contact };
      Object.assign(T, o, { updatedAt: new Date().toISOString() }); persistPlatform();
      audit('informations de l’établissement modifiées', req, { avant: before, apres: { name: T.name, nameAr: T.nameAr, shortName: T.shortName, contact: T.contact } }); persist();
      paudit('informations d’établissement modifiées par son administrateur', null, { tenantId: T.id, etablissement: T.name, par: req.user.username });
      return json(res, 200, { ok: true, tenant: PF.publicTenant(T) });
    }
  }
  /* ---- corbeille (suppression logique) et préférences de l'établissement ---- */
  if (p === '/api/prefs' && M === 'PUT') {
    if (!need(req, res, 'institution.manage')) return;
    let b; try { b = await body(req, 2048); } catch (e) { return fail(res, e.code || 400, e.msg); }
    const before = { ...(store.prefs || {}) }; store.prefs = { ...(store.prefs || {}) };
    if (b.requireDeleteReason !== undefined) store.prefs.requireDeleteReason = !!b.requireDeleteReason;
    audit('préférences de l’établissement modifiées', req, { section: 'paramètres', avant: before, apres: store.prefs }); persist();
    return json(res, 200, { ok: true, prefs: store.prefs });
  }
  if (p === '/api/trash' || p.startsWith('/api/trash/')) return trashApi(req, res, p, M, u);
  /* Super Admin en consultation : les accès aux données sont inscrits au journal de l'établissement */
  if (req.user.superAdmin && M === 'GET' && (/^\/api\/(users|absences|audit|alerts|policies|forms)$/.test(p) || /^\/api\/sessions\//.test(p) || (p === '/api/state' && !(u.searchParams.get('since') !== null && +u.searchParams.get('since') === state.rev)))) { audit('consultation (Super Admin)', req, { chemin: p, section: 'consultation Super Admin' }); persist(); }

  /* ---- serveur et sauvegardes (administrateur) ---- */
  if (M === 'GET' && p === '/api/server/info') {
    if (!need(req, res, 'server.manage')) return;
    return json(res, 200, { version: VERSION, node: process.version, platform: process.platform, host: cfg.HOST, port: cfg.PORT, https: cfg.TLS, dataDir: C.dir, backupDir: tBackupDir(C.tenant), tenant: tenantInfo(C.tenant), logDir: cfg.LOG_DIR, uptimeSec: Math.round(process.uptime()), stateRev: state.rev, stateAt: state.at, stateBy: state.by, users: store.users.length, activeSessions: Object.keys(store.logins).length, lastBackupAt: C.lastBackupAt, backupKeep: cfg.BACKUP_KEEP, backupIntervalHours: cfg.BACKUP_INTERVAL_HOURS, allowedNetworks: cfg.ALLOWED_NETWORKS, vendorMissing: vendorMissing() });
  }
  if (p === '/api/backups') {
    if (!need(req, res, 'server.manage')) return;
    if (M === 'GET') { if (CLOUD) { try { return json(res, 200, { items: await SB.listBackups(C.key) }); } catch (e) { return fail(res, 500, e.message); } } return json(res, 200, { items: BK.list(tBackupDir(C.tenant)) }); }
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
      const op = str(b.opId, 64); if (op && C.opDone.has(op)) return json(res, 200, C.opDone.get(op));
      const mine = b.data; if (!mine || typeof mine !== 'object' || Array.isArray(mine) || !Array.isArray(mine.sessions) || !Array.isArray(mine.teachers)) return fail(res, 400, 'Données invalides');
      const mineStr = ST.stable(mine);
      // si le serveur a complété ou protégé des données (historique des groupes, journaux), le poste reçoit la version finale
      const reply = (rev, merged, data) => { const changed = data && ST.stable(data) !== mineStr; return { ok: true, rev, merged: !!(merged || changed), ...((merged || changed) ? { data: ST.viewFor(req.user, data, can) } : {}) }; };
      const baseRev = Number.isInteger(b.baseRev) ? b.baseRev : -1;
      const deleteReason = str(b.deleteReason, 300);
      /* motif de suppression obligatoire (réglage de l'établissement) : vérifié avant tout enregistrement */
      const needReason = next => { if (!(store.prefs && store.prefs.requireDeleteReason) || deleteReason.length >= 3) return null; const d = TR.deletedBetween(state.data, next); return d.length ? d : null; };
      if (b.force === true) {
        if (!can_(req, 'state.force')) return fail(res, 403, 'Seul l’administrateur peut remplacer toutes les données');
        try { await makeBackup('avant-remplacement'); } catch (e) { return fail(res, 500, 'Sauvegarde préalable impossible : remplacement annulé'); }
        const rev = commitState(mine, req, { mode: 'remplacement complet', motif: str(b.reason, 200), deleteReason: deleteReason || str(b.reason, 200) });
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
        const nr = needReason(merged); if (nr) return fail(res, 400, 'Indiquez le motif de la suppression (obligatoire dans cet établissement).', { needDeleteReason: true, deletions: nr.slice(0, 50).map(d => ({ collection: d.collection, label: TR.label(d.collection, d.record, state.data) })) });
        const rev = commitState(merged, req, { collections: ks.join(','), deleteReason }); const r = reply(rev, false, state.data); remember(op, r); return json(res, 200, r);
      }
      const preferMine = b.resolve === 'mine';
      const { data, conflicts } = ST.merge3(base, mine, state.data, W, preferMine);
      if (conflicts.length && !preferMine) { log.info('Conflit de modification détecté', { user: req.user.username, baseRev, rev: state.rev, n: conflicts.length }); return fail(res, 409, 'Des éléments ont été modifiés en même temps sur un autre poste.', { rev: state.rev, conflicts: conflicts.slice(0, 200), data: curView }); }
      if (conflicts.length) { try { await makeBackup('avant-resolution-conflit'); } catch (e) { return fail(res, 500, 'Sauvegarde préalable impossible : résolution annulée'); } }
      const ks = ST.changedKeys(state.data, data);
      if (!ks.length) { const r = { ok: true, rev: state.rev, merged: true, data: curView }; remember(op, r); return json(res, 200, r); }
      const nr = needReason(data); if (nr) return fail(res, 400, 'Indiquez le motif de la suppression (obligatoire dans cet établissement).', { needDeleteReason: true, deletions: nr.slice(0, 50).map(d => ({ collection: d.collection, label: TR.label(d.collection, d.record, state.data) })) });
      const rev = commitState(data, req, { deleteReason, collections: ks.join(','), fusion: 'depuis rév. ' + baseRev, conflitsResolus: conflicts.length ? conflicts.map(c => c.collection + ':' + (c.label || c.id)).slice(0, 20).join('; ') : undefined });
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
    const token = PF.prefixed(C.tenant.id, crypto.randomBytes(24).toString('base64url')), id = rid(8);   // préfixe = établissement (vérifié ensuite par empreinte)
    store.forms[id] = { id, tokenHash: sha(token), session, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + hrs * 3600e3).toISOString(), revokedAt: null, submittedAt: null, absenceId: null };
    audit('lien créé', req, { formId: id }); persist();
    return json(res, 200, { id, url: baseUrl(req) + '/f/' + token, expiresAt: store.forms[id].expiresAt });
  }
  if (M === 'GET' && p === '/api/forms') { if (!need(req, res, 'forms.manage')) return; return json(res, 200, { items: Object.values(store.forms).map(f => ({ id: f.id, session: pubSession(Object.assign({ sessionId: f.session.sessionId }, f.session)), sessionId: f.session.sessionId, students: f.session.students.length, createdAt: f.createdAt, expiresAt: f.expiresAt, revokedAt: f.revokedAt, submittedAt: f.submittedAt, state: formState(f) })) }); }
  m = /^\/api\/forms\/([a-f0-9]+)$/.exec(p);
  if (m && M === 'DELETE') { if (!need(req, res, 'forms.manage')) return; const f = store.forms[m[1]]; if (!f) return fail(res, 404, 'Introuvable'); f.revokedAt = f.revokedAt || new Date(nowMs()).toISOString(); audit('lien révoqué', req, { formId: f.id }); persist(); return json(res, 200, { ok: true }); }
  if (TEST_CLOCK && p === '/api/_test/clock' && M === 'POST') { let b; try { b = await body(req, 1024); } catch (e) { return fail(res, 400, 'x'); } FAKE = b.iso ? Date.parse(b.iso) : null; return json(res, 200, { now: new Date(nowMs()).toISOString() }); }
  if (M === 'GET' && p === '/api/audit') {
    if (!need(req, res, 'audit.read')) return;
    const q = AL.cleanFilter(u.searchParams), filtered = [...u.searchParams.keys()].length > 0;
    if (!filtered) { q.order = 'asc'; q.limit = 1e9; }   // compatibilité : journal complet, dans l'ordre
    const r = await auditRead(C, q, false);
    return json(res, 200, { valid: await auditValidOf(C, false), total: r.total, items: r.items });
  }
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
/* Corbeille : consultation (trash.read) et restauration (trash.restore + droit d'écrire la collection) */
async function trashApi(req, res, p, M, u) {
  const T = store.trash || (store.trash = []);
  const canSee = e => can_(req, 'trash.read') || (e.collection === 'customRoles' ? can_(req, 'users.manage') : isWritable(writable(req.user), e.collection));
  if (M === 'GET' && p === '/api/trash') {
    if (!can_(req, 'trash.read') && !writable(req.user).size) return fail(res, 403, 'Action non autorisée pour votre rôle');
    const list = TR.filter(T.filter(canSee), u.searchParams);
    return json(res, 200, { items: list.slice(0, 1000).map(TR.summary), total: list.length, types: { ...TR.SOFT, customRoles: 'Rôle personnalisé' }, canRestore: can_(req, 'trash.restore'), prefs: store.prefs || {} });
  }
  const m = /^\/api\/trash\/([a-f0-9]{16})(\/restore|\/check)?$/.exec(p); if (!m) return fail(res, 404, 'Introuvable');
  const e = T.find(x => x.id === m[1]); if (!e || !canSee(e)) return fail(res, 404, 'Élément introuvable dans la corbeille');
  if (M === 'GET' && !m[2]) return json(res, 200, { entry: { ...TR.summary(e), data: shortVals(e.data) } });
  if (M === 'GET' && m[2] === '/check') return json(res, 200, { conflicts: e.status === 'deleted' && state.data && e.collection !== 'customRoles' ? TR.restoreConflicts(e, state.data, T) : [] });
  if (M === 'POST' && m[2] === '/restore') {
    const isRole = e.collection === 'customRoles';
    if (!can_(req, 'trash.restore') || !(isRole ? can_(req, 'users.manage') : isWritable(writable(req.user), e.collection))) { audit('restauration refusée (droits)', req, { section: TR.SECTION[e.collection], record: e.label, recordId: e.recordId, corbeille: e.id }); persist(); return fail(res, 403, 'Vous n’êtes pas autorisé à restaurer cet élément.'); }
    let b; try { b = await body(req, 4096); } catch (x) { return fail(res, x.code || 400, x.msg); }
    if (e.status !== 'deleted') return fail(res, 409, 'Cet élément a déjà été restauré (' + (e.restoredAt || '').slice(0, 16).replace('T', ' ') + ', ' + (e.restoredBy || '') + ').');
    const reason = str(b.reason, 300);
    if (isRole) {
      if (store.customRoles[e.recordId]) return fail(res, 409, 'Restauration impossible tant que ces conflits ne sont pas résolus.', { conflicts: [{ type: 'doublon', message: 'Un rôle actif utilise déjà la clé ' + e.recordId + '.' }] });
      const now = new Date(nowMs()).toISOString(); store.customRoles[e.recordId] = e.data.def; ROLESX.setCustomRoles(store.customRoles);
      e.status = 'restored'; e.restoredAt = now; e.restoredBy = req.user.username; e.restoreReason = reason; e.history.push({ at: now, action: 'restauration', by: req.user.username, reason });
      audit('restauration', req, { section: 'comptes', collection: 'customRoles', record: e.label, recordId: e.recordId, corbeille: e.id, motif: reason || undefined, supprimeLe: e.deletedAt, supprimePar: e.deletedBy }); persist();
      return json(res, 200, { ok: true, entry: TR.summary(e) });
    }
    if (!state.data) return fail(res, 409, 'Aucune donnée centrale : restauration impossible.');
    const conflicts = TR.restoreConflicts(e, state.data, T);
    if (conflicts.length) { audit('restauration refusée (conflit)', req, { section: TR.SECTION[e.collection], record: e.label, recordId: e.recordId, corbeille: e.id, conflits: conflicts.map(c => c.message) }); persist(); return fail(res, 409, 'Restauration impossible tant que ces conflits ne sont pas résolus.', { conflicts }); }
    const data = JSON.parse(JSON.stringify(state.data));
    data[e.collection] = (Array.isArray(data[e.collection]) ? data[e.collection] : []).concat([JSON.parse(JSON.stringify(e.data))]);
    const now = new Date(nowMs()).toISOString();
    const rev = commitState(data, req, { mode: 'restauration depuis la corbeille', collections: e.collection, trustedHistory: e.collection === 'students' ? { [e.recordId]: e.data.groupHistory } : undefined });
    e.status = 'restored'; e.restoredAt = now; e.restoredBy = req.user.username; e.restoreReason = reason; (e.history = e.history || []).push({ at: now, action: 'restauration', by: req.user.username, reason, rev });
    audit('restauration', req, { section: TR.SECTION[e.collection], collection: e.collection, record: e.label, recordId: e.recordId, corbeille: e.id, motif: reason || undefined, supprimeLe: e.deletedAt, supprimePar: e.deletedBy, rev });
    persist();
    return json(res, 200, { ok: true, rev, entry: TR.summary(e) });
  }
  return fail(res, 405, 'Méthode non autorisée');
}
async function usersApi(req, res, p, M) {
  let m;
  {
    if (M === 'GET' && p === '/api/users') { if (!need(req, res, 'users.manage', 'users.read')) return; return json(res, 200, { items: store.users.map(x => ({ ...A.publicUser(x), sessions: Object.values(store.logins).filter(s => s.userId === x.id).length })) }); }
    if (!need(req, res, 'users.manage')) return;
    let b; if (M !== 'GET') { try { b = await body(req, 8192); } catch (e) { return fail(res, e.code || 400, e.msg); } }
    const checkFields = (o, isNew) => {
      if (o.role !== undefined && !(ROLESX.assignable(o.role) || (store.customRoles || {})[o.role])) return 'Rôle invalide';
      if (o.jobTitle !== undefined && (typeof o.jobTitle !== 'string' || o.jobTitle.length > 80)) return 'Poste invalide (80 caractères maximum)';
      if (o.email !== undefined && (typeof o.email !== 'string' || o.email.length > 120 || (o.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email.trim())))) return 'Adresse e-mail invalide';
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
      const maxU = +((C.tenant.settings || {}).maxUsers) || 0; if (maxU && store.users.filter(x => !x.disabled).length >= maxU) return fail(res, 400, 'Nombre maximal de comptes actifs atteint pour cet établissement (' + maxU + '). Contactez l’administrateur de la plateforme.');
      const now = new Date().toISOString();
      const nu = { id: rid(8), username, displayName: str(b.displayName, 80) || username, role: b.role, jobTitle: str(b.jobTitle, 80), email: str(b.email, 120), teacherId: str(b.teacherId, 60), extraPerms: b.extraPerms || [], deniedPerms: b.deniedPerms || [], disabled: false, mustChange: true, pw: await A.hashPassword(b.password, cfg.SCRYPT_N), createdAt: now, failed: 0 };
      store.users.push(nu); audit('compte créé', req, { compte: username, recordId: nu.id, roleAttribue: nu.role, poste: nu.jobTitle, enseignant: nu.teacherId }); persist();
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
      const snap = x => ({ displayName: x.displayName, role: x.role, jobTitle: x.jobTitle || '', email: x.email || '', disabled: !!x.disabled, teacherId: x.teacherId || '', extraPerms: (x.extraPerms || []).join(','), deniedPerms: (x.deniedPerms || []).join(',') });
      const before = snap(tu);
      if (b.displayName !== undefined) tu.displayName = b.displayName.trim();
      if (b.role !== undefined) tu.role = b.role;
      if (b.teacherId !== undefined) tu.teacherId = b.teacherId.trim();
      if (b.extraPerms !== undefined) tu.extraPerms = b.extraPerms;
      if (b.deniedPerms !== undefined) tu.deniedPerms = b.deniedPerms;
      if (b.disabled !== undefined) tu.disabled = !!b.disabled;
      if (b.jobTitle !== undefined) tu.jobTitle = b.jobTitle.trim();
      if (b.email !== undefined) tu.email = b.email.trim();
      tu.updatedAt = new Date().toISOString();
      let closed = 0; if (tu.disabled || before.role !== tu.role) closed = revokeSessions(tu.id);   // permissions individuelles : effet immédiat à la requête suivante
      audit(before.disabled !== !!tu.disabled ? (tu.disabled ? 'compte désactivé' : 'compte réactivé') : before.role !== tu.role || before.extraPerms !== snap(tu).extraPerms || before.deniedPerms !== snap(tu).deniedPerms ? 'compte modifié (rôle ou autorisations)' : 'compte modifié', req, { compte: tu.username, recordId: tu.id, avant: before, apres: snap(tu), motif: str(b.reason, 300) || undefined, sessionsFermees: closed }); persist();
      return json(res, 200, { ok: true, user: A.publicUser(tu) });
    }
    if (M === 'POST' && m[2] === '/reset-password') {
      const e = A.passwordProblem(b.password, tu.username); if (e) return fail(res, 400, e);
      tu.pw = await A.hashPassword(b.password, cfg.SCRYPT_N); tu.mustChange = true; tu.failed = 0; tu.lockedUntil = ''; tu.updatedAt = new Date().toISOString();
      const n = revokeSessions(tu.id); audit('mot de passe réinitialisé par l’administrateur', req, { compte: tu.username, recordId: tu.id, sessionsFermees: n }); persist();
      return json(res, 200, { ok: true });
    }
    if (M === 'POST' && m[2] === '/unlock') { tu.failed = 0; tu.lockedUntil = ''; audit('compte déverrouillé', req, { compte: tu.username, recordId: tu.id }); persist(); return json(res, 200, { ok: true }); }
    return fail(res, 405, 'Méthode non autorisée');
  }
}
/* =========================== Console Super Admin (plateforme) ===========================
   Session distincte (cookie « psid », chemin /api/platform), mot de passe renforcé, double authentification TOTP,
   verrouillage après échecs, expiration courte. Aucun compte d'établissement ne peut appeler ces routes. */
const NETS_SA = String(process.env.SUPERADMIN_NETWORKS || '').split(',').map(x => x.trim()).filter(Boolean).map(c => { const [a, b] = c.split('/'), n = ip4(a), bits = b === undefined ? 32 : +b; if (n === null || !(bits >= 0 && bits <= 32)) return null; const mask = bits ? (~0 << (32 - bits)) >>> 0 : 0; return { n: (n & mask) >>> 0, mask }; }).filter(Boolean);
const saIpOk = addr => { if (!NETS_SA.length) return true; if (addr === '::1') addr = '127.0.0.1'; const n = ip4(addr); return n !== null && NETS_SA.some(x => ((n & x.mask) >>> 0) === x.n); };
function psidOf(req) { const m = /(?:^|;\s*)psid=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; }
const pCookie = (req, token, maxAge) => `psid=${token}; HttpOnly; SameSite=Strict; Path=/api/platform; Max-Age=${maxAge}` + ((cfg.TLS || (cfg.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https')) ? '; Secure' : '');
function platformSession(req) {
  const tok = psidOf(req); if (!tok) return null;
  const h = sha(tok), s = platform.logins[h]; if (!s) return null;
  const now = Date.now(), st = platform.settings;
  if (now - s.createdAt > (st.superAdminMaxHours || 8) * 3600e3 || now - s.lastSeen > (st.superAdminIdleMinutes || 30) * 60e3 || (st.bindSuperAdminIp !== false && ip(req) !== s.ip)) { delete platform.logins[h]; persistPlatform(); return null; }
  const a = platform.admins.find(x => x.id === s.adminId); if (!a || a.disabled) { delete platform.logins[h]; persistPlatform(); return null; }
  if (now - s.lastSeen > 60e3) { s.lastSeen = now; persistPlatform(); }
  return { hash: h, admin: a };
}
/* utilisateur « virtuel » utilisé pour inscrire une action de la console dans le journal d'un établissement */
const saActor = (req, a) => ({ id: 'sa:' + a.id, username: 'superadmin.' + a.username, displayName: a.displayName + ' (Super Admin)', role: 'platform_intervene', superAdmin: true, superAdminMode: 'console', teacherId: '' });
async function withTenant(t, fn) { const prev = C; bind(await ctxOf(t)); try { return await fn(C); } finally { sync(); if (prev) bind(prev); else C = null; } }
function tenantStats(ctx) {
  const d = ctx.state.data || {}, us = ctx.store.users || [];
  return { users: us.length, activeUsers: us.filter(x => !x.disabled).length, admins: us.filter(x => x.role === 'admin' && !x.disabled).length, students: (d.students || []).length, teachers: (d.teachers || []).length, sessions: (d.sessions || []).length, absences: (ctx.store.absences || []).length, stateRev: ctx.state.rev || 0, lastChangeAt: ctx.state.at || '', lastChangeBy: ctx.state.by || '', activeSessions: Object.keys(ctx.store.logins || {}).length, trash: (ctx.store.trash || []).filter(e => e.status === 'deleted').length, lastLoginAt: us.map(x => x.lastLoginAt || '').sort().pop() || '' };
}
const emptyData = name => ({ teachers: [], rooms: [], levels: [], subjects: [], programs: [], sessions: [], volumes: [], cal: { start: '', end: '' }, students: [], templates: [], tplCats: [], notCommon: [], audit: [], cfg: { etab: name || '' } });

async function platformRoute(req, res, u) {
  const p = u.pathname.replace(/\/+$/, ''), M = req.method;
  if (!saIpOk(ip(req))) { log.warn('Console Super Admin : adresse refusée', { ip: ip(req) }); return fail(res, 403, 'Adresse non autorisée pour la console de la plateforme'); }
  if (M !== 'GET' && !sameOrigin(req)) return fail(res, 403, 'Origine refusée');
  const rd = async max => { try { return await body(req, max || 16384); } catch (e) { fail(res, e.code || 400, e.msg); return null; } };

  if (M === 'POST' && p === '/api/platform/login') {
    if (limited('plogin:' + ip(req), Math.min(cfg.LOGIN_RATE_PER_MIN, 10), 60000)) { paudit('connexion Super Admin refusée (trop de tentatives)', req, { result: 'refusé' }); persistPlatform(); return fail(res, 429, 'Trop de tentatives, réessayez dans une minute'); }
    const b = await rd(4096); if (!b) return;
    await bootstrapSuperAdmin();
    const un = str(b.username, 64).toLowerCase(), a = platform.admins.find(x => x.username === un);
    if (!a) { await A.dummyVerify(b.password, cfg.SCRYPT_N); paudit('échec connexion Super Admin', req, { username: un.slice(0, 32), motif: 'identifiant inconnu' }); persistPlatform(); return fail(res, 401, 'Identifiant ou mot de passe incorrect'); }
    if (a.lockedUntil && Date.parse(a.lockedUntil) > Date.now()) { paudit('connexion Super Admin refusée (compte verrouillé)', req, { username: un }); persistPlatform(); return fail(res, 423, 'Compte verrouillé temporairement après plusieurs échecs.'); }
    const ok = await A.verifyPassword(b.password, a.pw);
    if (!ok || a.disabled) { if (!ok) { a.failed = (a.failed || 0) + 1; if (a.failed >= Math.min(cfg.LOGIN_MAX_FAILS, 5)) { a.lockedUntil = new Date(Date.now() + Math.max(cfg.LOGIN_LOCK_MINUTES, 15) * 60e3).toISOString(); a.failed = 0; } } paudit('échec connexion Super Admin', req, { username: un, motif: ok ? 'compte désactivé' : 'mot de passe incorrect' }); persistPlatform(); return fail(res, 401, 'Identifiant ou mot de passe incorrect'); }
    if (a.totp && a.totp.enabled) {
      if (!b.totp) return fail(res, 401, 'Code de double authentification requis', { totpRequired: true });
      const step = PF.totpCheck(a.totp.secret, b.totp, Date.now(), a.totp.lastStep);
      if (step === null) { a.failed = (a.failed || 0) + 1; paudit('échec connexion Super Admin', req, { username: un, motif: 'code de double authentification incorrect' }); persistPlatform(); return fail(res, 401, 'Code de double authentification incorrect', { totpRequired: true }); }
      a.totp.lastStep = step;
    }
    a.failed = 0; a.lockedUntil = ''; a.lastLoginAt = new Date().toISOString();
    const token = A.newToken(), now = Date.now();
    platform.logins[sha(token)] = { adminId: a.id, createdAt: now, lastSeen: now, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) };
    req.admin = a; paudit('connexion Super Admin', req, { totp: !!(a.totp && a.totp.enabled) }); persistPlatform();
    return json(res, 200, { ok: true, admin: PF.publicAdmin(a) }, { 'Set-Cookie': pCookie(req, token, Math.round((platform.settings.superAdminMaxHours || 8) * 3600)) });
  }
  const ps = platformSession(req); req.admin = ps ? ps.admin : null;
  if (M === 'POST' && p === '/api/platform/logout') { if (ps) { delete platform.logins[ps.hash]; paudit('déconnexion Super Admin', req); persistPlatform(); } return json(res, 200, { ok: true }, { 'Set-Cookie': 'psid=; HttpOnly; SameSite=Strict; Path=/api/platform; Max-Age=0' }); }
  if (M === 'GET' && p === '/api/platform/me') return json(res, 200, { auth: !!ps, admin: ps ? PF.publicAdmin(ps.admin) : null, setupRequired: !platform.admins.length, platformName: platform.settings.platformName, version: VERSION });
  if (!ps) return fail(res, 401, 'Authentification Super Admin requise');
  const a = ps.admin;

  if (M === 'POST' && p === '/api/platform/password') {
    if (limited('ppw:' + a.id, 10, 600000)) return fail(res, 429, 'Trop de tentatives');
    const b = await rd(4096); if (!b) return;
    if (!(await A.verifyPassword(b.current, a.pw))) { paudit('échec changement de mot de passe Super Admin', req); persistPlatform(); return fail(res, 400, 'Mot de passe actuel incorrect'); }
    const pb = PF.superPasswordProblem(b.next, a.username); if (pb) return fail(res, 400, pb);
    if (b.next === b.current) return fail(res, 400, 'Le nouveau mot de passe doit être différent.');
    a.pw = await A.hashPassword(b.next, cfg.SCRYPT_N); a.mustChange = false; a.updatedAt = new Date().toISOString();
    for (const [h, s] of Object.entries(platform.logins)) if (s.adminId === a.id && h !== ps.hash) delete platform.logins[h];
    paudit('mot de passe Super Admin changé', req); persistPlatform(); return json(res, 200, { ok: true });
  }
  if (M === 'POST' && p === '/api/platform/totp/setup') {
    if (a.totp && a.totp.enabled) return fail(res, 400, 'La double authentification est déjà active.');
    a.totp = { secret: PF.totpSecret(), enabled: false, createdAt: new Date().toISOString() }; persistPlatform();
    return json(res, 200, { secret: a.totp.secret, uri: PF.otpauth(a.totp.secret, a.username, platform.settings.platformName) });
  }
  if (M === 'POST' && p === '/api/platform/totp/enable') {
    const b = await rd(1024); if (!b) return;
    if (!a.totp || !a.totp.secret) return fail(res, 400, 'Commencez par générer la clé.');
    const step = PF.totpCheck(a.totp.secret, b.code, Date.now(), 0); if (step === null) return fail(res, 400, 'Code incorrect : vérifiez l’heure du téléphone et réessayez.');
    a.totp.enabled = true; a.totp.lastStep = step; a.totp.enabledAt = new Date().toISOString(); paudit('double authentification Super Admin activée', req); persistPlatform(); return json(res, 200, { ok: true });
  }
  if (M === 'POST' && p === '/api/platform/totp/disable') {
    const b = await rd(2048); if (!b) return;
    if (!(await A.verifyPassword(b.password, a.pw)) || !(a.totp && a.totp.enabled && PF.totpCheck(a.totp.secret, b.code, Date.now(), 0) !== null)) { paudit('désactivation de la double authentification refusée', req); persistPlatform(); return fail(res, 400, 'Mot de passe ou code incorrect'); }
    a.totp = null; paudit('double authentification Super Admin désactivée', req); persistPlatform(); return json(res, 200, { ok: true });
  }
  if (a.mustChange) return fail(res, 403, 'Changez d’abord le mot de passe initial du compte Super Admin.', { mustChange: true });

  /* ---- paramètres globaux ---- */
  if (p === '/api/platform/settings') {
    if (M === 'GET') return json(res, 200, { settings: platform.settings });
    if (M === 'PUT') {
      const b = await rd(4096); if (!b) return;
      const st = platform.settings, before = { ...st }, n = (v, lo, hi, d) => { const x = Math.floor(+v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
      if (b.platformName !== undefined) st.platformName = str(b.platformName, 80) || 'UniTimetable';
      if (b.defaultTenantId !== undefined) { if (b.defaultTenantId && !tenantById(b.defaultTenantId)) return fail(res, 400, 'Établissement par défaut introuvable'); st.defaultTenantId = b.defaultTenantId || ''; }
      if (b.allowDefaultLogin !== undefined) st.allowDefaultLogin = !!b.allowDefaultLogin;
      if (b.bindSuperAdminIp !== undefined) st.bindSuperAdminIp = !!b.bindSuperAdminIp;
      if (b.superAdminIdleMinutes !== undefined) st.superAdminIdleMinutes = n(b.superAdminIdleMinutes, 5, 240, 30);
      if (b.superAdminMaxHours !== undefined) st.superAdminMaxHours = n(b.superAdminMaxHours, 1, 24, 8);
      if (b.workspaceMaxHours !== undefined) st.workspaceMaxHours = n(b.workspaceMaxHours, 1, 12, 2);
      paudit('paramètres de la plateforme modifiés', req, { avant: before, apres: { ...st } }); persistPlatform(); return json(res, 200, { ok: true, settings: st });
    }
  }
  if (M === 'GET' && p === '/api/platform/audit') { const q = AL.cleanFilter(u.searchParams); const r = await auditRead(null, q, true); return json(res, 200, { ...(u.searchParams.get('verify') === '1' ? { valid: await auditValidOf(null, true) } : {}), ...r }); }
  if (M === 'GET' && p === '/api/platform/roles') return json(res, 200, { roles: Object.fromEntries(Object.entries(ROLES).filter(([k]) => ROLESX.assignable(k)).map(([k, r]) => [k, { label: r.label, perms: r.perms }])), perms: PERMS, grantable: GRANTABLE });

  /* ---- corbeille de toutes les institutions (surveillance des suppressions et restaurations) ---- */
  if (M === 'GET' && p === '/api/platform/trash') {
    const only = str(u.searchParams.get('tenantId') || '', 16), out = [];
    for (const t of platform.tenants) {
      if (only && t.id !== only) continue;
      await withTenant(t, async ctx => { for (const e of TR.filter(ctx.store.trash || [], u.searchParams)) out.push({ ...TR.summary(e), tenantId: t.id, tenant: t.name, tenantSlug: t.slug }); });
    }
    out.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    paudit('corbeille des établissements consultée', req, { filtres: Object.fromEntries(u.searchParams) }); persistPlatform();
    return json(res, 200, { items: out.slice(0, 2000), total: out.length, types: { ...TR.SOFT, customRoles: 'Rôle personnalisé' } });
  }
  /* ---- établissements ---- */
  if (p === '/api/platform/tenants' && M === 'GET') return json(res, 200, { items: platform.tenants.map(PF.publicTenant), defaultTenantId: platform.settings.defaultTenantId, statuses: PF.STATUSES, today: today() });
  if (p === '/api/platform/tenants' && M === 'POST') {
    const b = await rd(16384); if (!b) return;
    const f = PF.cleanTenantFields(b); if (!f.name) return fail(res, 400, 'Le nom de l’établissement est obligatoire');
    const slug = str(b.slug, 40).toLowerCase() || PF.slugify(f.shortName || f.name), sp = PF.slugProblem(slug, platform.tenants); if (sp) return fail(res, 400, sp);
    const ad = b.admin || {}, aun = str(ad.username, 40).toLowerCase();
    if (!A.USERNAME_RE.test(aun)) return fail(res, 400, 'Identifiant de l’administrateur de l’établissement invalide : 3 à 32 caractères (minuscules, chiffres, . _ -)');
    const apb = A.passwordProblem(ad.password, aun); if (apb) return fail(res, 400, 'Mot de passe de l’administrateur : ' + apb);
    for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
    const t = PF.newTenant({ ...f, slug }, a.username);
    platform.tenants.push(t);
    const now = new Date().toISOString();
    await withTenant(t, async () => {
      store.users.push({ id: rid(8), username: aun, displayName: str(ad.displayName, 80) || 'Administrateur', role: 'admin', jobTitle: str(ad.jobTitle, 80) || 'Administrateur de l’établissement', email: str(ad.email, 120), teacherId: '', extraPerms: [], deniedPerms: [], disabled: false, mustChange: true, pw: await A.hashPassword(ad.password, cfg.SCRYPT_N), createdAt: now, failed: 0 });
      state = { rev: 1, at: now, by: 'superadmin.' + a.username, data: emptyData(t.name) }; sync(); persistState(); saveHistory(1, state.data);
      audit('établissement créé par le Super Admin', { user: saActor(req, a), headers: req.headers, socket: req.socket }, { etablissement: t.name, code: t.slug });
      audit('compte créé', { user: saActor(req, a), headers: req.headers, socket: req.socket }, { compte: aun, roleAttribue: 'admin', poste: 'Administrateur de l’établissement' });
      persist();
    });
    paudit('établissement créé', req, { tenantId: t.id, etablissement: t.name, code: t.slug, administrateur: aun }); persistPlatform();
    return json(res, 200, { ok: true, tenant: PF.publicTenant(t) });
  }
  let m = /^\/api\/platform\/tenants\/([a-f0-9]{16})(\/.*)?$/.exec(p);
  if (!m) return fail(res, 404, 'Introuvable');
  const t = tenantById(m[1]); if (!t) return fail(res, 404, 'Établissement introuvable');
  const sub = m[2] || '';
  if (sub === '' && M === 'GET') return withTenant(t, async ctx => json(res, 200, { tenant: PF.publicTenant(t), stats: tenantStats(ctx), isDefault: platform.settings.defaultTenantId === t.id }));
  if (sub === '' && M === 'PUT') {
    const b = await rd(16384); if (!b) return;
    const f = PF.cleanTenantFields(b, t); for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
    if (f.name !== undefined && !f.name) return fail(res, 400, 'Le nom est obligatoire');
    if (b.slug !== undefined && b.slug !== t.slug) { const slug = str(b.slug, 40).toLowerCase(), sp = PF.slugProblem(slug, platform.tenants, t.id); if (sp) return fail(res, 400, sp); f.slug = slug; }
    const before = PF.publicTenant(t); Object.assign(t, f, { updatedAt: new Date().toISOString() });
    paudit('établissement modifié', req, { tenantId: t.id, etablissement: t.name, avant: { name: before.name, nameAr: before.nameAr, slug: before.slug, subscription: before.subscription, settings: before.settings, contact: before.contact }, apres: { name: t.name, nameAr: t.nameAr, slug: t.slug, subscription: t.subscription, settings: t.settings, contact: t.contact } }); persistPlatform();
    await withTenant(t, async () => { audit('établissement modifié par le Super Admin', { user: saActor(req, a), headers: req.headers, socket: req.socket }, { champs: Object.keys(f).join(',') }); persist(); });
    return json(res, 200, { ok: true, tenant: PF.publicTenant(t) });
  }
  if (sub === '/status' && M === 'POST') {
    const b = await rd(4096); if (!b) return;
    if (!PF.STATUSES[b.status]) return fail(res, 400, 'Statut invalide');
    const reason = str(b.reason, 300); if (reason.length < 3) return fail(res, 400, 'Le motif est obligatoire');
    if (b.status === t.status) return json(res, 200, { ok: true, tenant: PF.publicTenant(t) });
    const from = t.status; t.status = b.status; t.updatedAt = new Date().toISOString(); (t.statusHistory = t.statusHistory || []).push({ at: t.updatedAt, by: a.username, from, to: b.status, reason });
    let closed = 0;
    await withTenant(t, async () => { if (b.status !== 'active') { closed = Object.keys(store.logins).length; store.logins = {}; } audit('statut de l’établissement : ' + PF.STATUSES[from] + ' → ' + PF.STATUSES[b.status], { user: saActor(req, a), headers: req.headers, socket: req.socket }, { motif: reason, sessionsFermees: closed }); persist(); });
    paudit('statut d’établissement modifié', req, { tenantId: t.id, etablissement: t.name, ancien: from, nouveau: b.status, motif: reason, sessionsFermees: closed }); persistPlatform();
    return json(res, 200, { ok: true, tenant: PF.publicTenant(t) });
  }
  if (sub === '/audit' && M === 'GET') {
    const q = AL.cleanFilter(u.searchParams);
    return withTenant(t, async ctx => { const r = await auditRead(ctx, q, false); const v = u.searchParams.get('verify') === '1' ? { valid: await auditValidOf(ctx, false) } : {}; paudit('journal d’un établissement consulté', req, { tenantId: t.id, etablissement: t.name, filtres: q.f }); persistPlatform(); return json(res, 200, { ...v, ...r }); });
  }
  m = /^\/users\/([a-f0-9]{16})\/activity$/.exec(sub);
  if (m && M === 'GET') {
    return withTenant(t, async ctx => {
      const usr = ctx.store.users.find(x => x.id === m[1]); if (!usr) return fail(res, 404, 'Compte introuvable');
      const q = AL.cleanFilter(u.searchParams); q.f.user = usr.username; if (!u.searchParams.get('order')) q.order = 'asc';
      const r = await auditRead(ctx, q, false);
      paudit('historique d’activité d’un utilisateur consulté', req, { tenantId: t.id, etablissement: t.name, compte: usr.username }); persistPlatform();
      return json(res, 200, { user: A.publicUser(usr), ...r });
    });
  }
  if (sub === '/users' || sub.startsWith('/users/')) {
    return withTenant(t, async () => {
      if (M !== 'GET') { paudit('compte d’établissement géré par le Super Admin', req, { tenantId: t.id, etablissement: t.name, action: M + ' ' + sub }); persistPlatform(); }
      req.user = saActor(req, a);
      try { return await usersApi(req, res, '/api' + sub, M); } finally { req.user = null; }
    });
  }
  if (sub.startsWith('/trash/')) {
    return withTenant(t, async () => {
      if (M === 'POST') { paudit('restauration demandée par le Super Admin', req, { tenantId: t.id, etablissement: t.name, element: sub }); persistPlatform(); }
      req.user = saActor(req, a);
      try { return await trashApi(req, res, '/api' + sub, M, u); } finally { req.user = null; }
    });
  }
  if (sub === '/enter' && M === 'POST') {
    const b = await rd(2048); if (!b) return;
    const mode = b.mode === 'intervene' ? 'intervene' : 'view', reason = str(b.reason, 300);
    if (mode === 'intervene' && reason.length < 5) return fail(res, 400, 'Le motif de l’intervention est obligatoire (5 caractères minimum).');
    let cookie = '';
    await withTenant(t, async () => {
      const token = PF.prefixed(t.id, A.newToken()), now = Date.now();
      store.logins[sha(token)] = { userId: 'sa:' + a.id, superAdmin: a.id, mode, reason, createdAt: now, lastSeen: now, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) };
      const r2 = { user: superUser({ superAdmin: a.id, mode, reason }), headers: req.headers, socket: req.socket };
      audit(mode === 'intervene' ? 'entrée du Super Admin dans l’espace (intervention)' : 'entrée du Super Admin dans l’espace (consultation)', r2, { motif: reason || undefined, section: 'consultation Super Admin' }); persist();
      cookie = cookieFor(req, token, Math.round((platform.settings.workspaceMaxHours || 2) * 3600));
    });
    paudit(mode === 'intervene' ? 'entrée dans l’espace d’un établissement (intervention)' : 'entrée dans l’espace d’un établissement (consultation)', req, { tenantId: t.id, etablissement: t.name, motif: reason || undefined }); persistPlatform();
    return json(res, 200, { ok: true, url: '/', mode }, { 'Set-Cookie': cookie });
  }
  return fail(res, 404, 'Introuvable');
}
function meOf(u) { return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, roleLabel: (ROLESX.roleDef(u.role) || {}).label || u.role, jobTitle: u.jobTitle || '', superAdmin: !!u.superAdmin, superAdminMode: u.superAdminMode || '', reason: u.superAdmin ? u.reason || '' : undefined, teacherId: u.teacherId || '', perms: permsOf(u), writable: [...writable(u)], mustChange: !!u.mustChange }; }
const INDEX_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PLATFORM_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const fileCache = new Map();
async function readPub(rel) { if (CLOUD && fileCache.has(rel)) return fileCache.get(rel); const d = await fs.promises.readFile(path.join(PUB, rel)); if (CLOUD) fileCache.set(rel, d); return d; }
async function file(res, name, extra) { let d; try { d = await readPub(name); } catch (e) { return fail(res, 404, 'Fichier manquant : ' + name); } send(res, 200, d, 'text/html; charset=utf-8', extra); }
async function vendor(res, name) {
  let d; try { d = await readPub(path.join('vendor', path.basename(name))); } catch (e) { return fail(res, 404, 'Introuvable'); }
  send(res, 200, d, 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
}

/* ----- serveur HTTP / HTTPS : une requête à la fois (le contexte d'établissement est partagé) ----- */
let localQueue = Promise.resolve();
function serial(fn) { const p = localQueue.then(fn, fn); localQueue = p.catch(() => { }); return p; }
const STATIC_RE = /^\/(index\.html|UniTimetable\.html|platform\/?|favicon\.ico|vendor\/[a-z0-9._-]+\.js|f\/[A-Za-z0-9_-]+)?$/;
function handler(req, res) {
  const t0 = Date.now(), addr = ip(req);
  res.on('finish', () => { if (req.url !== '/health' && !(req.url || '').startsWith('/api/state?since=') && !(req.url || '').startsWith('/vendor/')) log.info(req.method + ' ' + log.redactPath(req.url) + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms', { ip: addr, user: req.user ? req.user.username : (req.admin ? 'superadmin.' + req.admin.username : undefined) }); else if (res.statusCode >= 400) log.warn(req.method + ' ' + log.redactPath(req.url) + ' ' + res.statusCode, { ip: addr }); });
  if (!allowedIp(addr)) { log.warn('Requête refusée : adresse hors des réseaux autorisés', { ip: addr }); return fail(res, 403, 'Adresse non autorisée'); }
  const err = e => { log.error('Erreur interne', { err: e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e), path: log.redactPath(req.url) }); if (!res.headersSent) fail(res, 500, 'Erreur serveur'); };
  const pth = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && STATIC_RE.test(pth)) return route(req, res).catch(err);   // fichiers : sans attente
  serial(async () => { C = null; try { await route(req, res); } finally { sync(); C = null; } }).catch(err);
}
/* tâches périodiques, pour chaque établissement actif (dans la file d'attente) */
function forEachTenant(fn) {
  return serial(async () => {
    for (const t of platform.tenants) {
      if (t.status === 'disabled') continue;
      try { bind(loadCtxLocal(t)); await fn(t); } catch (e) { log.error('Tâche périodique (' + t.slug + ')', { err: e.message }); } finally { sync(); C = null; }
    }
  });
}
function purgePlatformLogins() { const now = Date.now(), st = platform.settings; let ch = false; for (const [h, s] of Object.entries(platform.logins)) if (now - s.createdAt > (st.superAdminMaxHours || 8) * 3600e3 || now - s.lastSeen > (st.superAdminIdleMinutes || 30) * 60e3) { delete platform.logins[h]; ch = true; } if (ch) persistPlatform(); }
if (!CLOUD) {
  setInterval(() => forEachTenant(() => { runAlerts(); }), cfg.ALERT_INTERVAL_MS).unref();
  setInterval(() => { forEachTenant(() => purgeLogins()); serial(async () => purgePlatformLogins()); }, 5 * 60e3).unref();
  setInterval(() => { forEachTenant(() => autoBackup(false)); serial(async () => platformBackup(false)); }, 15 * 60e3).unref();
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
  /* plateforme : registre des établissements (créé au premier démarrage de cette version) */
  const hadPlatform = fs.existsSync(PLATFORM_FILE);
  try { platform = PF.normalize(readJson(PLATFORM_FILE, null, log) || PF.emptyPlatform()); } catch (e) { log.error(e.message); releaseLock(); process.exit(4); }
  if (!hadPlatform) {
    const legacyState = readJson(path.join(DATA, 'state.json'), {}, log) || {}, legacyHasData = fs.existsSync(path.join(DATA, 'store.json')) || fs.existsSync(path.join(DATA, 'state.json'));
    if (legacyHasData) { try { BK.create(DATA, cfg.BACKUP_DIR, 'avant-multi-etablissements', 0); } catch (e) { log.error('Sauvegarde préalable impossible : ' + e.message); releaseLock(); process.exit(6); } }
    ensurePlatform(((legacyState.data || {}).cfg || {}).etab);
    persistPlatform();
    log.info('Plateforme multi-établissements initialisée : « ' + platform.tenants[0].name + ' » (code ' + platform.tenants[0].slug + ').');
  } else if (ensurePlatform((((readJson(path.join(DATA, 'state.json'), {}, log) || {}).data || {}).cfg || {}).etab)) persistPlatform();
  await bootstrapSuperAdmin();
  if (!platform.admins.length) log.warn('Aucun compte Super Admin. Pour administrer la plateforme (console /platform) : node tools/create-superadmin.js');
  for (const t of platform.tenants) {
    bind(loadCtxLocal(t));
    runMigrations();
    if (!C.lastBackupAt && fs.existsSync(path.join(C.dir, 'store.json'))) autoBackup(true, 'premier-demarrage');   // copie des données existantes avant toute écriture de cette version
    await bootstrapAdmin();
    autoBackup(false);
    sync(); C = null;
  }
  platformBackup(false);
  server.listen(cfg.PORT, cfg.HOST, () => {
    try { fs.writeFileSync(CONTROL, CONTROL_TOKEN, { mode: 0o600 }); } catch (e) { log.warn('Jeton de contrôle local non écrit', { err: e.message }); }
    const proto = cfg.TLS ? 'https' : 'http';
    const nets = Object.values(require('os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => proto + '://' + n.address + ':' + cfg.PORT);
    log.always('Serveur UniTimetable ' + VERSION + ' démarré : ' + proto + '://localhost:' + cfg.PORT + '  (écoute ' + cfg.HOST + ', données : ' + DATA + ')');
    if (nets.length) log.info('Adresses pour les postes clients : ' + nets.join('  '));
    if (!cfg.TLS) log.warn('HTTP sans chiffrement : à réserver à un réseau local de confiance. Voir README-LOCAL-WINDOWS.md (section HTTPS).');
    forEachTenant(() => runAlerts());   // première vérification immédiate
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
  /* 1. plateforme (registre des établissements) ; 2. établissement de la requête, chargé à la demande (ctxOf) */
  const r = await SB.load(['platform'], ['platform']);
  const pd = r.docs.platform;
  platform = PF.normalize(pd ? pd.data : PF.emptyPlatform());
  REQ = { ctxs: new Map(), platformVersion: pd ? pd.version : 0, platformDirty: !pd };
  PAUDIT.pending = []; PAUDIT.last = r.last.platform || AL.GENESIS;
  C = null; loginsDirty = false; opPending.length = 0;
  if (!pd) {   // première requête de cette version : les données existantes deviennent le premier établissement
    ensurePlatform();
    const lt = legacyTenant(), lc = await loadCtxCloud(lt);
    const nm = lc.state.data && lc.state.data.cfg && lc.state.data.cfg.etab; if (nm) lt.name = nm;
    if (lc.store.users.length || lc.state.data) { bind(lc); makeBackup('avant-multi-etablissements'); sync(); C = null; }
  }
  await bootstrapSuperAdmin();
  const res = new BufRes();
  if (!allowedIp(ip(req))) fail(res, 403, 'Adresse non autorisée'); else await route(req, res);
  if (loginsDirty && C) { C.dirty.store = true; } loginsDirty = false;
  sync();
  /* sauvegardes demandées : copie AVANT l'enregistrement */
  for (const ctx of REQ.ctxs.values()) for (const why of ctx.backups) { try { await SB.backup(ctx.key, why, cfg.BACKUP_KEEP); } catch (e) { log.error('Sauvegarde Supabase impossible', { err: e.message }); } }
  /* enregistrement atomique : documents modifiés + journal d'audit (plateforme et établissements) + historique */
  const docs = [], aud = [], hist = [];
  if (REQ.platformDirty) docs.push({ id: 'platform', data: platform, version: REQ.platformVersion });
  for (const e of PAUDIT.pending) aud.push({ tenant: 'platform', entry: e });
  for (const ctx of REQ.ctxs.values()) {
    if (ctx.dirty.store) docs.push({ id: SB.docId('store', ctx.key), data: ctx.store, version: ctx.ver.store });
    if (ctx.dirty.state) docs.push({ id: SB.docId('state', ctx.key), data: ctx.state, version: ctx.ver.state });
    for (const e of ctx.auditPending) aud.push({ tenant: ctx.key, entry: e });
    if (ctx.hist) hist.push({ tenant: ctx.key, rev: ctx.hist.rev, data: ctx.hist.data, keep: cfg.HISTORY_KEEP });
  }
  if (docs.length || aud.length || hist.length) {
    for (let i = 1; i < hist.length; i++) await SB.saveDocs({ docs: [], audit: [], hist: hist[i] });   // cas rare : plusieurs établissements modifiés
    await SB.saveDocs({ docs, audit: aud, hist: hist[0] || null });
  }
  for (const [ctx, op, rr] of opPending.splice(0)) { ctx.opDone.set(op, rr); if (ctx.opDone.size > 500) ctx.opDone.delete(ctx.opDone.keys().next().value); }
  C = null; REQ = null;
  return res;
}
let cloudQueue = Promise.resolve();
function cloudHandler(req, res) {
  const run = async () => {
    const t0 = Date.now();
    let out;
    const pth = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && (pth === '/' || pth === '/index.html' || pth === '/platform' || pth === '/platform/' || pth === '/favicon.ico' || pth === '/api/ping' || /^\/(vendor|f)\//.test(pth))) {   // fichiers et ping : aucun accès à la base
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

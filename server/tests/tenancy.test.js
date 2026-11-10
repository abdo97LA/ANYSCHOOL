/* Plateforme multi-établissements : isolation stricte des données, Super Admin, journal d'audit séparé.
   node tests/tenancy.test.js                         (mode fichiers : serveur local)
   PG="-h … -p … -U …" node tests/tenancy.test.js     (en plus : mode cloud, Supabase simulé sur un VRAI PostgreSQL) */
'use strict';
const fs = require('fs'), cp = require('child_process'), path = require('path'), os = require('os');
const PF = require('../lib/platform'), AL = require('../lib/auditlog');
const DIR = path.join(__dirname, '..');
const PG = (process.env.PG || '').split(' ').filter(Boolean);
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = []; process.on('exit', () => procs.forEach(p => { try { p.kill(); } catch (e) { } }));
function spawnWait(args, env, re) {
  return new Promise((res, rej) => { const p = cp.spawn(process.execPath, args, { cwd: DIR, env: { ...process.env, ...env } }); procs.push(p); let o = ''; const on = d => { o += d; if (re.test(o)) res(p); }; p.stdout.on('data', on); p.stderr.on('data', on); setTimeout(() => rej(new Error('timeout ' + o)), 15000); });
}
const SA = { u: 'proprietaire', p0: 'Initial-Proprio-2026!x', p: 'Plateforme-Forte-2026!' };
/* client HTTP avec ses propres cookies (sid = établissement, psid = console Super Admin) */
function client(base) {
  const c = { jar: {} };
  c.h = async (m, p, b, hd) => {
    const ck = Object.entries(c.jar).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
    const r = await fetch(base + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(ck ? { Cookie: ck } : {}), ...(hd || {}) }, body: b ? JSON.stringify(b) : undefined });
    for (const sc of (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean))) { const [kv] = sc.split(';'); const i = kv.indexOf('='); c.jar[kv.slice(0, i)] = kv.slice(i + 1); }
    let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j };
  };
  c.login = (u, p, etab) => c.h('POST', '/api/login', { username: u, password: p, ...(etab !== undefined ? { etab } : {}) });
  c.salogin = (u, p, totp) => c.h('POST', '/api/platform/login', { username: u, password: p, ...(totp ? { totp } : {}) });
  return c;
}
const data = (tag) => ({ teachers: [{ id: 't1', name: 'Prof ' + tag }], rooms: [{ id: 'r1', name: 'Salle ' + tag }], levels: [], programs: [{ id: 'p', name: 'IP' }], subjects: [{ id: 's1', name: 'Matière ' + tag }],
  sessions: [{ id: 'se1', subjectId: 's1', teacherId: 't1', roomId: 'r1', date: '2026-06-15', startTime: '08:00', endTime: '10:00', programId: 'p', year: '1', group: 'G1' }],
  students: [{ id: 'st1', matricule: 'M-' + tag, lastName: 'Etudiant' + tag, firstName: 'X', programId: 'p', year: '1', group: 'G1' }], volumes: [], cal: { start: '', end: '' }, absences: [], templates: [], tplCats: [], cfg: { etab: tag }, audit: [], events: [], notCommon: [] });
const totpNow = secret => PF.hotp(secret, Math.floor(Date.now() / 30000));
const totpNext = secret => PF.hotp(secret, Math.floor(Date.now() / 30000) + 1);

async function scenario(mode, startServer, extra) {
  const L = s => mode + ' : ' + s;
  let srv = await startServer();
  const base = srv.base;
  let r;
  const anon = client(base);
  r = await fetch(base + '/health').then(x => x.json());
  ok(L('premier démarrage : un premier établissement est créé automatiquement, compte Super Admin initial présent'), r.tenants === 1 && r.superAdmin === true, r);

  /* ---------- Super Admin : connexion protégée ---------- */
  const sa = client(base);
  r = await sa.salogin(SA.u, 'mauvais'); ok(L('Super Admin : mauvais mot de passe refusé'), r.s === 401);
  r = await sa.salogin(SA.u, SA.p0); ok(L('Super Admin : connexion'), r.s === 200 && r.j.admin.mustChange === true, r);
  r = await sa.h('GET', '/api/platform/tenants'); ok(L('Super Admin : mot de passe initial à changer avant tout accès'), r.s === 403 && r.j.mustChange === true);
  r = await sa.h('POST', '/api/platform/password', { current: SA.p0, next: 'court' }); ok(L('Super Admin : mot de passe faible refusé (14 caractères, 3 types)'), r.s === 400);
  r = await sa.h('POST', '/api/platform/password', { current: SA.p0, next: SA.p }); ok(L('Super Admin : mot de passe changé'), r.s === 200, r.j);
  r = await sa.h('POST', '/api/platform/totp/setup'); const secret = r.j && r.j.secret;
  ok(L('Super Admin : clé de double authentification générée (otpauth)'), r.s === 200 && /^otpauth:\/\/totp\//.test(r.j.uri));
  r = await sa.h('POST', '/api/platform/totp/enable', { code: '000000' }); ok(L('Super Admin : code TOTP faux refusé'), r.s === 400);
  r = await sa.h('POST', '/api/platform/totp/enable', { code: totpNow(secret) }); ok(L('Super Admin : double authentification activée'), r.s === 200, r.j);
  const sa2 = client(base);
  r = await sa2.salogin(SA.u, SA.p); ok(L('Super Admin : sans code TOTP, connexion refusée'), r.s === 401 && r.j.totpRequired === true);
  r = await sa2.salogin(SA.u, SA.p, totpNow(secret)); ok(L('Super Admin : code TOTP déjà utilisé refusé (rejeu)'), r.s === 401);
  r = await sa2.salogin(SA.u, SA.p, totpNext(secret)); ok(L('Super Admin : connexion avec double authentification'), r.s === 200, r.j);

  /* ---------- établissements ---------- */
  r = await sa.h('GET', '/api/platform/tenants'); const legacy = r.j.items[0];
  ok(L('le premier établissement reprend les données existantes (code « principal »)'), r.j.items.length === 1 && legacy.slug === 'principal' && legacy.legacy === true);
  const mk = (name, slug, admin) => sa.h('POST', '/api/platform/tenants', { name, slug, nameAr: 'مؤسسة ' + slug, contact: { email: slug + '@ex.ma' }, subscription: { plan: 'standard', endsAt: '' }, settings: { maxUsers: 3 }, admin: { username: admin, displayName: 'Admin ' + slug, password: 'Temporaire-' + slug + '-2026' } });
  r = await mk('Faculté Alpha', 'alpha', 'admin'); const TA = r.j && r.j.tenant; ok(L('Super Admin : création de l’établissement Alpha avec son administrateur'), r.s === 200 && TA && TA.id && TA.status === 'active', r.j);
  r = await mk('École Beta', 'beta', 'admin'); const TB = r.j && r.j.tenant; ok(L('Super Admin : création de l’établissement Beta (même identifiant « admin » que Alpha : comptes indépendants)'), r.s === 200 && TB && TB.id !== TA.id, r.j);
  r = await mk('Doublon', 'alpha', 'x.admin'); ok(L('code d’établissement en double refusé'), r.s === 400);
  r = await mk('Réservé', 'platform', 'x.admin'); ok(L('code d’établissement réservé refusé'), r.s === 400);

  /* ---------- administrateurs d'établissement ---------- */
  const a = client(base), b = client(base);
  r = await a.login('admin', 'Temporaire-alpha-2026', 'alpha'); ok(L('admin Alpha : connexion avec le code d’établissement'), r.s === 200, r.j);
  await a.h('POST', '/api/account/password', { current: 'Temporaire-alpha-2026', next: 'Alpha-Definitif-2026' });
  r = await b.login('admin', 'Temporaire-alpha-2026', 'beta'); ok(L('le mot de passe d’Alpha ne fonctionne pas pour le compte « admin » de Beta'), r.s === 401);
  r = await b.login('admin', 'Temporaire-beta-2026', 'beta'); ok(L('admin Beta : connexion'), r.s === 200);
  await b.h('POST', '/api/account/password', { current: 'Temporaire-beta-2026', next: 'Beta-Definitif-2026' });
  r = await a.h('GET', '/api/state'); ok(L('nouvel établissement : données initiales vides (aucune donnée d’un autre établissement)'), r.s === 200 && r.j.data && r.j.data.students.length === 0 && r.j.data.cfg.etab === 'Faculté Alpha', r.j);
  r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: data('ALPHA') }); ok(L('admin Alpha : enregistre ses données'), r.s === 200, r.j);
  r = await b.h('GET', '/api/state'); r = await b.h('PUT', '/api/state', { baseRev: r.j.rev, data: data('BETA') }); ok(L('admin Beta : enregistre ses données'), r.s === 200, r.j);
  r = await b.h('GET', '/api/state'); ok(L('ISOLATION : Beta ne voit que ses étudiants'), r.j.data.students.length === 1 && r.j.data.students[0].matricule === 'M-BETA' && !JSON.stringify(r.j.data).includes('ALPHA'));
  r = await a.h('GET', '/api/state'); ok(L('ISOLATION : Alpha ne voit que ses étudiants'), r.j.data.students[0].matricule === 'M-ALPHA' && !JSON.stringify(r.j.data).includes('BETA'));
  r = await b.h('GET', '/api/users'); ok(L('ISOLATION : Beta ne voit que ses comptes'), r.j.items.length === 1 && r.j.items[0].username === 'admin');
  r = await b.h('GET', '/api/audit'); ok(L('ISOLATION : le journal de Beta ne contient aucun événement d’Alpha'), r.j.valid === true && r.j.items.length > 0 && r.j.items.every(e => e.tenantId === TB.id || !e.tenantId) && !JSON.stringify(r.j.items).includes('ALPHA'), r.j.items && r.j.items.slice(-3));

  /* tentatives d'accès croisé */
  const tokB = b.jar.sid, forged = client(base); forged.jar.sid = TA.id + tokB.slice(16);
  r = await forged.h('GET', '/api/state'); ok(L('ISOLATION : jeton de Beta présenté avec le préfixe d’Alpha → refusé'), r.s === 401);
  forged.jar.sid = tokB.slice(16); r = await forged.h('GET', '/api/state'); ok(L('ISOLATION : jeton de Beta sans préfixe (ancien format = premier établissement) → refusé'), r.s === 401);
  r = await b.h('PUT', '/api/state?tenantId=' + TA.id, { baseRev: 0, tenantId: TA.id, data: data('PIRATE') });
  r = await a.h('GET', '/api/state'); ok(L('ISOLATION : un tenantId envoyé par le navigateur est ignoré (Alpha intact)'), !JSON.stringify(r.j.data).includes('PIRATE'));
  r = await b.h('GET', '/api/platform/tenants'); ok(L('admin d’établissement : aucune route Super Admin accessible'), r.s === 401);
  r = await b.h('POST', '/api/users', { username: 'x.pirate', displayName: 'X', role: 'platform_intervene', password: 'Pirate-Pirate-2026' }); ok(L('admin d’établissement : rôle Super Admin non attribuable'), r.s === 400);
  r = await b.h('POST', '/api/platform/tenants', { name: 'X', slug: 'xx', admin: {} }); ok(L('admin d’établissement : ne peut pas créer d’établissement'), r.s === 401);

  /* comptes employés, rôles, limite */
  r = await b.h('POST', '/api/users', { username: 'k.finance', displayName: 'Karim Finance', jobTitle: 'Comptable', email: 'k@beta.ma', role: 'finance', password: 'Finance-Beta-2026' });
  const uFin = r.j && r.j.user; ok(L('admin Beta : compte employé avec poste, e-mail et rôle Finance'), r.s === 200 && uFin.jobTitle === 'Comptable' && uFin.email === 'k@beta.ma', r.j);
  r = await b.h('PUT', '/api/roles/custom/c_secretariat', { label: 'Secrétariat', perms: ['state.read', 'absences.read'] }); ok(L('admin Beta : rôle personnalisé créé'), r.s === 200, r.j);
  r = await b.h('PUT', '/api/roles/custom/c_pirate', { label: 'Pirate', perms: ['users.manage'] }); ok(L('rôle personnalisé : droits d’administration refusés'), r.s === 400);
  r = await b.h('POST', '/api/users', { username: 'n.secret', displayName: 'Nadia', role: 'c_secretariat', password: 'Secret-Beta-2026x' }); const uSec = r.j && r.j.user;
  ok(L('compte avec rôle personnalisé'), r.s === 200, r.j);
  r = await a.h('POST', '/api/users', { username: 'n.secret', displayName: 'Nadia', role: 'c_secretariat', password: 'Secret-Alpha-2026x' }); ok(L('ISOLATION : le rôle personnalisé de Beta n’existe pas chez Alpha'), r.s === 400);
  const ns = client(base); await ns.login('n.secret', 'Secret-Beta-2026x', 'beta'); await ns.h('POST', '/api/account/password', { current: 'Secret-Beta-2026x', next: 'Secret-Beta-2026-ok' });
  r = await ns.h('GET', '/api/me'); ok(L('rôle personnalisé : autorisations appliquées par le serveur'), r.j.user.perms.includes('state.read') && !r.j.user.perms.includes('users.manage') && r.j.user.roleLabel === 'Secrétariat', r.j.user);
  r = await ns.h('GET', '/api/users'); ok(L('rôle personnalisé : pas d’accès aux comptes'), r.s === 403);
  r = await b.h('POST', '/api/users', { username: 'trop', displayName: 'Trop', role: 'scolarite', password: 'Beta-Limite-2026xx' }); ok(L('limite de comptes actifs de l’établissement (3) appliquée'), r.s === 400 && /maximal/.test(r.j.error));
  r = await b.h('PUT', '/api/users/' + uFin.id, { jobTitle: 'Chef comptable', role: 'direction', reason: 'promotion' }); ok(L('admin Beta : modification d’un compte (poste, rôle)'), r.s === 200);

  /* informations de l'établissement */
  r = await b.h('PUT', '/api/institution', { name: 'École Beta Supérieure', nameAr: 'المدرسة بيتا', status: 'disabled', subscription: { endsAt: '2000-01-01' } });
  ok(L('admin Beta : modifie le nom de son établissement'), r.s === 200 && r.j.tenant.name === 'École Beta Supérieure' && r.j.tenant.status === 'active' && r.j.tenant.subscription.endsAt === '', r.j);
  r = await ns.h('PUT', '/api/institution', { name: 'Pirate' }); ok(L('un employé sans autorisation ne peut pas modifier l’établissement'), r.s === 403);

  /* liens de déclaration : préfixe d'établissement */
  r = await b.h('POST', '/api/forms', { session: { sessionId: 'se1', teacherId: 't1', subject: 'Matière BETA', teacher: 'Prof BETA', date: '2026-06-15', start: '08:00', end: '10:00', students: [{ m: 'M-BETA', n: 'EtudiantBETA X' }] } });
  const ftok = r.j && r.j.url && r.j.url.split('/f/')[1]; ok(L('lien de déclaration : jeton préfixé par l’établissement'), r.s === 200 && ftok && ftok.startsWith(TB.id), r.j);
  r = await anon.h('GET', '/api/form/' + ftok); ok(L('lien de Beta : fonctionne'), r.s === 200 && r.j.session.subject === 'Matière BETA');
  r = await anon.h('GET', '/api/form/' + TA.id + ftok.slice(16)); ok(L('ISOLATION : lien de Beta avec le préfixe d’Alpha → invalide'), r.s === 404);

  /* ---------- suspension / abonnement ---------- */
  r = await sa.h('POST', '/api/platform/tenants/' + TB.id + '/status', { status: 'suspended' }); ok(L('suspension : motif obligatoire'), r.s === 400);
  r = await sa.h('POST', '/api/platform/tenants/' + TB.id + '/status', { status: 'suspended', reason: 'Facture impayée' }); ok(L('Super Admin : établissement suspendu'), r.s === 200 && r.j.tenant.status === 'suspended');
  r = await b.h('GET', '/api/state'); ok(L('suspendu : les sessions ouvertes sont refusées'), r.s === 401 || r.s === 403);
  r = await b.login('admin', 'Beta-Definitif-2026', 'beta'); ok(L('suspendu : connexion refusée avec un message clair'), r.s === 403 && /suspendu/.test(r.j.error), r.j);
  r = await anon.h('GET', '/api/form/' + ftok); ok(L('suspendu : liens de déclaration fermés'), r.s === 410);
  r = await a.h('GET', '/api/state'); ok(L('la suspension de Beta n’affecte pas Alpha'), r.s === 200);
  r = await sa.h('POST', '/api/platform/tenants/' + TB.id + '/status', { status: 'active', reason: 'Paiement reçu' });
  r = await b.login('admin', 'Beta-Definitif-2026', 'beta'); ok(L('réactivé : connexion de nouveau possible'), r.s === 200);
  r = await sa.h('PUT', '/api/platform/tenants/' + TA.id, { subscription: { plan: 'standard', endsAt: '2020-01-31' } });
  r = await a.login('admin', 'Alpha-Definitif-2026', 'alpha'); ok(L('abonnement expiré : connexion refusée'), r.s === 403 && /expiré/.test(r.j.error), r.j);
  await sa.h('PUT', '/api/platform/tenants/' + TA.id, { subscription: { plan: 'standard', endsAt: '' } });
  r = await a.login('admin', 'Alpha-Definitif-2026', 'alpha'); ok(L('abonnement prolongé : connexion possible'), r.s === 200);

  /* ---------- entrée du Super Admin dans un espace ---------- */
  r = await sa.h('POST', '/api/platform/tenants/' + TB.id + '/enter', { mode: 'intervene' }); ok(L('intervention : motif obligatoire'), r.s === 400);
  const view = client(base); view.jar.psid = sa.jar.psid;
  r = await view.h('POST', '/api/platform/tenants/' + TB.id + '/enter', { mode: 'view', reason: 'contrôle qualité' }); ok(L('Super Admin : entrée en consultation dans Beta'), r.s === 200 && !!view.jar.sid);
  r = await view.h('GET', '/api/me'); ok(L('consultation : identité Super Admin visible (pas un compte de l’établissement)'), r.j.user.superAdmin === true && r.j.user.superAdminMode === 'consultation' && r.j.user.writable.length === 0, r.j.user);
  r = await view.h('GET', '/api/state'); ok(L('consultation : lecture des données de Beta'), r.s === 200 && r.j.data.students[0].matricule === 'M-BETA');
  r = await view.h('PUT', '/api/state', { baseRev: r.j.rev, data: data('SA-VIEW') }); ok(L('consultation : aucune modification possible'), r.s === 403);
  r = await view.h('POST', '/api/users', { username: 'zz', displayName: 'Z', role: 'scolarite', password: 'Zzzzzzzz-2026' }); ok(L('consultation : création de compte refusée'), r.s === 403);
  const inter = client(base); inter.jar.psid = sa.jar.psid;
  r = await inter.h('POST', '/api/platform/tenants/' + TB.id + '/enter', { mode: 'intervene', reason: 'Correction demandée par la direction (ticket 42)' }); ok(L('Super Admin : entrée en intervention avec motif'), r.s === 200);
  r = await inter.h('GET', '/api/state'); const d2 = r.j.data; d2.rooms.push({ id: 'r2', name: 'Salle ajoutée par SA' });
  r = await inter.h('PUT', '/api/state', { baseRev: r.j.rev, data: d2 }); ok(L('intervention : modification possible'), r.s === 200, r.j);
  r = await inter.h('GET', '/api/state?since=0'); ok(L('ISOLATION : la session du Super Admin dans Beta ne donne pas accès à Alpha'), !JSON.stringify(r.j).includes('ALPHA'));
  r = await b.h('GET', '/api/audit'); const evB = r.j.items;
  ok(L('journal de Beta : entrées du Super Admin inscrites (consultation, intervention, motif)'), evB.some(e => /entrée du Super Admin.*consultation/.test(e.event) && e.superAdmin) && evB.some(e => /entrée du Super Admin.*intervention/.test(e.event) && e.motif) && evB.some(e => e.event === 'consultation (Super Admin)') && evB.some(e => e.event === 'données centrales enregistrées' && e.user === 'superadmin.' + SA.u && e.superAdmin === true));
  r = await inter.h('POST', '/api/logout'); ok(L('sortie de l’espace inscrite au journal'), r.s === 200);

  /* ---------- historique d'activité ---------- */
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/users/' + uFin.id + '/activity');
  ok(L('historique d’activité d’un utilisateur : uniquement ses actions, dans l’ordre'), r.s === 200 && r.j.items.every(e => e.user === 'k.finance') && r.j.user.username === 'k.finance', r.j);
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/audit?user=admin&section=comptes');
  const cm = r.j.items.find(e => /compte modifié/.test(e.event) && e.compte === 'k.finance');
  ok(L('journal filtré (utilisateur + rubrique) : anciennes et nouvelles valeurs, motif'), r.s === 200 && cm && cm.avant.jobTitle === 'Comptable' && cm.apres.jobTitle === 'Chef comptable' && cm.avant.role === 'finance' && cm.apres.role === 'direction' && cm.motif === 'promotion' && cm.result === 'succès', cm);
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/audit?section=' + encodeURIComponent('emploi du temps') + '&verify=1');
  ok(L('journal filtré par rubrique (emploi du temps), chaîne valide'), r.j.valid === true && r.j.items.length > 0 && r.j.items.every(e => e.section === 'emploi du temps'), r.j.items && r.j.items.map(e => e.section));
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/audit?from=2000-01-01&to=2000-01-02'); ok(L('journal filtré par date'), r.j.total === 0);
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/audit?event=' + encodeURIComponent('échec connexion'));
  ok(L('journal filtré par type d’action (échecs de connexion)'), r.j.items.length >= 1 && r.j.items.every(e => /échec connexion/.test(e.event) && e.result === 'échec'));
  r = await sa.h('GET', '/api/platform/audit?verify=1'); const pev = r.j.items.map(e => e.event);
  ok(L('journal de la plateforme : créations, suspension, entrées, consultations ; chaîne valide'), r.j.valid === true && pev.includes('établissement créé') && pev.includes('statut d’établissement modifié') && pev.some(e => /entrée dans l’espace/.test(e)) && pev.includes('journal d’un établissement consulté'), pev);

  /* ---------- comptes d'un établissement gérés par le Super Admin ---------- */
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/users'); ok(L('Super Admin : liste des comptes de Beta'), r.s === 200 && r.j.items.some(x => x.username === 'k.finance'));
  r = await sa.h('PUT', '/api/platform/tenants/' + TB.id + '/users/' + uSec.id, { disabled: true }); ok(L('Super Admin : désactive un compte de Beta'), r.s === 200 && r.j.user.disabled === true);
  r = await sa.h('POST', '/api/platform/tenants/' + TB.id + '/users/' + uFin.id + '/reset-password', { password: 'Reinit-Finance-2026' }); ok(L('Super Admin : réinitialise un mot de passe dans Beta'), r.s === 200);
  r = await sa.h('GET', '/api/platform/tenants/' + TB.id); ok(L('Super Admin : statistiques de l’établissement'), r.s === 200 && r.j.stats.students === 1 && r.j.stats.users === 3, r.j && r.j.stats);
  r = await b.h('GET', '/api/audit'); ok(L('journal de Beta : actions de la console Super Admin inscrites'), r.j.items.some(e => e.user === 'superadmin.' + SA.u && /compte désactivé/.test(e.event)));

  /* ---------- premier établissement : compatibilité ---------- */
  const lg = client(base);
  r = await lg.login('admin', extra.legacyAdminPw); ok(L('compatibilité : connexion sans code → établissement par défaut (données d’origine)'), r.s === 200, r.j);
  r = await lg.h('GET', '/api/me'); ok(L('établissement par défaut : informations renvoyées'), r.j.tenant.slug === 'principal');
  r = await lg.h('GET', '/api/users'); ok(L('ISOLATION : le premier établissement ne voit pas les comptes de Beta'), !r.j.items.some(x => x.username === 'k.finance'));

  if (extra.after) await extra.after({ TA, TB, srv, L, sa });
  srv.stop && await srv.stop();
}

(async () => {
  /* ===== mode fichiers ===== */
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-mt-')), D = path.join(ROOT, 'data');
    fs.mkdirSync(D, { recursive: true });
    // données v2 existantes (avant cette version) : un compte, un ancien journal dans store.json
    const A = require('../lib/auth'), legacyPw = 'Ancien-Admin-2026';
    const audit0 = []; let prev = AL.GENESIS; for (const ev of ['connexion', 'compte créé']) { const e = AL.seal(prev, { at: '2026-10-01T00:00:00.000Z', event: ev, ip: '1.2.3.4', user: 'admin' }); audit0.push(e); prev = e.h; }
    fs.writeFileSync(path.join(D, 'store.json'), JSON.stringify({ users: [{ id: 'aaaaaaaaaaaaaaaa', username: 'admin', displayName: 'Admin', role: 'admin', pw: await A.hashPassword(legacyPw, 4096), disabled: false, mustChange: false, createdAt: '2026-10-01' }], logins: {}, audit: audit0, forms: {}, absences: [], policies: {}, sessions: {}, alerts: {}, notifs: [] }));
    fs.writeFileSync(path.join(D, 'state.json'), JSON.stringify({ rev: 3, at: '', by: '', data: { ...data('ORIGINE'), cfg: { etab: 'UM6SS – FM6SIPS Dakhla' } } }));
    const PORT = 9700 + Math.floor(Math.random() * 100);
    const env = { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: D, LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(ROOT, 'bk'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), LOGIN_RATE_PER_MIN: '1000', SUPERADMIN_USERNAME: SA.u, SUPERADMIN_PASSWORD: SA.p0 };
    const start = async () => { const p = await spawnWait(['server.js'], env, /démarré/); return { base: 'http://127.0.0.1:' + PORT, stop: async () => { p.kill(); await sleep(400); } }; };
    await scenario('fichiers', start, {
      legacyAdminPw: legacyPw,
      after: async ({ TA, TB, srv, L, sa: sa0 }) => {
        const pf = JSON.parse(fs.readFileSync(path.join(D, 'platform.json'), 'utf8'));
        ok(L('le premier établissement porte le nom des données existantes'), pf.tenants[0].name === 'UM6SS – FM6SIPS Dakhla');
        ok(L('données de chaque établissement dans son propre dossier'), fs.existsSync(path.join(D, 'tenants', TB.id, 'state.json')) && fs.existsSync(path.join(D, 'tenants', TA.id, 'state.json')) && !fs.readFileSync(path.join(D, 'tenants', TB.id, 'state.json'), 'utf8').includes('ALPHA'));
        const st = JSON.parse(fs.readFileSync(path.join(D, 'store.json'), 'utf8'));
        const la = new AL.FileAudit(path.join(D, 'audit.jsonl')).readAll();
        ok(L('ancien journal transféré dans audit.jsonl (séparé des données), chaîne conservée'), st.audit === undefined && la.length > 2 && JSON.stringify(la.slice(0, 2)) === JSON.stringify(audit0) && AL.chainValid(la));
        ok(L('mot de passe Super Admin jamais stocké en clair'), !fs.readFileSync(path.join(D, 'platform.json'), 'utf8').includes(SA.p) && !fs.readFileSync(path.join(D, 'platform.json'), 'utf8').includes(SA.p0));
        ok(L('sauvegarde faite avant la conversion en plateforme'), fs.readdirSync(path.join(ROOT, 'bk')).some(n => /avant-multi-etablissements/.test(n)));
        // altération du journal d'un établissement détectée
        await srv.stop();
        const f = path.join(D, 'tenants', TB.id, 'audit.jsonl'), lines = fs.readFileSync(f, 'utf8').split('\n'); const e1 = JSON.parse(lines[1]); e1.event = 'falsifié'; lines[1] = JSON.stringify(e1); fs.writeFileSync(f, lines.join('\n'));
        const s2 = await start(); const sa = client(s2.base); sa.jar.psid = sa0.jar.psid;   // la session Super Admin survit au redémarrage
        let r = await sa.h('GET', '/api/platform/tenants/' + TB.id + '/audit?verify=1'); ok(L('altération du journal de Beta détectée (chaîne invalide)'), r.j.valid === false, r.j && r.j.valid);
        r = await sa.h('GET', '/api/platform/tenants/' + TA.id + '/audit?verify=1'); ok(L('journal d’Alpha toujours valide'), r.j.valid === true);
        const tool = cp.spawnSync(process.execPath, ['tools/reset-password.js', '--etab', 'beta', '--username', 'k.finance', '--unlock-only'], { cwd: DIR, env: { ...process.env, ...env } });
        ok(L('outils en ligne de commande : --etab vise un établissement'), /serveur est en cours/.test(tool.stderr + tool.stdout) || tool.status === 0, tool.stderr + tool.stdout);
        await s2.stop();
      }
    });
  }
  /* ===== mode cloud (Supabase simulé sur PostgreSQL réel) ===== */
  if (PG.length) {
    const DB = 'unitt_mt_' + Date.now(), psql = (q, db) => cp.spawnSync('psql', [...PG, '-d', db || 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: q, encoding: 'utf8' });
    psql('create database ' + DB);
    psql("do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;", DB);
    // base d'une version précédente : documents store/state existants, puis schéma mis à jour (ré-exécution)
    const schema = fs.readFileSync(path.join(DIR, '..', 'supabase', 'schema.sql'), 'utf8');
    let r0 = psql(schema, DB); ok('cloud : schéma appliqué', r0.status === 0, r0.stderr);
    r0 = psql(schema, DB); ok('cloud : schéma ré-exécutable sans erreur', r0.status === 0, r0.stderr);
    const KEY = 'k' + Date.now(), MP = 9850 + Math.floor(Math.random() * 50), PORT = MP + 60;
    await spawnWait(['tests/support/supabase-mock.js', String(MP), KEY, ...PG, '-d', DB], {}, /prêt/);
    const env = { UNITT_STORAGE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:' + MP, SUPABASE_SERVICE_ROLE_KEY: KEY, SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: '/nonexistent', LOGIN_RATE_PER_MIN: '1000', PORT: String(PORT), ADMIN_PASSWORD: 'Admin-Cloud-2026', SUPERADMIN_USERNAME: SA.u, SUPERADMIN_PASSWORD: SA.p0 };
    const start = async () => { const p = await spawnWait(['tools/cloud-dev.js'], env, /démarré/); return { base: 'http://127.0.0.1:' + PORT, stop: async () => { p.kill(); await sleep(300); } }; };
    await scenario('cloud', start, {
      legacyAdminPw: 'Admin-Cloud-2026',
      after: async ({ TB, L }) => {
        const q = s => psql(s, DB);
        let r = q('update unitt_audit set entry = \'{}\' where tenant = \'' + TB.id + '\'');
        ok(L('PostgreSQL : modification du journal d’audit refusée par la base (déclencheur)'), r.status !== 0 && /append_only/.test(r.stderr));
        r = q('delete from unitt_audit'); ok(L('PostgreSQL : suppression du journal refusée par la base'), r.status !== 0 && /append_only/.test(r.stderr));
        r = q('truncate unitt_audit'); ok(L('PostgreSQL : vidage du journal refusé par la base'), r.status !== 0);
        r = q("select count(*) from unitt_docs where id like 'state:%'"); ok(L('PostgreSQL : un document de données par établissement'), +r.stdout.trim() === 2, r.stdout);
        r = q("select count(distinct tenant) from unitt_audit"); ok(L('PostgreSQL : journaux séparés (plateforme, premier établissement, Alpha, Beta)'), +r.stdout.trim() === 4, r.stdout);
        r = q("set role anon; select count(*) from unitt_audit"); ok(L('PostgreSQL : le rôle public ne peut pas lire le journal'), r.status !== 0);
      }
    });
    psql('drop database if exists ' + DB + ' with (force)');
  } else console.log('SKIP mode cloud : définir PG pour le tester');
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  procs.forEach(p => { try { p.kill(); } catch (e) { } });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERREUR', e); procs.forEach(p => { try { p.kill(); } catch (x) { } }); process.exit(1); });

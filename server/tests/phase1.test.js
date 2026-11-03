/* Phase 1 — modèle de données, rôles et audit : critères d'acceptation.
   node tests/phase1.test.js            (option : REAL_STORE=chemin\store.json pour tester la migration sur une copie de vos données réelles) */
'use strict';
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
const DIR = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-p1-'));
const PORT = 9100 + Math.floor(Math.random() * 200), B = 'http://127.0.0.1:' + PORT;
const mkEnv = d => ({ ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: d, LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(d, 'backups'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), ADMIN_PASSWORD: '', LOGIN_RATE_PER_MIN: '500', ALLOW_EARLY: '1', MIGRATIONS_AUTO: '1' });
let ENV = mkEnv(path.join(ROOT, 'data'));
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400) : '')); };
let proc;
const start = () => new Promise((res, rej) => { proc = cp.spawn(process.execPath, ['server.js'], { cwd: DIR, env: ENV }); let o = ''; const on = d => { o += d; if (/démarré/.test(o)) res(o); }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('exit ' + c + ' ' + o))); setTimeout(() => rej(new Error(o)), 10000); });
const stop = () => new Promise(r => { if (!proc || proc.exitCode !== null) return r(); proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); });
const cli = (args, input) => cp.spawnSync(process.execPath, args, { cwd: DIR, env: ENV, input: input || '', encoding: 'utf8' });
function client() { const c = { cookie: '' }; c.h = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0]; let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j }; }; c.login = (u, p) => c.h('POST', '/api/login', { username: u, password: p }); return c; }
const clone = o => JSON.parse(JSON.stringify(o));
const W = 'Secret-Long-Phase1-2026';
function data() {
  return {
    teachers: [{ id: 't1', name: 'Dr. Amrani' }, { id: 't2', name: 'Pr. Benali' }], rooms: [{ id: 'r1', name: 'A101' }], levels: [{ id: 'l1', name: 'IP 1' }],
    programs: [{ id: 'p_ip', name: 'IP' }], subjects: [{ id: 's1', name: 'Anatomie', level: 'l1' }, { id: 's2', name: 'Physiologie', level: 'l1' }],
    sessions: [
      { id: 'past1', subjectId: 's1', teacherId: 't1', roomId: 'r1', date: '2026-06-15', startTime: '08:30', endTime: '10:30', programId: 'p_ip', year: '1', group: 'G1' },
      { id: 'fut1', subjectId: 's1', teacherId: 't1', roomId: 'r1', date: '2027-06-14', startTime: '08:30', endTime: '10:30', programId: 'p_ip', year: '1', group: 'G2' },
      { id: 'fut2', subjectId: 's1', teacherId: 't1', roomId: 'r1', date: '2027-06-15', startTime: '08:30', endTime: '10:30', programId: 'p_ip', year: '1', group: 'G1' },
      { id: 'other', subjectId: 's2', teacherId: 't2', roomId: 'r1', date: '2026-06-15', startTime: '10:30', endTime: '12:30', programId: 'p_ip', year: '1', group: 'G1' },
      { id: 'canc', subjectId: 's2', teacherId: 't2', roomId: 'r1', date: '2026-06-16', startTime: '08:30', endTime: '10:30', programId: 'p_ip', year: '1', group: 'G1', cancelled: true },
      { id: 'post', subjectId: 's2', teacherId: 't2', roomId: 'r1', date: '2026-06-17', startTime: '08:30', endTime: '10:30', programId: 'p_ip', year: '1', group: 'G1', postponed: true },
      { id: 'repl', subjectId: 's2', teacherId: 't2', roomId: 'r1', date: '2026-06-24', startTime: '08:30', endTime: '10:30', programId: 'p_ip', year: '1', group: 'G1', replacesId: 'post' }
    ],
    students: [
      { id: 'st1', matricule: '00123', lastName: 'Alaoui', firstName: 'Sara', programId: 'p_ip', year: '1', group: 'G1', cin: 'AB1' },
      { id: 'st2', matricule: '00124', lastName: 'Bennani', firstName: 'Omar', programId: 'p_ip', year: '1', group: 'G1', cin: 'CD2' }
    ],
    volumes: [], cal: { start: '', end: '' }, absences: [], templates: [], tplCats: [], cfg: { cc: '212' },
    audit: [{ id: 'a1', at: '2026-06-01T08:00:00Z', user: 'admin', action: 'création', object: 'x', detail: {} }, { id: 'a2', at: '2026-06-02T08:00:00Z', user: 'admin', action: 'modif', object: 'y', detail: {} }],
    alertLog: [], alertSeen: [], alertMeta: {}, alertState: {}, events: [], waLog: [], sheetLog: [], docLog: [], notCommon: []
  };
}

(async () => {
  /* ===== 1. Migration réversible sur une COPIE (données v2 existantes, sans migrations) ===== */
  const MD = path.join(ROOT, 'copie');
  fs.mkdirSync(MD, { recursive: true });
  const real = process.env.REAL_STORE && fs.existsSync(process.env.REAL_STORE);
  const store0 = real ? JSON.parse(fs.readFileSync(process.env.REAL_STORE, 'utf8')) : { forms: {}, absences: [], audit: [], policies: {}, sessions: {}, alerts: {}, notifs: [] };
  store0.absences = (store0.absences || []).concat([{ id: 'ab01', sessionId: 'past1', date: '2026-06-15', absent: [{ m: '00123', n: 'ALAOUI Sara' }], total: 1, status: 'soumise', versions: [] }]);
  const state0 = { rev: 7, at: '2026-10-01T00:00:00Z', by: 'admin', data: data() };
  fs.writeFileSync(path.join(MD, 'store.json'), JSON.stringify(store0)); fs.writeFileSync(path.join(MD, 'state.json'), JSON.stringify(state0));
  const before = { store: fs.readFileSync(path.join(MD, 'store.json'), 'utf8'), state: fs.readFileSync(path.join(MD, 'state.json'), 'utf8') };
  let r = cli(['tools/migrate.js', '--data-dir', MD, '--up']);
  const sUp = JSON.parse(fs.readFileSync(path.join(MD, 'store.json'), 'utf8')), tUp = JSON.parse(fs.readFileSync(path.join(MD, 'state.json'), 'utf8'));
  ok('P1. migration --up appliquée sur une copie' + (real ? ' de vos données réelles (' + process.env.REAL_STORE + ')' : ''), r.status === 0 && sUp.migrations.length === 2, r.stdout + r.stderr);
  ok('P1. une sauvegarde vérifiée est créée avant la migration', /Sauvegarde vérifiée/.test(r.stdout) && fs.readdirSync(path.join(MD, 'backups')).some(n => /avant-migration/.test(n)));
  ok('P1. année universitaire ajoutée aux déclarations (2026-06-15 -> 2025/2026)', sUp.absences.find(a => a.id === 'ab01').ay === '2025/2026');
  ok('P1. historique des groupes créé pour chaque étudiant', tUp.data.students.every(s => Array.isArray(s.groupHistory) && s.groupHistory.length === 1 && s.groupHistory[0].group === s.group));
  r = cli(['tools/migrate.js', '--data-dir', MD, '--down', '001-annee-universitaire-absences']);
  const sDown = JSON.parse(fs.readFileSync(path.join(MD, 'store.json'), 'utf8')), tDown = JSON.parse(fs.readFileSync(path.join(MD, 'state.json'), 'utf8'));
  const strip = o => { const x = clone(o); delete x.migrations; delete x.audit; return JSON.stringify(x); };
  ok('P1. migration --down : retour arrière effectué', r.status === 0 && (sDown.migrations || []).length === 0, r.stdout + r.stderr);
  ok('P1. après --up puis --down : déclarations, liens, alertes, séances surveillées identiques à l’original (aucune perte)', strip(sDown) === strip(JSON.parse(before.store)));
  ok('P1. après --up puis --down : données centrales identiques à l’original (aucune perte)', JSON.stringify(tDown.data) === JSON.stringify(JSON.parse(before.state).data));
  ok('P1. le journal d’audit garde la trace de la migration et de son annulation (ajout seul)', sDown.audit.length >= (store0.audit || []).length + 4 && sDown.audit.slice(0, (store0.audit || []).length).every((e, i) => JSON.stringify(e) === JSON.stringify(store0.audit[i])));

  /* ===== 2. Démarrage sur des données v2 existantes (comptes + emplois du temps) ===== */
  const D2 = path.join(ROOT, 'v2'); fs.mkdirSync(D2, { recursive: true }); ENV = mkEnv(D2);
  fs.writeFileSync(path.join(D2, 'store.json'), JSON.stringify(store0)); fs.writeFileSync(path.join(D2, 'state.json'), JSON.stringify(state0));
  r = cli(['tools/create-admin.js', '--username', 'admin', '--name', 'Admin'], W + '\n' + W + '\n');
  // simule un compte préexistant v2 (MIGRATIONS absentes du store)
  const st2 = JSON.parse(fs.readFileSync(path.join(D2, 'store.json'), 'utf8')); delete st2.migrations; fs.writeFileSync(path.join(D2, 'store.json'), JSON.stringify(st2));
  await start();
  const adm = client(); r = await adm.login('admin', W);
  ok('P1. après migration automatique au démarrage : le compte existant se connecte', r.s === 200);
  let v = (await adm.h('GET', '/api/state')).j;
  ok('P1. emplois du temps et dossiers existants intacts et accessibles', v.data.sessions.length === 7 && v.data.students.length === 2 && v.data.students[0].matricule === '00123' && v.data.students[0].cin === 'AB1');
  ok('P1. matricule conservé en texte (zéros initiaux)', v.data.students[0].matricule === '00123');
  ok('P1. les clients rechargent : nouvelle révision après migration', v.rev === 8, v.rev);
  ok('P1. sauvegarde « avant-migration » vérifiée créée au démarrage', fs.readdirSync(path.join(D2, 'backups')).some(n => /avant-migration/.test(n)));

  /* ===== 3. Rôles / permissions / accès d'un enseignant à la séance d'un autre ===== */
  const mk = async (u, role, extra) => { await adm.h('POST', '/api/users', { username: u, displayName: u, role, password: 'Provisoire-Zq8-2026x', ...extra }); const c = client(); await c.login(u, 'Provisoire-Zq8-2026x'); await c.h('POST', '/api/account/password', { current: 'Provisoire-Zq8-2026x', next: W + '-' + u.length + 'k' }); return c; };
  const prof = await mk('prof1', 'teacher', { teacherId: 't1' }), plan = await mk('plan1', 'planning'), scol = await mk('scol1', 'scolarite');
  r = await prof.h('GET', '/api/sessions/other'); ok('P1. un enseignant qui appelle l’API d’une séance d’un autre enseignant reçoit 403 (aucune donnée)', r.s === 403 && !r.j.session);
  r = await prof.h('GET', '/api/sessions/past1'); ok('P1. l’enseignant accède à SA séance', r.s === 200 && r.j.session.id === 'past1');
  r = await prof.h('GET', '/api/sessions/inexistante'); ok('P1. identifiant inventé : 403 aussi (on ne révèle pas son existence)', r.s === 403);
  r = await prof.h('POST', '/api/absences', { sessionId: 'other', absent: [], date: '2026-06-15' }); ok('P1. absences sur la séance d’un autre : 403', r.s === 403);
  r = await adm.h('GET', '/api/audit'); ok('P1. les refus d’accès sont inscrits au journal d’audit', r.j.items.some(e => e.event === 'accès refusé à une séance' && e.user === 'prof1' && e.sessionId === 'other'));
  // permissions individuelles : retirer / accorder sans toucher au code
  const users = (await adm.h('GET', '/api/users')).j.items, U = n => users.find(x => x.username === n);
  r = await adm.h('PUT', '/api/users/' + U('prof1').id, { deniedPerms: ['absences.write.own'] });
  r = await prof.h('POST', '/api/absences', { sessionId: 'fut2', absent: [], date: '2027-06-15' }); ok('P1. permission retirée individuellement à un enseignant : saisie refusée (403)', r.s === 403);
  await adm.h('PUT', '/api/users/' + U('prof1').id, { deniedPerms: [] });
  r = await prof.h('POST', '/api/absences', { sessionId: 'fut2', absent: [{ m: '00123', n: 'ALAOUI Sara' }], date: '2027-06-15', start: '08:30' }); ok('P1. permission rendue : saisie acceptée', r.s === 200, r.j);
  v = (await plan.h('GET', '/api/state')).j; ok('P1. responsable planification : dossiers étudiants limités par défaut', !v.data.students[0].lastName);
  await adm.h('PUT', '/api/users/' + U('plan1').id, { extraPerms: ['state.read'] });
  v = (await plan.h('GET', '/api/state')).j; ok('P1. permission accordée individuellement (dossiers étudiants) : effet immédiat', v.data.students[0].lastName === 'Alaoui');
  r = await adm.h('PUT', '/api/users/' + U('plan1').id, { extraPerms: ['users.manage'] }); ok('P1. les droits d’administration ne peuvent pas être accordés individuellement', r.s === 400);
  r = await adm.h('GET', '/api/roles'); ok('P1. permission dédiée aux données financières (finance.read) réservée par défaut à l’administrateur', !!r.j.perms['finance.read'] && r.j.roles.admin.perms.includes('finance.read') && !r.j.roles.planning.perms.includes('finance.read'));

  /* ===== 4. Statuts de séance calculés par le serveur ===== */
  const st = k => adm.h('GET', '/api/sessions/' + k).then(x => x.j);
  let x = await st('past1'); ok('P1. séance passée avec déclaration : Réalisée / Absences enregistrées (année 2025/2026)', x.status === 'realisee' && x.declStatus === 'absences_enregistrees' && x.ay === '2025/2026', x);
  x = await st('other'); ok('P1. séance passée sans déclaration : Programmée / Non déclarée (jamais « Aucun absent »)', x.status === 'programmee' && x.declStatus === 'non_declaree', x);
  x = await st('fut1'); ok('P1. séance future : Programmée / En attente', x.status === 'programmee' && x.declStatus === 'en_attente');
  x = await st('canc'); ok('P1. séance annulée : Annulée / Sans objet', x.status === 'annulee' && x.declStatus === 'sans_objet');
  x = await st('post'); ok('P1. séance reportée avec remplacement : Reportée / Sans objet', x.status === 'reportee' && x.declStatus === 'sans_objet');
  x = await st('repl'); ok('P1. séance de remplacement liée et marquée « Remplacement »', x.replacement === true && x.replacesId === 'post');
  const al = (await adm.h('GET', '/api/alerts')).j.items;
  ok('P1. alertes calculées à partir des données centrales (sans synchronisation par un poste) ; aucune pour annulée/reportée', al.some(a => a.sessionId === 'other' && !a.resolvedAt) && !al.some(a => a.sessionId === 'canc' || a.sessionId === 'post'));

  /* ===== 5. Historique des groupes ===== */
  v = (await scol.h('GET', '/api/state')).j; let d = clone(v.data);
  d.students.find(s => s.id === 'st2').group = 'G2'; d.students.forEach(s => delete s.groupHistory);
  r = await scol.h('PUT', '/api/state', { baseRev: v.rev, data: d });
  const hist = r.j.data && r.j.data.students.find(s => s.id === 'st2').groupHistory;
  ok('P1. changement de groupe : nouvelle entrée datée dans l’historique, géré par le serveur', r.s === 200 && hist && hist.length === 2 && hist[0].group === 'G1' && hist[1].group === 'G2' && /^\d{4}-\d{2}-\d{2}$/.test(hist[1].from), r.j);
  v = (await prof.h('GET', '/api/state')).j;
  ok('P1. enseignant : l’étudiant reste dans la liste de la séance passée (groupe G1 à cette date) et apparaît pour la séance future en G2', v.data.students.some(s => s.id === 'st2'));
  v = (await scol.h('GET', '/api/state')).j; d = clone(v.data); d.students.find(s => s.id === 'st2').groupHistory = [{ from: '', programId: 'p_ip', year: '1', group: 'G9' }];
  r = await scol.h('PUT', '/api/state', { baseRev: v.rev, data: d }); v = (await adm.h('GET', '/api/state')).j;
  ok('P1. un poste ne peut pas réécrire l’historique des groupes', v.data.students.find(s => s.id === 'st2').groupHistory.length === 2 && v.data.students.find(s => s.id === 'st2').groupHistory[0].group === 'G1');

  /* ===== 6. Journal d'audit centralisé : utilisateur, action, date, objet, anciennes et nouvelles valeurs ; ajout seul ===== */
  const A = (await adm.h('GET', '/api/audit')).j;
  const e = A.items.filter(z => z.event === 'données centrales enregistrées' && z.user === 'scol1').find(z => (z.modifications || []).some(c => c.id === 'st2'));
  const c = e && e.modifications.find(c => c.id === 'st2');
  ok('P1. audit : utilisateur, action, date, objet, ancienne et nouvelle valeur', !!(e && e.at && e.user === 'scol1' && c && c.op === 'modification' && c.label === 'Bennani Omar' && c.champs.group.ancien === 'G1' && c.champs.group.nouveau === 'G2'), e);
  ok('P1. audit serveur chaîné et valide', A.valid === true);
  for (const [m, p] of [['PUT', '/api/audit'], ['DELETE', '/api/audit'], ['POST', '/api/audit'], ['DELETE', '/api/audit/0']]) { r = await plan.h(m, p, {}); ok('P1. ' + m + ' ' + p + ' : aucune API pour modifier/supprimer une entrée d’audit (' + r.s + ')', r.s === 404 || r.s === 405 || r.s === 403); }
  r = await plan.h('GET', '/api/audit'); ok('P1. un non-administrateur ne peut pas lire le journal serveur', r.s === 403);
  // journal de l'interface (S.audit) : tentative de suppression et de modification par un non-administrateur
  v = (await plan.h('GET', '/api/state')).j; d = clone(v.data);
  d.audit = d.audit.filter(z => z.id !== 'a1'); d.audit.find(z => z.id === 'a2').action = 'falsifié'; d.audit.push({ id: 'a3', at: new Date().toISOString(), user: 'plan1', action: 'nouvelle action', object: '', detail: {} });
  d.rooms.push({ id: 'r2', name: 'Salle B' });
  r = await plan.h('PUT', '/api/state', { baseRev: v.rev, data: d });
  v = (await adm.h('GET', '/api/state')).j; const au = v.data.audit;
  ok('P1. un non-administrateur ne peut pas supprimer une entrée du journal de l’interface', au.some(z => z.id === 'a1'));
  ok('P1. un non-administrateur ne peut pas modifier une entrée du journal', au.find(z => z.id === 'a2').action === 'modif');
  ok('P1. les nouvelles entrées sont bien ajoutées (ajout seul) et le reste de l’enregistrement est conservé', au.some(z => z.id === 'a3') && v.data.rooms.some(z => z.id === 'r2'));
  ok('P1. la tentative est inscrite au journal du serveur', (await adm.h('GET', '/api/audit')).j.items.some(z => /journal protégé/.test(z.event) && z.user === 'plan1'));
  ok('P1. le poste reçoit la version corrigée (journal restauré)', r.s === 200 && r.j.merged === true && r.j.data.audit.some(z => z.id === 'a1'));

  await stop();
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.log('ERREUR', e); try { await stop(); } catch (x) { } process.exit(1); });

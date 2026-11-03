/* Tests de l'adaptation réseau local : comptes, rôles, état central, synchronisation entre deux postes,
   conflits, persistance, sauvegarde/restauration, journaux, instance unique, filtrage réseau, HTTPS.
   Exécution : node tests/lan.test.js   (Node 18+ ; aucun accès Internet nécessaire) */
'use strict';
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path'), https = require('https');
const DIR = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-lan-'));
const D = path.join(ROOT, 'data'), LOGS = path.join(ROOT, 'logs'), BKD = path.join(ROOT, 'backups');
const PORT = 8800 + Math.floor(Math.random() * 150), B = 'http://127.0.0.1:' + PORT;
const ENV = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: D, LOG_DIR: LOGS, BACKUP_DIR: BKD, SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'none.env'), ALLOW_EARLY: '', ADMIN_PASSWORD: '', LOGIN_RATE_PER_MIN: '500' };
let fails = 0, passes = 0;
const ok = (n, c, x) => { if (c) passes++; else fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined && !c ? '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let proc = null;
function start(extra) {
  return new Promise((res, rej) => {
    proc = cp.spawn(process.execPath, ['server.js'], { cwd: DIR, env: { ...ENV, ...(extra || {}) } });
    let o = ''; const t = setTimeout(() => rej(new Error('démarrage trop long : ' + o)), 10000);
    const on = d => { o += d; if (/démarré/.test(o)) { clearTimeout(t); res(o); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on);
    proc.on('exit', c => { clearTimeout(t); if (!/démarré/.test(o)) rej(new Error('sortie ' + c + ' : ' + o)); });
  });
}
const stop = () => new Promise(r => { if (!proc || proc.exitCode !== null) return r(); proc.on('exit', r); proc.kill('SIGTERM'); });
function cli(script, args, input) { return cp.spawnSync(process.execPath, [path.join('tools', script), ...args], { cwd: DIR, env: ENV, input: input || '', encoding: 'utf8' }); }

/* Un « poste client » : son propre cookie, comme un navigateur */
function client(name) {
  const c = { name, cookie: '' };
  c.h = async (m, p, b, hdr) => {
    const r = await fetch(B + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...(hdr || {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch (e) { /* */ } return { s: r.status, j };
  };
  c.login = (username, password) => c.h('POST', '/api/login', { username, password });
  return c;
}
const PW = { admin: 'Tres-Long-Secret-2026!', plan: 'Horaires-Secret-2026', scol: 'Dossiers-Secret-2026', prof: 'Enseignant-Secret-2026', prof2: 'Enseignant2-Secret-2026' };
function seedData() {
  return {
    teachers: [{ id: 't1', name: 'Dr. Amrani', phone: '0600000001' }, { id: 't2', name: 'Pr. Benali', phone: '0600000002' }],
    rooms: [{ id: 'r1', name: 'A101' }, { id: 'r2', name: 'Amphi 1' }],
    levels: [{ id: 'l1', name: 'IP 1', program: 'IP', year: '1', group: 'G1' }],
    programs: [{ id: 'p_ip', name: 'IP', label: 'Infirmier polyvalent' }],
    subjects: [{ id: 's1', name: 'Anatomie', level: 'l1', teacherId: 't1' }, { id: 's2', name: 'Physiologie', level: 'l1', teacherId: 't2' }],
    sessions: [
      { id: 'se1', subjectId: 's1', teacherId: 't1', roomIds: ['r1'], date: '2026-06-15', startTime: '08:30', endTime: '10:30', day: 'MON', programId: 'p_ip', year: '1', group: 'G1' },
      { id: 'se2', subjectId: 's2', teacherId: 't2', roomIds: ['r2'], date: '2026-06-15', startTime: '10:30', endTime: '12:30', day: 'MON', programId: 'p_ip', year: '1', group: 'G1' }
    ],
    students: [
      { id: 'st1', matricule: 'M001', lastName: 'ALAOUI', firstName: 'Sara', programId: 'p_ip', year: '1', group: 'G1', phone: '0611111111', email: 'sara@example.ma', cin: 'AB123' },
      { id: 'st2', matricule: 'M002', lastName: 'BENNANI', firstName: 'Omar', programId: 'p_ip', year: '1', group: 'G1', phone: '0622222222', cin: 'CD456' },
      { id: 'st3', matricule: 'M003', lastName: 'CHAKIR', firstName: 'Lina', programId: 'p_ip', year: '2', group: 'G1', cin: 'EF789' }
    ],
    volumes: [], cal: { start: '2025-09-01', end: '2026-07-15' }, absences: [], templates: [{ id: 'tp1', name: 'Attestation', cat: 'Attestation de scolarité' }],
    tplCats: ['Attestation de scolarité'], cfg: { cc: '212', etab: 'UM6SS – FM6SIPS Dakhla' }, audit: [], alertLog: [], alertSeen: [], alertMeta: {}, alertState: {}, events: [], waLog: [], sheetLog: [], docLog: [], notCommon: []
  };
}
const clone = o => JSON.parse(JSON.stringify(o));

(async () => {
  /* ---------- 1. démarrage sans compte, santé, accès non authentifié ---------- */
  await start();
  let h = await fetch(B + '/health').then(r => r.json());
  ok('1. le serveur démarre et /health répond', h.ok === true && h.app === 'unitimetable' && h.users === false);
  const anon = client('anonyme');
  let me = await anon.h('GET', '/api/me');
  ok('1. sans compte, /api/me signale qu’un premier administrateur doit être créé (aucun mot de passe par défaut)', me.j.auth === false && me.j.setupRequired === true);
  let r = await anon.login('admin', 'admin'); ok('1. aucun identifiant/mot de passe par défaut ne fonctionne', r.s === 401);
  const prot = [['GET', '/api/state'], ['PUT', '/api/state'], ['GET', '/api/users'], ['GET', '/api/absences'], ['POST', '/api/absences'], ['GET', '/api/audit'], ['GET', '/api/backups'], ['POST', '/api/sessions/sync'], ['GET', '/api/forms'], ['GET', '/api/server/info']];
  const codes = []; for (const [m, p] of prot) codes.push((await anon.h(m, p, m === 'GET' ? null : {})).s);
  ok('5. un utilisateur non authentifié ne peut accéder à aucune API protégée (401)', codes.every(c => c === 401), codes);
  r = await anon.h('GET', '/'); ok('1. l’interface est servie par le serveur', (await fetch(B + '/')).status === 200);
  for (const f of ['pdf.js', 'pdf.worker.js', 'xlsx.full.min.js', 'jspdf.umd.min.js']) {
    if (!fs.existsSync(path.join(DIR, 'public/vendor', f))) { console.log('SKIP 4. ' + f + ' : non présent dans public/vendor (exécuter node tools/fetch-vendor.js avec Internet) — test non exécuté'); continue; }
    const v = await fetch(B + '/vendor/' + f); ok('4. ' + f + ' est servi localement par le serveur (aucun CDN)', v.status === 200 && /javascript/.test(v.headers.get('content-type')), v.status);
  }
  ok('4. un fichier hors liste n’est pas servi (pas de parcours de répertoires)', (await fetch(B + '/vendor/..%2fserver.js')).status === 404 && (await fetch(B + '/vendor/../server.js')).status === 404);
  const idx = await fetch(B + '/').then(r => r.text()); ok('4. l’interface ne référence plus aucun CDN Internet', !/cdnjs\.cloudflare|https:\/\/cdn\./.test(idx));

  /* ---------- 2. instance unique ---------- */
  const second = cp.spawnSync(process.execPath, ['server.js'], { cwd: DIR, env: { ...ENV, PORT: String(PORT + 1) }, encoding: 'utf8', timeout: 8000 });
  ok('9. une deuxième instance sur le même dossier de données refuse de démarrer', second.status === 3 && /autre instance/.test(second.stderr + second.stdout), second.status + ' ' + second.stderr);
  r = cli('create-admin.js', ['--username', 'admin', '--name', 'Admin'], PW.admin + '\n' + PW.admin + '\n');
  ok('7. create-admin refuse de modifier les comptes pendant que le serveur tourne', r.status === 10, r.stdout + r.stderr);
  await stop();

  /* ---------- 3. premier administrateur par la console ---------- */
  r = cli('create-admin.js', ['--username', 'admin', '--name', 'Administrateur'], 'court\ncourt\n');
  ok('7. create-admin refuse un mot de passe trop court', r.status === 1 && /10 caractères/.test(r.stderr));
  r = cli('create-admin.js', ['--username', 'admin', '--name', 'Administrateur'], PW.admin + '\n' + PW.admin + '\n');
  ok('7. create-admin crée le premier administrateur', r.status === 0, r.stdout + r.stderr);
  const st0 = JSON.parse(fs.readFileSync(path.join(D, 'store.json'), 'utf8'));
  ok('sécurité : le mot de passe est stocké haché avec scrypt (jamais en clair)', st0.users[0].pw.alg === 'scrypt' && !JSON.stringify(st0).includes(PW.admin));
  await start();
  const adm = client('admin');
  r = await adm.login('admin', 'mauvais-mot-de-passe'); ok('connexion refusée avec un mauvais mot de passe', r.s === 401);
  r = await adm.login('admin', PW.admin); ok('connexion administrateur', r.s === 200 && r.j.user.role === 'admin' && /HttpOnly/.test('HttpOnly'));
  const rawLogin = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PW.admin }) });
  const sc = rawLogin.headers.get('set-cookie') || '';
  ok('sécurité : cookie de session HttpOnly, SameSite=Strict, durée limitée', /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=\d+/.test(sc), sc);
  r = await adm.h('POST', '/api/login', { username: 'admin', password: PW.admin }, { Origin: 'http://evil.example' }); ok('sécurité : une connexion venant d’une autre origine est refusée (CSRF)', r.s === 403);

  /* ---------- 4. comptes et rôles ---------- */
  const mk = async (username, role, password, teacherId) => (await adm.h('POST', '/api/users', { username, displayName: username, role, password, teacherId }));
  r = await mk('plan', 'planning', PW.plan); ok('8. création d’un compte « responsable emploi du temps »', r.s === 200 && r.j.user.mustChange === true, r.j);
  r = await mk('scol', 'scolarite', PW.scol); ok('8. création d’un compte « responsable scolarité »', r.s === 200);
  r = await mk('prof', 'teacher', PW.prof, 't1'); ok('8. création d’un compte enseignant relié à la fiche t1', r.s === 200);
  r = await mk('prof2', 'teacher', PW.prof2, 't2'); ok('8. création d’un second enseignant (t2)', r.s === 200);
  r = await mk('bad', 'teacher', PW.prof); ok('8. un compte enseignant sans fiche enseignant est refusé', r.s === 400);
  r = await mk('Bad User', 'planning', PW.plan); ok('8. identifiant invalide refusé', r.s === 400);
  r = await mk('plan', 'planning', PW.plan); ok('8. identifiant en double refusé', r.s === 409);
  r = await mk('weak', 'planning', 'abc'); ok('8. mot de passe faible refusé', r.s === 400);
  const users = (await adm.h('GET', '/api/users')).j.items; ok('8. la liste des comptes ne contient aucun hachage de mot de passe', users.length === 5 && !JSON.stringify(users).includes('salt') && !JSON.stringify(users).includes('scrypt'));
  const C = { plan: client('plan'), scol: client('scol'), prof: client('prof'), prof2: client('prof2') };
  for (const k of Object.keys(C)) await C[k].login(k, PW[k]);
  r = await C.plan.h('GET', '/api/state'); ok('8. premier accès : changement de mot de passe obligatoire avant toute action', r.s === 403 && r.j.mustChange === true);
  r = await C.plan.h('POST', '/api/account/password', { current: 'faux', next: 'Nouveau-Horaire-2026' }); ok('8. changement refusé si le mot de passe actuel est faux', r.s === 400);
  for (const k of Object.keys(C)) { PW[k] = PW[k] + '-v2'; r = await C[k].h('POST', '/api/account/password', { current: PW[k].slice(0, -3), next: PW[k] }); if (r.s !== 200) ok('changement de mot de passe ' + k, false, r.j); }
  r = await C.plan.h('GET', '/api/me'); ok('8. après changement, le compte est actif avec son rôle', r.j.user && r.j.user.role === 'planning' && !r.j.user.mustChange);

  /* ---------- 5. état central : initialisation, droits ---------- */
  r = await C.plan.h('PUT', '/api/state', { baseRev: 0, data: seedData() }); ok('6. seul l’administrateur peut initialiser les données vides', r.s === 409 && r.j.empty === true, r.j);
  r = await adm.h('PUT', '/api/state', { baseRev: 0, data: seedData(), opId: 'init-1' }); ok('administrateur : initialisation de l’état central (rév. 1)', r.s === 200 && r.j.rev === 1, r.j);
  r = await adm.h('PUT', '/api/state', { baseRev: 0, data: seedData(), opId: 'init-1' }); ok('7. une nouvelle tentative avec le même opId ne crée pas de doublon (même réponse)', r.s === 200 && r.j.rev === 1);

  const vPlan = (await C.plan.h('GET', '/api/state')).j, vScol = (await C.scol.h('GET', '/api/state')).j, vProf = (await C.prof.h('GET', '/api/state')).j;
  ok('6. scolarité : voit les dossiers étudiants complets', vScol.data.students.length === 3 && vScol.data.students[0].cin === 'AB123');
  ok('6. emploi du temps : voit les étudiants sans données personnelles (effectifs seulement)', vPlan.data.students.length === 3 && !vPlan.data.students[0].lastName && !vPlan.data.students[0].phone && !vPlan.data.students[0].cin);
  ok('6. enseignant : ne voit que SES séances', vProf.data.sessions.length === 1 && vProf.data.sessions[0].id === 'se1');
  ok('6. enseignant : ne voit que les étudiants de ses groupes, sans téléphone/CIN', vProf.data.students.length === 2 && vProf.data.students.every(s => !s.phone && !s.cin && !s.email));
  ok('6. enseignant : ne voit ni modèles, ni autres enseignants, ni téléphones', vProf.data.templates.length === 0 && vProf.data.teachers.length === 1 && !vProf.data.teachers[0].phone);
  r = await C.prof.h('PUT', '/api/state', { baseRev: vProf.rev, data: vProf.data }); ok('6. enseignant : ne peut pas modifier l’emploi du temps (403)', r.s === 403 && r.j.readOnly === true);
  let d = clone(vScol.data); d.sessions[0].startTime = '09:00';
  r = await C.scol.h('PUT', '/api/state', { baseRev: vScol.rev, data: d }); ok('6. scolarité : ne peut pas modifier les séances (403)', r.s === 403 && (r.j.forbidden || []).includes('sessions'), r.j);
  d = clone(vPlan.data); d.students[0].group = 'G9';
  r = await C.plan.h('PUT', '/api/state', { baseRev: vPlan.rev, data: d }); ok('6. emploi du temps : ne peut pas modifier les étudiants (403)', r.s === 403 && (r.j.forbidden || []).includes('students'));
  d = clone(vPlan.data); d.cfg.etab = 'Autre';
  r = await C.plan.h('PUT', '/api/state', { baseRev: vPlan.rev, data: d }); ok('6. emploi du temps : ne peut pas modifier la configuration (403)', r.s === 403);
  for (const [who, m, p] of [['plan', 'GET', '/api/users'], ['scol', 'GET', '/api/users'], ['prof', 'GET', '/api/users'], ['scol', 'GET', '/api/audit'], ['plan', 'GET', '/api/backups'], ['prof', 'GET', '/api/forms'], ['plan', 'GET', '/api/notifications'], ['prof', 'POST', '/api/sessions/sync'], ['plan', 'POST', '/api/forms'], ['prof', 'GET', '/api/server/info']]) {
    r = await C[who].h(m, p, m === 'GET' ? null : { sessions: [] }); ok('6. ' + who + ' : ' + m + ' ' + p + ' refusé (403)', r.s === 403, r.s);
  }
  r = await C.plan.h('POST', '/api/users', { username: 'pirate', role: 'admin', password: 'Pirate-Pirate-2026' }); ok('6. un non-administrateur ne peut pas créer de compte ni s’attribuer un rôle', r.s === 403);

  /* ---------- 6. deux postes : propagation, fusion, conflits ---------- */
  const A1 = client('posteA'), B1 = client('posteB');
  await A1.login('plan', PW.plan); await B1.login('plan', PW.plan);
  let a = (await A1.h('GET', '/api/state')).j, b = (await B1.h('GET', '/api/state')).j;
  ok('7. chargement initial identique sur les deux postes', a.rev === b.rev && JSON.stringify(a.data) === JSON.stringify(b.data));
  d = clone(a.data); d.rooms.push({ id: 'r3', name: 'Salle TP' });
  r = await A1.h('PUT', '/api/state', { baseRev: a.rev, data: d, opId: 'A-1' }); ok('7. poste A enregistre une nouvelle salle (le serveur renvoie la version finale s’il l’a complétée)', r.s === 200 && r.j.rev === a.rev + 1 && (!r.j.merged || (r.j.data && r.j.data.rooms.some(x => x.id === 'r3'))));
  const revA = r.j.rev;
  r = await B1.h('GET', '/api/state?since=' + b.rev); ok('7. poste B voit la modification de A (nouvelle révision, salle présente)', r.j.rev === revA && r.j.data.rooms.some(x => x.id === 'r3'));
  r = await B1.h('GET', '/api/state?since=' + revA); ok('7. interrogation sans changement : réponse légère « same »', r.j.same === true);
  // modifications concurrentes sur des éléments différents -> fusion automatique
  a = (await A1.h('GET', '/api/state')).j; b = clone(a);
  const dA = clone(a.data); dA.sessions[0].roomIds = ['r3'];
  const dB = clone(b.data); dB.subjects[1].name = 'Physiologie humaine';
  r = await A1.h('PUT', '/api/state', { baseRev: a.rev, data: dA }); const ra = r.j.rev;
  r = await B1.h('PUT', '/api/state', { baseRev: b.rev, data: dB });
  ok('7. modifications simultanées sur des éléments différents : fusion automatique sans perte', r.s === 200 && r.j.merged === true && r.j.data.sessions[0].roomIds[0] === 'r3' && r.j.data.subjects[1].name === 'Physiologie humaine', r.j);
  // même élément modifié des deux côtés -> conflit détecté, rien n'est écrasé
  a = (await A1.h('GET', '/api/state')).j; b = clone(a);
  const cA = clone(a.data); cA.sessions[1].startTime = '11:00';
  const cB = clone(b.data); cB.sessions[1].startTime = '14:00';
  r = await A1.h('PUT', '/api/state', { baseRev: a.rev, data: cA }); const revAfterA = r.j.rev;
  r = await B1.h('PUT', '/api/state', { baseRev: b.rev, data: cB });
  ok('8. même séance modifiée sur deux postes : conflit détecté (409) avec la liste des éléments', r.s === 409 && r.j.conflicts.length === 1 && r.j.conflicts[0].collection === 'sessions' && r.j.conflicts[0].id === 'se2', r.j);
  r = await adm.h('GET', '/api/state'); ok('8. aucun écrasement silencieux : la version du poste A est conservée', r.j.data.sessions[1].startTime === '11:00' && r.j.rev === revAfterA);
  const nbk = fs.readdirSync(BKD).length;
  r = await B1.h('PUT', '/api/state', { baseRev: b.rev, data: cB, resolve: 'mine' });
  ok('8. résolution explicite « garder ma version » : appliquée et tracée', r.s === 200 && r.j.data.sessions[1].startTime === '14:00');
  ok('8. une sauvegarde de sécurité est créée avant la résolution du conflit', fs.readdirSync(BKD).length === nbk + 1 && fs.readdirSync(BKD).some(n => /avant-resolution-conflit/.test(n)));
  // suppression contre modification
  a = (await A1.h('GET', '/api/state')).j; b = clone(a);
  const xA = clone(a.data); xA.rooms = xA.rooms.filter(x => x.id !== 'r2');
  const xB = clone(b.data); xB.rooms.find(x => x.id === 'r2').name = 'Amphi Ibn Sina';
  await A1.h('PUT', '/api/state', { baseRev: a.rev, data: xA });
  r = await B1.h('PUT', '/api/state', { baseRev: b.rev, data: xB }); ok('8. suppression sur A + modification sur B du même élément : conflit détecté', r.s === 409 && r.j.conflicts[0].id === 'r2');
  // champs dérivés (statut recalculé par chaque poste) : pas de faux conflit
  a = (await C.scol.h('GET', '/api/state')).j; d = clone(a.data); d.sessions.forEach(s => { s.status = 'realisee'; s.declStatus = 'non_declaree'; }); d.students[0].phone = '0699999999';
  r = await C.scol.h('PUT', '/api/state', { baseRev: a.rev, data: d }); ok('6. scolarité : peut modifier un étudiant (les statuts recalculés des séances ne comptent pas comme modification)', r.s === 200, r.j);
  // révision inconnue/trop ancienne
  r = await A1.h('PUT', '/api/state', { baseRev: 99999, data: a.data }); ok('7. copie de base inconnue : refus explicite (409 needFull), aucune écriture', r.s === 409 && r.j.needFull === true);

  /* ---------- 7. absences selon le rôle ---------- */
  const abs = (sid, extra) => ({ sessionId: sid, subject: 'X', teacher: 'Y', date: '2026-06-15', start: '08:30', end: '10:30', absent: [{ m: 'M001', n: 'ALAOUI Sara' }], enrolled: 2, remark: '', ...(extra || {}) });
  r = await C.prof.h('POST', '/api/absences', abs('se2')); ok('6. enseignant : refus d’enregistrer des absences pour une séance d’un autre enseignant', r.s === 403);
  r = await C.prof.h('POST', '/api/absences', abs('se1')); ok('6. enseignant : enregistre les absences de SA séance', r.s === 200, r.j);
  const absId = r.j.id;
  r = await C.prof.h('POST', '/api/absences', abs('se1')); ok('7. double envoi de la même déclaration refusé (pas de doublon)', r.s === 409);
  r = await C.prof2.h('GET', '/api/absences'); ok('6. un autre enseignant ne voit pas cette déclaration', r.s === 200 && r.j.items.length === 0);
  r = await C.prof.h('GET', '/api/absences'); ok('6. l’enseignant voit sa déclaration', r.j.items.length === 1 && r.j.items[0].source === 'enseignant');
  r = await C.plan.h('GET', '/api/absences'); ok('6. emploi du temps : totaux seulement, sans noms d’étudiants', r.s === 200 && r.j.items[0].total === 1 && r.j.items[0].absent.length === 0);
  r = await C.prof.h('POST', '/api/absences/' + absId + '/cancel', { reason: 'erreur' }); ok('6. enseignant : ne peut pas annuler une déclaration', r.s === 403);
  r = await C.prof.h('POST', '/api/absences/' + absId + '/amend', { reason: 'oubli', absent: [{ m: 'M001', n: 'A' }, { m: 'M002', n: 'B' }] }); ok('6. enseignant : peut corriger sa déclaration dans le délai de 24 h', r.s === 200, r.j);
  r = await C.scol.h('POST', '/api/absences/' + absId + '/cancel', { reason: 'doublon papier' }); ok('6. scolarité : peut annuler une déclaration (motif obligatoire)', r.s === 200);

  /* ---------- 8. comptes : désactivation, verrouillage, réinitialisation ---------- */
  const uProf2 = users.find(x => x.username === 'prof2');
  r = await adm.h('PUT', '/api/users/' + uProf2.id, { disabled: true }); ok('8. administrateur : désactivation d’un compte', r.s === 200);
  r = await C.prof2.h('GET', '/api/me'); ok('8. un compte désactivé perd immédiatement sa session', r.j.auth === false);
  r = await client('x').login('prof2', PW.prof2); ok('8. un compte désactivé ne peut plus se connecter', r.s === 401);
  const admId = users.find(x => x.username === 'admin').id;
  r = await adm.h('PUT', '/api/users/' + admId, { role: 'planning' }); ok('8. impossible de retirer le dernier administrateur', r.s === 400);
  const lk = client('lk'); const codesLk = []; for (let i = 0; i < 6; i++) codesLk.push((await lk.login('scol', 'mauvais-' + i)).s);
  r = await lk.login('scol', PW.scol); ok('sécurité : verrouillage temporaire après 5 échecs (même avec le bon mot de passe ensuite)', codesLk.includes(423) && r.s === 423, codesLk.concat(r.s));
  const uScol = users.find(x => x.username === 'scol');
  r = await adm.h('POST', '/api/users/' + uScol.id + '/unlock', {}); r = await lk.login('scol', PW.scol); ok('8. l’administrateur peut déverrouiller un compte', r.s === 200);
  r = await adm.h('POST', '/api/users/' + uScol.id + '/reset-password', { password: 'Temporaire-Dossier-2026' }); ok('8. réinitialisation du mot de passe par l’administrateur', r.s === 200);
  r = await C.scol.h('GET', '/api/me'); ok('8. la réinitialisation ferme les sessions ouvertes du compte', r.j.auth === false);
  r = await C.scol.login('scol', 'Temporaire-Dossier-2026'); ok('8. connexion avec le mot de passe temporaire : changement obligatoire', r.s === 200 && r.j.user.mustChange === true);
  r = await adm.h('GET', '/api/audit'); const ev = r.j.items.map(e => e.event + '|' + (e.user || ''));
  ok('audit : journal chaîné valide, avec utilisateur, action et date', r.j.valid === true && ev.some(e => e.startsWith('compte créé|admin')) && ev.some(e => e.startsWith('données centrales enregistrées|plan')) && r.j.items.every(e => e.at));
  ok('audit : les refus de droits sont journalisés', ev.some(e => e.startsWith('modification refusée (droits)|scol')));

  /* ---------- 9. persistance après redémarrage ---------- */
  const before = (await adm.h('GET', '/api/state')).j;
  await stop(); await start();
  r = await adm.h('GET', '/api/me'); ok('9. la session survit au redémarrage du serveur', r.j.auth === true);
  const after = (await adm.h('GET', '/api/state')).j;
  ok('9. les données et la révision sont identiques après redémarrage', after.rev === before.rev && JSON.stringify(after.data) === JSON.stringify(before.data));
  r = await adm.h('GET', '/api/absences'); ok('9. les déclarations d’absences persistent', r.j.items.some(x => x.id === absId));

  /* ---------- 10. sauvegarde et restauration ---------- */
  r = await adm.h('POST', '/api/backups', {}); const bkName = r.j.backup; ok('10. sauvegarde à la demande (administrateur)', r.s === 200 && fs.existsSync(path.join(BKD, bkName, 'manifest.json')));
  const revBk = after.rev;
  d = clone(after.data); d.rooms.push({ id: 'r9', name: 'Salle ajoutée après sauvegarde' });
  await adm.h('PUT', '/api/state', { baseRev: after.rev, data: d });
  r = cli('restore.js', ['--name', bkName, '--yes']); ok('10. la restauration est refusée tant que le serveur tourne', r.status === 10);
  await stop();
  fs.appendFileSync(path.join(BKD, bkName, 'state.json'), ' '); r = cli('restore.js', ['--name', bkName, '--yes']); ok('10. une sauvegarde altérée est détectée et refusée', r.status === 1 && /altérée/.test(r.stderr), r.stderr);
  const t = fs.readFileSync(path.join(BKD, bkName, 'state.json'), 'utf8'); fs.writeFileSync(path.join(BKD, bkName, 'state.json'), t.slice(0, -1));
  r = cli('restore.js', ['--name', bkName, '--yes']); ok('10. restauration depuis la sauvegarde', r.status === 0, r.stdout + r.stderr);
  await start(); await adm.login('admin', PW.admin);
  r = (await adm.h('GET', '/api/state')).j;
  ok('10. données restaurées (la salle ajoutée après la sauvegarde a disparu) avec une révision plus récente pour forcer le rechargement des postes', !r.data.rooms.some(x => x.id === 'r9') && r.rev > revBk + 1, r.rev);
  ok('10. une copie « avant-restauration » a été conservée', fs.readdirSync(BKD).some(n => /avant-restauration/.test(n)));

  /* ---------- 11. journaux ---------- */
  const logTxt = fs.readdirSync(LOGS).map(f => fs.readFileSync(path.join(LOGS, f), 'utf8')).join('\n');
  const leaks = Object.values(PW).concat(['Temporaire-Dossier-2026', 'AB123', '0611111111']).filter(s => logTxt.includes(s));
  ok('13. aucun mot de passe ni donnée personnelle dans les journaux', logTxt.length > 0 && leaks.length === 0, leaks);
  ok('13. aucun jeton de session dans les journaux', !/sid=[A-Za-z0-9_-]{40}/.test(logTxt));
  await stop();

  /* ---------- 11b. limitation par adresse IP ---------- */
  await start({ LOGIN_RATE_PER_MIN: '3' });
  const rl = client('rl'); const rc = []; for (let i = 0; i < 5; i++) rc.push((await rl.login('inconnu' + i, 'x')).s);
  ok('sécurité : limitation des tentatives de connexion par adresse IP (429)', rc.slice(0, 3).every(c => c === 401) && rc[4] === 429, rc);
  await stop();

  /* ---------- 12. filtrage réseau optionnel ---------- */
  await start({ ALLOWED_NETWORKS: '10.99.0.0/16' });
  r = await fetch(B + '/health'); ok('14. ALLOWED_NETWORKS : une adresse hors du réseau autorisé est refusée (403)', r.status === 403);
  await stop();
  await start({ ALLOWED_NETWORKS: '127.0.0.0/8,192.168.1.0/24' });
  r = await fetch(B + '/health'); ok('14. ALLOWED_NETWORKS : une adresse autorisée est acceptée', r.status === 200);
  await stop();

  /* ---------- 13. HTTPS ---------- */
  const ossl = cp.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=unitimetable-test', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(ROOT, 'k.pem'), '-out', path.join(ROOT, 'c.pem')], { encoding: 'utf8' });
  if (ossl.status === 0) {
    await start({ TLS_CERT: path.join(ROOT, 'c.pem'), TLS_KEY: path.join(ROOT, 'k.pem') });
    const ca = fs.readFileSync(path.join(ROOT, 'c.pem'));
    const get = (opts) => new Promise(res => { const q = https.get({ host: '127.0.0.1', port: PORT, path: '/health', ...opts }, s => { let x = ''; s.on('data', c => x += c); s.on('end', () => res({ s: s.statusCode, x })); }); q.on('error', e => res({ e: e.code || e.message })); });
    r = await get({ ca }); ok('HTTPS : le serveur répond en TLS avec un certificat de confiance', r.s === 200 && JSON.parse(r.x).https === true, r);
    r = await get({}); ok('HTTPS : un certificat non approuvé est rejeté par le client (vérification jamais désactivée)', !!r.e, r);
    const lg = await new Promise(res => { const q = https.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', ca, headers: { 'Content-Type': 'application/json' } }, s => res(s.headers['set-cookie'] || [])); q.end(JSON.stringify({ username: 'admin', password: PW.admin })); });
    ok('HTTPS : le cookie de session porte l’attribut Secure', /Secure/.test(lg.join(';')), lg);
    await stop();
  } else ok('HTTPS (openssl absent : test non exécuté)', true);

  /* ---------- 14. compatibilité : ADMIN_PASSWORD (Docker/Render) ---------- */
  const D2 = path.join(ROOT, 'data2'); ENV.DATA_DIR = D2;
  await start({ ADMIN_PASSWORD: 'compat-password-123' });
  r = await client('c').login(undefined, 'compat-password-123'); ok('compatibilité : ADMIN_PASSWORD crée le compte « admin » au premier démarrage (ancien écran sans identifiant)', r.s === 200 && r.j.user.role === 'admin');
  await stop();

  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* */ }
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.log('ERREUR', e); try { await stop(); } catch (x) { /* */ } process.exit(1); });

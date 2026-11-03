/* Tests du mode « cloud » (Vercel + Supabase), avec un VRAI PostgreSQL et supabase/schema.sql.
   Deux instances du serveur partagent la même base, comme deux fonctions Vercel simultanées.
   PG="-h <hôte> -p <port> -U <utilisateur>" node tests/cloud.test.js     (sans PG : test ignoré) */
'use strict';
const fs = require('fs'), cp = require('child_process'), path = require('path');
const PG = (process.env.PG || '').split(' ').filter(Boolean);
if (!PG.length) { console.log('SKIP : définir PG (accès psql à un PostgreSQL de test)'); process.exit(0); }
const DIR = path.join(__dirname, '..'), DB = 'unitt_cloud_' + Date.now();
const psql = (q, db) => cp.spawnSync('psql', [...PG, '-d', db || 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: q, encoding: 'utf8' });
const KEY = 'cle-service-test-' + Date.now(), MP = 9500 + Math.floor(Math.random() * 100), PA = MP + 100, PB = MP + 200;
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
function spawnWait(args, env, re) {
  return new Promise((res, rej) => { const p = cp.spawn(process.execPath, args, { cwd: DIR, env: { ...process.env, ...env } }); procs.push(p); let o = ''; const on = d => { o += d; if (re.test(o)) res(p); }; p.stdout.on('data', on); p.stderr.on('data', on); setTimeout(() => rej(new Error('timeout ' + o)), 10000); });
}
const ENV = extra => ({ UNITT_STORAGE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:' + MP, SUPABASE_SERVICE_ROLE_KEY: KEY, SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: '/nonexistent', LOGIN_RATE_PER_MIN: '1000', ALLOW_EARLY: '1', ...extra });
const instance = (port, extra) => spawnWait(['tools/cloud-dev.js'], ENV({ PORT: String(port), ...extra }), /démarré/);
function client(port) { const c = { cookie: '', port }; c.h = async (m, p, b, hd) => { const r = await fetch('http://127.0.0.1:' + c.port + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...(hd || {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0]; let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j, sc }; }; c.login = (u, p) => c.h('POST', '/api/login', { username: u, password: p }); return c; }
const PW = 'Mot-De-Passe-Cloud-2026', T = 'Temporaire-Cloud-2026';
const data = () => ({ teachers: [{ id: 't1', name: 'Dr. A' }, { id: 't2', name: 'Pr. B' }], rooms: [{ id: 'r1', name: 'A101' }], levels: [], programs: [{ id: 'p', name: 'IP' }], subjects: [{ id: 's1', name: 'Anatomie' }], sessions: [{ id: 'se1', subjectId: 's1', teacherId: 't1', roomId: 'r1', date: '2026-06-15', startTime: '08:00', endTime: '10:00', programId: 'p', year: '1', group: 'G1' }, { id: 'se2', subjectId: 's1', teacherId: 't2', roomId: 'r1', date: '2026-06-15', startTime: '10:00', endTime: '12:00', programId: 'p', year: '1', group: 'G1' }], students: [{ id: 'st1', matricule: '00123', lastName: 'Alaoui', firstName: 'Sara', programId: 'p', year: '1', group: 'G1', cin: 'X1' }], volumes: [], cal: { start: '', end: '' }, absences: [], templates: [], tplCats: [], cfg: {}, audit: [], events: [], notCommon: [] });

(async () => {
  let r = psql('create database ' + DB);
  if (r.status !== 0) { console.log('ERREUR base : ' + r.stderr); process.exit(1); }
  psql("do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;", DB);
  r = psql(fs.readFileSync(path.join(DIR, '..', 'supabase', 'schema.sql'), 'utf8'), DB);
  ok('schéma Supabase appliqué sur un PostgreSQL réel', r.status === 0, r.stderr);
  await spawnWait(['tests/support/supabase-mock.js', String(MP), KEY, ...PG, '-d', DB], {}, /prêt/);

  /* 1. base vide, pas d'administrateur par défaut */
  let A = await instance(PA);
  const anon = client(PA);
  r = await anon.h('GET', '/api/me'); ok('base vide : aucun compte, création du premier administrateur demandée', r.j.setupRequired === true && r.j.auth === false);
  r = await anon.login('admin', 'admin'); ok('aucun mot de passe par défaut', r.s === 401);
  r = await fetch('http://127.0.0.1:' + PA + '/'); ok('l’interface est servie (page d’accueil)', r.status === 200 && /UniTimetable/.test(await r.text()));
  r = await fetch('http://127.0.0.1:' + PA + '/vendor/pdf.js'); ok('bibliothèques servies par la fonction (pdf.js)', r.status === 200);
  A.kill(); await sleep(300);

  /* 2. premier administrateur via ADMIN_PASSWORD (variable Vercel) */
  A = await instance(PA, { ADMIN_PASSWORD: PW });
  const B = await instance(PB);           // 2e instance, comme une autre fonction Vercel
  const adm = client(PA);
  r = await adm.login('admin', PW); ok('premier administrateur créé depuis ADMIN_PASSWORD', r.s === 200 && r.j.user.role === 'admin');
  const row = psql("select data->'users'->0->>'username', data->'users'->0->'pw'->>'alg', position('" + PW + "' in data::text) from unitt_docs where id='store'", DB).stdout.trim();
  ok('compte enregistré dans Supabase, mot de passe haché (scrypt), jamais en clair', row === 'admin|scrypt|0', row);
  r = await adm.h('POST', '/api/login', { username: 'admin', password: PW }, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' });
  ok('derrière Vercel (https) : cookie de session Secure, HttpOnly, SameSite=Strict', /Secure/.test(r.sc) && /HttpOnly/.test(r.sc) && /SameSite=Strict/.test(r.sc), r.sc);
  const admB = client(PB); admB.cookie = adm.cookie;
  r = await admB.h('GET', '/api/me'); ok('la session ouverte sur une instance est valable sur une autre (stockée dans Supabase)', r.j.auth === true && r.j.user.username === 'admin');

  /* 3. comptes et rôles */
  for (const [u, role, extra] of [['plan', 'planning'], ['prof', 'teacher', { teacherId: 't1' }], ['scol', 'scolarite']]) {
    r = await adm.h('POST', '/api/users', { username: u, displayName: u, role, password: T, ...(extra || {}) }); if (r.s !== 200) ok('création ' + u, false, r.j);
  }
  const C = {}; for (const [u, port] of [['plan', PA], ['prof', PB], ['scol', PB]]) { C[u] = client(port); await C[u].login(u, T); await C[u].h('POST', '/api/account/password', { current: T, next: PW + '-' + u.length }); }
  r = await C.prof.h('GET', '/api/me'); ok('comptes créés, mot de passe changé à la première connexion (sur l’autre instance)', r.j.user.role === 'teacher' && !r.j.user.mustChange);

  /* 4. état central, rôles, vues filtrées */
  r = await adm.h('PUT', '/api/state', { baseRev: 0, data: data() }); ok('initialisation des données par l’administrateur', r.s === 200 && r.j.rev === 1, r.j);
  ok('révision enregistrée dans unitt_history', psql('select count(*) from unitt_history', DB).stdout.trim() === '1');
  let v = (await C.prof.h('GET', '/api/state')).j; ok('enseignant (instance B) : uniquement sa séance, étudiants sans CIN', v.data.sessions.length === 1 && v.data.sessions[0].id === 'se1' && !v.data.students[0].cin);
  r = await C.prof.h('GET', '/api/sessions/se2'); ok('enseignant : séance d’un autre -> 403', r.s === 403);
  r = await C.prof.h('PUT', '/api/state', { baseRev: v.rev, data: v.data }); ok('enseignant : modification de l’emploi du temps refusée', r.s === 403);
  v = (await C.scol.h('GET', '/api/state')).j; let d = JSON.parse(JSON.stringify(v.data)); d.sessions[0].startTime = '09:00';
  r = await C.scol.h('PUT', '/api/state', { baseRev: v.rev, data: d }); ok('scolarité : modification des séances refusée', r.s === 403);
  r = await C.plan.h('GET', '/api/users'); ok('planification : gestion des comptes refusée', r.s === 403);

  /* 5. écritures simultanées sur deux instances : aucune perte (contrôle de version + nouvelle tentative) */
  const base = (await C.plan.h('GET', '/api/state')).j;
  const N = 16;
  const res = await Promise.all(Array.from({ length: N }, (_, i) => { const c = client(i % 2 ? PB : PA); c.cookie = C.plan.cookie; const dd = JSON.parse(JSON.stringify(base.data)); dd.rooms.push({ id: 'room' + i, name: 'Salle ' + i }); return c.h('PUT', '/api/state', { baseRev: base.rev, data: dd }); }));
  const fin = (await adm.h('GET', '/api/state')).j;
  ok(N + ' enregistrements simultanés répartis sur 2 instances : tous réussis', res.every(x => x.s === 200), res.map(x => x.s));
  ok('… et aucune modification perdue (fusion + contrôle de version Supabase)', Array.from({ length: N }, (_, i) => 'room' + i).every(id => fin.data.rooms.some(x => x.id === id)), fin.data.rooms.length);
  ok('révision finale cohérente (une révision par enregistrement)', fin.rev === base.rev + N, fin.rev);

  /* 6. conflit sur le même élément : détecté, rien d'écrasé */
  const b2 = (await C.plan.h('GET', '/api/state')).j;
  const x1 = JSON.parse(JSON.stringify(b2.data)); x1.rooms[0].name = 'Version A';
  const x2 = JSON.parse(JSON.stringify(b2.data)); x2.rooms[0].name = 'Version B';
  await C.plan.h('PUT', '/api/state', { baseRev: b2.rev, data: x1 });
  const pb = client(PB); pb.cookie = C.plan.cookie;
  r = await pb.h('PUT', '/api/state', { baseRev: b2.rev, data: x2 }); ok('même élément modifié depuis deux endroits : conflit 409', r.s === 409 && r.j.conflicts[0].id === 'r1');
  ok('pas d’écrasement silencieux', (await adm.h('GET', '/api/state')).j.data.rooms[0].name === 'Version A');

  /* 7. absences et alertes */
  r = await C.prof.h('POST', '/api/absences', { sessionId: 'se1', date: '2026-06-15', start: '08:00', absent: [{ m: '00123', n: 'ALAOUI Sara' }] }); ok('enseignant : déclaration d’absences enregistrée', r.s === 200);
  r = await C.prof.h('POST', '/api/absences', { sessionId: 'se1', date: '2026-06-15', absent: [] }); ok('double envoi refusé', r.s === 409);
  r = await adm.h('GET', '/api/alerts'); ok('alertes calculées à chaque requête (séance se2 non déclarée)', r.j.items.some(a => a.sessionId === 'se2' && !a.resolvedAt) && !r.j.items.some(a => a.sessionId === 'se1' && !a.resolvedAt), r.j.items.map(a => a.sessionId + (a.resolvedAt ? '✓' : '')));

  /* 8. sauvegardes */
  r = await adm.h('POST', '/api/backups', {}); ok('sauvegarde manuelle -> table unitt_backups', r.s === 200 && +psql('select count(*) from unitt_backups', DB).stdout.trim() >= 1);
  r = await adm.h('GET', '/api/backups'); ok('liste des sauvegardes', r.s === 200 && r.j.items.length >= 1 && r.j.items[0].reason);
  r = await C.plan.h('POST', '/api/backups', {}); ok('sauvegarde refusée aux non-administrateurs', r.s === 403);

  /* 9. redémarrage complet (nouvelles instances = « démarrage à froid ») */
  const revBefore = (await adm.h('GET', '/api/state')).j.rev;
  for (const p of procs.splice(1)) p.kill(); await sleep(300);
  const A2 = await instance(PA); procs.push(A2);
  const a2 = client(PA); a2.cookie = adm.cookie;
  r = await a2.h('GET', '/api/state'); ok('démarrage à froid : session, données et révision conservées', r.s === 200 && r.j.rev === revBefore && r.j.data.rooms.length === 1 + N);
  r = await a2.h('GET', '/api/audit'); ok('journal d’audit chaîné et valide dans Supabase', r.j.valid === true && r.j.items.some(e => e.event === 'connexion'));
  r = await a2.h('GET', '/api/absences'); ok('déclarations conservées', r.j.items.length === 1);

  /* 10. sécurité de la base */
  const bad = await fetch('http://127.0.0.1:' + MP + '/rest/v1/unitt_docs?select=data', { headers: { apikey: 'cle-publique', Authorization: 'Bearer cle-publique' } });
  ok('simulation : sans la clé service_role, la base refuse', bad.status === 401);
  r = psql("set role anon; select count(*) from unitt_docs;", DB); ok('PostgreSQL : le rôle public (anon) ne peut pas lire les tables', r.status !== 0 && /permission denied/.test(r.stderr));
  r = psql("set role anon; select unitt_save('{}',0,null,null,null,null,50);", DB); ok('PostgreSQL : le rôle public ne peut pas exécuter les fonctions d’écriture', r.status !== 0 && /permission denied/.test(r.stderr));
  r = await a2.h('POST', '/api/server/shutdown', {}, { 'X-Unitt-Control': 'x' }); ok('aucun arrêt du serveur à distance en mode cloud', r.s === 404 || r.s === 401);

  for (const p of procs) p.kill();
  psql('drop database ' + DB + ' with (force)');
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERREUR', e); for (const p of procs) p.kill(); process.exit(1); });

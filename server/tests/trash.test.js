/* Phase 2 : suppression logique, corbeille, restauration avec conflits, journal (suppression et restauration = événements distincts).
   node tests/trash.test.js        PG="…" pour tester aussi le mode cloud (Supabase simulé sur un vrai PostgreSQL) */
'use strict';
const fs = require('fs'), cp = require('child_process'), path = require('path'), os = require('os');
const DIR = path.join(__dirname, '..'), PG = (process.env.PG || '').split(' ').filter(Boolean);
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = []; process.on('exit', () => procs.forEach(p => { try { p.kill(); } catch (e) { } }));
function spawnWait(args, env, re) { return new Promise((res, rej) => { const p = cp.spawn(process.execPath, args, { cwd: DIR, env: { ...process.env, ...env } }); procs.push(p); let o = ''; const on = d => { o += d; if (re.test(o)) res(p); }; p.stdout.on('data', on); p.stderr.on('data', on); setTimeout(() => rej(new Error('timeout ' + o)), 15000); }); }
function client(base) {
  const c = { jar: {} };
  c.h = async (m, p, b) => { const ck = Object.entries(c.jar).map(([k, v]) => k + '=' + v).join('; '); const r = await fetch(base + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(ck ? { Cookie: ck } : {}) }, body: b ? JSON.stringify(b) : undefined }); for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); c.jar[kv.slice(0, i)] = kv.slice(i + 1); } let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j }; };
  c.login = (u, p, etab) => c.h('POST', '/api/login', { username: u, password: p, etab });
  return c;
}
const SA = { u: 'proprio.test', p0: 'Initial-Plateforme-2026!x', p: 'Plateforme-Forte-2026!y' };
const data = () => ({
  teachers: [{ id: 't1', name: 'Dr. Amrani' }, { id: 't2', name: 'Pr. Benali' }], rooms: [{ id: 'r1', name: 'A101' }, { id: 'r2', name: 'B202' }],
  levels: [{ id: 'l1', name: 'IP 1' }], programs: [{ id: 'p', name: 'IP', label: 'Infirmier polyvalent' }], subjects: [{ id: 's1', name: 'Anatomie', level: 'l1' }, { id: 's2', name: 'Physiologie', level: 'l1' }],
  sessions: [{ id: 'se1', subjectId: 's1', teacherId: 't1', roomId: 'r1', extraRooms: [], date: '2026-12-01', day: 'TUE', startTime: '08:00', endTime: '10:00', programId: 'p', year: '1', group: 'G1' },
    { id: 'se2', subjectId: 's2', teacherId: 't2', roomId: 'r2', extraRooms: [], date: '2026-12-01', day: 'TUE', startTime: '10:00', endTime: '12:00', programId: 'p', year: '1', group: 'G1' }],
  students: [{ id: 'st1', matricule: 'M001', lastName: 'Alaoui', firstName: 'Sara', programId: 'p', year: '1', group: 'G1' }, { id: 'st2', matricule: 'M002', lastName: 'Bennani', firstName: 'Omar', programId: 'p', year: '1', group: 'G1' }],
  volumes: [], cal: { start: '', end: '' }, absences: [], templates: [{ id: 'tp1', name: 'Attestation', category: 'Attestation de scolarité', content: 'x'.repeat(2000) }], tplCats: [], cfg: {}, audit: [], events: [], notCommon: []
});
async function scenario(mode, start, extra) {
  const L = s => mode + ' : ' + s;
  const srv = await start(), B = srv.base;
  const sa = client(B); await sa.h('POST', '/api/platform/login', { username: SA.u, password: SA.p0 }); await sa.h('POST', '/api/platform/password', { current: SA.p0, next: SA.p });
  let r = await sa.h('POST', '/api/platform/tenants', { name: 'Faculté Corbeille', slug: 'corb', admin: { username: 'admin', password: 'Temporaire-Corb-2026' } }); const T = r.j.tenant;
  const a = client(B); await a.login('admin', 'Temporaire-Corb-2026', 'corb'); await a.h('POST', '/api/account/password', { current: 'Temporaire-Corb-2026', next: 'Direction-Corb-2026x' });
  r = await a.h('GET', '/api/state'); r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: data() }); ok(L('données initiales'), r.s === 200, r.j);
  // employé scolarité : supprime un étudiant
  await a.h('POST', '/api/users', { username: 'scol', displayName: 'Scolarité', role: 'scolarite', password: 'Bureau-Temp-2026xy' });
  const sc = client(B); await sc.login('scol', 'Bureau-Temp-2026xy', 'corb'); await sc.h('POST', '/api/account/password', { current: 'Bureau-Temp-2026xy', next: 'Bureau-Etudes-2026x' });
  r = await sc.h('GET', '/api/state'); let d = r.j.data; d.students = d.students.filter(s => s.id !== 'st1');
  r = await sc.h('PUT', '/api/state', { baseRev: r.j.rev, data: d, deleteReason: 'Abandon des études' }); ok(L('suppression d’un étudiant par la scolarité'), r.s === 200, r.j);
  r = await a.h('GET', '/api/state'); ok(L('l’étudiant n’apparaît plus dans les vues normales'), !r.j.data.students.some(s => s.id === 'st1'));
  r = await a.h('GET', '/api/trash'); const e1 = r.j.items.find(e => e.recordId === 'st1');
  ok(L('corbeille : élément conservé avec auteur, date, motif, type'), e1 && e1.status === 'deleted' && e1.deletedBy === 'scol' && e1.reason === 'Abandon des études' && e1.type === 'Étudiant' && /Alaoui/i.test(e1.label) && e1.deletedAt, e1);
  r = await a.h('GET', '/api/trash/' + e1.id); ok(L('corbeille : valeurs d’origine complètes conservées (même identifiant)'), r.j.entry.data.id === 'st1' && r.j.entry.data.matricule === 'M001' && Array.isArray(r.j.entry.data.groupHistory));
  r = await sc.h('POST', '/api/trash/' + e1.id + '/restore', { reason: 'x' }); ok(L('utilisateur ordinaire : restauration refusée'), r.s === 403);
  r = await sc.h('GET', '/api/trash'); ok(L('la scolarité voit les suppressions de ses rubriques'), r.s === 200 && r.j.items.some(e => e.recordId === 'st1'));
  // planification : ne voit pas les étudiants supprimés (données nominatives)
  await a.h('POST', '/api/users', { username: 'plan', displayName: 'Planning', role: 'planning', password: 'Horaires-Temp-2026x' });
  const pl = client(B); await pl.login('plan', 'Horaires-Temp-2026x', 'corb'); await pl.h('POST', '/api/account/password', { current: 'Horaires-Temp-2026x', next: 'Horaires-Def-2026x' });
  r = await pl.h('GET', '/api/trash'); ok(L('planification : ne voit pas les étudiants supprimés'), r.s === 200 && !r.j.items.some(e => e.collection === 'students'));
  // doublon : un nouvel étudiant prend le même matricule
  r = await a.h('GET', '/api/state'); d = r.j.data; d.students.push({ id: 'st9', matricule: 'M001', lastName: 'Autre', firstName: 'X', programId: 'p', year: '1', group: 'G1' });
  r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d });
  r = await a.h('GET', '/api/trash/' + e1.id + '/check'); ok(L('vérification avant restauration : doublon de matricule signalé'), r.j.conflicts.some(c => c.type === 'doublon' && /M001/.test(c.message)), r.j);
  r = await a.h('POST', '/api/trash/' + e1.id + '/restore', { reason: 'erreur' }); ok(L('restauration refusée tant que le doublon existe (409 + message clair)'), r.s === 409 && r.j.conflicts.length >= 1);
  r = await a.h('GET', '/api/state'); d = r.j.data; d.students = d.students.filter(s => s.id !== 'st9'); r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d });
  r = await a.h('POST', '/api/trash/' + e1.id + '/restore', { reason: 'Réinscription validée' }); ok(L('conflit résolu : restauration'), r.s === 200 && r.j.entry.status === 'restored', r.j);
  r = await a.h('GET', '/api/state'); const st1 = r.j.data.students.find(s => s.id === 'st1');
  ok(L('restauré avec le MÊME identifiant, sans doublon'), st1 && r.j.data.students.filter(s => s.id === 'st1').length === 1 && st1.matricule === 'M001');
  ok(L('historique de groupe d’origine conservé à la restauration'), st1 && st1.groupHistory && st1.groupHistory[0].from === '');
  r = await a.h('POST', '/api/trash/' + e1.id + '/restore', {}); ok(L('pas de double restauration'), r.s === 409);
  r = await a.h('GET', '/api/trash?status=all'); const e1b = r.j.items.find(e => e.id === e1.id);
  ok(L('corbeille : l’historique de suppression reste disponible après restauration'), e1b.status === 'restored' && e1b.deletedBy === 'scol' && e1b.history.length === 2 && e1b.restoredBy === 'admin');
  r = await a.h('GET', '/api/audit?record=' + encodeURIComponent('M001') + '&order=asc');
  const evs = r.j.items.filter(e => /suppression logique|restauration$/.test(e.event)).map(e => e.event + '|' + e.user);
  ok(L('journal : suppression puis restauration = deux événements distincts, dans l’ordre'), evs.indexOf('suppression logique|scol') >= 0 && evs.indexOf('restauration|admin') > evs.indexOf('suppression logique|scol'), evs);
  // dépendances et conflits d'emploi du temps
  r = await a.h('GET', '/api/state'); d = r.j.data; d.sessions = d.sessions.filter(s => s.id !== 'se1'); d.teachers = d.teachers.filter(t => t.id !== 't1');
  r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d }); ok(L('suppression d’une séance et de son enseignant'), r.s === 200);
  r = await a.h('GET', '/api/trash'); const es = r.j.items.find(e => e.recordId === 'se1'), et = r.j.items.find(e => e.recordId === 't1');
  r = await a.h('POST', '/api/trash/' + es.id + '/restore', {}); ok(L('dépendance : la séance ne peut pas revenir sans son enseignant (dans la corbeille)'), r.s === 409 && r.j.conflicts.some(c => c.type === 'dépendance' && /corbeille/.test(c.message)), r.j);
  r = await a.h('POST', '/api/trash/' + et.id + '/restore', {}); ok(L('restauration de l’enseignant'), r.s === 200);
  r = await a.h('GET', '/api/state'); d = r.j.data; d.sessions.push({ id: 'se5', subjectId: 's2', teacherId: 't2', roomId: 'r1', extraRooms: [], date: '2026-12-01', day: 'TUE', startTime: '09:00', endTime: '10:00', programId: 'p', year: '2', group: 'G1' });
  r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d });
  r = await a.h('POST', '/api/trash/' + es.id + '/restore', {}); ok(L('conflit d’emploi du temps : salle déjà occupée sur le créneau → refus'), r.s === 409 && r.j.conflicts.some(c => c.type === 'emploi du temps' && /Salle « A101 »/.test(c.message)), r.j);
  r = await a.h('GET', '/api/state'); d = r.j.data; d.sessions.find(s => s.id === 'se5').roomId = 'r2'; d.sessions.find(s => s.id === 'se5').startTime = '07:00'; d.sessions.find(s => s.id === 'se5').endTime = '08:00';
  r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d });
  r = await a.h('POST', '/api/trash/' + es.id + '/restore', { reason: 'séance maintenue' }); ok(L('créneau libéré : séance restaurée'), r.s === 200, r.j);
  r = await a.h('GET', '/api/state'); ok(L('séance restaurée : mêmes liens (matière, enseignant, salle)'), r.j.data.sessions.some(s => s.id === 'se1' && s.teacherId === 't1' && s.roomId === 'r1' && s.subjectId === 's1'));
  // motif obligatoire (réglage de l'établissement)
  r = await sc.h('PUT', '/api/prefs', { requireDeleteReason: true }); ok(L('réglage du motif obligatoire réservé à l’administrateur'), r.s === 403);
  r = await a.h('PUT', '/api/prefs', { requireDeleteReason: true }); ok(L('administrateur : motif de suppression rendu obligatoire'), r.s === 200);
  r = await a.h('GET', '/api/state'); d = r.j.data; d.templates = [];
  let r2 = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d }); ok(L('motif obligatoire : suppression sans motif refusée, liste des éléments renvoyée'), r2.s === 400 && r2.j.needDeleteReason === true && r2.j.deletions[0].label === 'Attestation');
  r2 = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d, deleteReason: 'Modèle obsolète' }); ok(L('motif fourni : suppression acceptée'), r2.s === 200);
  r = await a.h('GET', '/api/audit?event=' + encodeURIComponent('suppression logique') + '&record=Attestation');
  ok(L('journal : contenu volumineux du modèle résumé, motif inscrit'), r.j.items[0] && r.j.items[0].motif === 'Modèle obsolète' && /volumineux/.test(r.j.items[0].ancien.content));
  // rôle personnalisé supprimé → corbeille
  await a.h('PUT', '/api/roles/custom/c_temp', { label: 'Temporaire', perms: ['state.read'] });
  r = await a.h('DELETE', '/api/roles/custom/c_temp'); r = await a.h('GET', '/api/trash?collection=customRoles'); const er = r.j.items[0];
  ok(L('rôle personnalisé supprimé : conservé dans la corbeille'), er && er.recordId === 'c_temp');
  r = await a.h('POST', '/api/trash/' + er.id + '/restore', {}); r2 = await a.h('GET', '/api/roles'); ok(L('rôle personnalisé restauré'), r.s === 200 && r2.j.roles.c_temp && r2.j.roles.c_temp.label === 'Temporaire');
  // suppression massive (régénération) : rien n'est perdu
  r = await a.h('GET', '/api/state'); d = r.j.data; const n0 = d.sessions.length + d.subjects.length; d.sessions = []; d.subjects = [];
  r = await a.h('PUT', '/api/state', { baseRev: r.j.rev, data: d, deleteReason: 'Nouvel emploi du temps' });
  r = await a.h('GET', '/api/trash'); ok(L('suppression massive : chaque élément est dans la corbeille'), r.j.items.filter(e => ['sessions', 'subjects'].includes(e.collection) && e.reason === 'Nouvel emploi du temps').length === n0);
  // Super Admin : surveillance de toutes les institutions et restauration
  r = await sa.h('GET', '/api/platform/trash?status=all'); ok(L('Super Admin : corbeille de tous les établissements'), r.s === 200 && r.j.items.some(e => e.tenantId === T.id && e.recordId === 'st1' && e.status === 'restored'));
  const es2 = r.j.items.find(e => e.tenantId === T.id && e.recordId === 's2' && e.status === 'deleted');
  r = await sa.h('POST', '/api/platform/tenants/' + T.id + '/trash/' + es2.id + '/restore', { reason: 'Demande de la direction' }); ok(L('Super Admin : restauration dans un établissement'), r.s === 200, r.j);
  r = await a.h('GET', '/api/audit?event=restauration'); ok(L('journal de l’établissement : restauration par le Super Admin inscrite'), r.j.items.some(e => e.user === 'superadmin.' + SA.u && e.motif === 'Demande de la direction'));
  r = await sa.h('GET', '/api/platform/audit?event=restauration'); ok(L('journal de la plateforme : restauration demandée inscrite'), r.j.items.some(e => e.tenantId === T.id));
  // isolation : un autre établissement ne voit pas cette corbeille
  await sa.h('POST', '/api/platform/tenants', { name: 'Autre', slug: 'autre', admin: { username: 'admin', password: 'Temporaire-Autre-2026' } });
  const o = client(B); await o.login('admin', 'Temporaire-Autre-2026', 'autre'); await o.h('POST', '/api/account/password', { current: 'Temporaire-Autre-2026', next: 'Direction-Autre-2026x' });
  r = await o.h('GET', '/api/trash?status=all'); ok(L('ISOLATION : la corbeille d’un autre établissement est vide'), r.s === 200 && r.j.items.length === 0);
  r = await o.h('POST', '/api/trash/' + es2.id + '/restore', {}); ok(L('ISOLATION : impossible de restaurer un élément d’un autre établissement'), r.s === 404);
  r = await o.h('DELETE', '/api/trash/' + e1.id); ok(L('aucune suppression définitive possible (pas de route)'), r.s === 404 || r.s === 405);
  if (extra) await extra(L);
  await srv.stop();
}
(async () => {
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-tr-')), PORT = 9600 + Math.floor(Math.random() * 100);
    const env = { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(ROOT, 'bk'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), LOGIN_RATE_PER_MIN: '1000', SUPERADMIN_USERNAME: SA.u, SUPERADMIN_PASSWORD: SA.p0 };
    await scenario('fichiers', async () => { const p = await spawnWait(['server.js'], env, /démarré/); return { base: 'http://127.0.0.1:' + PORT, stop: async () => { p.kill(); await sleep(300); } }; });
  }
  if (PG.length) {
    const DB = 'unitt_tr_' + Date.now(), psql = (q, db) => cp.spawnSync('psql', [...PG, '-d', db || 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: q, encoding: 'utf8' });
    psql('create database ' + DB); psql("do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;", DB);
    psql(fs.readFileSync(path.join(DIR, '..', 'supabase', 'schema.sql'), 'utf8'), DB);
    const KEY = 'k' + Date.now(), MP = 9750 + Math.floor(Math.random() * 40), PORT = MP + 50;
    await spawnWait(['tests/support/supabase-mock.js', String(MP), KEY, ...PG, '-d', DB], {}, /prêt/);
    const env = { UNITT_STORAGE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:' + MP, SUPABASE_SERVICE_ROLE_KEY: KEY, SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: '/nonexistent', LOGIN_RATE_PER_MIN: '1000', PORT: String(PORT), SUPERADMIN_USERNAME: SA.u, SUPERADMIN_PASSWORD: SA.p0 };
    await scenario('cloud', async () => { const p = await spawnWait(['tools/cloud-dev.js'], env, /démarré/); return { base: 'http://127.0.0.1:' + PORT, stop: async () => { p.kill(); await sleep(300); } }; });
    psql('drop database if exists ' + DB + ' with (force)');
  } else console.log('SKIP mode cloud : définir PG');
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  procs.forEach(p => { try { p.kill(); } catch (e) { } }); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERREUR', e); procs.forEach(p => { try { p.kill(); } catch (x) { } }); process.exit(1); });

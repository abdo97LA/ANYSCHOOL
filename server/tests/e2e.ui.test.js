/* Test de bout en bout de l'interface réelle (public/index.html) avec deux à trois navigateurs simultanés.
   Nécessite Playwright + Chromium :  npm i -D playwright && npx playwright install chromium
   Exécution : node tests/e2e.ui.test.js */
'use strict';
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP : Playwright non installé (npm i -D playwright)'); process.exit(0); }
const DIR = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-e2e-'));
const PORT = 8960 + Math.floor(Math.random() * 30), B = 'http://127.0.0.1:' + PORT;
const ENV = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(ROOT, 'bk'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), ADMIN_PASSWORD: '', LOGIN_RATE_PER_MIN: '500' };
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());
const dayCode = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date(today + 'T12:00:00Z').getUTCDay()];
let proc;
const start = () => new Promise((res, rej) => { proc = cp.spawn(process.execPath, ['server.js'], { cwd: DIR, env: ENV }); let o = ''; const on = d => { o += d; if (/démarré/.test(o)) res(); }; proc.stdout.on('data', on); proc.stderr.on('data', on); setTimeout(() => rej(new Error(o)), 10000); });
async function api(cookie, m, p, b) { const r = await fetch(B + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j, cookie: sc ? sc.split(';')[0] : cookie }; }
const PW = { admin: 'Tres-Long-Secret-2026!', plan: 'Horaires-Secret-2026', prof: 'Enseignant-Secret-2026' };

/* E2E_CLOUD=1 + PG="…" : même scénario sur la version cloud (Vercel + Supabase), avec un PostgreSQL réel */
const CLOUD = process.env.E2E_CLOUD === '1', PGA = (process.env.PG || '').split(' ').filter(Boolean), extra = [];
async function startCloud() {
  const db = 'unitt_e2e_' + Date.now(), psql = (q, d) => cp.spawnSync('psql', [...PGA, '-d', d || 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: q, encoding: 'utf8' });
  psql('create database ' + db); psql("do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;", db);
  psql(fs.readFileSync(path.join(DIR, '..', 'supabase', 'schema.sql'), 'utf8'), db);
  const mp = PORT + 500, key = 'k' + Date.now();
  await new Promise(res => { const m = cp.spawn(process.execPath, ['tests/support/supabase-mock.js', String(mp), key, ...PGA, '-d', db], { cwd: DIR }); extra.push(m); m.stdout.on('data', d => /prêt/.test(d) && res()); });
  Object.assign(ENV, { UNITT_STORAGE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:' + mp, SUPABASE_SERVICE_ROLE_KEY: key, ADMIN_PASSWORD: PW.admin });
  await new Promise((res, rej) => { proc = cp.spawn(process.execPath, ['tools/cloud-dev.js'], { cwd: DIR, env: ENV }); let o = ''; const on = d => { o += d; if (/démarré/.test(o)) res(); }; proc.stdout.on('data', on); proc.stderr.on('data', on); setTimeout(() => rej(new Error(o)), 10000); });
}
(async () => {
  if (CLOUD) { await startCloud(); console.log('(mode cloud : Supabase simulé sur PostgreSQL réel)'); }
  else { cp.spawnSync(process.execPath, ['tools/create-admin.js', '--username', 'admin', '--name', 'Administrateur'], { cwd: DIR, env: ENV, input: PW.admin + '\n' + PW.admin + '\n' }); await start(); }
  let c = (await api('', 'POST', '/api/login', { username: 'admin', password: PW.admin })).cookie;
  await api(c, 'POST', '/api/users', { username: 'plan', displayName: 'Mme Horaires', role: 'planning', password: 'Temporaire-H-2026' });
  await api(c, 'POST', '/api/users', { username: 'prof', displayName: 'Dr. Amrani', role: 'teacher', teacherId: 't1', password: 'Temporaire-P-2026' });
  let pc = (await api('', 'POST', '/api/login', { username: 'plan', password: 'Temporaire-H-2026' })).cookie;
  await api(pc, 'POST', '/api/account/password', { current: 'Temporaire-H-2026', next: PW.plan });
  const data = {
    teachers: [{ id: 't1', name: 'Dr. Amrani' }, { id: 't2', name: 'Pr. Benali' }], rooms: [{ id: 'r1', name: 'A101', type: 'lecture', capacity: 40 }, { id: 'r2', name: 'Amphi 1', type: 'lecture', capacity: 120 }],
    levels: [{ id: 'l1', name: 'IP 1', size: 30 }], programs: [{ id: 'p_ip', name: 'IP', label: 'Infirmier polyvalent' }],
    subjects: [{ id: 's1', name: 'Anatomie', hoursPerWeek: 2, level: 'l1', teacherId: 't1', roomType: 'lecture' }, { id: 's2', name: 'Physiologie', hoursPerWeek: 2, level: 'l1', teacherId: 't2', roomType: 'lecture' }],
    sessions: [{ id: 'se1', subjectId: 's1', teacherId: 't1', roomId: 'r1', extraRooms: [], day: dayCode, date: today, startTime: '00:05', endTime: '23:55', programId: 'p_ip', year: '1', group: 'G1', type: 'CM', title: '' },
      { id: 'se2', subjectId: 's2', teacherId: 't2', roomId: 'r2', extraRooms: [], day: dayCode, date: today, startTime: '00:10', endTime: '23:50', programId: 'p_ip', year: '1', group: 'G1', type: 'CM', title: '' }],
    students: [{ id: 'st1', matricule: 'M001', lastName: 'Alaoui', firstName: 'Sara', programId: 'p_ip', year: '1', group: 'G1', cin: 'AB1' }, { id: 'st2', matricule: 'M002', lastName: 'Bennani', firstName: 'Omar', programId: 'p_ip', year: '1', group: 'G1', cin: 'CD2' }],
    volumes: [], cal: { start: '', end: '' }, absences: [], templates: [], tplCats: ['Attestation de scolarité'], cfg: { cc: '212', etab: 'UM6SS – FM6SIPS Dakhla' }
  };
  const ini = await api(c, 'PUT', '/api/state', { baseRev: 0, data }); ok('préparation : données initiales envoyées par l’administrateur', ini.s === 200, ini.j);

  const browser = await chromium.launch();
  const cspErrors = [];
  async function open(name) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    page.on('console', m => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(name + ': ' + m.text()); });
    page.on('pageerror', e => { if (!/XLSX|jspdf/i.test(e.message)) cspErrors.push(name + ' JS: ' + e.message); });
    await page.goto(B + '/'); return { ctx, page };
  }
  async function login(page, u, p) { await page.waitForSelector('#srv_us', { timeout: 8000 }); await page.fill('#srv_us', u); await page.fill('#srv_pw', p); await page.click('#srv_go'); }
  const tabs = page => page.$$eval('#nav button', bs => bs.map(b => b.textContent.trim()));

  /* Poste A : administrateur */
  const A = await open('A');
  await A.page.waitForSelector('#srv_us', { timeout: 10000 }).catch(() => { });
  ok('sans session, l’interface n’affiche aucune donnée et demande la connexion', await A.page.isVisible('#srv_us') && !(await A.page.textContent('#app')).includes('Anatomie'));
  await login(A.page, 'admin', 'mauvais');
  await A.page.waitForFunction(() => /incorrect/.test(document.querySelector('#ferr').textContent), null, { timeout: 5000 }).then(() => ok('mauvais mot de passe : message d’erreur', true), () => ok('mauvais mot de passe : message d’erreur', false));
  await A.page.fill('#srv_pw', PW.admin); await A.page.click('#srv_go');
  await A.page.waitForFunction(() => window.USR && ST.on, null, { timeout: 8000 });
  const tA = await tabs(A.page);
  ok('administrateur : connecté, tous les onglets + « Administration »', tA.includes('Administration') && tA.includes('Étudiants') && tA.includes('Teachers'), tA);
  ok('administrateur : les données du serveur sont chargées', await A.page.evaluate(() => S.sessions.length === 2 && S.students.length === 2));
  ok('le nom de l’utilisateur et son rôle sont affichés', /Administrateur/.test(await A.page.textContent('#usr')));

  /* Poste B : responsable emploi du temps */
  const Bp = await open('B'); await login(Bp.page, 'plan', PW.plan);
  await Bp.page.waitForFunction(() => window.USR && ST.on, null, { timeout: 8000 });
  const tB = await tabs(Bp.page);
  ok('emploi du temps : pas d’onglet Étudiants / Absences / Administration', !tB.includes('Étudiants') && !tB.includes('Absences') && !tB.includes('Administration') && tB.includes('Rooms'), tB);
  ok('emploi du temps : étudiants reçus sans nom ni CIN', await Bp.page.evaluate(() => S.students.length === 2 && !S.students[0].lastName && !S.students[0].cin));

  /* propagation B -> A */
  await Bp.page.evaluate(() => { S.rooms.push({ id: 'r3', name: 'Salle TP 3', type: 'lab', capacity: 20 }); save(); });
  await Bp.page.waitForFunction(() => !ST.dirty, null, { timeout: 8000 });
  const t0 = Date.now();
  await A.page.waitForFunction(() => S.rooms.some(r => r.id === 'r3'), null, { timeout: 30000 }).then(() => ok('7. une salle ajoutée sur le poste B apparaît automatiquement sur le poste A (' + Math.round((Date.now() - t0) / 1000) + ' s)', true), () => ok('7. propagation B -> A', false));

  /* conflit : même séance modifiée sur A et B */
  await A.page.evaluate(() => { ST.ms = 300; }); await Bp.page.evaluate(() => { ST.ms = 300; clearInterval(ST.poll); });
  await A.page.evaluate(() => { S.sessions.find(s => s.id === 'se2').roomId = 'r1'; save(); });
  await A.page.waitForFunction(() => !ST.dirty, null, { timeout: 8000 });
  await Bp.page.evaluate(() => { S.sessions.find(s => s.id === 'se2').roomId = 'r3'; save(); });
  await Bp.page.waitForFunction(() => document.querySelector('#modal.show') && /Conflit de modification/.test(document.querySelector('#mbox').textContent), null, { timeout: 8000 }).then(() => ok('8. conflit détecté sur le poste B : boîte de dialogue avec l’élément en cause', true), () => ok('8. conflit détecté sur le poste B', false));
  let srv = (await api(c, 'GET', '/api/state')).j;
  ok('8. pas d’écrasement silencieux : la version du poste A reste sur le serveur', srv.data.sessions.find(s => s.id === 'se2').roomId === 'r1');
  ok('8. une copie de sécurité locale est faite avant la résolution', await Bp.page.evaluate(() => !!localStorage.getItem(KEY + '-pre-conflict')));
  await Bp.page.click('text=Garder ma version pour ces éléments');
  await Bp.page.waitForFunction(() => !ST.conflict && !ST.dirty, null, { timeout: 8000 });
  srv = (await api(c, 'GET', '/api/state')).j;
  ok('8. résolution « garder ma version » appliquée sur le serveur', srv.data.sessions.find(s => s.id === 'se2').roomId === 'r3');
  ok('8. la salle ajoutée plus tôt n’a pas été perdue', srv.data.rooms.some(r => r.id === 'r3'));

  /* droits : B (emploi du temps) tente de modifier la configuration */
  await Bp.page.evaluate(() => { S.cfg.etab = 'Piratage'; save(); });
  await Bp.page.waitForFunction(() => document.querySelector('#modal.show') && /refusée/.test(document.querySelector('#mbox').textContent), null, { timeout: 8000 }).then(() => ok('6. modification hors rôle : refus du serveur affiché clairement', true), () => ok('6. refus hors rôle affiché', false));
  await Bp.page.click('text=Recharger les données du serveur');
  await Bp.page.waitForFunction(() => S.cfg.etab !== 'Piratage' && !ST.conflict, null, { timeout: 8000 }).then(() => ok('6. rechargement : la donnée non autorisée est annulée localement', true), () => ok('6. rechargement après refus', false));

  /* coupure réseau sur B, modifications conservées, renvoi au retour */
  await Bp.ctx.setOffline(true);
  await Bp.page.evaluate(() => { S.rooms.push({ id: 'r4', name: 'Salle hors ligne', type: 'lecture', capacity: 10 }); save(); });
  await sleep(1500);
  ok('7. hors ligne : la modification est conservée sur le poste (en attente)', await Bp.page.evaluate(() => ST.dirty && localStorage.getItem('unitt-st-dirty') === '1' && JSON.parse(localStorage.getItem(KEY)).rooms.some(r => r.id === 'r4')));
  await Bp.page.evaluate(() => srvPing()); ok('7. hors ligne : état « Serveur injoignable » affiché', /injoignable/.test(await Bp.page.textContent('#srvst')));
  await Bp.ctx.setOffline(false);
  await Bp.page.evaluate(() => srvPing());
  await Bp.page.waitForFunction(() => !ST.dirty, null, { timeout: 15000 }).catch(() => { });
  srv = (await api(c, 'GET', '/api/state')).j;
  ok('7. après reconnexion, la modification faite hors ligne est envoyée et fusionnée', srv.data.rooms.some(r => r.id === 'r4'), srv.data.rooms.map(r => r.id));

  /* Poste C : enseignant */
  const C = await open('C'); await login(C.page, 'prof', 'Temporaire-P-2026');
  await C.page.waitForSelector('#pw_c', { timeout: 8000 });
  ok('enseignant : changement de mot de passe obligatoire à la première connexion', true);
  await C.page.fill('#pw_c', 'Temporaire-P-2026'); await C.page.fill('#pw_n', PW.prof); await C.page.fill('#pw_n2', PW.prof); await C.page.click('#mbox button.pri');
  await C.page.waitForFunction(() => window.USR && !USR.mustChange && ST.on, null, { timeout: 8000 });
  const tC = await tabs(C.page);
  ok('enseignant : onglets limités (Today, Timetable, Absences)', tC.length === 3 && tC.includes('Absences') && !tC.includes('Teachers'), tC);
  ok('enseignant : ne reçoit que sa séance et les étudiants de son groupe', await C.page.evaluate(() => S.sessions.length === 1 && S.sessions[0].id === 'se1' && S.students.length === 2 && !S.students[0].cin));
  await C.page.evaluate(() => absDlg('se1'));
  await C.page.waitForSelector('#abe_l input[type=checkbox]', { timeout: 5000 });
  await C.page.check('#abe_l input[type=checkbox] >> nth=0');
  await C.page.click('#mbox button.pri');
  await sleep(1200);
  const ab = (await api(c, 'GET', '/api/absences')).j.items;
  ok('enseignant : saisit les absences de sa séance depuis l’interface', ab.length === 1 && ab[0].sessionId === 'se1' && ab[0].total === 1 && ab[0].source === 'enseignant', ab);
  ok('enseignant : une tentative sur la séance d’un autre est refusée par le serveur', (await C.page.evaluate(async () => { try { await api('POST', '/api/absences', { sessionId: 'se2', absent: [] }); return 0 } catch (e) { return e.status } })) === 403);
  await C.page.evaluate(() => { S.sessions[0].startTime = '07:00'; save(); });
  await sleep(800);
  srv = (await api(c, 'GET', '/api/state')).j;
  ok('enseignant : une modification de l’emploi du temps n’est jamais envoyée ni acceptée', srv.data.sessions.find(s => s.id === 'se1').startTime === '00:05');
  await C.page.evaluate(() => lanLogout(true));
  await C.page.waitForSelector('#srv_us', { timeout: 5000 });
  ok('déconnexion : retour à l’écran de connexion, cache local effacé (poste partagé)', await C.page.evaluate(() => !localStorage.getItem(KEY) && !window.USR));

  /* Administration depuis l'interface */
  await A.page.evaluate(() => go('admin'));
  await A.page.waitForFunction(() => document.querySelector('#adm_users table'), null, { timeout: 8000 });
  ok('administration : la liste des comptes s’affiche', /prof/.test(await A.page.textContent('#adm_users')) && /plan/.test(await A.page.textContent('#adm_users')));
  await A.page.click('text=+ Nouveau compte');
  await A.page.fill('#u_us', 'scol.dakhla'); await A.page.fill('#u_dn', 'Service scolarité'); await A.page.selectOption('#u_ro', 'scolarite');
  await A.page.click('#mbox button.pri');
  await A.page.waitForFunction(() => /scol\.dakhla/.test(document.querySelector('#adm_users').textContent), null, { timeout: 8000 }).then(() => ok('administration : création d’un compte depuis l’interface', true), () => ok('administration : création d’un compte', false));
  const profId = await A.page.evaluate(() => ADM.users.find(u => u.username === 'prof').id);
  await A.page.evaluate(id => usrDlg(id), profId);
  await A.page.waitForSelector('#u_perms .u_xp');
  ok('administration : les autorisations du compte s’affichent cochées selon le rôle', await A.page.evaluate(() => document.querySelector('.u_xp[value="absences.write.own"]').checked && !document.querySelector('.u_xp[value="absences.read"]').checked));
  await A.page.uncheck('.u_xp[value="absences.write.own"]'); await A.page.check('.u_xp[value="absences.read"]');
  await A.page.click('#mbox button.pri'); await sleep(800);
  const pu = (await api(c, 'GET', '/api/users')).j.items.find(u => u.username === 'prof');
  ok('administration : retirer et accorder une autorisation individuelle depuis l’interface', pu.deniedPerms.includes('absences.write.own') && pu.extraPerms.includes('absences.read'), pu);
  await A.page.waitForFunction(() => /modification\(s\)/.test(document.querySelector('#adm_audit').textContent), null, { timeout: 8000 }).then(() => ok('administration : le journal affiche les anciennes / nouvelles valeurs', true), () => ok('administration : anciennes / nouvelles valeurs visibles', false));
  ok('administration : journal d’audit du serveur affiché et valide', /valide/.test(await A.page.textContent('#adm_audit')));

  const before = cspErrors.length, shot = process.env.E2E_SHOTS;
  for (const t of await A.page.evaluate(() => TABS.map(x => x[0]))) { await A.page.evaluate(t => go(t), t); await sleep(250); if (shot) await A.page.screenshot({ path: path.join(shot, 'admin-' + t + '.png'), fullPage: false }); }
  ok('12. tous les onglets existants s’affichent sans erreur JavaScript pour l’administrateur', cspErrors.length === before, cspErrors.slice(before));
  for (const t of await Bp.page.evaluate(() => TABS.map(x => x[0]))) { await Bp.page.evaluate(t => go(t), t); await sleep(150); }
  ok('12. tous les onglets s’affichent sans erreur pour le responsable emploi du temps', cspErrors.length === before, cspErrors.slice(before));
  ok('aucune violation de la politique de sécurité (CSP) ni erreur JavaScript', cspErrors.length === 0, cspErrors);
  await browser.close(); proc.kill('SIGTERM'); for (const x of extra) x.kill();
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERREUR', e); try { proc.kill(); } catch (x) { } process.exit(1); });

/* Phase 3 : identité visuelle par établissement (nom, logo, couleurs), isolée, validée, journalisée.
   node tests/branding.test.js        PG="…" pour tester aussi le mode cloud (Supabase simulé sur un vrai PostgreSQL) */
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
const PNG = (() => { const b = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005fe02fea7d6c1d70000000049454e44ae426082', 'hex'); return 'data:image/png;base64,' + b.toString('base64'); })();
async function scenario(mode, start) {
  const L = s => mode + ' : ' + s;
  const srv = await start(), B = srv.base;
  const sa = client(B); await sa.h('POST', '/api/platform/login', { username: SA.u, password: SA.p0 }); await sa.h('POST', '/api/platform/password', { current: SA.p0, next: SA.p });
  let r = await sa.h('POST', '/api/platform/tenants', { name: 'Institut Atlas', nameAr: 'معهد أطلس', slug: 'atlas', admin: { username: 'admin', password: 'Temporaire-Atlas-2026' } }); const TA = r.j.tenant;
  r = await sa.h('POST', '/api/platform/tenants', { name: 'École Beta', slug: 'beta', admin: { username: 'admin', password: 'Temporaire-Beta-2026' } });
  const a = client(B); await a.login('admin', 'Temporaire-Atlas-2026', 'atlas'); await a.h('POST', '/api/account/password', { current: 'Temporaire-Atlas-2026', next: 'Direction-Atlas-2026x' });
  const b = client(B); await b.login('admin', 'Temporaire-Beta-2026', 'beta'); await b.h('POST', '/api/account/password', { current: 'Temporaire-Beta-2026', next: 'Direction-Beta-2026x' });
  r = await a.h('GET', '/api/me'); ok(L('par défaut : nom de l’établissement, thème par défaut, logo absent'), r.j.brand.effective.name === 'Institut Atlas' && r.j.brand.effective.nameAr === 'معهد أطلس' && !r.j.brand.logo && Object.keys(r.j.brand.colors).length === 0, r.j.brand);
  r = await a.h('PUT', '/api/branding', { colors: { primary: 'red' } }); ok(L('couleur invalide refusée'), r.s === 400);
  r = await a.h('PUT', '/api/branding', { logo: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==' }); ok(L('logo SVG refusé (sécurité)'), r.s === 400 && /SVG/.test(r.j.error));
  r = await a.h('PUT', '/api/branding', { logo: 'data:image/png;base64,' + Buffer.from('pas une image png').toString('base64') }); ok(L('faux PNG refusé (contenu vérifié)'), r.s === 400);
  r = await a.h('PUT', '/api/branding', { logo: 'data:image/png;base64,' + 'A'.repeat(700000) }); ok(L('logo trop volumineux refusé'), r.s === 400 || r.s === 413);
  r = await a.h('PUT', '/api/branding', { displayName: 'Atlas', reportName: 'Institut Supérieur Atlas – Rabat', nameAr: 'المعهد العالي أطلس', logo: PNG, logoPlaces: { sidebar: true, login: true, dashboard: false, reports: true, documents: true }, colors: { primary: '#0E7490', secondary: '#9333ea', background: '#f8fafc', sidebar: '#0f172a', button: '#0e7490', text: '#111827' } });
  ok(L('identité visuelle enregistrée (noms, logo, emplacements, 6 couleurs)'), r.s === 200 && r.j.brand.colors.primary === '#0e7490' && r.j.brand.logoPlaces.dashboard === false && r.j.brand.effective.reportName === 'Institut Supérieur Atlas – Rabat', r.j);
  r = await b.h('GET', '/api/me'); ok(L('ISOLATION : aucune incidence sur l’autre établissement'), r.j.brand.effective.name === 'École Beta' && !r.j.brand.logo && !Object.keys(r.j.brand.colors).length);
  const anon = client(B);
  r = await anon.h('GET', '/api/branding?etab=atlas'); ok(L('page de connexion : identité publique de l’établissement par son code'), r.s === 200 && r.j.brand.name === 'Atlas' && r.j.brand.logo === PNG && r.j.brand.colors.sidebar === '#0f172a');
  r = await anon.h('GET', '/api/branding?etab=beta'); ok(L('page de connexion d’un autre établissement : sa propre identité'), r.j.brand.name === 'École Beta' && !r.j.brand.logo);
  r = await anon.h('GET', '/api/branding?etab=inconnu'); ok(L('code inconnu : identité de la plateforme, aucune fuite'), r.s === 200 && r.j.unknown === true && !r.j.brand.logo);
  await a.h('PUT', '/api/branding', { logoPlaces: { sidebar: true, login: false, dashboard: true, reports: true, documents: true } });
  r = await anon.h('GET', '/api/branding?etab=atlas'); ok(L('emplacement « connexion » décoché : logo non affiché avant connexion'), r.j.brand.logo === '');
  await a.h('POST', '/api/users', { username: 'scol', displayName: 'S', role: 'scolarite', password: 'Bureau-Temp-2026xy' });
  const sc = client(B); await sc.login('scol', 'Bureau-Temp-2026xy', 'atlas'); await sc.h('POST', '/api/account/password', { current: 'Bureau-Temp-2026xy', next: 'Bureau-Etudes-2026x' });
  r = await sc.h('PUT', '/api/branding', { colors: {} }); ok(L('un employé sans autorisation ne peut pas modifier l’identité visuelle'), r.s === 403);
  r = await sc.h('GET', '/api/me'); ok(L('tous les utilisateurs de l’établissement reçoivent son identité'), r.j.brand.colors.primary === '#0e7490' && r.j.brand.logo === PNG);
  r = await a.h('PUT', '/api/branding', { resetColors: true }); ok(L('thème par défaut rétabli (nom et logo conservés)'), r.s === 200 && !Object.keys(r.j.brand.colors).length && r.j.brand.logo === PNG && r.j.brand.displayName === 'Atlas');
  r = await a.h('GET', '/api/audit?section=' + encodeURIComponent('identité visuelle')); const ev = r.j.items.map(e => e.event);
  ok(L('journal : logo, couleurs et thème par défaut inscrits (empreinte du logo, pas l’image)'), ev.includes('logo de l’établissement modifié') && ev.includes('couleurs de l’établissement modifiées') && ev.includes('thème par défaut rétabli (couleurs)') && !JSON.stringify(r.j.items).includes(PNG.slice(30, 60)) && r.j.items.some(e => e.apres && e.apres.logo && e.apres.logo.sha256), ev);
  r = await sa.h('GET', '/api/platform/tenants/' + TA.id); ok(L('Super Admin : aperçu de l’identité visuelle de l’établissement'), r.j.brand && r.j.brand.logo === PNG && r.j.brand.effective.name === 'Atlas');
  r = await sa.h('GET', '/api/platform/audit?event=' + encodeURIComponent('identité visuelle')); ok(L('journal de la plateforme : changement d’identité signalé'), r.j.items.some(e => e.tenantId === TA.id));
  r = await a.h('POST', '/api/forms', { session: { sessionId: 'se1', teacherId: 't1', subject: 'Anatomie', teacher: 'Dr X', date: '2026-06-15', start: '08:00', end: '10:00', students: [{ m: 'M1', n: 'A B' }] } });
  r = await anon.h('GET', '/api/form/' + r.j.url.split('/f/')[1]); ok(L('formulaire enseignant (WhatsApp) : identité de l’établissement'), r.s === 200 && r.j.brand.reportName === 'Institut Supérieur Atlas – Rabat');
  const view = client(B); view.jar.psid = sa.jar.psid; await view.h('POST', '/api/platform/tenants/' + TA.id + '/enter', { mode: 'view' });
  r = await view.h('PUT', '/api/branding', { colors: { primary: '#000000' } }); ok(L('Super Admin en consultation : identité non modifiable'), r.s === 403);
  await srv.stop();
}
(async () => {
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-br-')), PORT = 9500 + Math.floor(Math.random() * 100);
    const env = { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(ROOT, 'bk'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), LOGIN_RATE_PER_MIN: '1000', SUPERADMIN_USERNAME: SA.u, SUPERADMIN_PASSWORD: SA.p0 };
    await scenario('fichiers', async () => { const p = await spawnWait(['server.js'], env, /démarré/); return { base: 'http://127.0.0.1:' + PORT, stop: async () => { p.kill(); await sleep(300); } }; });
  }
  if (PG.length) {
    const DB = 'unitt_br_' + Date.now(), psql = (q, db) => cp.spawnSync('psql', [...PG, '-d', db || 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], { input: q, encoding: 'utf8' });
    psql('create database ' + DB); psql("do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;", DB);
    psql(fs.readFileSync(path.join(DIR, '..', 'supabase', 'schema.sql'), 'utf8'), DB);
    const KEY = 'k' + Date.now(), MP = 9450 + Math.floor(Math.random() * 40), PORT = MP + 50;
    await spawnWait(['tests/support/supabase-mock.js', String(MP), KEY, ...PG, '-d', DB], {}, /prêt/);
    const env = { UNITT_STORAGE: 'supabase', SUPABASE_URL: 'http://127.0.0.1:' + MP, SUPABASE_SERVICE_ROLE_KEY: KEY, SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: '/nonexistent', LOGIN_RATE_PER_MIN: '1000', PORT: String(PORT), SUPERADMIN_USERNAME: SA.u, SUPERADMIN_PASSWORD: SA.p0 };
    await scenario('cloud', async () => { const p = await spawnWait(['tools/cloud-dev.js'], env, /démarré/); return { base: 'http://127.0.0.1:' + PORT, stop: async () => { p.kill(); await sleep(300); } }; });
    psql('drop database if exists ' + DB + ' with (force)');
  } else console.log('SKIP mode cloud : définir PG');
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  procs.forEach(p => { try { p.kill(); } catch (e) { } }); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERREUR', e); procs.forEach(p => { try { p.kill(); } catch (x) { } }); process.exit(1); });

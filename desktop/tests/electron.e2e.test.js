/* Test de bout en bout de l'application Electron (mode développement) : gestion du serveur local.
   Nécessite Playwright et un exécutable Electron :  ELECTRON_EXE=... node tests/electron.e2e.test.js
   (Linux : lancer sous xvfb-run ; le binaire doit correspondre à la version d'Electron du projet) */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
let _electron; try { ({ _electron } = require('playwright')); } catch (e) { console.log('SKIP : Playwright absent'); process.exit(0); }
const APP = path.join(__dirname, '..'), CODE = path.join(APP, 'server-bundle');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-el-'));
const PORT = 9700 + Math.floor(Math.random() * 200), URL0 = 'http://127.0.0.1:' + PORT;
const PW = 'Gestion-Locale-2026!';
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const health = () => fetch(URL0 + '/health').then(r => r.json()).then(j => j.ok === true, () => false);

/* dossier du serveur existant, avec données (à préserver) */
const SR = path.join(ROOT, 'serveur'); fs.mkdirSync(path.join(SR, 'data'), { recursive: true });
fs.writeFileSync(path.join(SR, 'server.env'), 'HOST=127.0.0.1\nPORT=' + PORT + '\nBACKUP_INTERVAL_HOURS=0\nSCRYPT_N=4096\n');
const envC = { ...process.env, UNITT_CONFIG: path.join(SR, 'server.env'), DATA_DIR: path.join(SR, 'data'), LOG_DIR: path.join(SR, 'logs'), SCRYPT_N: '4096' };
cp.spawnSync(process.execPath, [path.join(CODE, 'tools', 'create-admin.js'), '--username', 'admin', '--name', 'Administrateur'], { cwd: CODE, env: envC, input: PW + '\n' + PW + '\n' });
{ const st = JSON.parse(fs.readFileSync(path.join(SR, 'data', 'store.json'), 'utf8')); st.users.push({ ...st.users[0], id: 'c'.repeat(16), username: 'prof', displayName: 'Dr. Prof', role: 'teacher', teacherId: 't1' }); fs.writeFileSync(path.join(SR, 'data', 'store.json'), JSON.stringify(st)); }
fs.writeFileSync(path.join(SR, 'data', 'state.json'), JSON.stringify({ rev: 3, at: '2026-10-25T10:00:00Z', by: 'admin', data: { teachers: [{ id: 't1', name: 'Dr. Prof' }], sessions: [], students: [], rooms: [{ id: 'r1', name: 'A101' }], levels: [], subjects: [], programs: [], volumes: [], cal: { start: '', end: '' }, absences: [], templates: [], tplCats: [], cfg: {} } }));
const stateHash = sha(path.join(SR, 'data', 'state.json'));

/* profil utilisateur isolé : dossier du serveur déjà choisi */
const HOME = path.join(ROOT, 'home'), UD = path.join(HOME, '.config', 'UniTimetable'); fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'server-control.json'), JSON.stringify({ serverRoot: SR }));
/* Quitter l'application comme un utilisateur (app.quit) et attendre la fin du processus Electron uniquement
   (le serveur détaché peut garder ouverts des descripteurs hérités : on n'attend pas la fermeture des tubes). */
const quit = async a => { const p = a.process(); const done = new Promise(r => p.once('exit', r)); await a.evaluate(({ app }) => setTimeout(() => app.quit(), 50)).catch(() => { }); await Promise.race([done, sleep(8000)]); };
const launch = () => _electron.launch({ executablePath: process.env.ELECTRON_EXE, args: [APP, '--no-sandbox', '--server=' + URL0], env: { ...process.env, HOME, XDG_CONFIG_HOME: path.join(HOME, '.config') }, timeout: 30000 });

(async () => {
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForSelector('#srvbox', { state: 'visible', timeout: 15000 });
  ok('serveur arrêté : l’écran local affiche la section « Gestion du serveur local »', await win.isVisible('#srvbox') && /Gestion du serveur local/.test(await win.textContent('#srvbox')));
  ok('les commandes sont masquées tant qu’aucun administrateur n’est connecté', !(await win.isVisible('#srvpanel')));
  let r = await win.evaluate(() => window.electronAPI.serverControl.start());
  ok('appel direct de la commande « démarrer » sans connexion administrateur : refusé par le processus principal', r.denied === true && !(await health()));
  ok('aucune API de commande arbitraire exposée au rendu', await win.evaluate(() => Object.keys(window.electronAPI.serverControl).every(k => ['available', 'login', 'logout', 'status', 'start', 'stop', 'restart', 'openLogs', 'openLogFolder', 'chooseFolder', 'logInit', 'onStatus', 'onLog'].includes(k)) && typeof require === 'undefined' && typeof process === 'undefined'));
  await win.fill('#su', 'prof'); await win.fill('#sp', PW); await win.click('#sgo');
  await win.waitForFunction(() => /Administrateur/.test(document.querySelector('#smsg').textContent));
  ok('un compte Enseignant est refusé (bouton indisponible aux autres rôles)', !(await win.isVisible('#srvpanel')));
  await win.fill('#su', 'admin'); await win.fill('#sp', PW); await win.click('#sgo');
  await win.waitForSelector('#srvpanel', { state: 'visible' });
  ok('compte Administrateur : panneau affiché, état « Arrêté »', (await win.textContent('#sstate')) === 'Arrêté');
  await win.click('#sstart');
  await win.waitForFunction(() => /terminé|déjà/.test(document.querySelector('#smsg').textContent) || /Erreur/.test(document.querySelector('#sstate').textContent), null, { timeout: 30000 });
  ok('« Démarrer le serveur » : le serveur répond (/health)', await health());
  const pid1 = +fs.readFileSync(path.join(SR, 'data', 'server.lock'), 'utf8');
  // l'écran local ouvre ensuite l'interface du serveur
  await win.waitForURL(u => u.toString().startsWith(URL0), { timeout: 15000 }).catch(() => { });
  ok('après démarrage, l’application ouvre l’interface servie par le serveur', win.url().startsWith(URL0), win.url());
  r = await win.evaluate(() => window.electronAPI.serverControl.start());
  ok('nouveau clic « Démarrer » : déjà en marche détecté, aucune 2e instance', (r.denied || (r.ok && r.already)) && +fs.readFileSync(path.join(SR, 'data', 'server.lock'), 'utf8') === pid1, r);

  /* interface web : enseignant -> aucune section, commande refusée */
  await win.waitForSelector('#srv_us', { timeout: 15000 });
  await win.fill('#srv_us', 'prof'); await win.fill('#srv_pw', PW); await win.click('#srv_go');
  await win.waitForFunction(() => window.USR || document.querySelector('#pw_c'), null, { timeout: 10000 }).catch(() => { });
  r = await win.evaluate(() => window.electronAPI.serverControl.restart());
  ok('session Enseignant dans l’interface : redémarrage refusé par le processus principal', r.denied === true);
  ok('session Enseignant : pas d’onglet Administration', !(await win.evaluate(() => (window.TABS || []).some(t => t[0] === 'admin'))));
  await win.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  await win.reload();
  await win.waitForSelector('#srv_us', { timeout: 15000 });
  await win.fill('#srv_us', 'admin'); await win.fill('#srv_pw', PW); await win.click('#srv_go');
  await win.waitForFunction(() => window.USR && USR.role === 'admin', null, { timeout: 10000 });
  await win.evaluate(() => go('admin'));
  await win.waitForFunction(() => document.querySelector('#lsc_st') && document.querySelector('#lsc_st').textContent === 'En marche', null, { timeout: 10000 }).then(() => ok('Administration : section « Gestion du serveur local » avec l’état « En marche »', true), () => ok('section de gestion dans l’Administration', false));

  /* confirmation : Annuler ne fait rien, Confirmer redémarre */
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await win.click('#lsc_restart'); await sleep(1500);
  ok('Redémarrer puis « Annuler » dans la confirmation : serveur inchangé', +fs.readFileSync(path.join(SR, 'data', 'server.lock'), 'utf8') === pid1 && await health());
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await win.evaluate(() => lscDo('restart'));
  await sleep(500);
  let pid2 = 0; try { pid2 = +fs.readFileSync(path.join(SR, 'data', 'server.lock'), 'utf8'); } catch (e) { }
  ok('Redémarrer + « Confirmer » : nouveau processus serveur, prêt', pid2 && pid2 !== pid1 && await health(), pid2);

  /* fenêtre des journaux */
  const [logw] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.electronAPI.serverControl.openLogs())]);
  await logw.waitForFunction(() => document.querySelectorAll('#log div').length > 3, null, { timeout: 10000 }).catch(() => { });
  ok('« Voir les journaux » : fenêtre dédiée avec les lignes du journal du serveur', /démarré/.test(await logw.textContent('#log')) && (await logw.textContent('#st')) === 'En marche');
  ok('la fenêtre des journaux n’offre aucune saisie de commande', (await logw.$$('input[type=text],textarea')).length === 0);
  await logw.close(); await sleep(500);
  ok('fermer la fenêtre des journaux n’arrête pas le serveur', await health());

  /* fermer l'application : le serveur reste actif */
  await quit(app); await sleep(1000);
  ok('quitter l’application (déconnexion comprise) n’arrête pas le serveur', await health());

  /* relancer l'application : serveur déjà en marche détecté */
  app = await launch(); win = await app.firstWindow();
  await win.waitForURL(u => u.toString().startsWith(URL0), { timeout: 20000 }).catch(() => { });
  ok('nouvelle ouverture de l’application : le serveur en marche est utilisé directement', win.url().startsWith(URL0));
  await win.waitForFunction(() => window.USR || (document.querySelector('#srv_us') && document.querySelector('#modal.show')), null, { timeout: 15000 });
  ok('la session Administrateur ouverte avant la fermeture est conservée (cookie de session persistant)', await win.evaluate(() => !!window.USR));
  if (!(await win.evaluate(() => !!window.USR))) { await win.fill('#srv_us', 'admin'); await win.fill('#srv_pw', PW); await win.click('#srv_go'); await win.waitForFunction(() => window.USR, null, { timeout: 10000 }); }
  r = await win.evaluate(() => window.electronAPI.serverControl.status());
  ok('état détecté : En marche, lancé hors de cette instance de l’application', r.ok && r.status.state === 'running' && /déjà en marche/.test(r.status.detail), r.status);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  r = await win.evaluate(() => window.electronAPI.serverControl.stop());
  ok('« Arrêter le serveur » (après confirmation) : arrêt propre', r.ok && !(await health()), r);
  await quit(app);

  ok('données intactes : state.json identique octet par octet après démarrage, redémarrage et arrêt', sha(path.join(SR, 'data', 'state.json')) === stateHash);
  const st = JSON.parse(fs.readFileSync(path.join(SR, 'data', 'store.json'), 'utf8'));
  ok('comptes intacts', st.users.length === 2 && st.users.some(u => u.username === 'admin' && u.role === 'admin'));
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.log('ERREUR', e); try { await fetch(URL0 + '/health'); } catch (x) { } process.exit(1); });

/* Tests du contrôle du serveur local (module utilisé par le processus principal d'Electron).
   node tests/server-control.test.js   — SERVER_CODE=<dossier contenant server.js> (par défaut ../server-bundle) ; ELECTRON_EXE=<electron> pour tester aussi le moteur intégré */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), http = require('http'), crypto = require('crypto');
const { ServerController, validateServerRoot, verifyLocalAdmin, health } = require('../server-control');
const CODE = path.resolve(process.env.SERVER_CODE || path.join(__dirname, '..', 'server-bundle'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-ctl-'));
const PORT = 9400 + Math.floor(Math.random() * 300);
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const node = { exe: process.execPath, args: [], env: { SCRYPT_N: '4096' }, label: 'node de test' };
const PW = 'Gestion-Locale-2026!';

function makeRoot(name, port) {
  const r = path.join(ROOT, name); fs.mkdirSync(path.join(r, 'data'), { recursive: true });
  fs.writeFileSync(path.join(r, 'server.env'), 'HOST=127.0.0.1\nPORT=' + port + '\nDATA_DIR=data\nLOG_DIR=logs\nBACKUP_INTERVAL_HOURS=0\nSCRYPT_N=4096\n');
  const env = { ...process.env, UNITT_CONFIG: path.join(r, 'server.env'), DATA_DIR: path.join(r, 'data'), LOG_DIR: path.join(r, 'logs'), SCRYPT_N: '4096' };
  cp.spawnSync(process.execPath, [path.join(CODE, 'tools', 'create-admin.js'), '--username', 'admin', '--name', 'Admin'], { cwd: CODE, env, input: PW + '\n' + PW + '\n' });
  // un compte non administrateur + des données centrales existantes (à préserver)
  const st = JSON.parse(fs.readFileSync(path.join(r, 'data', 'store.json'), 'utf8'));
  st.users.push({ ...st.users[0], id: 'b'.repeat(16), username: 'prof', role: 'teacher', teacherId: 't1' });
  st.absences = [{ id: 'abcd', sessionId: 's1', total: 1, absent: [{ m: '001', n: 'X' }], status: 'soumise', versions: [] }];
  fs.writeFileSync(path.join(r, 'data', 'store.json'), JSON.stringify(st));
  fs.writeFileSync(path.join(r, 'data', 'state.json'), JSON.stringify({ rev: 12, at: '2026-10-25T10:00:00Z', by: 'admin', data: { teachers: [{ id: 't1', name: 'Dr. A' }], sessions: [{ id: 's1', teacherId: 't1', date: '2026-10-20', startTime: '08:00', endTime: '10:00' }], students: [{ id: 'x', matricule: '001' }], rooms: [], levels: [], subjects: [], programs: [] } }));
  return r;
}
const procsOn = (root) => { try { return +fs.readFileSync(path.join(root, 'data', 'server.lock'), 'utf8'); } catch (e) { return 0; } };

(async () => {
  if (!fs.existsSync(path.join(CODE, 'server.js'))) { console.log('ERREUR : code du serveur introuvable dans ' + CODE + ' (lancez node scripts/copy-server.js)'); process.exit(1); }
  const R = makeRoot('srv', PORT);
  const stateHash = sha(path.join(R, 'data', 'state.json'));
  const store0 = JSON.parse(fs.readFileSync(path.join(R, 'data', 'store.json'), 'utf8'));

  /* configuration */
  const empty = path.join(ROOT, 'vide'); fs.mkdirSync(empty);
  ok('dossier sans données refusé (aucune base créée par erreur)', !validateServerRoot(empty).ok && !fs.existsSync(path.join(empty, 'data')));
  const v = validateServerRoot(R); ok('dossier du serveur valide (server.env lu, chemins absolus)', v.ok && v.cfg.port === PORT && path.isAbsolute(v.cfg.dataDir));

  /* administrateur uniquement */
  let a = await verifyLocalAdmin(v.cfg, 'admin', PW); ok('compte Administrateur vérifié localement (lecture seule)', a.ok && a.user.username === 'admin');
  a = await verifyLocalAdmin(v.cfg, 'admin', 'faux'); ok('mauvais mot de passe refusé', !a.ok);
  a = await verifyLocalAdmin(v.cfg, 'prof', PW); ok('un compte non administrateur (enseignant) est refusé', !a.ok && /Administrateur/.test(a.error));
  a = await verifyLocalAdmin(v.cfg, 'inconnu', PW); ok('compte inconnu refusé', !a.ok);
  ok('la vérification ne modifie pas les données', sha(path.join(R, 'data', 'state.json')) === stateHash);

  /* démarrage, disponibilité, instance unique */
  const states = [];
  const C = new ServerController({ codeDir: CODE, runtime: node, onStatus: s => states.push(s.state) });
  C.setServerRoot(R);
  let s = await C.refresh(); ok('état initial : Arrêté', s.state === 'stopped');
  let r = await C.start();
  ok('Démarrer : état « En marche » seulement après /health réussi', r.ok && states.includes('starting') && states[states.length - 1] === 'running' && (await health(v.cfg)).ok, r);
  const pid1 = procsOn(R);
  ok('le verrou appartient au processus lancé', pid1 && pid1 === C.pid);
  const [r2, r3] = await Promise.all([C.start(), C.start()]);
  ok('deux clics simultanés : aucune deuxième instance', (r2.ok && r2.already) || (r3.ok && r3.already) || /en cours/.test((r2.error || '') + (r3.error || '')));
  const C2 = new ServerController({ codeDir: CODE, runtime: node }); C2.setServerRoot(R);
  r = await C2.start(); ok('serveur déjà en marche détecté (autre fenêtre / autre instance de l’application) : pas de nouveau lancement', r.ok && r.already && procsOn(R) === pid1, r);
  s = await C2.refresh(); ok('état détecté : En marche (lancé hors de cette instance)', s.state === 'running' && /déjà en marche/.test(s.detail));

  /* journaux */
  await sleep(300);
  const files = C.logFiles(); ok('journaux disponibles (journal du serveur + journal de lancement)', files.some(f => /server-\d{4}/.test(f)) && files.some(f => /lancement-application/.test(f)));

  /* arrêt / redémarrage propres */
  r = await C.restart('admin');
  const pid2 = procsOn(R);
  ok('Redémarrer : arrêt propre puis relance (nouveau processus)', r.ok && pid2 && pid2 !== pid1, r);
  r = await C.stop('admin');
  ok('Arrêter : arrêt propre par l’API locale (jeton)', r.ok && !r.forced && !(await health(v.cfg)).ok && !procsOn(R), r);
  const st1 = JSON.parse(fs.readFileSync(path.join(R, 'data', 'store.json'), 'utf8'));
  ok('l’arrêt est inscrit au journal d’audit', st1.audit.some(e => e.event === 'arrêt du serveur demandé' && e.par === 'admin'));
  ok('jeton de contrôle supprimé à l’arrêt', !fs.existsSync(path.join(R, 'data', 'control.token')));

  /* données intactes */
  ok('données centrales (state.json) identiques octet par octet après démarrages / redémarrage / arrêt', sha(path.join(R, 'data', 'state.json')) === stateHash);
  ok('comptes, absences et liens intacts (seuls le journal d’audit et les sessions s’ajoutent)', JSON.stringify(st1.users.map(u => [u.username, u.role, u.pw.hash])) === JSON.stringify(store0.users.map(u => [u.username, u.role, u.pw.hash])) && JSON.stringify(st1.absences) === JSON.stringify(store0.absences));
  ok('aucune migration appliquée sans choix explicite (MIGRATIONS_AUTO=0)', !(st1.migrations || []).length);

  /* jeton refusé depuis un autre poste / sans jeton */
  await C.start();
  const resp = await new Promise(res => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/api/server/shutdown', method: 'POST', headers: { 'X-Unitt-Control': 'f'.repeat(64) } }, x => res(x.statusCode)); q.on('error', () => res(0)); q.end(); });
  ok('arrêt avec un jeton invalide refusé (403), serveur toujours en marche', resp === 403 && (await health(v.cfg)).ok);

  /* arrêt inattendu */
  const before = states.length; process.kill(procsOn(R), 'SIGKILL'); await sleep(1500);
  ok('arrêt inattendu du processus détecté (état Erreur avec le motif)', C.state === 'error' && /inattendu/.test(C.detail), C.detail);
  try { fs.unlinkSync(path.join(R, 'data', 'server.lock')); } catch (e) { }

  /* conflit de port */
  const busy = http.createServer((q, x) => x.end('autre logiciel')); await new Promise(res => busy.listen(PORT, '127.0.0.1', res));
  r = await C.start(); ok('port occupé par un autre programme : erreur claire, aucun lancement', !r.ok && r.portConflict && C.state === 'error' && /déjà utilisé/.test(C.detail), r);
  busy.close();

  /* échec de démarrage : données illisibles -> refus, rien n'est écrasé */
  const RB = makeRoot('casse', PORT + 1); fs.writeFileSync(path.join(RB, 'data', 'store.json'), '{ illisible'); fs.rmSync(path.join(RB, 'data', 'store.json.bak'), { force: true });
  const CB = new ServerController({ codeDir: CODE, runtime: node }); CB.setServerRoot(RB);
  r = await CB.start(); ok('échec de démarrage (données illisibles) signalé clairement', !r.ok && r.exitCode === 4 && /illisible/.test(r.error), r);
  ok('le fichier illisible n’a pas été écrasé ni recréé', fs.readFileSync(path.join(RB, 'data', 'store.json'), 'utf8') === '{ illisible');

  /* le serveur survit à la fermeture de l'application (processus détaché) */
  const script = `const {ServerController}=require(${JSON.stringify(path.join(__dirname, '..', 'server-control.js'))});(async()=>{const c=new ServerController({codeDir:${JSON.stringify(CODE)},runtime:{exe:process.execPath,args:[],env:{SCRYPT_N:'4096'},label:'x'}});c.setServerRoot(${JSON.stringify(R)});const r=await c.start();console.log(JSON.stringify(r.ok));process.exit(0)})()`;
  const out = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 40000 });
  await sleep(800);
  ok('fermer l’application n’arrête pas le serveur (processus détaché toujours en marche)', /true/.test(out.stdout) && (await health(v.cfg)).ok, out.stdout + out.stderr);
  const C3 = new ServerController({ codeDir: CODE, runtime: node }); C3.setServerRoot(R);
  r = await C3.stop('admin'); ok('une nouvelle fenêtre de l’application peut l’arrêter proprement', r.ok);

  /* moteur Node intégré à Electron (application installée sans Node.js) */
  if (process.env.ELECTRON_EXE) {
    const CE = new ServerController({ codeDir: CODE, runtime: { exe: process.env.ELECTRON_EXE, args: [], env: { ELECTRON_RUN_AS_NODE: '1', SCRYPT_N: '4096' }, label: 'electron' } }); CE.setServerRoot(R);
    r = await CE.start(); const h = await health(v.cfg);
    ok('moteur intégré à Electron (ELECTRON_RUN_AS_NODE) : le serveur démarre', r.ok && h.ok, r);
    r = await CE.stop('admin'); ok('moteur intégré : arrêt propre', r.ok);
    ok('données toujours intactes après le moteur intégré', sha(path.join(R, 'data', 'state.json')) === stateHash);
  } else console.log('SKIP moteur intégré à Electron (ELECTRON_EXE non défini)');

  console.log('\n' + passes + ' réussis, ' + fails + ' échoués');
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERREUR', e); process.exit(1); });

/* Régression : sur Vercel (ou toute plateforme sans serveur), le chargement du serveur ne doit JAMAIS créer
   ni utiliser le dossier local server/data, quel que soit le point d'entrée et la valeur de UNITT_STORAGE.
   En local (sans VERCEL), le stockage fichiers reste utilisé.   node tests/serverless.test.js */
'use strict';
const cp = require('child_process'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + x : '')); };
const probe = `const path=require('path'),fs=require('fs');const root=process.argv[1],entry=process.argv[2],data=path.join(root,'server','data');const real=fs.mkdirSync;let att=null;
fs.mkdirSync=function(p){if(String(p).startsWith(data)){att=String(p);const e=new Error('EROFS');e.code='EROFS';throw e}return real.apply(this,arguments)};
const wf=fs.writeFileSync;fs.writeFileSync=function(p){if(String(p).startsWith(data)){att=att||String(p);const e=new Error('EROFS');throw e}return wf.apply(this,arguments)};
let err=null,exp=null;try{exp=require(path.join(root,entry==='api'?'api/index.js':'server/server.js'))}catch(e){err=e.message}
const cfg=require(path.join(root,'server/lib/config.js'));
console.log(JSON.stringify({STORAGE:cfg.STORAGE,att,err,fn:typeof exp,handler:!!(exp&&typeof exp.cloudHandler==='function')}));process.exit(0)`;
function run(entry, env) {
  const r = cp.spawnSync(process.execPath, ['-e', probe, ROOT, entry], { env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', UNITT_QUIET: '1', UNITT_CONFIG: '/nonexistent', ...env }, encoding: 'utf8', timeout: 20000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return { raw: r.stdout + r.stderr }; }
}
const S = { SUPABASE_URL: 'https://exemple.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'cle' };
const cases = [
  ['Vercel, entrée api/index.js, variables normales', 'api', { VERCEL: '1', ...S }],
  ['Vercel, entrée server.js chargée directement, sans UNITT_STORAGE', 'server', { VERCEL: '1', ...S }],
  ['Vercel, entrée server.js, SUPABASE_URL absent', 'server', { VERCEL: '1' }],
  ['Vercel, UNITT_STORAGE=files', 'server', { VERCEL: '1', UNITT_STORAGE: 'files', ...S }],
  ['Vercel, UNITT_STORAGE avec espace / majuscule (« Supabase »)', 'server', { VERCEL: '1', UNITT_STORAGE: 'Supabase ', ...S }],
  ['Vercel, entrée api/index.js, UNITT_STORAGE=files', 'api', { VERCEL: '1', UNITT_STORAGE: 'files', ...S }],
  ['AWS Lambda (sans VERCEL)', 'server', { AWS_LAMBDA_FUNCTION_NAME: 'f', ...S }]
];
for (const [name, entry, env] of cases) {
  const r = run(entry, env);
  ok(name + ' : stockage Supabase, aucun accès à server/data, chargement sans erreur', r.STORAGE === 'supabase' && !r.att && !r.err, JSON.stringify(r));
}
let r = run('server', { VERCEL: '1', ...S });
ok('serveur direct : l’export est une fonction (req, res) avec cloudHandler', r.fn === 'function' && r.handler, JSON.stringify(r));
r = run('server', { UNITT_STORAGE: 'supabase', ...S });
ok('local, UNITT_STORAGE=supabase (outil cloud-dev) : stockage Supabase', r.STORAGE === 'supabase' && !r.att, JSON.stringify(r));
r = run('server', { DATA_DIR: path.join(ROOT, 'server', 'data') });
ok('local Windows / réseau (sans VERCEL) : stockage fichiers conservé (dossier data utilisé)', r.STORAGE === 'files' && !!r.att, JSON.stringify(r));
console.log('\n' + passes + ' réussis, ' + fails + ' échoués'); process.exit(fails ? 1 : 0);

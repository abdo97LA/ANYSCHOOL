'use strict';
/* Prépare la copie du serveur embarquée dans l'installateur (resources\server).
   Ne copie QUE le code : jamais data\, logs\, backups\, certs\ ni server.env (aucune donnée ni secret dans l'installateur).
   Source : ..\um6ss-server\um6ss-server (ou variable UNITT_SERVER_SRC). Usage : node scripts/copy-server.js */
const fs = require('fs'), path = require('path');
const SRC = path.resolve(process.env.UNITT_SERVER_SRC || path.join(__dirname, '..', '..', 'um6ss-server', 'um6ss-server'));
const DST = path.join(__dirname, '..', 'server-bundle');
const INCLUDE = ['server.js', 'package.json', 'server.env.exemple', 'README-LOCAL-WINDOWS.md', 'lib', 'public', 'tools', 'windows'];
const EXCLUDE = new Set(['index.base.html']);
const FORBIDDEN = /(^|[\\/])(data|logs|backups|certs|node_modules|_sauvegarde-avant-lan)([\\/]|$)|(^|[\\/])server\.env$|\.(pfx|key|lock|token)$/i;
if (!fs.existsSync(path.join(SRC, 'server.js'))) { console.error('Serveur introuvable : ' + SRC + ' (définissez UNITT_SERVER_SRC)'); process.exit(1); }
try { fs.rmSync(DST, { recursive: true, force: true }); }
catch (e) { console.error('Impossible de remplacer server-bundle (' + e.code + ') : un serveur lancé depuis ce dossier est probablement en marche.\nArrêtez-le d’abord (UniTimetable > Administration > Arrêter le serveur), puis relancez la compilation.'); process.exit(1); }
fs.mkdirSync(DST, { recursive: true });
let n = 0, bytes = 0;
function copy(rel) {
  const s = path.join(SRC, rel), d = path.join(DST, rel);
  if (FORBIDDEN.test(rel) || EXCLUDE.has(path.basename(rel))) return;
  const st = fs.statSync(s);
  if (st.isDirectory()) { fs.mkdirSync(d, { recursive: true }); for (const c of fs.readdirSync(s)) copy(path.join(rel, c)); return; }
  fs.copyFileSync(s, d); n++; bytes += st.size;
}
for (const r of INCLUDE) if (fs.existsSync(path.join(SRC, r))) copy(r);
const walk = p => fs.readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(p, e.name)) : [path.relative(DST, path.join(p, e.name))]);
const bad = walk(DST).filter(f => FORBIDDEN.test(f));
if (bad.length) { console.error('Fichiers interdits dans la copie : ' + bad.join(', ')); process.exit(1); }
for (const f of ['server.js', 'lib/config.js', 'public/index.html', 'public/form.html']) if (!fs.existsSync(path.join(DST, f))) { console.error('Fichier requis manquant : ' + f); process.exit(1); }
console.log('Serveur copié dans server-bundle : ' + n + ' fichiers, ' + Math.round(bytes / 1024) + ' Ko (aucune donnée, aucun secret).');

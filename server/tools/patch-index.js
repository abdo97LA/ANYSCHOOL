'use strict';
/* Construit public/index.html à partir de l'interface d'origine (public/index.base.html) :
   - bibliothèques servies localement (public/vendor) au lieu des CDN Internet ;
   - insertion du bloc public/lan-client.js (comptes, rôles, synchronisation, administration) ;
   - quelques renommages ciblés pour envelopper les fonctions existantes.
   Usage : node tools/patch-index.js   (à relancer après toute mise à jour de index.base.html) */
const fs = require('fs'), path = require('path');
const PUB = path.join(__dirname, '..', 'public');
let s = fs.readFileSync(path.join(PUB, 'index.base.html'), 'utf8').replace(/^﻿/, '');
const lan = fs.readFileSync(path.join(PUB, 'lan-client.js'), 'utf8');
const R = [
  ['<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>', '<script src="vendor/pdf.js"></script>'],
  ['<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>', '<script src="vendor/xlsx.full.min.js"></script>'],
  ['<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>', '<script src="vendor/jspdf.umd.min.js"></script>'],
  ["pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'", "pdfjsLib.GlobalWorkerOptions.workerSrc='vendor/pdf.worker.js'"],
  ["toast('Moteur PDF non chargé. Vérifiez la connexion.',true)", "toast('Moteur PDF absent du serveur (dossier public/vendor) : voir README-LOCAL-WINDOWS.md.',true)"],
  ['<button id="bk" title="Sauvegarde et restauration"', '<span id="usr" style="display:none"></span><button id="bk" title="Sauvegarde et restauration"'],
  ["e.status=r.status;throw e}return j}", "e.status=r.status;e.body=j;throw e}return j}"],
  ["user:SRV.on&&SRV.auth?'administration (serveur)':'poste local'", "user:SRV.on&&SRV.auth?(window.USR?USR.username+' ('+USR.roleLabel+')':'serveur'):'poste local'"],
  ['function render(){$(\'#nav\')', 'function render0(){$(\'#nav\')'],
  ["tab==='templates'?tplView():", "tab==='admin'?admView():tab==='templates'?tplView():"],
  ['function polView(){', 'function polView0(){'],
  ['function studentsOf(s){', 'function studentsOf0(s){'],
  ['function absDlg(sid){', 'function absDlg0(sid){'],
  ['function backupDlg(){', 'function backupDlg0(){'],
  ['async function restoreDo(){', 'async function restoreDo0(){'],
  ["addEventListener('storage',e=>{", lan + "\naddEventListener('storage',e=>{"]
];
for (const [a, b] of R) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('Motif trouvé ' + n + ' fois (attendu : 1) : ' + a.slice(0, 90)); process.exit(1); }
  s = s.replace(a, () => b);
}
if (/cdnjs\.cloudflare\.com/.test(s)) { console.error('Une référence CDN subsiste.'); process.exit(1); }
fs.writeFileSync(path.join(PUB, 'index.html'), s);
console.log('public/index.html généré (' + Math.round(s.length / 1024) + ' Ko).');

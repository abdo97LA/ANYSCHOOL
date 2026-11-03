'use strict';
/* Télécharge UNE FOIS les bibliothèques JavaScript utilisées par l'interface (import/export Excel, PDF)
   pour qu'elles soient servies par le serveur local, sans Internet ensuite.
   Usage (PC serveur, connexion Internet nécessaire uniquement pendant cette commande) :
       node tools/fetch-vendor.js
   Sans Internet sur le PC serveur : copiez les fichiers depuis un autre PC dans public\vendor (mêmes noms). */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'public', 'vendor');
const LIBS = [
  { file: 'xlsx.full.min.js', check: /XLSX/, urls: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'] },
  { file: 'jspdf.umd.min.js', check: /jspdf/i, urls: ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', 'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js'] },
  { file: 'pdf.js', check: /pdfjsLib|pdfjs-dist/, urls: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'] },
  { file: 'pdf.worker.js', check: /pdfjs|WorkerMessageHandler/, urls: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'] }
];
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const manPath = path.join(DIR, 'manifest.json'); let man = {}; try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (e) { /* */ }
  let bad = 0;
  for (const L of LIBS) {
    const dest = path.join(DIR, L.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000 && !process.argv.includes('--force')) { console.log('[déjà présent] ' + L.file); continue; }
    let done = false;
    for (const u of L.urls) {
      try {
        const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 10000 || !L.check.test(buf.subarray(0, 400000).toString('latin1'))) throw new Error('contenu inattendu');
        fs.writeFileSync(dest + '.tmp', buf); fs.renameSync(dest + '.tmp', dest);
        man[L.file] = { source: u, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), at: new Date().toISOString() };
        console.log('[téléchargé] ' + L.file + ' (' + Math.round(buf.length / 1024) + ' Ko) depuis ' + new URL(u).host); done = true; break;
      } catch (e) { console.log('  échec ' + new URL(u).host + ' : ' + e.message); }
    }
    if (!done) { bad++; console.log('[MANQUANT] ' + L.file); }
  }
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
  if (bad) { console.log('\n' + bad + ' bibliothèque(s) manquante(s) : les fonctions Excel/PDF correspondantes seront indisponibles. Réessayez avec une connexion Internet.'); process.exit(1); }
  console.log('\nToutes les bibliothèques sont disponibles localement.');
})();

'use strict';
/* Import des données de l'application (fichier « sauvegarde_um6ss_AAAA-MM-JJ.json » exporté depuis
   💾 Sauvegarde > Exporter toutes les données) vers l'état central du serveur. Serveur ARRÊTÉ.
   Usage : node tools/import-data.js --file C:\chemin\sauvegarde_um6ss_2026-10-25.json [--yes]
   L'état central actuel est sauvegardé avant le remplacement. */
const fs = require('fs');
const C = require('./common'); const BK = require('../lib/backup');
(async () => {
  C.requireStopped('importer des données');
  const file = C.arg('file') || await C.ask('Chemin du fichier JSON exporté : ');
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const data = j && j.app === 'um6ss-edt' ? j.data : null;
  if (!data || !Array.isArray(data.sessions) || !Array.isArray(data.teachers)) { console.error('Ce fichier n’est pas une sauvegarde exportée par UniTimetable.'); process.exit(1); }
  const cnt = k => Array.isArray(data[k]) ? data[k].length : 0;
  console.log('Contenu : ' + ['sessions', 'teachers', 'subjects', 'rooms', 'levels', 'students', 'templates'].map(k => k + '=' + cnt(k)).join(', '));
  const cur = C.readJson(C.STATE_FILE, { rev: 0, data: null }, null);
  if (cur.data && !process.argv.includes('--yes')) { const a = await C.ask('Le serveur contient déjà des données (révision ' + cur.rev + '). Elles seront remplacées (une sauvegarde est faite avant). Taper OUI : '); if (a !== 'OUI') { console.log('Annulé.'); return; } }
  const b = BK.create(C.TARGET.dir, C.TARGET.backupDir, 'avant-import', C.cfg.BACKUP_KEEP);
  const st = { rev: (cur.rev || 0) + 1, at: new Date().toISOString(), by: 'import console', data };
  C.writeAtomic(C.STATE_FILE, st);
  const store = C.loadStore(); C.auditCli(store, 'données importées (console)', { fichier: require('path').basename(file), rev: st.rev, sauvegardePrealable: b.name }); C.saveStore(store);
  console.log('Import terminé (révision ' + st.rev + '). Sauvegarde préalable : ' + b.name + '. Démarrez le serveur : les postes chargeront ces données.');
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

'use strict';
/* Restauration d'une sauvegarde (serveur ARRÊTÉ). L'état actuel est d'abord sauvegardé (« avant-restauration »).
   Usage : node tools/restore.js --list
           node tools/restore.js --name 20261025-101500-auto [--from D:\Sauvegardes\UniTimetable] [--yes] */
const path = require('path'), fs = require('fs');
const C = require('./common'); const BK = require('../lib/backup');
(async () => {
  const from = C.arg('from') || C.TARGET.backupDir;   // --etab <code> : autre établissement
  if (process.argv.includes('--list')) { for (const b of BK.list(from)) console.log(b.name + '  ' + (b.createdAt || '') + '  ' + (b.reason || '')); return; }
  C.requireStopped('restaurer une sauvegarde');
  const name = C.arg('name') || await C.ask('Nom de la sauvegarde à restaurer (voir --list) : ');
  const dir = path.isAbsolute(name) ? name : path.join(from, name);
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) { console.error('Sauvegarde introuvable : ' + dir); process.exit(1); }
  const v = BK.verify(dir); if (!v.ok) { console.error('Sauvegarde altérée ou incomplète (' + v.bad.join(', ') + '). Restauration annulée.'); process.exit(1); }
  if (!process.argv.includes('--yes')) { const a = await C.ask('Les données actuelles seront remplacées par celles du ' + v.manifest.createdAt + '. Taper OUI pour confirmer : '); if (a !== 'OUI') { console.log('Annulé.'); return; } }
  const prevRev = (C.readJson(C.STATE_FILE, {}, null) || {}).rev || 0;
  const r = BK.restore(C.TARGET.dir, C.TARGET.backupDir, dir, 0);
  // révision supérieure à l'ancienne : les postes clients rechargent automatiquement les données restaurées
  const st = C.readJson(C.STATE_FILE, null, null);
  if (st) { st.rev = Math.max(prevRev, st.rev || 0) + 1; st.at = new Date().toISOString(); st.by = 'restauration'; C.writeAtomic(C.STATE_FILE, st, { noBackup: true }); }
  const store = C.loadStore(); store.logins = {}; C.auditCli(store, 'sauvegarde restaurée (console)', { sauvegarde: r.restored, copieDeSecurite: r.safetyCopy }); C.saveStore(store);
  console.log('Restauration terminée depuis « ' + r.restored + ' ». Copie de l’état précédent : « ' + r.safetyCopy + ' ». Toutes les sessions ont été fermées. Redémarrez le serveur.');
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

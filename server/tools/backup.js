'use strict';
/* Sauvegarde immédiate (possible serveur démarré : les fichiers sont écrits de façon atomique).
   Usage : node tools/backup.js [--list] [--dest D:\Sauvegardes\UniTimetable] */
const C = require('./common'); const BK = require('../lib/backup');
const dest = C.arg('dest') || C.cfg.BACKUP_DIR;
if (process.argv.includes('--list')) { for (const b of BK.list(dest)) console.log(b.name + '  ' + (b.createdAt || '') + '  ' + (b.reason || '') + (b.error ? '  ' + b.error : '')); process.exit(0); }
try { const b = BK.create(C.cfg.DATA_DIR, dest, 'manuelle', C.cfg.BACKUP_KEEP); console.log('Sauvegarde créée : ' + b.dir); for (const [f, i] of Object.entries(b.files)) console.log('  ' + f + '  ' + i.bytes + ' octets  sha256=' + i.sha256.slice(0, 16) + '…'); }
catch (e) { console.error('Échec : ' + e.message); process.exit(1); }

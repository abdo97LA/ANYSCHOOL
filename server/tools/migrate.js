'use strict';
/* Migrations du modèle de données (serveur ARRÊTÉ).
   node tools/migrate.js --status                 état des migrations
   node tools/migrate.js --up                     applique les migrations en attente (le serveur le fait aussi au démarrage)
   node tools/migrate.js --down <id> [--force]    annule les migrations jusqu'à <id> inclus (retour arrière)
   Une sauvegarde complète vérifiée est faite avant --up et --down. Option --data-dir pour travailler sur une COPIE. */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const C = require('./common'); const BK = require('../lib/backup'); const MIG = require('../lib/migrations');
const dd = C.arg('data-dir'); const DATA = dd ? path.resolve(dd) : C.cfg.DATA_DIR;
const STORE = path.join(DATA, 'store.json'), STATE = path.join(DATA, 'state.json');
(async () => {
  const store = C.readJson(STORE, {}, null) || {}; store.audit = store.audit || [];
  const state = C.readJson(STATE, { rev: 0, at: '', by: '', data: null }, null);
  if (process.argv.includes('--status')) {
    const done = store.migrations || [];
    for (const m of MIG.MIGRATIONS) { const d = done.find(x => x.id === m.id); console.log((d ? '[appliquée ' + d.at.slice(0, 16) + '] ' : '[en attente]           ') + m.id + ' — ' + m.description); }
    return;
  }
  if (!dd) C.requireStopped('migrer les données');
  const up = process.argv.includes('--up'), down = C.arg('down');
  if (!up && !down) { console.log('Indiquez --status, --up ou --down <id>.'); process.exit(1); }
  const bdir = dd ? path.join(DATA, 'backups') : C.cfg.BACKUP_DIR;
  const b = BK.create(DATA, bdir, down ? 'avant-retour-migration' : 'avant-migration', 0);
  if (!BK.verify(b.dir).ok) { console.error('Sauvegarde non vérifiée : opération annulée.'); process.exit(1); }
  console.log('Sauvegarde vérifiée : ' + b.dir);
  const ctx = { store, state, stateChanged: false };
  let ids;
  try { ids = down ? MIG.revertTo(ctx, down, process.argv.includes('--force')) : MIG.applyAll(ctx); }
  catch (e) { console.error('Annulé : ' + e.message + ' (aucune donnée modifiée)'); process.exit(1); }
  if (!ids.length) { console.log('Rien à faire.'); return; }
  if (ctx.stateChanged && state.data) {
    state.rev = (state.rev || 0) + 1; state.at = new Date().toISOString(); state.by = down ? 'retour migration' : 'migration';
    C.writeAtomic(STATE, state);
    const h = path.join(DATA, 'history'); fs.mkdirSync(h, { recursive: true }); fs.writeFileSync(path.join(h, 'rev-' + state.rev + '.json.gz'), zlib.gzipSync(JSON.stringify(state.data)));
  }
  for (const id of ids) C.auditCli(store, down ? 'migration annulée (console)' : 'migration appliquée (console)', { migration: id });
  C.writeAtomic(STORE, store);
  console.log((down ? 'Migrations annulées : ' : 'Migrations appliquées : ') + ids.join(', '));
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

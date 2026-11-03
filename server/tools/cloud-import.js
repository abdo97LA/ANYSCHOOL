'use strict';
/* Copie les données d'un serveur local (data\store.json et data\state.json) vers Supabase, pour les retrouver en ligne.
   Les fichiers locaux ne sont PAS modifiés. Si la base Supabase contient déjà des données, il faut --force
   (une sauvegarde Supabase est alors faite avant le remplacement).
   Usage (PowerShell) :
     $env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="…"
     node tools/cloud-import.js --data "C:\…\um6ss-server\um6ss-server\data" [--force] [--sans-comptes]
   --sans-comptes : n'importe pas les comptes ni les sessions (on recréera les comptes en ligne). */
const fs = require('fs'), path = require('path');
const SB = require('../lib/supabase');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
(async () => {
  const dir = path.resolve(arg('data') || path.join(__dirname, '..', 'data'));
  const read = f => { const p = path.join(dir, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
  const store = read('store.json'), state = read('state.json');
  if (!store && !state) { console.error('Aucune donnée dans ' + dir); process.exit(1); }
  if (!SB.configured()) { console.error('Définissez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }
  if (store) { store.logins = {}; if (process.argv.includes('--sans-comptes')) store.users = []; }   // les sessions ouvertes localement ne sont jamais copiées
  const cur = await SB.load();
  if ((cur.store || cur.state) && !process.argv.includes('--force')) { console.error('La base Supabase contient déjà des données. Relancez avec --force pour les remplacer (une sauvegarde sera faite avant).'); process.exit(2); }
  if (cur.store || cur.state) { const b = await SB.backup('avant-import', 30); console.log('Sauvegarde Supabase faite avant import : ' + JSON.stringify(b)); }
  if (state && cur.state && (cur.state.rev || 0) >= (state.rev || 0)) state.rev = (cur.state.rev || 0) + 1;   // les postes rechargeront les données
  await SB.save({ store: store || undefined, storeVersion: cur.storeVersion, state: state || undefined, stateVersion: cur.stateVersion, histRev: state ? state.rev : null, histData: state ? state.data : undefined, histKeep: 50 });
  console.log('Import terminé : ' + (store ? (store.users || []).length + ' compte(s), ' + (store.absences || []).length + ' déclaration(s) ; ' : '') + (state && state.data ? (state.data.sessions || []).length + ' séance(s), ' + (state.data.students || []).length + ' étudiant(s), révision ' + state.rev : ''));
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

'use strict';
/* Copie les données d'un établissement local (dossier data : store.json, state.json, audit.jsonl) vers Supabase.
   Les fichiers locaux ne sont PAS modifiés. Si l'établissement en ligne contient déjà des données, il faut --force
   (une sauvegarde Supabase est alors faite avant le remplacement).
   Usage (PowerShell) :
     $env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="…"
     node tools/cloud-import.js --data "C:\…\data" [--etab <code en ligne>] [--force] [--sans-comptes]
   --etab        : établissement en ligne visé (code affiché dans la console Super Admin) ; par défaut le premier établissement.
   --sans-comptes : n'importe pas les comptes ni les sessions (on recréera les comptes en ligne).
   Journal d'audit : copié seulement si celui de l'établissement en ligne est vide (il est en ajout seul : on ne peut
   pas y insérer d'anciennes entrées) ; sinon un événement « données importées » y est ajouté. */
const fs = require('fs'), path = require('path');
const SB = require('../lib/supabase'), AL = require('../lib/auditlog');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
(async () => {
  const dir = path.resolve(arg('data') || path.join(__dirname, '..', 'data'));
  const read = f => { const p = path.join(dir, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
  const store = read('store.json'), state = read('state.json');
  if (!store && !state) { console.error('Aucune donnée dans ' + dir); process.exit(1); }
  if (!SB.configured()) { console.error('Définissez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }
  let localAudit = new AL.FileAudit(path.join(dir, 'audit.jsonl')).readAll();
  if (store && Array.isArray(store.audit)) { if (!localAudit.length) localAudit = store.audit; delete store.audit; }
  if (store) { store.logins = {}; if (process.argv.includes('--sans-comptes')) store.users = []; }   // les sessions ouvertes localement ne sont jamais copiées
  /* établissement visé */
  let key = '';
  const code = String(arg('etab') || '').trim().toLowerCase();
  if (code) {
    const pf = (await SB.load(['platform'], [])).docs.platform;
    const t = pf && (pf.data.tenants || []).find(x => x.slug === code);
    if (!t) { console.error('Établissement « ' + code + ' » introuvable en ligne (créez-le d’abord dans la console Super Admin).'); process.exit(1); }
    key = t.legacy ? '' : t.id;
  }
  const ids = [SB.docId('store', key), SB.docId('state', key)];
  const cur = await SB.load(ids, [key]), cs = cur.docs[ids[0]], ct = cur.docs[ids[1]];
  if ((cs || ct) && !process.argv.includes('--force')) { console.error('L’établissement en ligne contient déjà des données. Relancez avec --force pour les remplacer (une sauvegarde sera faite avant).'); process.exit(2); }
  if (cs || ct) { const b = await SB.backup(key, 'avant-import', 30); console.log('Sauvegarde Supabase faite avant import : ' + JSON.stringify(b)); }
  if (state && ct && ((ct.data || {}).rev || 0) >= (state.rev || 0)) state.rev = (ct.data.rev || 0) + 1;   // les postes rechargeront les données
  const last = cur.last[key] || AL.GENESIS, audit = [];
  if (last === AL.GENESIS && localAudit.length && AL.chainValid(localAudit)) for (const e of localAudit) audit.push({ tenant: key, entry: e });
  else audit.push({ tenant: key, entry: AL.seal(last, { at: new Date().toISOString(), event: 'données importées depuis un serveur local (console)', section: 'système', result: 'succès', ip: 'console', user: 'console', entreesLocales: localAudit.length }) });
  const docs = [];
  if (store) docs.push({ id: ids[0], data: store, version: cs ? cs.version : 0 });
  if (state) docs.push({ id: ids[1], data: state, version: ct ? ct.version : 0 });
  await SB.saveDocs({ docs, audit, hist: state ? { tenant: key, rev: state.rev, data: state.data, keep: 50 } : null });
  console.log('Import terminé : ' + (store ? (store.users || []).length + ' compte(s), ' + (store.absences || []).length + ' déclaration(s) ; ' : '') + (state && state.data ? (state.data.sessions || []).length + ' séance(s), ' + (state.data.students || []).length + ' étudiant(s), révision ' + state.rev : '') + ' ; journal : ' + (audit.length > 1 || (audit.length === 1 && localAudit.length === 1) ? audit.length + ' entrée(s) copiée(s)' : 'événement d’import ajouté'));
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

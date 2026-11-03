'use strict';
/* Migrations versionnées et réversibles des données (store.json + state.json).
   - Chaque migration ne fait qu'AJOUTER des champs ; son « down » retire exactement ce qu'elle a ajouté.
   - Avant toute migration, une sauvegarde complète est créée puis VÉRIFIÉE (empreintes SHA-256) ; sans sauvegarde valide, rien n'est modifié.
   - Les migrations appliquées sont notées dans store.migrations. */
const { acy, maintainGroupHistory } = require('./model');

const MIGRATIONS = [
  {
    id: '001-annee-universitaire-absences',
    description: 'Ajoute l’année universitaire (ay) à chaque déclaration d’absences, calculée à partir de la date de la séance.',
    up(ctx) {
      const added = [];
      for (const a of ctx.store.absences || []) if (a && a.ay === undefined) { a.ay = acy(a.date); added.push(a.id); }
      return { added };
    },
    down(ctx, info) {
      const ids = new Set((info && info.added) || []);
      for (const a of ctx.store.absences || []) if (ids.has(a.id)) delete a.ay;
    }
  },
  {
    id: '002-historique-groupes',
    description: 'Crée l’historique d’appartenance aux groupes de chaque étudiant (entrée initiale = groupe actuel, date inconnue).',
    up(ctx) {
      const added = [];
      if (ctx.state.data && Array.isArray(ctx.state.data.students)) {
        for (const s of ctx.state.data.students) if (s && !Array.isArray(s.groupHistory)) added.push(s.id);
        maintainGroupHistory(null, ctx.state.data, '');
        ctx.stateChanged = added.length > 0;
      }
      return { added };
    },
    down(ctx, info, force) {
      const ids = new Set((info && info.added) || []);
      const S = (ctx.state.data && ctx.state.data.students) || [];
      const grown = S.filter(s => ids.has(s.id) && Array.isArray(s.groupHistory) && s.groupHistory.length > 1);
      if (grown.length && !force) throw new Error(grown.length + ' étudiant(s) ont changé de groupe depuis la migration : annuler effacerait cet historique. Relancez avec --force pour l’accepter.');
      for (const s of S) if (ids.has(s.id)) delete s.groupHistory;
      ctx.stateChanged = ids.size > 0;
    }
  }
];
const LATEST = MIGRATIONS.length;

function pending(store) { const done = new Set((store.migrations || []).map(m => m.id)); return MIGRATIONS.filter(m => !done.has(m.id)); }
/* ctx = { store, state } (objets modifiés sur place). Renvoie la liste des migrations appliquées. */
function applyAll(ctx) {
  ctx.store.migrations = ctx.store.migrations || [];
  const applied = [];
  for (const m of pending(ctx.store)) {
    const info = m.up(ctx) || {};
    ctx.store.migrations.push({ id: m.id, at: new Date().toISOString(), info });
    applied.push(m.id);
  }
  return applied;
}
/* Annule les migrations jusqu'à (et y compris) « toId », dans l'ordre inverse. */
function revertTo(ctx, toId, force) {
  const list = ctx.store.migrations || [];
  const idx = list.findIndex(m => m.id === toId); if (idx < 0) throw new Error('Migration non appliquée : ' + toId);
  const reverted = [];
  for (let i = list.length - 1; i >= idx; i--) {
    const rec = list[i], m = MIGRATIONS.find(x => x.id === rec.id); if (!m) throw new Error('Migration inconnue : ' + rec.id);
    m.down(ctx, rec.info, force); reverted.push(rec.id); list.splice(i, 1);
  }
  return reverted;
}
module.exports = { MIGRATIONS, LATEST, pending, applyAll, revertTo };

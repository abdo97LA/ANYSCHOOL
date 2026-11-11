'use strict';
/* Suppression logique (phase 2) — appliquée par le SERVEUR, quelle que soit l'interface utilisée.
   Quand un poste enregistre des données centrales d'où un élément a disparu (bouton « Supprimer »), le serveur :
   1. ne perd jamais l'élément : il le conserve tel quel (même identifiant, toutes ses valeurs et ses liens)
      dans la corbeille de l'établissement (store.trash), avec le statut « supprimé » ;
   2. enregistre qui l'a supprimé, quand et pourquoi (motif facultatif ou obligatoire selon l'établissement) ;
   3. inscrit un événement « suppression logique » au journal d'audit.
   L'élément est masqué des vues normales. Il peut être restauré (même identifiant, liens intacts), après
   vérification des conflits (doublon, dépendance supprimée, conflit d'emploi du temps). Rien n'est jamais purgé. */
const crypto = require('crypto');
const { stable } = require('./state');

const SOFT = { students: 'Étudiant', teachers: 'Enseignant', sessions: 'Séance', levels: 'Groupe', subjects: 'Matière', rooms: 'Salle', programs: 'Filière', templates: 'Modèle de document', volumes: 'Volume horaire' };
const SECTION = { students: 'étudiants', teachers: 'enseignants', sessions: 'emploi du temps', levels: 'groupes', subjects: 'emploi du temps', rooms: 'emploi du temps', programs: 'filières', templates: 'documents', volumes: 'volumes horaires' };
const rid = () => crypto.randomBytes(8).toString('hex');
function label(coll, x, data) {
  if (!x) return '';
  if (coll === 'students') return [String(x.lastName || '').toUpperCase(), x.firstName].filter(Boolean).join(' ') + (x.matricule ? ' (' + x.matricule + ')' : '');
  if (coll === 'sessions') {
    const sub = ((data && data.subjects) || []).find(s => s.id === x.subjectId);
    return (x.title || (sub && sub.name) || 'Séance') + ' — ' + (x.date || x.day || '') + ' ' + (x.startTime || '') + (x.endTime ? '-' + x.endTime : '');
  }
  if (coll === 'volumes') return [x.title, x.program, x.year && 'A' + x.year, x.group, x.teach].filter(Boolean).join(' · ') || x.id;
  return x.name || x.title || x.label || x.id;
}
/* éléments supprimés entre prev et next (collections à suppression logique) */
function deletedBetween(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  for (const c of Object.keys(SOFT)) {
    const a = Array.isArray(prev[c]) ? prev[c] : [], b = Array.isArray(next[c]) ? next[c] : [];
    if (!a.length) continue;
    const keep = new Set(b.filter(x => x && x.id).map(x => x.id));
    for (const x of a) if (x && x.id && !keep.has(x.id)) out.push({ collection: c, record: x });
  }
  return out;
}
function makeEntries(dels, meta, prevData) {
  return dels.map(d => ({
    id: rid(), collection: d.collection, type: SOFT[d.collection], recordId: d.record.id, label: label(d.collection, d.record, prevData),
    data: JSON.parse(JSON.stringify(d.record)), status: 'deleted',
    deletedAt: meta.at, deletedBy: meta.by, deletedById: meta.byId || '', deletedByName: meta.byName || '', reason: meta.reason || '', rev: meta.rev || 0,
    history: [{ at: meta.at, action: 'suppression', by: meta.by, reason: meta.reason || '' }]
  }));
}

/* ---------- conflits avant restauration ---------- */
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
const mn = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const dowOf = d => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
function sessGroupOf(data, s) {
  const sub = (data.subjects || []).find(x => x.id === s.subjectId), l = sub && (data.levels || []).find(x => x.id === sub.level);
  const P = data.programs || [], p = P.find(x => x.id === s.programId);
  let prog = p ? p.name : ''; if (!prog && l) { const t = l.program || String(l.name || '').split(' ')[0]; if (P.some(x => x.name === t)) prog = t; }
  return { prog, year: String(s.year || (l && l.year) || ''), group: s.group || (l && l.group) || '', level: sub ? sub.level : '' };
}
function sameSlot(a, b) {
  if (a.date && b.date) { if (a.date !== b.date) return false; }
  else if (!a.date && !b.date) { if (a.day !== b.day) return false; }
  else { const d = a.date ? a : b, w = a.date ? b : a; if (dowOf(d.date) !== w.day) return false; }
  const s1 = mn(a.startTime), e1 = mn(a.endTime), s2 = mn(b.startTime), e2 = mn(b.endTime);
  if ([s1, e1, s2, e2].some(v => v === null)) return false;
  return s1 < e2 && s2 < e1;
}
function sessionClashes(data, s) {
  const out = [], rooms = new Set([s.roomId, ...(s.extraRooms || [])].filter(Boolean)), g = sessGroupOf(data, s);
  const name = (k, id) => ((data[k] || []).find(x => x.id === id) || {}).name || id;
  for (const o of data.sessions || []) {
    if (!o || o.id === s.id || o.cancelled || o.postponed) continue;
    if (s.commonId && o.commonId === s.commonId) continue;
    if (!sameSlot(s, o)) continue;
    const when = (o.date || o.day) + ' ' + o.startTime + '-' + o.endTime, what = label('sessions', o, data);
    if (s.teacherId && o.teacherId === s.teacherId) out.push({ type: 'emploi du temps', message: 'Enseignant « ' + name('teachers', s.teacherId) + ' » déjà occupé : ' + what + ' (' + when + ')', with: o.id });
    const shared = [o.roomId, ...(o.extraRooms || [])].filter(r => r && rooms.has(r));
    if (shared.length) out.push({ type: 'emploi du temps', message: 'Salle « ' + name('rooms', shared[0]) + ' » déjà occupée : ' + what + ' (' + when + ')', with: o.id });
    const og = sessGroupOf(data, o);
    const sameGroup = (g.prog && g.prog === og.prog && g.year && g.year === og.year && (!g.group || !og.group || g.group === og.group)) || (!g.prog && g.level && g.level === og.level);
    if (sameGroup) out.push({ type: 'emploi du temps', message: 'Groupe ' + [g.prog, g.year && 'année ' + g.year, g.group].filter(Boolean).join(' ') + ' déjà en cours : ' + what + ' (' + when + ')', with: o.id });
  }
  return out;
}
/* Liste des conflits qui empêchent la restauration (vide = restauration possible) */
function restoreConflicts(entry, data, trash) {
  const c = entry.collection, x = entry.data, out = [], arr = (data && data[c]) || [];
  const inTrash = (coll, id) => (trash || []).some(t => t.status === 'deleted' && t.collection === coll && t.recordId === id);
  const dep = (coll, id, what) => {
    if (!id) return;
    if ((data[coll] || []).some(y => y.id === id)) return;
    out.push({ type: 'dépendance', message: what + (inTrash(coll, id) ? ' est dans la corbeille : restaurez-le d’abord.' : ' n’existe plus.'), collection: coll, recordId: id });
  };
  if (arr.some(y => y && y.id === x.id)) out.push({ type: 'doublon', message: 'Un élément actif porte déjà le même identifiant (' + x.id + ').' });
  const dupBy = (key, what) => { const v = norm(key(x)); if (v && arr.some(y => y && y.id !== x.id && norm(key(y)) === v)) out.push({ type: 'doublon', message: what }); };
  if (c === 'students') { dupBy(y => y.matricule, 'Un autre étudiant actif a déjà le matricule ' + x.matricule + '.'); dep('programs', x.programId, 'La filière de l’étudiant'); }
  if (c === 'teachers') dupBy(y => y.name, 'Un autre enseignant actif s’appelle déjà « ' + x.name + ' ».');
  if (c === 'rooms') dupBy(y => y.name, 'Une autre salle active s’appelle déjà « ' + x.name + ' ».');
  if (c === 'programs') dupBy(y => y.name, 'Une autre filière active porte déjà le code « ' + x.name + ' ».');
  if (c === 'levels') dupBy(y => y.name, 'Un autre groupe actif s’appelle déjà « ' + x.name + ' ».');
  if (c === 'subjects') { dupBy(y => (y.name || '') + '|' + (y.level || ''), 'Une matière active du même nom existe déjà pour ce groupe.'); dep('levels', x.level, 'Le groupe de la matière'); }
  if (c === 'templates') dupBy(y => (y.name || '') + '|' + (y.category || ''), 'Un modèle actif du même nom existe déjà dans cette catégorie.');
  if (c === 'sessions') {
    dep('subjects', x.subjectId, 'La matière de la séance');
    dep('teachers', x.teacherId, 'L’enseignant de la séance');
    dep('rooms', x.roomId, 'La salle de la séance');
    for (const r of x.extraRooms || []) dep('rooms', r, 'Une salle supplémentaire de la séance');
    if (!x.cancelled && !x.postponed) out.push(...sessionClashes(data, x));
  }
  return out;
}
const summary = e => ({ id: e.id, collection: e.collection, type: e.type, recordId: e.recordId, label: e.label, status: e.status, deletedAt: e.deletedAt, deletedBy: e.deletedBy, deletedByName: e.deletedByName || '', reason: e.reason || '', restoredAt: e.restoredAt || '', restoredBy: e.restoredBy || '', restoreReason: e.restoreReason || '', history: e.history || [] });
function filter(list, q) {
  const g = k => { const v = q && (typeof q.get === 'function' ? q.get(k) : q[k]); return typeof v === 'string' ? v.trim().slice(0, 120) : ''; };
  const coll = g('collection'), st = g('status') || 'deleted', by = g('by'), from = g('from'), to = g('to'), s = norm(g('q'));
  return list.filter(e => (!coll || e.collection === coll) && (st === 'all' || e.status === st) && (!by || e.deletedBy === by) && (!from || e.deletedAt >= from) && (!to || e.deletedAt <= to + 'T23:59:59.999Z') && (!s || norm(e.label + ' ' + e.reason + ' ' + e.recordId + ' ' + stable(e.data)).includes(s)))
    .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
}
module.exports = { SOFT, SECTION, label, deletedBetween, makeEntries, restoreConflicts, sessionClashes, summary, filter };

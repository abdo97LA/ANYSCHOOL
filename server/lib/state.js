'use strict';
/* État central de l'application (séances, enseignants, étudiants, modèles…) :
   - vues filtrées selon le rôle ;
   - fusion à trois voies par élément (id) pour éviter les écrasements silencieux ;
   - détection des collections modifiées sans autorisation. */
const { COLLECTIONS, isWritable } = require('./roles');
const LOGS = new Set(COLLECTIONS.logs);
const DERIVED = { sessions: ['status', 'declStatus', 'declModified'], students: ['groupHistory'] };   // champs recalculés (postes) ou gérés par le serveur (historique des groupes)

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function normItem(coll, it) {
  const d = DERIVED[coll]; if (!d || !it || typeof it !== 'object') return it;
  const o = { ...it }; for (const k of d) delete o[k]; return o;
}
function normColl(coll, v) { return Array.isArray(v) && DERIVED[coll] ? v.map(x => normItem(coll, x)) : v; }
const eqN = (coll, a, b) => stable(normColl(coll, a)) === stable(normColl(coll, b));
const eqI = (coll, a, b) => stable(normItem(coll, a)) === stable(normItem(coll, b));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const idArray = a => Array.isArray(a) && a.every(x => isObj(x) && typeof x.id === 'string' && x.id) && new Set(a.map(x => x.id)).size === a.length;
const label = x => x && (x.name || x.title || x.label || (x.lastName ? x.lastName + ' ' + (x.firstName || '') : '') || x.matricule || x.id) || '';

function mergeById(coll, b, m, t, preferMine, conflicts) {
  const B = new Map((b || []).map(x => [x.id, x])), M = new Map(m.map(x => [x.id, x])), out = [];
  const seen = new Set();
  for (const ti of t) {
    const id = ti.id; seen.add(id);
    const bi = B.get(id), mi = M.get(id);
    const mCh = !eqI(coll, mi, bi), tCh = !eqI(coll, ti, bi);
    if (!mCh) { out.push(ti); continue; }                                   // je n'ai pas touché cet élément
    if (!tCh || eqI(coll, mi, ti)) { if (mi) out.push(mi); continue; }        // seul moi l'ai modifié (ou même résultat)
    if (LOGS.has(coll)) { out.push(mi || ti); continue; }
    conflicts.push({ collection: coll, id, label: label(mi || ti || bi), mine: mi ? 'modifié' : 'supprimé', theirs: 'modifié' });
    if (preferMine) { if (mi) out.push(mi); } else out.push(ti);
  }
  for (const mi of m) {
    if (seen.has(mi.id)) continue;
    const bi = B.get(mi.id);
    if (!bi) { out.push(mi); continue; }                                     // ajouté par moi
    if (eqI(coll, mi, bi)) continue;                                         // supprimé par l'autre, je n'y ai pas touché
    if (LOGS.has(coll)) { out.push(mi); continue; }
    conflicts.push({ collection: coll, id: mi.id, label: label(mi), mine: 'modifié', theirs: 'supprimé' });
    if (preferMine) out.push(mi);
  }
  return out;
}
function mergeSet(b, m, t) {
  const K = x => stable(x), Bs = new Set((b || []).map(K)), Ms = new Set(m.map(K)), Ts = new Set(t.map(K));
  return t.filter(x => !(Bs.has(K(x)) && !Ms.has(K(x)))).concat(m.filter(x => !Ts.has(K(x)) && !Bs.has(K(x))));
}
function mergeValue(coll, b, m, t, preferMine, conflicts) {
  if (eqN(coll, m, b)) return t;
  if (eqN(coll, t, b) || eqN(coll, m, t)) return m;
  if (Array.isArray(m) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
    if (idArray(m) && idArray(t) && (b === undefined || idArray(b))) return mergeById(coll, b, m, t, preferMine, conflicts);
    if (!m.some(isObj) || LOGS.has(coll)) return mergeSet(b, m, t);
  }
  if (isObj(m) && isObj(t) && (b === undefined || isObj(b))) {
    const o = {}, bb = b || {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
      const bv = bb[k], mv = m[k], tv = t[k];
      if (stable(mv) === stable(bv)) { if (tv !== undefined) o[k] = tv; continue; }
      if (stable(tv) === stable(bv) || stable(mv) === stable(tv)) { if (mv !== undefined) o[k] = mv; continue; }
      if (LOGS.has(coll)) { o[k] = mv; continue; }
      conflicts.push({ collection: coll, id: k, label: coll + '.' + k, mine: 'modifié', theirs: 'modifié' });
      const v = preferMine ? mv : tv; if (v !== undefined) o[k] = v;
    }
    return o;
  }
  if (LOGS.has(coll)) return m;
  conflicts.push({ collection: coll, id: '', label: coll, mine: 'modifié', theirs: 'modifié' });
  return preferMine ? m : t;
}
/* base = état complet à la révision connue du client ; mine = données envoyées ; theirs = état complet actuel. */
function merge3(base, mine, theirs, writableSet, preferMine) {
  const out = {}, conflicts = [];
  for (const k of new Set([...Object.keys(theirs || {}), ...Object.keys(mine || {})])) {
    if (!isWritable(writableSet, k)) { if (theirs && k in theirs) out[k] = theirs[k]; continue; }
    const v = mergeValue(k, base ? base[k] : undefined, mine[k], theirs ? theirs[k] : undefined, preferMine, conflicts);
    if (v !== undefined) out[k] = v;
  }
  return { data: out, conflicts };
}
/* Collections que le client a modifiées par rapport à la vue qu'il avait reçue */
const emptyish = v => v === undefined || v === null || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
function changedKeys(view, mine) {
  const ks = [];
  for (const k of new Set([...Object.keys(view || {}), ...Object.keys(mine || {})])) {
    const a = (view || {})[k], b = (mine || {})[k];
    if (emptyish(a) && emptyish(b)) continue;
    if (!eqN(k, a, b)) ks.push(k);
  }
  return ks;
}

/* ---------- vues filtrées ---------- */
function progName(d, s) {
  const P = d.programs || [], p = P.find(x => x.id === s.programId); if (p) return p.name;
  const sub = (d.subjects || []).find(x => x.id === s.subjectId), l = sub && (d.levels || []).find(x => x.id === sub.level);
  const t = l && (l.program || String(l.name || '').split(' ')[0]); return t && P.some(x => x.name === t) ? t : '';
}
function sessGroup(d, s) {
  const sub = (d.subjects || []).find(x => x.id === s.subjectId), l = sub && (d.levels || []).find(x => x.id === sub.level);
  return { program: progName(d, s), year: s.year || (l && l.year) || '', group: s.group || (l && l.group) || '' };
}
const STU_PLANNING = ['id', 'programId', 'year', 'group', 'ay', 'status', 'groupHistory'];
const STU_TEACHER = ['id', 'matricule', 'lastName', 'firstName', 'programId', 'year', 'group', 'ay', 'status', 'groupHistory'];
const pick = (o, ks) => { const r = {}; for (const k of ks) if (o[k] !== undefined) r[k] = o[k]; return r; };
const EMPTY_LOGS = { audit: [], alertLog: [], alertSeen: [], alertMeta: {}, alertState: {}, events: [], waLog: [], sheetLog: [], docLog: [] };

function viewFor(user, data, can) {
  if (!data) return null;
  if (can(user, 'state.read')) return data;
  if (can(user, 'state.read.planning')) return { ...data, students: (data.students || []).map(s => pick(s, STU_PLANNING)) };
  if (can(user, 'state.read.own')) {
    const tid = user.teacherId || '\u0000';
    const sessions = (data.sessions || []).filter(s => s.teacherId === tid);
    const subIds = new Set(sessions.map(s => s.subjectId)), progOf = id => ((data.programs || []).find(p => p.id === id) || {}).name || '';
    const groups = sessions.map(s => ({ ...sessGroup(data, s), date: s.date || '' })).filter(g => g.program && g.year);
    const { groupAt } = require('./model');
    // l'étudiant est visible s'il appartenait au groupe à la date de la séance (historique), ou s'il y est actuellement pour une séance hebdomadaire
    const students = (data.students || []).filter(st => groups.some(g => { const t = groupAt(st, g.date); return progOf(t.programId) === g.program && String(t.year) === String(g.year) && (!g.group || t.group === g.group); })).map(s => pick(s, STU_TEACHER));
    const me = (data.teachers || []).filter(t => t.id === tid).map(t => pick(t, ['id', 'name', 'specialization']));
    return {
      ...EMPTY_LOGS, teachers: me, sessions, subjects: (data.subjects || []).filter(s => subIds.has(s.id)), rooms: data.rooms || [], levels: data.levels || [],
      programs: data.programs || [], volumes: [], cal: data.cal || { start: '', end: '' }, students, absences: [], templates: [], tplCats: [], notCommon: [],
      cfg: pick(data.cfg || {}, ['cc', 'etab'])
    };
  }
  return null;
}
module.exports = { merge3, changedKeys, viewFor, stable, sessGroup };

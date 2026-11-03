'use strict';
/* Règles du modèle de données (Partie A.4), calculées par le SERVEUR à partir des données centrales :
   - année universitaire ;
   - historique d'appartenance aux groupes (géré uniquement par le serveur) ;
   - statut pédagogique et statut de déclaration de chaque séance (deux champs distincts) ;
   - résumé des modifications (anciennes / nouvelles valeurs) pour le journal d'audit. */
const { stable } = require('./state');

/* Année universitaire : de septembre à août (ex. 2026-10-12 -> « 2026/2027 »), même règle que l'interface. */
const acy = d => { if (!/^\d{4}-\d{2}/.test(d || '')) return ''; const y = +d.slice(0, 4), m = +d.slice(5, 7); return m >= 9 ? y + '/' + (y + 1) : (y - 1) + '/' + y; };
const casaDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date(ms));

/* ---------- appartenance aux groupes ---------- */
const tuple = s => ({ programId: s.programId || '', year: String(s.year || ''), group: s.group || '', ay: s.ay || '' });
const sameTuple = (a, b) => a.programId === b.programId && a.year === b.year && a.group === b.group && a.ay === b.ay;
/* Groupe d'un étudiant à une date donnée (AAAA-MM-JJ) ; entrée « from: '' » = depuis toujours (date inconnue). */
function groupAt(st, date) {
  const h = Array.isArray(st.groupHistory) && st.groupHistory.length ? st.groupHistory : null;
  if (!h || !date) return tuple(st);
  let cur = null; for (const e of h) if (!e.from || e.from <= date) cur = e;
  return cur ? tuple(cur) : tuple(h[0]);
}
/* L'historique est géré par le serveur : celui envoyé par un poste est ignoré ; on part de l'historique connu
   et on ajoute une entrée datée du jour quand filière / année / groupe / année universitaire changent. */
function maintainGroupHistory(prevData, nextData, today) {
  if (!nextData || !Array.isArray(nextData.students)) return 0;
  const prev = new Map(((prevData && prevData.students) || []).map(s => [s.id, s]));
  let n = 0;
  for (const s of nextData.students) {
    if (!s || typeof s !== 'object') continue;
    const p = prev.get(s.id), t = tuple(s);
    let h = p && Array.isArray(p.groupHistory) && p.groupHistory.length ? p.groupHistory.map(e => ({ ...e })) : null;
    if (!h) h = [{ from: '', ...(p ? tuple(p) : t) }];
    const last = h[h.length - 1];
    if (!sameTuple(tuple(last), t)) {
      if (last.from === today) h[h.length - 1] = { from: today, ...t };          // plusieurs changements le même jour : la dernière valeur l'emporte
      else h.push({ from: today, ...t });
      n++;
    }
    s.groupHistory = h;
  }
  return n;
}

/* ---------- statuts des séances (mêmes règles que l'interface, calculées sur le serveur) ---------- */
function names(data) {
  const by = k => new Map((data[k] || []).map(x => [x.id, x]));
  return { sub: by('subjects'), tea: by('teachers'), room: by('rooms'), lev: by('levels'), prog: by('programs') };
}
function sessionInfo(data, s, N) {
  N = N || names(data);
  const sub = N.sub.get(s.subjectId), l = sub && N.lev.get(sub.level), p = N.prog.get(s.programId);
  let program = p ? p.name : '';
  if (!program && l) { const t = l.program || String(l.name || '').split(' ')[0]; if ((data.programs || []).some(x => x.name === t)) program = t; }
  const rooms = [s.roomId, ...(s.extraRooms || [])].filter(Boolean).map(id => (N.room.get(id) || {}).name).filter(Boolean);
  return { subject: s.title || (sub && sub.name) || '', teacher: (N.tea.get(s.teacherId) || {}).name || '', program, year: String(s.year || (l && l.year) || ''), group: s.group || (l && l.group) || '', room: rooms.join(' + ') };
}
/* absences : déclarations du serveur ; wallToUtc : conversion heure du Maroc -> UTC ; now : instant courant (ms) */
function deriveSessions(data, absences, now, wallToUtc) {
  const out = {}, statuses = {};
  if (!data || !Array.isArray(data.sessions)) return { sessions: out, statuses };
  const N = names(data), replaced = new Set(data.sessions.filter(x => x.replacesId).map(x => x.replacesId));
  const decl = new Map(); for (const a of absences || []) if (a.status !== 'annulée') decl.set(a.sessionId, a);
  for (const s of data.sessions) {
    if (!s || !s.id) continue;
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(s.date || '') && /^\d{2}:\d{2}$/.test(s.startTime || '') && /^\d{2}:\d{2}$/.test(s.endTime || '');
    const ended = dated && now >= wallToUtc(s.date, s.endTime), a = decl.get(s.id), off = !!(s.cancelled || s.postponed);
    const ped = s.cancelled ? 'annulee' : s.postponed ? (replaced.has(s.id) ? 'reportee' : 'reportee_sans_date') : ((a && ended) || s.done ? 'realisee' : 'programmee');
    const dec = off ? 'sans_objet' : a ? (a.total > 0 ? 'absences_enregistrees' : 'aucun_absent') : (ended ? 'non_declaree' : 'en_attente');
    statuses[s.id] = { status: ped, declStatus: dec, declModified: !!(a && (a.versions || []).length), ay: acy(s.date), replacesId: s.replacesId || '', replacement: !!s.replacesId };
    if (dated) out[s.id] = { id: s.id, date: s.date, start: s.startTime, end: s.endTime, status: ped, teacherId: s.teacherId || '', ...sessionInfo(data, s, N) };
  }
  return { sessions: out, statuses };
}

/* ---------- audit : anciennes et nouvelles valeurs ---------- */
const AUDITED = ['teachers', 'rooms', 'levels', 'subjects', 'sessions', 'programs', 'volumes', 'students', 'templates', 'tplCats', 'cfg', 'cal', 'notCommon'];
const IGNORE = { sessions: ['status', 'declStatus', 'declModified'], students: ['groupHistory'] };
const short = v => { if (v === undefined) return null; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 300 ? '[contenu volumineux : ' + s.length + ' caractères]' : v; };
const lab = x => x && (x.name || x.title || x.label || [x.lastName, x.firstName].filter(Boolean).join(' ') || x.matricule || x.id) || '';
function diffForAudit(prev, next, max) {
  max = max || 100; const out = []; let total = 0;
  const push = c => { total++; if (out.length < max) out.push(c); };
  for (const k of AUDITED) {
    const a = (prev || {})[k], b = (next || {})[k];
    if (stable(a) === stable(b)) continue;
    if (Array.isArray(a) || Array.isArray(b)) {
      const A = Array.isArray(a) ? a : [], Bv = Array.isArray(b) ? b : [];
      if ([...A, ...Bv].every(x => x && typeof x === 'object' && x.id)) {
        const MA = new Map(A.map(x => [x.id, x])), MB = new Map(Bv.map(x => [x.id, x]));
        for (const [id, x] of MB) {
          const o = MA.get(id);
          if (!o) { push({ collection: k, id, label: lab(x), op: 'ajout', nouveau: Object.fromEntries(Object.entries(x).filter(([f]) => !(IGNORE[k] || []).includes(f)).map(([f, v]) => [f, short(v)])) }); continue; }
          const ch = {};
          for (const f of new Set([...Object.keys(o), ...Object.keys(x)])) { if ((IGNORE[k] || []).includes(f)) continue; if (stable(o[f]) !== stable(x[f])) ch[f] = { ancien: short(o[f]), nouveau: short(x[f]) }; }
          if (Object.keys(ch).length) push({ collection: k, id, label: lab(x), op: 'modification', champs: ch });
        }
        for (const [id, o] of MA) if (!MB.has(id)) push({ collection: k, id, label: lab(o), op: 'suppression', ancien: Object.fromEntries(Object.entries(o).filter(([f]) => !(IGNORE[k] || []).includes(f)).map(([f, v]) => [f, short(v)])) });
        continue;
      }
    }
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const ch = {}; for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) if (stable(a[f]) !== stable(b[f])) ch[f] = { ancien: short(a[f]), nouveau: short(b[f]) };
      push({ collection: k, id: '', label: k, op: 'modification', champs: ch }); continue;
    }
    push({ collection: k, id: '', label: k, op: 'modification', ancien: short(a), nouveau: short(b) });
  }
  return { changes: out, total };
}

/* ---------- journaux de l'interface en AJOUT SEUL ----------
   Les entrées déjà connues du serveur sont conservées telles quelles (une modification ou une suppression
   envoyée par un poste est ignorée) ; seules les nouvelles entrées (nouvel id) sont ajoutées. */
const APPEND_ONLY = ['audit', 'docLog', 'sheetLog', 'waLog', 'events'];
function enforceAppendOnly(prevData, nextData) {
  const report = {};
  if (!prevData || !nextData) return report;
  for (const k of APPEND_ONLY) {
    const old = Array.isArray(prevData[k]) ? prevData[k] : [], cur = Array.isArray(nextData[k]) ? nextData[k] : [];
    if (!old.length) continue;
    const key = e => (e && e.id) ? 'id:' + e.id : 'js:' + stable(e);
    const seenCur = new Map(cur.map(e => [key(e), e]));
    let removed = 0, altered = 0;
    for (const e of old) { const c = seenCur.get(key(e)); if (!c) removed++; else if (stable(c) !== stable(e)) altered++; }
    if (!removed && !altered) continue;
    const oldKeys = new Set(old.map(key));
    nextData[k] = old.concat(cur.filter(e => !oldKeys.has(key(e))));
    report[k] = { conservees: removed, modificationsIgnorees: altered };
  }
  return report;
}
module.exports = { acy, casaDate, tuple, groupAt, maintainGroupHistory, deriveSessions, sessionInfo, diffForAudit, enforceAppendOnly, APPEND_ONLY };

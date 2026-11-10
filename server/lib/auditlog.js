'use strict';
/* Journal d'audit SÉPARÉ des données de travail, en AJOUT SEUL, chaîné par empreintes SHA-256.
   - mode fichiers : un fichier audit.jsonl par établissement (une ligne JSON par événement) + platform-audit.jsonl ;
   - mode cloud    : table unitt_audit (Supabase) protégée par un déclencheur qui refuse UPDATE / DELETE / TRUNCATE
                     (voir supabase/schema.sql) ; les écritures passent par unitt_save_docs, qui vérifie la chaîne.
   Aucune API ne permet de modifier ou de supprimer une entrée. Chaque entrée contient « prev » (empreinte de la
   précédente) et « h » = sha256(prev + JSON de l'entrée sans h) : toute altération casse la chaîne. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GENESIS = '0'.repeat(64);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function seal(prev, e) { const x = { ...e, prev }; delete x.h; x.h = sha(prev + JSON.stringify(x)); return x; }
function chainValid(items, start) {
  let prev = start || GENESIS;
  for (const e of items) { const { h, ...rest } = e; if (rest.prev !== prev || sha(prev + JSON.stringify(rest)) !== h) return false; prev = h; }
  return true;
}

/* ---------- filtres communs (historique d'activité) ---------- */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function matches(e, f) {
  if (!f) return true;
  if (f.user && norm(e.user) !== norm(f.user)) return false;
  if (f.userId && e.userId !== f.userId) return false;
  if (f.event && !norm(e.event).includes(norm(f.event))) return false;
  if (f.section && norm(e.section) !== norm(f.section)) return false;
  if (f.result && norm(e.result) !== norm(f.result)) return false;
  if (f.from && String(e.at) < f.from) return false;
  if (f.to && String(e.at) > f.to + (f.to.length === 10 ? 'T23:59:59.999Z' : '')) return false;
  if (f.record) { const r = norm(f.record); if (!norm(JSON.stringify([e.record, e.recordId, e.modifications, e.compte, e.id, e.sessionId, e.formId])).includes(r)) return false; }
  if (f.q && !norm(JSON.stringify(e)).includes(norm(f.q))) return false;
  return true;
}
function cleanFilter(q) {
  const g = k => { const v = q && (typeof q.get === 'function' ? q.get(k) : q[k]); return typeof v === 'string' ? v.slice(0, 120) : ''; };
  const f = { user: g('user'), userId: g('userId'), event: g('event'), section: g('section'), result: g('result'), from: g('from'), to: g('to'), record: g('record'), q: g('q') };
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  if (f.from && !/^\d{4}-\d{2}-\d{2}/.test(f.from)) delete f.from;
  if (f.to && !/^\d{4}-\d{2}-\d{2}/.test(f.to)) delete f.to;
  const lim = parseInt(g('limit'), 10), off = parseInt(g('offset'), 10);
  return { f, limit: lim > 0 ? Math.min(lim, 5000) : 1000, offset: off > 0 ? off : 0, order: g('order') === 'asc' ? 'asc' : 'desc' };
}

/* ---------- mode fichiers ---------- */
class FileAudit {
  constructor(file) { this.file = file; this._last = null; }
  readAll() {
    let t; try { t = fs.readFileSync(this.file, 'utf8'); } catch (e) { return []; }
    const out = []; for (const line of t.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (e) { out.push({ corrupt: line.slice(0, 200) }); } }
    return out;
  }
  last() {
    if (this._last !== null) return this._last;
    const a = this.readAll(); this._last = a.length ? a[a.length - 1].h || GENESIS : GENESIS; return this._last;
  }
  append(e) {
    const x = seal(this.last(), e);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, 'a'); try { fs.writeSync(fd, JSON.stringify(x) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this._last = x.h; return x;
  }
  /* reprise d'un ancien journal (store.audit) : entrées recopiées telles quelles, uniquement si le fichier est vide */
  importLegacy(items) {
    if (!Array.isArray(items) || !items.length || this.readAll().length) return 0;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, items.map(e => JSON.stringify(e)).join('\n') + '\n');
    this._last = items[items.length - 1].h || GENESIS; return items.length;
  }
  valid() { return chainValid(this.readAll()); }
  query(q) {   // q : filtre déjà nettoyé par cleanFilter()
    const { f, limit, offset, order } = q && q.f ? q : cleanFilter(q);
    let a = this.readAll().filter(e => matches(e, f)); const total = a.length;
    if (order === 'desc') a = a.reverse();
    return { total, items: a.slice(offset, offset + limit) };
  }
}
module.exports = { GENESIS, sha, seal, chainValid, matches, cleanFilter, FileAudit };

'use strict';
/* Stockage dans Supabase (PostgreSQL) via l'API REST (PostgREST), sans dépendance.
   Utilisé en mode « cloud » (Vercel) : aucun fichier local n'est persistant entre deux requêtes.
   Tables et fonctions : supabase/schema.sql. La clé « service_role » reste côté serveur (variable d'environnement),
   jamais dans le navigateur ; les tables ont la sécurité RLS activée sans aucune politique (inaccessibles avec la clé publique). */
const URL0 = () => String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
class Conflict extends Error { constructor() { super('unitt_conflict'); this.conflict = true; } }

async function call(method, path, body, extra) {
  if (!URL0() || !KEY()) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définis (variables d’environnement Vercel).');
  const r = await fetch(URL0() + '/rest/v1/' + path, {
    method, headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', Accept: 'application/json', ...(extra || {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* */ }
  if (!r.ok) {
    const msg = (j && (j.message || j.error || j.hint)) || t || ('HTTP ' + r.status);
    if (/unitt_conflict/.test(msg)) throw new Conflict();
    const e = new Error('Supabase : ' + String(msg).slice(0, 300)); e.status = r.status; throw e;
  }
  return j;
}
/* Charge les deux documents (store : comptes, absences, audit… ; state : données de l'établissement) avec leur version */
async function load() {
  const rows = await call('GET', 'unitt_docs?select=id,data,version&id=in.(store,state)');
  const out = { store: null, storeVersion: 0, state: null, stateVersion: 0 };
  for (const r of rows || []) { out[r.id] = r.data; out[r.id + 'Version'] = Number(r.version) || 0; }
  return out;
}
/* Enregistrement atomique et conditionnel (version attendue) : si un autre appel a écrit entre-temps -> Conflict */
async function save(p) {
  return call('POST', 'rpc/unitt_save', {
    p_store: p.store === undefined ? null : p.store, p_store_version: p.storeVersion,
    p_state: p.state === undefined ? null : p.state, p_state_version: p.stateVersion,
    p_hist_rev: p.histRev || null, p_hist_data: p.histData === undefined ? null : p.histData, p_hist_keep: p.histKeep || 50
  });
}
async function history(rev) {
  const rows = await call('GET', 'unitt_history?select=data&rev=eq.' + Number(rev));
  return rows && rows[0] ? rows[0].data : undefined;
}
async function backup(reason, keep) { return call('POST', 'rpc/unitt_backup', { p_reason: String(reason || 'manuelle').slice(0, 40), p_keep: keep || 30 }); }
async function listBackups() {
  const rows = await call('GET', 'unitt_backups?select=id,created_at,reason,bytes&order=id.desc&limit=50');
  return (rows || []).map(b => ({ name: 'supabase-' + b.id, createdAt: b.created_at, reason: b.reason, files: { 'store+state': { bytes: Number(b.bytes) || 0 } } }));
}
module.exports = { load, save, history, backup, listBackups, Conflict, configured: () => !!(URL0() && KEY()) };

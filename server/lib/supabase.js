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
/* Clés de stockage : '' = premier établissement (documents d'origine « store » / « state »), sinon id de l'établissement */
const docId = (kind, key) => kind === 'platform' ? 'platform' : kind + (key ? ':' + key : '');
/* Charge en un appel : documents demandés + dernière empreinte du journal d'audit de chaque « tenant » demandé */
async function load(ids, auditTenants) {
  const r = await call('POST', 'rpc/unitt_load', { p_ids: ids, p_tenants: auditTenants || [] });
  const docs = {}; for (const d of (r && r.docs) || []) docs[d.id] = { data: d.data, version: Number(d.version) || 0 };
  return { docs, last: (r && r.last) || {} };
}
/* Enregistrement atomique et conditionnel (versions attendues + continuité de la chaîne d'audit) ; sinon Conflict */
async function saveDocs(p) { return call('POST', 'rpc/unitt_save_docs', { p_docs: p.docs || [], p_audit: p.audit || [], p_hist: p.hist || null }); }
async function history(key, rev) {
  const rows = await call('GET', 'unitt_history?select=data&tenant=eq.' + encodeURIComponent(key || '') + '&rev=eq.' + Number(rev));
  return rows && rows[0] ? rows[0].data : undefined;
}
async function backup(key, reason, keep) { return call('POST', 'rpc/unitt_backup_t', { p_tenant: key || '', p_reason: String(reason || 'manuelle').slice(0, 40), p_keep: keep || 30 }); }
async function listBackups(key) {
  const rows = await call('GET', 'unitt_backups?select=id,created_at,reason,bytes&tenant=eq.' + encodeURIComponent(key || '') + '&order=id.desc&limit=50');
  return (rows || []).map(b => ({ name: 'supabase-' + b.id, createdAt: b.created_at, reason: b.reason, files: { 'store+state': { bytes: Number(b.bytes) || 0 } } }));
}
async function auditQuery(tenant, q) { return call('POST', 'rpc/unitt_audit_query', { p_tenant: tenant, p_filter: q.f || {}, p_limit: q.limit || 1000, p_offset: q.offset || 0, p_order: q.order || 'desc' }); }
module.exports = { load, saveDocs, history, backup, listBackups, auditQuery, docId, Conflict, configured: () => !!(URL0() && KEY()) };

'use strict';
/* Plateforme multi-établissements : registre des établissements (tenants), compte Super Admin, paramètres globaux.
   Le document « platform » ne contient AUCUNE donnée d'établissement (étudiants, séances…) : seulement le registre.
   Chaque établissement a ses propres documents (store / state), son propre journal d'audit et ses propres comptes. */
const crypto = require('crypto');
const rid = n => crypto.randomBytes(n).toString('hex');
const TENANT_ID_RE = /^[a-f0-9]{16}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_SLUGS = new Set(['platform', 'admin', 'api', 'superadmin', 'super-admin', 'root', 'system', 'www', 'vendor']);
const STATUSES = { active: 'Actif', suspended: 'Suspendu', disabled: 'Désactivé' };

const emptyPlatform = () => ({ version: 1, tenants: [], admins: [], logins: {}, settings: { platformName: 'UniTimetable', defaultTenantId: '', allowDefaultLogin: true, superAdminIdleMinutes: 30, superAdminMaxHours: 8, workspaceMaxHours: 2 } });
function normalize(p) {
  const d = emptyPlatform();
  p = p && typeof p === 'object' ? p : d;
  if (!Array.isArray(p.tenants)) p.tenants = [];
  if (!Array.isArray(p.admins)) p.admins = [];
  if (!p.logins || typeof p.logins !== 'object') p.logins = {};
  p.settings = Object.assign({}, d.settings, p.settings || {});
  return p;
}
function slugify(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'etablissement'; }
function slugProblem(slug, tenants, selfId) {
  if (!SLUG_RE.test(slug || '')) return 'Code d’établissement invalide : 3 à 32 caractères (minuscules, chiffres, tirets ; ni début ni fin par un tiret).';
  if (RESERVED_SLUGS.has(slug)) return 'Ce code est réservé.';
  if (tenants.some(t => t.slug === slug && t.id !== selfId)) return 'Ce code est déjà utilisé par un autre établissement.';
  return '';
}
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const dateOrEmpty = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
function cleanTenantFields(b, cur) {
  const o = {};
  if (b.name !== undefined) o.name = str(b.name, 160);
  if (b.nameAr !== undefined) o.nameAr = str(b.nameAr, 160);
  if (b.shortName !== undefined) o.shortName = str(b.shortName, 60);
  if (b.contact !== undefined) { const c = b.contact || {}; o.contact = { email: str(c.email, 120), phone: str(c.phone, 40), address: str(c.address, 300), city: str(c.city, 80), country: str(c.country, 80), person: str(c.person, 120) }; }
  if (b.subscription !== undefined) { const s = b.subscription || {}; o.subscription = { plan: str(s.plan, 40) || (cur && cur.subscription && cur.subscription.plan) || 'standard', startsAt: dateOrEmpty(s.startsAt), endsAt: dateOrEmpty(s.endsAt), notes: str(s.notes, 500) }; }
  if (b.settings !== undefined) { const s = b.settings || {}; const n = +s.maxUsers; o.settings = { maxUsers: Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 100000) : 0, locale: ['fr', 'ar', 'en'].includes(s.locale) ? s.locale : 'fr', timezone: str(s.timezone, 60) || 'Africa/Casablanca', notes: str(s.notes, 1000) }; }
  return o;
}
function newTenant(fields, by) {
  const now = new Date().toISOString();
  return Object.assign({ id: rid(8), slug: '', name: '', nameAr: '', shortName: '', status: 'active', legacy: false, contact: { email: '', phone: '', address: '', city: '', country: '', person: '' }, subscription: { plan: 'standard', startsAt: now.slice(0, 10), endsAt: '', notes: '' }, settings: { maxUsers: 0, locale: 'fr', timezone: 'Africa/Casablanca', notes: '' }, createdAt: now, createdBy: by || '', updatedAt: now, statusHistory: [] }, fields);
}
/* Accès bloqué ? (statut, ou abonnement expiré) — renvoie le motif à afficher, ou '' */
function blocked(t, today) {
  if (!t) return 'Établissement introuvable.';
  if (t.status === 'suspended') return 'L’accès de cet établissement est suspendu. Contactez l’administrateur de la plateforme.';
  if (t.status === 'disabled') return 'Cet établissement est désactivé.';
  if (t.subscription && t.subscription.endsAt && today && t.subscription.endsAt < today) return 'L’abonnement de cet établissement a expiré le ' + t.subscription.endsAt + '. Contactez l’administrateur de la plateforme.';
  return '';
}
const publicTenant = t => t && ({ id: t.id, slug: t.slug, name: t.name, nameAr: t.nameAr || '', shortName: t.shortName || '', status: t.status, legacy: !!t.legacy, contact: t.contact || {}, subscription: t.subscription || {}, settings: t.settings || {}, createdAt: t.createdAt, createdBy: t.createdBy || '', updatedAt: t.updatedAt || '', statusHistory: (t.statusHistory || []).slice(-50) });
const publicAdmin = a => a && ({ id: a.id, username: a.username, displayName: a.displayName, email: a.email || '', totp: !!(a.totp && a.totp.enabled), createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || '', disabled: !!a.disabled, mustChange: !!a.mustChange });

/* Jetons préfixés par l'identifiant d'établissement (16 hex). Un jeton sans préfixe (ancien format)
   désigne le premier établissement. Le préfixe ne donne aucun droit : le jeton doit exister dans
   le magasin de CET établissement (empreinte SHA-256), sinon il est refusé. */
const prefixed = (tenantId, token) => tenantId + token;
function tenantOfToken(tok, lenWithout) {
  if (typeof tok !== 'string') return null;
  if (tok.length === lenWithout + 16 && TENANT_ID_RE.test(tok.slice(0, 16))) return tok.slice(0, 16);
  if (tok.length === lenWithout) return '';   // ancien format : premier établissement
  return null;
}

/* ---------- double authentification TOTP (RFC 6238 : SHA-1, 30 s, 6 chiffres) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32decode(s) { s = String(s || '').replace(/[\s=]/g, '').toUpperCase(); let bits = 0, val = 0; const out = []; for (const c of s) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(secret, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(b).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const totpSecret = () => b32encode(crypto.randomBytes(20));
/* accepte la période courante ± 1 ; refuse la réutilisation d'un code déjà accepté (lastStep) */
function totpCheck(secret, code, now, lastStep) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = Math.floor((now || Date.now()) / 30000);
  for (const d of [0, -1, 1]) { const s = step + d; if (lastStep && s <= lastStep) continue; if (crypto.timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(String(code)))) return s; }
  return null;
}
const otpauth = (secret, account, issuer) => 'otpauth://totp/' + encodeURIComponent((issuer || 'UniTimetable') + ':' + account) + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer || 'UniTimetable') + '&algorithm=SHA1&digits=6&period=30';

function superPasswordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 14) return 'Le mot de passe Super Admin doit contenir au moins 14 caractères.';
  if (pw.length > 200) return 'Mot de passe trop long.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Le mot de passe ne doit pas contenir l’identifiant.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (kinds < 3) return 'Le mot de passe Super Admin doit mélanger au moins 3 types de caractères (minuscules, majuscules, chiffres, symboles).';
  return '';
}
module.exports = { rid, TENANT_ID_RE, SLUG_RE, STATUSES, emptyPlatform, normalize, slugify, slugProblem, cleanTenantFields, newTenant, blocked, publicTenant, publicAdmin, prefixed, tenantOfToken, totpSecret, totpCheck, hotp, otpauth, superPasswordProblem, b32decode };

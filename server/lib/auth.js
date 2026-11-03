'use strict';
/* Comptes individuels : mots de passe hachés avec scrypt (sel aléatoire de 16 octets),
   sessions par jeton aléatoire (seul le hachage SHA-256 est conservé), expiration d'inactivité et absolue,
   verrouillage temporaire après plusieurs échecs. */
const crypto = require('crypto');
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, N) {
  return new Promise((ok, ko) => {
    const salt = crypto.randomBytes(16), p = { N: N || 32768, r: 8, p: 1 };
    crypto.scrypt(pw.normalize('NFC'), salt, 64, { ...p, maxmem: 256 * p.N * p.r }, (e, key) => e ? ko(e) : ok({ alg: 'scrypt', ...p, salt: salt.toString('base64'), hash: key.toString('base64') }));
  });
}
function verifyPassword(pw, rec) {
  return new Promise(ok => {
    if (!rec || rec.alg !== 'scrypt' || typeof pw !== 'string') return ok(false);
    const salt = Buffer.from(rec.salt, 'base64'), want = Buffer.from(rec.hash, 'base64');
    crypto.scrypt(pw.normalize('NFC'), salt, want.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 256 * rec.N * rec.r }, (e, key) => ok(!e && crypto.timingSafeEqual(key, want)));
  });
}
/* Hachage factice pour garder un temps de réponse identique quand l'identifiant n'existe pas */
let DUMMY = null;
async function dummyVerify(pw, N) { if (!DUMMY) DUMMY = await hashPassword('x-' + crypto.randomBytes(8).toString('hex'), N); return verifyPassword(String(pw || ''), DUMMY); }

function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Le mot de passe doit contenir au moins 10 caractères.';
  if (pw.length > 200) return 'Mot de passe trop long (200 caractères maximum).';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Le mot de passe ne doit pas contenir l’identifiant.';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|azertyuiop|qwertyuiop|motdepasse|password)/i.test(pw)) return 'Mot de passe trop simple.';
  return '';
}
const newToken = () => crypto.randomBytes(32).toString('base64url');
const publicUser = u => u && ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, teacherId: u.teacherId || '', extraPerms: u.extraPerms || [], deniedPerms: u.deniedPerms || [], disabled: !!u.disabled, mustChange: !!u.mustChange, createdAt: u.createdAt, updatedAt: u.updatedAt || '', lastLoginAt: u.lastLoginAt || '', lockedUntil: u.lockedUntil || '' });
module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem, newToken, sha, publicUser, USERNAME_RE };

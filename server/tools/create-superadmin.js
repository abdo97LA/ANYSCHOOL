'use strict';
/* Création du compte Super Admin (propriétaire de la plateforme), ou d'un compte de secours.
   Usage (sur le PC serveur, serveur ARRÊTÉ) :  node tools/create-superadmin.js [--username proprietaire] [--name "Nom affiché"]
   Mot de passe : 14 caractères minimum, 3 types de caractères. Il est demandé de façon masquée et n'est jamais écrit
   en clair. À la première connexion (console : https://<serveur>/platform), activez la double authentification.
   En ligne (Vercel) : définir SUPERADMIN_USERNAME et SUPERADMIN_PASSWORD, voir DEPLOIEMENT-VERCEL-SUPABASE.md. */
const crypto = require('crypto');
const C = require('./common');
const A = require('../lib/auth'), PF = require('../lib/platform');
(async () => {
  C.requireStopped('créer un compte Super Admin');
  const pf = PF.normalize(C.readJson(C.PLATFORM_FILE, null, null) || PF.emptyPlatform());
  const username = (C.arg('username') || await C.ask('Identifiant Super Admin (ex. proprietaire) : ')).toLowerCase();
  if (!A.USERNAME_RE.test(username)) { console.error('Identifiant invalide : 3 à 32 caractères (minuscules, chiffres, . _ -).'); process.exit(1); }
  if (pf.admins.some(a => a.username === username)) { console.error('Ce compte Super Admin existe déjà. Réinitialisation : node tools/create-superadmin.js --reset --username ' + username); if (!process.argv.includes('--reset')) process.exit(1); }
  const name = C.arg('name') || (process.argv.includes('--reset') ? '' : await C.ask('Nom affiché (ex. Propriétaire UniTimetable) : ')) || username;
  const pw = await C.ask('Mot de passe (14 caractères minimum, rien ne s’affiche) : ', true);
  const pb = PF.superPasswordProblem(pw, username); if (pb) { console.error(pb); process.exit(1); }
  const pw2 = await C.ask('Confirmez le mot de passe : ', true);
  if (pw !== pw2) { console.error('Les deux saisies sont différentes. Aucun changement.'); process.exit(1); }
  const now = new Date().toISOString(), hash = await A.hashPassword(pw, C.cfg.SCRYPT_N);
  const ex = pf.admins.find(a => a.username === username);
  if (ex) { ex.pw = hash; ex.failed = 0; ex.lockedUntil = ''; ex.totp = null; ex.mustChange = false; ex.updatedAt = now; for (const [h, s] of Object.entries(pf.logins)) if (s.adminId === ex.id) delete pf.logins[h]; }
  else pf.admins.push({ id: crypto.randomBytes(8).toString('hex'), username, displayName: name.slice(0, 80), email: '', pw: hash, totp: null, failed: 0, lockedUntil: '', createdAt: now, mustChange: false, disabled: false });
  C.writeAtomic(C.PLATFORM_FILE, pf);
  new C.AL.FileAudit(require('path').join(C.cfg.DATA_DIR, 'platform-audit.jsonl')).append({ at: now, event: ex ? 'compte Super Admin réinitialisé (console)' : 'compte Super Admin créé (console)', section: 'plateforme', result: 'succès', ip: 'console serveur', user: 'console', compte: username });
  console.log((ex ? 'Compte Super Admin « ' + username + ' » réinitialisé (double authentification désactivée : réactivez-la).' : 'Compte Super Admin « ' + username + ' » créé.') + ' Console : /platform');
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

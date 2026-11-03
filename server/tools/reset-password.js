'use strict';
/* Réinitialisation d'un mot de passe depuis le PC serveur (par exemple si l'administrateur a oublié le sien).
   Usage (serveur ARRÊTÉ) :  node tools/reset-password.js --username nom [--unlock-only]
   L'utilisateur devra choisir un nouveau mot de passe à sa prochaine connexion. Toutes ses sessions sont fermées. */
const C = require('./common');
const A = require('../lib/auth');
(async () => {
  C.requireStopped('réinitialiser un mot de passe');
  const store = C.loadStore();
  const username = (C.arg('username') || await C.ask('Identifiant du compte : ')).toLowerCase();
  const u = store.users.find(x => x.username === username);
  if (!u) { console.error('Compte introuvable. Comptes existants : ' + store.users.map(x => x.username + ' (' + x.role + ')').join(', ')); process.exit(1); }
  if (process.argv.includes('--unlock-only')) { u.failed = 0; u.lockedUntil = ''; C.auditCli(store, 'compte déverrouillé (console)', { compte: username }); C.saveStore(store); console.log('Compte déverrouillé.'); return; }
  const pw = await C.ask('Nouveau mot de passe temporaire (rien ne s’affiche) : ', true);
  const pb = A.passwordProblem(pw, username); if (pb) { console.error(pb); process.exit(1); }
  const pw2 = await C.ask('Confirmez : ', true); if (pw !== pw2) { console.error('Saisies différentes. Rien n’a été modifié.'); process.exit(1); }
  u.pw = await A.hashPassword(pw, C.cfg.SCRYPT_N); u.mustChange = true; u.failed = 0; u.lockedUntil = ''; u.disabled = false; u.updatedAt = new Date().toISOString();
  for (const [h, s] of Object.entries(store.logins)) if (s.userId === u.id) delete store.logins[h];
  C.auditCli(store, 'mot de passe réinitialisé (console)', { compte: username });
  C.saveStore(store);
  console.log('Mot de passe réinitialisé pour « ' + username + ' » (compte réactivé). Il devra être changé à la prochaine connexion.');
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

'use strict';
/* Création d'un compte administrateur (premier administrateur ou administrateur de secours).
   Usage (sur le PC serveur, serveur ARRÊTÉ) :  node tools/create-admin.js [--username admin] [--name "Nom affiché"]
   Le mot de passe est demandé de façon masquée ; il n'est jamais écrit dans un fichier ni dans les journaux. */
const crypto = require('crypto');
const C = require('./common');
const A = require('../lib/auth');
(async () => {
  C.requireStopped('créer un administrateur');
  const store = C.loadStore();
  const username = (C.arg('username') || await C.ask('Identifiant de l’administrateur (ex. admin.scolarite) : ')).toLowerCase();
  if (!A.USERNAME_RE.test(username)) { console.error('Identifiant invalide : 3 à 32 caractères (minuscules, chiffres, . _ -).'); process.exit(1); }
  if (store.users.some(u => u.username === username)) { console.error('Ce compte existe déjà. Pour changer son mot de passe : node tools/reset-password.js --username ' + username); process.exit(1); }
  const name = C.arg('name') || await C.ask('Nom affiché (ex. Service informatique) : ') || username;
  const pw = await C.ask('Mot de passe (10 caractères minimum, rien ne s’affiche) : ', true);
  const pb = A.passwordProblem(pw, username); if (pb) { console.error(pb); process.exit(1); }
  const pw2 = await C.ask('Confirmez le mot de passe : ', true);
  if (pw !== pw2) { console.error('Les deux saisies sont différentes. Aucun compte créé.'); process.exit(1); }
  const now = new Date().toISOString();
  store.users.push({ id: crypto.randomBytes(8).toString('hex'), username, displayName: name.slice(0, 80), role: 'admin', teacherId: '', extraPerms: [], disabled: false, mustChange: false, pw: await A.hashPassword(pw, C.cfg.SCRYPT_N), createdAt: now, failed: 0 });
  C.auditCli(store, 'compte administrateur créé (console)', { compte: username });
  C.saveStore(store);
  console.log('Compte administrateur « ' + username + ' » créé. Démarrez le serveur puis connectez-vous.');
})().catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });

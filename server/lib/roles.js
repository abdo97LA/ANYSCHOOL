'use strict';
/* Rôles et autorisations. Toutes les vérifications sont faites côté serveur (can()).
   Masquer un bouton dans l'interface n'est qu'un confort : le serveur refuse toujours. */
const COLLECTIONS = {
  planning: ['teachers', 'rooms', 'levels', 'subjects', 'sessions', 'programs', 'volumes', 'cal', 'notCommon'],
  scolarite: ['students', 'templates', 'tplCats', 'absences'],
  config: ['cfg'],
  logs: ['audit', 'alertLog', 'alertSeen', 'alertMeta', 'alertState', 'events', 'waLog', 'sheetLog', 'docLog']
};
const PERMS = {
  'users.manage': 'Gérer les comptes et les rôles',
  'server.manage': 'Paramètres serveur et sauvegardes',
  'audit.read': 'Consulter le journal d’audit du serveur',
  'state.read': 'Lire toutes les données de l’établissement',
  'state.read.planning': 'Lire les données nécessaires à la planification (étudiants anonymisés)',
  'state.read.own': 'Lire uniquement ses propres séances (enseignant)',
  'state.write.planning': 'Modifier séances, matières, salles, enseignants, groupes, filières, calendrier',
  'state.write.scolarite': 'Modifier étudiants, modèles de documents',
  'state.write.config': 'Modifier la configuration de l’établissement',
  'state.force': 'Remplacer toutes les données (restauration)',
  'absences.read': 'Consulter toutes les absences',
  'absences.read.summary': 'Consulter les totaux d’absences (sans noms)',
  'absences.read.own': 'Consulter les absences de ses séances',
  'absences.write': 'Saisir des absences pour toute séance',
  'absences.write.own': 'Saisir des absences pour ses séances',
  'absences.amend': 'Corriger / annuler une déclaration',
  'forms.manage': 'Créer / révoquer les liens de déclaration',
  'policies.manage': 'Gérer les délais de modification des enseignants',
  'alerts.read': 'Consulter toutes les alertes',
  'alerts.read.own': 'Consulter les alertes de ses séances',
  'notifs.read': 'Consulter les notifications',
  'sessions.sync': 'Transmettre les séances à la surveillance des alertes',
  'finance.read': 'Consulter les données financières (rémunérations, taux)'
};
const ROLES = {
  admin: { label: 'Administrateur système', perms: Object.keys(PERMS) },
  scolarite: { label: 'Responsable de la scolarité', perms: ['state.read', 'state.write.scolarite', 'absences.read', 'absences.write', 'absences.amend', 'forms.manage', 'policies.manage', 'alerts.read', 'notifs.read', 'sessions.sync'] },
  planning: { label: 'Responsable de l’emploi du temps', perms: ['state.read.planning', 'state.write.planning', 'absences.read.summary', 'alerts.read', 'sessions.sync'] },
  teacher: { label: 'Enseignant', perms: ['state.read.own', 'absences.read.own', 'absences.write.own', 'alerts.read.own'] }
};
// Autorisations supplémentaires qu'un administrateur peut accorder individuellement (jamais les droits d'administration).
const GRANTABLE = Object.keys(PERMS).filter(p => !['users.manage', 'server.manage', 'state.force', 'audit.read'].includes(p));

/* Permissions effectives = permissions du rôle + autorisations accordées individuellement − autorisations retirées.
   Les droits d'un administrateur ne peuvent pas être retirés (pour ne jamais se retrouver sans administrateur). */
function permsOf(user) {
  if (!user) return [];
  const r = ROLES[user.role]; if (!r) return [];
  const denied = new Set(user.role === 'admin' ? [] : (user.deniedPerms || []).filter(p => GRANTABLE.includes(p)));
  return [...new Set([...r.perms, ...(user.extraPerms || []).filter(p => GRANTABLE.includes(p))])].filter(p => !denied.has(p));
}
const can = (user, perm) => permsOf(user).includes(perm);

/* Collections que l'utilisateur peut modifier dans l'état central */
function writable(user) {
  const s = new Set();
  if (can(user, 'state.write.planning')) COLLECTIONS.planning.forEach(k => s.add(k));
  if (can(user, 'state.write.scolarite')) COLLECTIONS.scolarite.forEach(k => s.add(k));
  if (can(user, 'state.write.config')) COLLECTIONS.config.forEach(k => s.add(k));
  if (s.size) COLLECTIONS.logs.forEach(k => s.add(k));
  return s;
}
const KNOWN = new Set(Object.values(COLLECTIONS).flat());
/* Une clé inconnue (ajoutée par une future version de l'interface) relève de la configuration : réservée à l'administrateur. */
const isWritable = (set, key) => set.has(key) || (!KNOWN.has(key) && set.has('cfg'));
module.exports = { ROLES, PERMS, COLLECTIONS, GRANTABLE, permsOf, can, writable, isWritable, KNOWN };

'use strict';
/* Point d'entrée Vercel : toutes les requêtes (voir vercel.json) arrivent ici et sont traitées par le serveur
   UniTimetable en mode « cloud » (données dans Supabase). Variables d'environnement : voir DEPLOIEMENT-VERCEL-SUPABASE.md. */
process.env.UNITT_STORAGE = process.env.UNITT_STORAGE || 'supabase';
const { cloudHandler } = require('../server/server.js');
module.exports = (req, res) => {
  // vercel.json réécrit « /chemin » en « /api/index?__path=/chemin » : on restaure l'adresse d'origine
  const u = new URL(req.url, 'http://local');
  const p = u.searchParams.get('__path');
  if (p !== null) { u.searchParams.delete('__path'); const q = u.searchParams.toString(); req.url = (p.startsWith('/') ? p : '/' + p) + (q ? '?' + q : ''); }
  return cloudHandler(req, res);
};

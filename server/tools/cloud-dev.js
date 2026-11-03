'use strict';
/* Lance la version « cloud » (celle de Vercel) sur ce PC, connectée à Supabase, pour la tester avant déploiement.
   Variables nécessaires : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (et ADMIN_PASSWORD pour créer le premier administrateur).
   Usage : node tools/cloud-dev.js   puis ouvrir http://localhost:3000 */
process.env.UNITT_STORAGE = 'supabase';
const http = require('http');
const { cloudHandler } = require('../server.js');
const port = +process.env.PORT || 3000;
http.createServer((req, res) => cloudHandler(req, res)).listen(port, process.env.HOST || '127.0.0.1', () => console.log('UniTimetable (mode cloud) démarré : http://localhost:' + port));

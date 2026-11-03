'use strict';
/* Journal de diagnostic : console + fichier quotidien logs/server-AAAA-MM-JJ.log.
   Ne jamais y écrire de mot de passe, de jeton, de cookie ni de contenu de requête. */
const fs = require('fs'), path = require('path');
let DIR = null, KEEP = 60, quiet = false;
function init(dir, keepDays, opts) {
  DIR = dir || null; quiet = !!(opts && opts.quiet); KEEP = keepDays || 60; if (!DIR) return;   // mode cloud : console uniquement (journaux Vercel)
  DIR = dir; KEEP = keepDays || 60; quiet = !!(opts && opts.quiet);
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { DIR = null; }
  prune();
}
function prune() {
  if (!DIR) return;
  try {
    const lim = Date.now() - KEEP * 864e5;
    for (const f of fs.readdirSync(DIR)) if (/^server-\d{4}-\d{2}-\d{2}\.log$/.test(f)) {
      const p = path.join(DIR, f); if (fs.statSync(p).mtimeMs < lim) fs.unlinkSync(p);
    }
  } catch (e) { /* ignore */ }
}
const SECRET_KEYS = /pass(word)?|pw|token|cookie|secret|signature|hash|salt/i;
function clean(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const o = {};
  for (const [k, v] of Object.entries(meta)) o[k] = SECRET_KEYS.test(k) ? '[masqué]' : (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v);
  return o;
}
function write(level, msg, meta, force) {
  const at = new Date();
  const line = at.toISOString() + ' ' + level.padEnd(5) + ' ' + msg + (meta ? ' ' + JSON.stringify(clean(meta)) : '');
  if (!quiet || force || level === 'ERROR') (level === 'ERROR' ? console.error : console.log)(line);
  if (DIR) { try { fs.appendFileSync(path.join(DIR, 'server-' + at.toISOString().slice(0, 10) + '.log'), line + '\n'); } catch (e) { /* disque plein : on continue */ } }
}
/* Masque les jetons dans les chemins (/f/<jeton>, /api/form/<jeton>) */
const redactPath = p => String(p || '').replace(/^(\/f\/|\/api\/form\/)[^/?]+/, '$1***').replace(/\?.*$/, m => m.length > 1 ? '?…' : '');
setInterval(prune, 6 * 3600e3).unref();
module.exports = { init, info: (m, x) => write('INFO', m, x), always: (m, x) => write('INFO', m, x, true), warn: (m, x) => write('WARN', m, x), error: (m, x) => write('ERROR', m, x), redactPath, clean };

'use strict';
/* Lecture / écriture sûres de fichiers JSON.
   Écriture : fichier temporaire + fsync, copie de l'ancien en .bak, puis renommage atomique.
   Lecture : si le fichier principal est illisible, on essaie le .bak ; si les deux sont illisibles,
   on refuse de continuer plutôt que d'écraser des données. */
const fs = require('fs'), path = require('path');
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* */ } };

function writeAtomic(file, data, opts) {
  const txt = typeof data === 'string' ? data : JSON.stringify(data);
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, txt); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!(opts && opts.noBackup) && fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* */ } }
  // Sous Windows, un antivirus ou un outil de sauvegarde peut verrouiller brièvement le fichier : quelques essais.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); break; }
    catch (e) { if (i >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; sleepSync(50 * (i + 1)); }
  }
}

function readJson(file, fallback, log) {
  const tryRead = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!fs.existsSync(file)) {
    if (fs.existsSync(file + '.bak')) { const d = tryRead(file + '.bak'); log && log.warn('Fichier absent, restauré depuis .bak', { file }); return d; }
    return fallback;
  }
  try { return tryRead(file); }
  catch (e) {
    const aside = file + '.corrompu-' + Date.now();
    try { fs.copyFileSync(file, aside); } catch (x) { /* */ }
    if (fs.existsSync(file + '.bak')) {
      try { const d = tryRead(file + '.bak'); log && log.error('Fichier illisible, utilisation de la copie .bak (original conservé)', { file, copie: path.basename(aside) }); return d; } catch (x) { /* */ }
    }
    const err = new Error('Fichier de données illisible : ' + file + ' (copie conservée : ' + aside + '). Restaurez une sauvegarde avec tools/restore.js.');
    err.fatal = true; throw err;
  }
}
module.exports = { writeAtomic, readJson };

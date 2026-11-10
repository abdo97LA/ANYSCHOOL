'use strict';
/* Sauvegardes : copie horodatée de store.json et state.json + manifeste avec empreintes SHA-256.
   La restauration se fait serveur arrêté, avec tools/restore.js (qui sauvegarde d'abord l'état actuel). */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILES = ['store.json', 'state.json', 'secret.key', 'audit.jsonl'];
const PLATFORM_FILES = ['platform.json', 'platform-audit.jsonl'];
/* Le journal d'audit est sauvegardé (archive) mais JAMAIS restauré : il est en ajout seul, la restauration
   ne doit pas effacer les événements postérieurs à la sauvegarde (elle est elle-même inscrite au journal). */
const NEVER_RESTORED = new Set(['audit.jsonl', 'platform-audit.jsonl']);
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function create(dataDir, backupDir, reason, keep, fileList) {
  fs.mkdirSync(backupDir, { recursive: true });
  const at = new Date(), name = stamp(at) + '-' + String(reason || 'manuelle').replace(/[^a-z0-9-]/gi, '').slice(0, 30), dir = path.join(backupDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const f of (fileList || FILES)) { const src = path.join(dataDir, f); if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f)); files[f] = { sha256: sha(path.join(dir, f)), bytes: fs.statSync(path.join(dir, f)).size }; } }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ app: 'unitimetable', createdAt: at.toISOString(), reason, files }, null, 2));
  if (keep) prune(backupDir, keep);
  return { name, dir, createdAt: at.toISOString(), files };
}
function list(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter(n => fs.existsSync(path.join(backupDir, n, 'manifest.json'))).sort().reverse().map(n => {
    try { const m = JSON.parse(fs.readFileSync(path.join(backupDir, n, 'manifest.json'), 'utf8')); return { name: n, createdAt: m.createdAt, reason: m.reason, files: m.files }; }
    catch (e) { return { name: n, error: 'manifeste illisible' }; }
  });
}
function verify(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), bad = [];
  for (const [f, info] of Object.entries(m.files || {})) { const p = path.join(dir, f); if (!fs.existsSync(p) || sha(p) !== info.sha256) bad.push(f); }
  return { ok: !bad.length && !!(m.files && (m.files['store.json'] || m.files['state.json'] || m.files['platform.json'])), bad, manifest: m };
}
function prune(backupDir, keep) {
  const all = list(backupDir).filter(b => !b.error);
  for (const b of all.slice(keep)) { try { fs.rmSync(path.join(backupDir, b.name), { recursive: true, force: true }); } catch (e) { /* */ } }
}
function restore(dataDir, backupDir, name, keep) {
  const dir = path.isAbsolute(name) ? name : path.join(backupDir, name);
  const v = verify(dir); if (!v.ok) throw new Error('Sauvegarde invalide ou altérée : ' + (v.bad.join(', ') || 'manifeste incomplet'));
  const before = create(dataDir, backupDir, 'avant-restauration', 0, v.manifest.files['platform.json'] ? PLATFORM_FILES : undefined);
  for (const f of Object.keys(v.manifest.files)) if (!NEVER_RESTORED.has(f)) fs.copyFileSync(path.join(dir, f), path.join(dataDir, f));
  // l'historique des révisions ne correspond plus : on le met de côté
  const h = path.join(dataDir, 'history'); if (fs.existsSync(h)) fs.renameSync(h, h + '-avant-restauration-' + Date.now());
  if (keep) prune(backupDir, keep);
  return { restored: path.basename(dir), safetyCopy: before.name };
}
module.exports = { create, list, verify, restore, prune, FILES, PLATFORM_FILES };

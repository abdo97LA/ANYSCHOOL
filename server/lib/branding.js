'use strict';
/* Identité visuelle (phase 3) : propre à CHAQUE établissement (store.branding de l'établissement),
   modifiable par son administrateur sans toucher au code, sans effet sur les autres établissements.
   - noms : nom affiché dans l'application, nom des rapports et documents officiels, nom en arabe ;
   - logo : PNG, JPEG ou WEBP (jamais SVG : pas de script possible), 400 Ko maximum, contenu vérifié ;
   - emplacements du logo : barre de navigation, page de connexion, tableau de bord, rapports, documents ;
   - couleurs : principale, secondaire, fond, barre de navigation, boutons, texte (#rrggbb) ; vide = thème par défaut. */
const crypto = require('crypto');
const COLORS = { primary: 'Couleur principale', secondary: 'Couleur secondaire', background: 'Fond', sidebar: 'Barre de navigation', button: 'Boutons et éléments interactifs', text: 'Texte' };
const PLACES = { sidebar: 'Barre de navigation', login: 'Page de connexion', dashboard: 'Tableau de bord', reports: 'Rapports et PDF', documents: 'Documents officiels et attestations' };
const DEFAULT = () => ({ displayName: '', reportName: '', nameAr: '', logo: '', logoPlaces: { sidebar: true, login: true, dashboard: true, reports: true, documents: true }, colors: {}, updatedAt: '', updatedBy: '' });
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_LOGO = 400 * 1024;
function logoProblem(v) {
  if (v === '') return '';
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(v || '');
  if (!m) return 'Logo : format accepté PNG, JPEG ou WEBP (le SVG n’est pas accepté).';
  if (v.length > MAX_LOGO * 1.37) return 'Logo trop volumineux (400 Ko maximum).';
  const b = Buffer.from(m[2], 'base64');
  const ok = m[1] === 'png' ? b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : m[1] === 'jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
      : b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP';
  return ok ? '' : 'Logo : le contenu du fichier ne correspond pas à une image ' + m[1].toUpperCase() + '.';
}
/* nettoie et valide une modification ; renvoie { value } ou { error } */
function clean(b, cur) {
  const o = Object.assign(DEFAULT(), cur || {});
  const s = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  if (b.displayName !== undefined) o.displayName = s(b.displayName, 120);
  if (b.reportName !== undefined) o.reportName = s(b.reportName, 160);
  if (b.nameAr !== undefined) o.nameAr = s(b.nameAr, 160);
  if (b.logo !== undefined) { const e = logoProblem(b.logo); if (e) return { error: e }; o.logo = b.logo || ''; }
  if (b.logoPlaces !== undefined) { const p = b.logoPlaces || {}; o.logoPlaces = Object.fromEntries(Object.keys(PLACES).map(k => [k, !!p[k]])); }
  if (b.resetColors === true) o.colors = {};
  else if (b.colors !== undefined) {
    const c = {}; for (const k of Object.keys(COLORS)) { const v = (b.colors || {})[k]; if (v === undefined || v === '' || v === null) continue; if (!HEX.test(v)) return { error: 'Couleur invalide (' + COLORS[k] + ') : format #rrggbb attendu.' }; c[k] = v.toLowerCase(); }
    o.colors = c;
  }
  return { value: o };
}
const digest = l => l ? { octets: Math.round(l.length * 3 / 4), sha256: crypto.createHash('sha256').update(l).digest('hex').slice(0, 16) } : null;
/* résumé pour le journal (jamais l'image elle-même) */
const forAudit = b => b && ({ displayName: b.displayName, reportName: b.reportName, nameAr: b.nameAr, logo: digest(b.logo), logoPlaces: b.logoPlaces, colors: b.colors });
/* informations publiques (page de connexion, formulaire enseignant) */
function publicBrand(b, tenant) {
  b = Object.assign(DEFAULT(), b || {});
  const name = b.displayName || (tenant && (tenant.shortName || tenant.name)) || '';
  return { name, reportName: b.reportName || (tenant && tenant.name) || name, nameAr: b.nameAr || (tenant && tenant.nameAr) || '', logo: b.logo && b.logoPlaces.login ? b.logo : '', colors: b.colors || {}, slug: tenant ? tenant.slug : '' };
}
function full(b, tenant) {
  b = Object.assign(DEFAULT(), b || {});
  return { ...b, effective: { name: b.displayName || (tenant && (tenant.shortName || tenant.name)) || '', reportName: b.reportName || (tenant && tenant.name) || '', nameAr: b.nameAr || (tenant && tenant.nameAr) || '' } };
}
module.exports = { COLORS, PLACES, DEFAULT, clean, logoProblem, forAudit, publicBrand, full, MAX_LOGO };

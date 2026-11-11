/* Interface — phase 2 (suppression logique, motif, Corbeille, restauration) et phase 3 (identité visuelle).
   Nécessite Playwright + Chromium. node tests/phase23.ui.test.js   (SHOTS=dossier pour des captures) */
'use strict';
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP : Playwright non installé'); process.exit(0); }
const DIR = path.join(__dirname, '..'), ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-p23-'));
const PORT = 9200 + Math.floor(Math.random() * 90), B = 'http://127.0.0.1:' + PORT, SHOTS = process.env.SHOTS || '';
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(x).slice(0, 300) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAU = 'proprietaire', SAP0 = 'Initial-Console-2026!x', SAP = 'Console-Forte-2026!!';
async function api(jar, m, p, b) { const r = await fetch(B + p, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body: b ? JSON.stringify(b) : undefined }); for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } let j = null; try { j = await r.json(); } catch (e) { } return { s: r.status, j }; }
(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(ROOT, 'bk'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), LOGIN_RATE_PER_MIN: '1000', SUPERADMIN_USERNAME: SAU, SUPERADMIN_PASSWORD: SAP0 };
  const srv = cp.spawn(process.execPath, ['server.js'], { cwd: DIR, env });
  await new Promise((res, rej) => { let o = ''; const on = d => { o += d; if (/démarré/.test(o)) res(); }; srv.stdout.on('data', on); srv.stderr.on('data', on); setTimeout(() => rej(new Error(o)), 10000); });
  // préparation par l'API : établissement + données
  const sj = {}; await api(sj, 'POST', '/api/platform/login', { username: SAU, password: SAP0 }); await api(sj, 'POST', '/api/platform/password', { current: SAP0, next: SAP });
  let r = await api(sj, 'POST', '/api/platform/tenants', { name: 'Institut Supérieur Atlas', nameAr: 'المعهد العالي أطلس', slug: 'atlas', admin: { username: 'admin', password: 'Temporaire-Atlas-2026' } }); const TA = r.j.tenant;
  const aj = {}; await api(aj, 'POST', '/api/login', { username: 'admin', password: 'Temporaire-Atlas-2026', etab: 'atlas' }); await api(aj, 'POST', '/api/account/password', { current: 'Temporaire-Atlas-2026', next: 'Direction-Atlas-2026x' });
  r = await api(aj, 'GET', '/api/state'); const d = r.j.data;
  Object.assign(d, { programs: [{ id: 'p', name: 'IP', label: 'Infirmier polyvalent' }], teachers: [{ id: 't1', name: 'Dr. Amrani' }], rooms: [{ id: 'r1', name: 'A101', type: 'lecture', capacity: 40 }], levels: [{ id: 'l1', name: 'IP 1', size: 30 }], subjects: [{ id: 's1', name: 'Anatomie', hoursPerWeek: 2, level: 'l1', teacherId: 't1' }],
    students: [{ id: 'st1', matricule: 'M001', lastName: 'Alaoui', firstName: 'Sara', programId: 'p', year: '1', group: 'G1' }, { id: 'st2', matricule: 'M002', lastName: 'Bennani', firstName: 'Omar', programId: 'p', year: '1', group: 'G1' }] });
  r = await api(aj, 'PUT', '/api/state', { baseRev: r.j.rev, data: d }); ok('préparation des données', r.s === 200, JSON.stringify(r.j));
  const png = path.join(ROOT, 'logo.png');
  const browser = await chromium.launch(), errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (/Content Security Policy/.test(m.text())) errs.push(m.text()); });
  page.on('dialog', dl => dl.accept());
  const shot = async (n, full) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: !!full }); };
  try {
    // logo de test dessiné dans le navigateur
    await page.goto(B + '/?etab=atlas'); await page.waitForSelector('#srv_et'); await page.waitForLoadState('networkidle'); await sleep(300);
    const dataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 120; const x = c.getContext('2d'); x.fillStyle = '#0e7490'; x.fillRect(0, 0, 300, 120); x.fillStyle = '#fff'; x.font = 'bold 54px sans-serif'; x.fillText('ATLAS', 50, 80); return c.toDataURL('image/png'); });
    fs.writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
    await page.fill('#srv_us', 'admin'); await page.fill('#srv_pw', 'Direction-Atlas-2026x'); await page.click('#srv_go');
    await page.waitForSelector('#usr button'); await sleep(800);
    ok('connexion : nom de l’établissement dans l’en-tête', (await page.textContent('header h1')).includes('Institut Supérieur Atlas'));

    /* ----- phase 3 : identité visuelle ----- */
    await page.click('#nav button:has-text("Administration")'); await page.waitForSelector('#br_dn');
    await page.fill('#br_dn', 'Atlas'); await page.fill('#br_rn', 'Institut Supérieur Atlas – Rabat');
    await page.setInputFiles('#adm_brand input[type=file]', png); await page.waitForSelector('#br_lp img');
    ok('identité : logo chargé et prévisualisé', true);
    for (const [k, v] of [['primary', '#0e7490'], ['sidebar', '#0f172a'], ['button', '#0e7490'], ['secondary', '#9333ea']]) { await page.$eval('#brc_' + k, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); }
    await sleep(200);
    const hb = await page.$eval('header', e => getComputedStyle(e).backgroundColor);
    ok('identité : aperçu en direct (en-tête recoloré avant enregistrement)', hb === 'rgb(15, 23, 42)', hb);
    ok('identité : texte de l’en-tête lisible (contraste automatique)', (await page.$eval('header h1', e => getComputedStyle(e).color)) === 'rgb(255, 255, 255)');
    await page.$eval('#brc_text', e => { e.value = '#eeeeee'; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
    ok('identité : avertissement de contraste insuffisant', /Contraste texte/.test(await page.textContent('#br_warn')));
    await page.uncheck('#brc_on_text'); await page.click('text=Enregistrer l’identité visuelle'); await page.waitForSelector('text=Identité visuelle enregistrée');
    ok('identité : enregistrée', true);
    await shot('10-identite-visuelle', true);
    ok('identité : logo dans la barre de navigation', await page.isVisible('header h1 img'));
    await page.click('#nav button:has-text("Dashboard")'); await page.waitForSelector('#brandbanner');
    ok('identité : logo et nom sur le tableau de bord', (await page.textContent('#brandbanner')).includes('Atlas') && await page.isVisible('#brandbanner img'));
    await shot('11-tableau-de-bord');
    const sheet = await page.evaluate(() => { SH = { sid: '', blank: 5, teacher: '', subject: '', room: '' }; S.sessions.push({ id: 'zz', subjectId: 's1', teacherId: 't1', roomId: 'r1', day: 'MON', startTime: '08:00', endTime: '09:00' }); SH.sid = 'zz'; const h = sheetHtml(); S.sessions = S.sessions.filter(s => s.id !== 'zz'); return h; });
    ok('identité : feuille d’émargement avec le nom des documents et le logo (sans les logos d’un autre établissement)', sheet.includes('Institut Supérieur Atlas – Rabat') && sheet.includes('data:image/') && !sheet.includes('UM6SS'));
    ok('identité : champs des attestations (établissement, nom arabe)', await page.evaluate(() => brandName('documents') === 'Institut Supérieur Atlas – Rabat' && brandNameAr() === 'المعهد العالي أطلس'));
    // page de connexion d'un autre navigateur
    const p2 = await (await browser.newContext()).newPage(); p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(B + '/?etab=atlas'); await p2.waitForSelector('#lg_brand img');
    ok('connexion : logo et nom de l’établissement avant connexion', (await p2.textContent('#lg_brand')).includes('Atlas'));
    ok('connexion : couleurs de l’établissement appliquées', (await p2.$eval('header', e => getComputedStyle(e).backgroundColor)) === 'rgb(15, 23, 42)');
    if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, '12-connexion-identite.png') });
    await p2.fill('#srv_et', 'principal'); await p2.dispatchEvent('#srv_et', 'change'); await sleep(600);
    ok('connexion : un autre code affiche l’identité de l’autre établissement (pas celle d’Atlas)', !(await p2.textContent('#lg_brand')).includes('Atlas') && !(await p2.$('#lg_brand img')));

    /* ----- phase 2 : suppression logique et Corbeille ----- */
    await page.click('#nav button:has-text("Étudiants")'); await page.waitForSelector('text=Alaoui', { timeout: 8000 }).catch(() => { });
    await page.evaluate(() => { S.students = S.students.filter(s => s.id !== 'st1'); save(); render(); });
    await page.waitForSelector('#del_r', { timeout: 8000 }); ok('suppression : demande du motif, éléments listés, rappel de la Corbeille', (await page.textContent('#mbox')).includes('ALAOUI') && (await page.textContent('#mbox')).includes('Corbeille'));
    await shot('13-motif-suppression');
    await page.fill('#del_r', 'Doublon de saisie'); await page.click('text=Confirmer la suppression');
    await page.waitForFunction(() => !ST.dirty, null, { timeout: 8000 });
    r = await api(aj, 'GET', '/api/trash'); ok('suppression : élément dans la corbeille du serveur avec le motif', r.j.items.some(e => e.recordId === 'st1' && e.reason === 'Doublon de saisie'));
    await page.click('#nav button:has-text("Corbeille")'); await page.waitForSelector('#tr_l table');
    ok('Corbeille : élément affiché (auteur, motif)', (await page.textContent('#tr_l')).includes('Doublon de saisie'));
    await shot('14-corbeille');
    // conflit : nouveau étudiant avec le même matricule
    await page.evaluate(() => { S.students.push({ id: 'st9', matricule: 'M001', lastName: 'Copie', firstName: 'X', programId: 'p', year: '1', group: 'G1' }); save(); });
    await page.waitForFunction(() => !ST.dirty, null, { timeout: 8000 });
    await page.click('#tr_l button:has-text("Restaurer")'); await page.waitForSelector('#rs_r');
    ok('restauration : conflit affiché clairement, bouton désactivé', (await page.textContent('#mbox')).includes('M001') && await page.isDisabled('#mbox button.pri'));
    await shot('15-conflit-restauration');
    await page.click('#mbox button:has-text("Annuler")');
    await page.evaluate(() => { S.students = S.students.filter(s => s.id !== 'st9'); save(); });
    await page.waitForSelector('#del_r'); await page.fill('#del_r', 'Copie erronée'); await page.click('text=Confirmer la suppression'); await page.waitForFunction(() => !ST.dirty, null, { timeout: 8000 });
    await page.evaluate(() => trashLoad()); await sleep(400);
    await page.click('#tr_l tr:has-text("Alaoui") button:has-text("Restaurer")'); await page.waitForSelector('#rs_r');
    ok('restauration : plus de conflit', (await page.textContent('#mbox')).includes('Aucun conflit'));
    await page.fill('#rs_r', 'Suppression par erreur'); await page.click('#mbox button.pri'); await page.waitForSelector('text=Élément restauré');
    await page.waitForFunction(() => S.students.some(s => s.id === 'st1'), null, { timeout: 8000 });
    ok('restauration : l’étudiant revient dans l’application avec son identifiant', true);

    /* ----- console : corbeilles de tous les établissements ----- */
    const pc = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); pc.on('pageerror', e => errs.push(e.message));
    await pc.goto(B + '/platform'); await pc.waitForSelector('#l_u'); await pc.fill('#l_u', SAU); await pc.fill('#l_p', SAP); await pc.click('#l_go');
    await pc.waitForSelector('nav button:has-text("Corbeilles")'); await pc.click('nav button:has-text("Corbeilles")'); await pc.waitForSelector('#x_out table');
    ok('console : corbeilles de tous les établissements', (await pc.textContent('#x_out')).includes('Institut Supérieur Atlas'));
    if (SHOTS) await pc.screenshot({ path: path.join(SHOTS, '16-console-corbeilles.png') });
    await pc.click('nav button:has-text("Établissements")'); await pc.click('text=Institut Supérieur Atlas'); await pc.waitForSelector('text=Identité visuelle');
    ok('console : aperçu de l’identité visuelle de l’établissement', await pc.isVisible('#ttab img'));
    if (SHOTS) await pc.screenshot({ path: path.join(SHOTS, '17-console-identite.png') });
    // thème par défaut
    await page.click('#nav button:has-text("Administration")'); await page.waitForSelector('#br_dn'); await page.click('text=Rétablir le thème par défaut'); await page.waitForSelector('text=Thème par défaut rétabli');
    ok('thème par défaut rétabli : en-tête aux couleurs d’origine', (await page.$eval('header', e => getComputedStyle(e).backgroundColor)) !== 'rgb(15, 23, 42)');
    ok('aucune erreur JavaScript ni violation CSP', errs.length === 0, errs.join(' | '));
  } catch (e) { ok('déroulé de l’interface', false, e.message); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'erreur-p23.png') }); }
  await browser.close(); srv.kill();
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués'); process.exit(fails ? 1 : 0);
})();

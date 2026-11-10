/* Interface : console Super Admin (/platform) et connexion par code d'établissement dans l'application.
   Nécessite Playwright + Chromium. node tests/platform.ui.test.js  (SHOTS=dossier pour enregistrer des captures) */
'use strict';
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP : Playwright non installé'); process.exit(0); }
const DIR = path.join(__dirname, '..'), ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unitt-pui-'));
const PORT = 9300 + Math.floor(Math.random() * 100), B = 'http://127.0.0.1:' + PORT, SHOTS = process.env.SHOTS || '';
let fails = 0, passes = 0; const ok = (n, c, x) => { c ? passes++ : fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + String(x).slice(0, 300) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAU = 'proprietaire', SAP0 = 'Initial-Console-2026!x', SAP = 'Console-Forte-2026!!';
(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), LOG_DIR: path.join(ROOT, 'logs'), BACKUP_DIR: path.join(ROOT, 'bk'), SCRYPT_N: '4096', UNITT_QUIET: '1', UNITT_CONFIG: path.join(ROOT, 'x.env'), LOGIN_RATE_PER_MIN: '1000', SUPERADMIN_USERNAME: SAU, SUPERADMIN_PASSWORD: SAP0, ADMIN_PASSWORD: 'Principal-Admin-2026' };
  const srv = cp.spawn(process.execPath, ['server.js'], { cwd: DIR, env });
  await new Promise((res, rej) => { let o = ''; const on = d => { o += d; if (/démarré/.test(o)) res(); }; srv.stdout.on('data', on); srv.stderr.on('data', on); setTimeout(() => rej(new Error(o)), 10000); });
  const browser = await chromium.launch(), errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }), page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (/Content Security Policy/.test(m.text())) errs.push(m.text()); });
  page.on('dialog', d => d.accept('Départ de l’employé'));
  let p2 = null;
  const shot = async n => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: false }); };
  try {
    await page.goto(B + '/platform'); await page.waitForSelector('#l_u');
    await page.fill('#l_u', SAU); await page.fill('#l_p', SAP0); await page.click('#l_go');
    await page.waitForSelector('#p_n'); ok('console : connexion puis changement du mot de passe initial exigé', true);
    await page.fill('#p_c', SAP0); await page.fill('#p_n', SAP); await page.fill('#p_n2', SAP); await page.click('button.pri');
    await page.waitForSelector('text=Mon compte Super Admin'); ok('console : mot de passe changé, accès au compte', true);
    await page.click('nav button:has-text("Établissements")'); await page.waitForSelector('text=Établissements abonnés');
    ok('console : le premier établissement (données d’origine) est listé', await page.isVisible('code:has-text("principal")'));
    await page.click('text=+ Nouvel établissement'); await page.fill('#t_n', 'Institut Supérieur Atlas'); await page.fill('#t_a', 'المعهد العالي أطلس');
    ok('console : code de connexion proposé à partir du nom', (await page.inputValue('#t_s')) === 'institut-superieur-atlas');
    await page.fill('#t_s', 'atlas'); await page.fill('#a_n', 'Mme Benjelloun'); const tmp = await page.inputValue('#a_p');
    await shot('01-nouvel-etablissement');
    await page.click('text=Créer l’établissement'); await page.waitForSelector('text=Établissement créé');
    ok('console : établissement créé, identifiants à transmettre affichés', await page.isVisible('code:has-text("atlas")'));
    await page.click('text=Ouvrir l’établissement'); await page.waitForSelector('text=Comptes actifs');
    await shot('02-fiche-etablissement');
    await page.click('#app button:has-text("Comptes")'); await page.waitForSelector('#ttab table');
    ok('console : comptes de l’établissement visibles', await page.isVisible('#ttab td:has-text("Mme Benjelloun")'));
    await page.click('#app button:has-text("Journal d’activité")'); await page.waitForSelector('#f_out table');
    ok('console : journal de l’établissement (création, compte créé)', await page.isVisible('#f_out summary:has-text("compte créé")'));
    await page.click('#f_ver'); await page.waitForSelector('text=Chaîne d’intégrité du journal valide');
    ok('console : vérification d’intégrité du journal', true);
    await shot('03-journal');
    await page.click('#app button:has-text("Statut et abonnement")'); await page.click('#ttab button:has-text("Suspendre")'); await page.fill('#s_r', 'Retard de paiement'); await page.click('text=Confirmer');
    await page.waitForSelector('#app h1 .pill:has-text("Suspendu")'); ok('console : établissement suspendu (motif obligatoire)', true);

    /* application : connexion de l'établissement suspendu puis réactivé, avec le code */
    p2 = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage(); p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(B + '/?etab=atlas'); await p2.waitForSelector('#srv_et'); await p2.waitForLoadState('networkidle'); await sleep(300);
    ok('application : code d’établissement prérempli depuis le lien', (await p2.inputValue('#srv_et')) === 'atlas');
    await p2.fill('#srv_us', 'admin'); await p2.fill('#srv_pw', tmp); await p2.click('#srv_go');
    await p2.waitForSelector('#ferr:has-text("suspendu")'); ok('application : connexion refusée, établissement suspendu (message clair)', true);
    await page.click('#ttab button:has-text("Activer")'); await page.fill('#s_r', 'Paiement reçu'); await page.click('text=Confirmer'); await page.waitForSelector('#app h1 .pill:has-text("Actif")');
    await p2.click('#srv_go'); await p2.waitForSelector('#pw_n'); ok('application : connexion avec le code après réactivation (mot de passe à changer)', true);
    await p2.fill('#pw_c', tmp); await p2.fill('#pw_n', 'Atlas-Direction-2026x'); await p2.fill('#pw_n2', 'Atlas-Direction-2026x'); await p2.click('#mbox button.pri');
    await p2.waitForSelector('#usr button'); ok('application : nom de l’établissement affiché', (await p2.textContent('#usr')).includes('Institut Supérieur Atlas'));
    await p2.click('#nav button:has-text("Administration")'); await p2.waitForSelector('#adm_inst b');
    ok('application : administration — établissement, comptes, rôles personnalisés, journal filtrable', await p2.isVisible('text=Rôles personnalisés') && await p2.isVisible('#aud_sec'));
    await p2.click('text=+ Nouveau compte'); await p2.fill('#u_us', 'r.alami'); await p2.fill('#u_dn', 'Rachid Alami'); await p2.fill('#u_jt', 'Responsable scolarité'); await p2.fill('#u_em', 'r.alami@atlas.ma'); await p2.selectOption('#u_ro', 'scolarite'); await p2.click('#mbox button.pri');
    await p2.waitForSelector('#adm_users td:has-text("Responsable scolarité")'); ok('application : compte employé créé avec son poste', true);
    await p2.click('text=+ Nouveau rôle'); await p2.fill('#ro_k', 'secretariat'); await p2.fill('#ro_l', 'Secrétariat'); await p2.check('.ro_p[value="state.read"]'); await p2.click('#mbox button.pri');
    await p2.waitForSelector('#adm_roles td:has-text("Secrétariat")'); ok('application : rôle personnalisé créé', true);
    await p2.selectOption('#aud_sec', 'comptes'); await sleep(500);
    ok('application : journal filtré par rubrique', (await p2.$$eval('#adm_audit tr td:nth-child(3)', t => t.map(x => x.textContent))).every(x => x === 'comptes'));
    if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, '04-admin-etablissement.png'), fullPage: true });

    /* entrée du Super Admin en consultation */
    await page.click('#app button:has-text("Consulter son espace")'); await page.fill('#e_r', 'Contrôle qualité'); await page.click('#mbox button:has-text("Entrer")');
    await page.waitForSelector('#sabanner'); ok('Super Admin dans l’espace : bandeau « consultation » affiché', (await page.textContent('#sabanner')).includes('CONSULTATION'));
    await shot('05-espace-consultation');
    await page.click('#sabanner button'); await page.waitForURL(/\/platform/); await page.waitForSelector('text=Établissements abonnés');
    ok('Super Admin : retour à la console en quittant l’espace', true);
    await page.click('nav button:has-text("Journal de la plateforme")'); await page.waitForSelector('#f_out table');
    ok('console : journal de la plateforme (entrée dans l’espace inscrite)', await page.isVisible('#f_out summary:has-text("entrée dans l’espace")'));
    await shot('06-journal-plateforme');
    await page.click('nav button:has-text("Mon compte")'); await page.click('text=Activer la double authentification'); await page.waitForSelector('#t_c');
    const secret = (await page.textContent('#totp code')).replace(/\s/g, ''); await page.fill('#t_c', require('../lib/platform').hotp(secret, Math.floor(Date.now() / 30000))); await page.click('text=Vérifier et activer');
    await page.waitForSelector('text=Activée ✔'); ok('console : double authentification activée depuis l’interface', true);
    ok('aucune erreur JavaScript ni violation CSP', errs.length === 0, errs.join(' | '));
  } catch (e) { ok('déroulé de l’interface', false, e.message); if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, 'erreur.png') }); if (p2) await p2.screenshot({ path: path.join(SHOTS, 'erreur2.png') }); } }
  await browser.close(); srv.kill();
  console.log('\n' + passes + ' réussis, ' + fails + ' échoués'); process.exit(fails ? 1 : 0);
})();

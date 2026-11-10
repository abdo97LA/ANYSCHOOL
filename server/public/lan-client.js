/* ===== UniTimetable LAN : comptes individuels, rôles, synchronisation fiable =====
   Ce bloc est inséré dans index.html par tools/patch-index.js. Il remplace (même nom de fonction,
   la dernière déclaration l'emporte) les fonctions de connexion, de chargement et de synchronisation.
   Rappel : masquer un onglet n'est qu'un confort ; toutes les autorisations sont vérifiées par le serveur. */
var USR = null, TEN = null, SRV_BLOCKED = '';
/* en-tête : le menu passe à la ligne au lieu de se réduire à une colonne quand l'en-tête est chargé */
(function () { const st = document.createElement('style'); st.textContent = '#nav{min-width:min(100%,560px)}#usr .tenant{display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}'; document.head.appendChild(st); })();
const ALL_TABS = TABS.slice();
const TAB_ROLES = { admin: null, scolarite: ['dashboard', 'timetable', 'today', 'progress', 'students', 'absences', 'audit'], planning: ['dashboard', 'timetable', 'today', 'progress', 'import', 'programs', 'teachers', 'subjects', 'rooms', 'levels'], teacher: ['today', 'timetable', 'absences'], direction: ['dashboard', 'timetable', 'today', 'progress', 'students', 'absences', 'audit'], finance: ['dashboard', 'timetable', 'progress', 'teachers'] };
const TAB_PARENT = { simport: 'students', timport: 'teachers', templates: 'students', tplgen: 'students', sheet: 'today' };
function hasP(p) { return !!(USR && USR.perms && USR.perms.includes(p)) }
function isTeacher() { return !!(USR && USR.role === 'teacher') }
const served = () => /^https?:$/.test(location.protocol);
function applyRoleTabs() {
  const allow = USR ? TAB_ROLES[USR.role] : null;
  const list = ALL_TABS.filter(t => !allow || allow.includes(t[0]));
  if (allow && USR.role === 'teacher') list.sort((a, b) => allow.indexOf(a[0]) - allow.indexOf(b[0]));
  if (hasP('users.manage')) list.push(['admin', 'Administration']);
  TABS.splice(0, TABS.length, ...list);
}
function lanGate() {
  if (!served() || (SRV.checked && !SRV.on)) return false;         // fichier local / sans serveur : ancien mode autonome
  if (SRV.checked && SRV.auth && USR && !USR.mustChange) return false;
  $('#nav').innerHTML = ''; lanBadge();
  $('#app').innerHTML = `<div class="card" style="max-width:520px;margin:40px auto;text-align:center"><h2 style="margin-top:0">UniTimetable</h2><p class="mu">${!SRV.checked ? 'Connexion au serveur…' : SRV.setup ? 'Aucun compte n’existe encore sur ce serveur.' : USR && USR.mustChange ? 'Vous devez choisir un nouveau mot de passe.' : 'Connectez-vous avec votre compte personnel pour accéder aux données de l’établissement.'}</p>${SRV.checked ? `<button class="pri" onclick="${USR && USR.mustChange ? 'pwDlg(true)' : 'srvLogin()'}">${USR && USR.mustChange ? 'Changer mon mot de passe' : 'Se connecter'}</button>` : ''}</div>`;
  return true;
}
function render() {
  if (lanGate()) return;
  if (USR) {
    if (tab === 'admin' && !hasP('users.manage')) tab = TABS[0][0];
    const t = TAB_PARENT[tab] || tab;
    if (tab !== 'admin' && !TABS.some(x => x[0] === t)) tab = TABS[0][0];
  }
  render0(); lanBadge();
}
function lanBadge() {
  let e = $('#usr'); if (!e) return;
  if (!(SRV.on && SRV.auth && USR)) { e.innerHTML = ''; e.style.display = 'none'; return; }
  e.style.display = ''; e.innerHTML = (TEN ? `<span class="mu tenant" style="font-size:12px;margin-right:6px" title="${esc(TEN.name)}">🏛 ${esc(TEN.shortName || TEN.name)}</span>` : '') + `<button title="Mon compte" onclick="accDlg()">👤 ${esc(USR.superAdmin ? 'Super Admin' : USR.displayName)} <span class="mu" style="font-size:11px">${esc(USR.superAdmin ? '' : USR.roleLabel)}</span></button>`;
  let sb = $('#sabanner');
  if (USR.superAdmin) {
    if (!sb) { sb = document.createElement('div'); sb.id = 'sabanner'; document.body.insertBefore(sb, document.body.firstChild); }
    sb.style.cssText = 'background:' + (USR.superAdminMode === 'intervention' ? '#b91c1c' : '#d97706') + ';color:#fff;padding:6px 14px;font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:20';
    sb.innerHTML = `<b>Super Admin — ${USR.superAdminMode === 'intervention' ? 'mode INTERVENTION (toutes vos actions sont journalisées)' : 'mode CONSULTATION (lecture seule)'}</b><span>Établissement : ${esc(TEN ? TEN.name : '')}${USR.reason ? ' · motif : ' + esc(USR.reason) : ''}</span><span style="flex:1"></span><button onclick="saLeave()" style="background:#fff;color:#111">Quitter l’espace</button>`;
  } else if (sb) sb.remove();
  const bk = $('#bk'); if (bk) bk.style.display = isTeacher() ? 'none' : '';
}
/* ---------- connexion ---------- */
async function srvInit() {
  try { const j = await api('GET', '/api/ping'); SRV.on = !!(j && j.app === 'um6ss-edt'); } catch (e) { SRV.on = false }
  SRV.checked = true;
  if (!SRV.on) { render(); return }
  await srvMe();
}
async function srvMe() {
  let m; try { m = await api('GET', '/api/me') } catch (e) { SRV.auth = false; render(); return }
  SRV.auth = !!m.auth; SRV.setup = !!m.setupRequired; USR = m.user || null; TEN = m.tenant || TEN; SRV_BLOCKED = m.blocked || '';
  if (!SRV.auth) { USR = null; render(); srvLogin(SRV_BLOCKED); return }
  lanSwitchUser();
  if (USR.mustChange) { render(); pwDlg(true); return }
  applyRoleTabs(); render(); await abLoad(); render();
}
/* Poste partagé : on ne garde jamais en cache les données d'un autre compte. */
/* Clé du compte sur ce poste : établissement + identifiant (deux établissements peuvent avoir un compte « admin »). */
const lanUserKey = () => USR.username + (TEN && !TEN.legacy ? '@' + TEN.slug : '');
function lanSwitchUser() {
  let prev = null; try { prev = localStorage.getItem('unitt-user') } catch (e) { }
  const restricted = !hasP('state.read') || !!USR.superAdmin;
  const me = lanUserKey();
  if (prev === me) return;
  try {
    if (prev === null && !restricted) { localStorage.setItem('unitt-user', me); return }   // première connexion : les données locales éventuelles sont proposées à la fusion
    if (ST.dirty) localStorage.setItem(KEY + '-non-envoye-' + (prev || 'avant-comptes'), localStorage.getItem(KEY) || '');
    localStorage.removeItem(KEY); localStorage.removeItem('unitt-st-rev'); localStorage.removeItem('unitt-st-dirty'); localStorage.removeItem(KEY + '-pre-sync');
    localStorage.setItem('unitt-user', me);
  } catch (e) { }
  ST.rev = 0; ST.dirty = false; load(); AB.list = [];
}
function srvLogin(msg) {
  if (SRV.setup) { modal(`<h3 style="margin-top:0">Aucun compte n’existe encore</h3><p>Sur le PC serveur, créez le premier administrateur avec la commande<br><code>node tools\\create-admin.js</code><br>(voir README-LOCAL-WINDOWS.md), puis rechargez cette page.</p><div class="row"><button class="pri" onclick="location.reload()">Recharger</button></div>`); $('#modal').onclick = null; return }
  let last = '', code = ''; try { last = localStorage.getItem('unitt-last-user') || ''; code = localStorage.getItem('unitt-etab') || '' } catch (e) { }
  const qp = new URLSearchParams(location.search).get('etab'); if (qp) code = qp.trim().toLowerCase();
  if (TEN && !code && !TEN.legacy) code = TEN.slug;
  modal(`<h3 style="margin-top:0">Connexion à UniTimetable</h3><p class="mu">Connectez-vous avec votre compte personnel.</p><label>Code de l’établissement <span class="mu" style="font-weight:normal">(fourni par votre administrateur ; laisser vide pour l’établissement par défaut)</span></label><input id="srv_et" autocomplete="organization" autocapitalize="none" placeholder="ex. fm6sips-dakhla" value="${esc(code)}"><label>Identifiant</label><input id="srv_us" autocomplete="username" autocapitalize="none" value="${esc(last)}"><label>Mot de passe</label><input id="srv_pw" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')srvDoLogin()"><div class="err" id="ferr">${esc(msg || '')}</div><div class="row" style="margin-top:12px"><button class="pri" id="srv_go" onclick="srvDoLogin()">Se connecter</button></div><p class="mu" style="font-size:12px">Mot de passe oublié ou compte verrouillé : contactez l’administrateur de votre établissement.</p>`);
  $('#modal').onclick = null; setTimeout(() => { const e = last ? $('#srv_pw') : $('#srv_us'); e && e.focus() }, 50);
}
async function srvDoLogin() {
  const us = ($('#srv_us').value || '').trim().toLowerCase(), pw = $('#srv_pw').value, et = (($('#srv_et') || {}).value || '').trim().toLowerCase();
  if (!us || !pw) return $('#ferr').textContent = 'Saisissez votre identifiant et votre mot de passe';
  $('#srv_go').disabled = true;
  try {
    await api('POST', '/api/login', { username: us, password: pw, etab: et }); try { localStorage.setItem('unitt-last-user', us); localStorage.setItem('unitt-etab', et) } catch (e) { }
    closeModal(); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal() }; await srvMe(); if (USR) toast('Connecté : ' + USR.displayName);
  } catch (e) { const b = $('#srv_go'); if (b) b.disabled = false; $('#ferr').textContent = e.network ? 'Le serveur ne répond pas. Vérifiez le réseau.' : e.message }
}
function pwDlg(forced) {
  modal(`<h3 style="margin-top:0">${forced ? 'Choisissez votre mot de passe' : 'Changer mon mot de passe'}</h3>${forced ? '<p class="mu">Votre mot de passe a été défini par l’administrateur : choisissez-en un nouveau, connu de vous seul.</p>' : ''}<label>Mot de passe actuel</label><input id="pw_c" type="password" autocomplete="current-password"><label>Nouveau mot de passe (10 caractères minimum)</label><input id="pw_n" type="password" autocomplete="new-password"><label>Confirmer</label><input id="pw_n2" type="password" autocomplete="new-password" onkeydown="if(event.key==='Enter')pwDo(${forced ? 1 : 0})"><div class="err" id="ferr"></div><div class="row" style="margin-top:12px"><button class="pri" onclick="pwDo(${forced ? 1 : 0})">Enregistrer</button>${forced ? '<button onclick="lanLogout(true)">Se déconnecter</button>' : '<button onclick="closeModal()">Annuler</button>'}</div>`);
  if (forced) $('#modal').onclick = null;
}
async function pwDo(forced) {
  const c = $('#pw_c').value, n = $('#pw_n').value; if (n !== $('#pw_n2').value) return $('#ferr').textContent = 'Les deux saisies sont différentes';
  try { await api('POST', '/api/account/password', { current: c, next: n }); closeModal(); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal() }; toast('Mot de passe modifié'); if (forced) await srvMe() } catch (e) { $('#ferr').textContent = e.message }
}
function accDlg() {
  modal(`<h3 style="margin-top:0">Mon compte</h3><p><b>${esc(USR.displayName)}</b> (${esc(USR.username)})<br><span class="mu">${esc(USR.roleLabel)}</span></p><p class="mu" style="font-size:12px">Données centrales : révision ${ST.rev}${ST.dirty ? ' · modifications en attente d’envoi' : ''}</p><div class="row"><button onclick="pwDlg(false)">Changer mon mot de passe</button><button class="dng" onclick="lanLogout()">Se déconnecter</button><button onclick="closeModal()">Fermer</button></div>`);
}
async function saLeave() { try { await api('POST', '/api/logout', {}) } catch (e) { } try { localStorage.removeItem(KEY); localStorage.removeItem('unitt-st-rev'); localStorage.removeItem('unitt-st-dirty'); localStorage.removeItem('unitt-user') } catch (e) { } location.href = '/platform' }
async function lanLogout(force) {
  if (ST.dirty && !force && !confirm('Des modifications ne sont pas encore envoyées au serveur. Si vous vous déconnectez maintenant, elles restent sur ce poste et seront envoyées à votre prochaine connexion (elles seront perdues si un autre compte se connecte ici). Se déconnecter quand même ?')) return;
  try { await api('POST', '/api/logout', {}) } catch (e) { }
  stStop(); const dirty = ST.dirty; SRV.auth = false; USR = null; TABS.splice(0, TABS.length, ...ALL_TABS);
  if (!dirty) { try { localStorage.removeItem(KEY); localStorage.removeItem('unitt-st-rev'); localStorage.removeItem('unitt-st-dirty'); localStorage.removeItem(KEY + '-pre-sync') } catch (e) { } ST.rev = 0; load() }
  AB.list = []; closeModal(); render(); srvLogin();
}
/* ---------- chargement des absences / alertes selon les droits ---------- */
async function abLoad0() {
  if (!(SRV.on && SRV.auth && USR)) { AB.list = S.absences || []; return }
  const g = async (p, f) => { try { return (await api('GET', p)).items } catch (e) { if (e.status === 401) { SRV.auth = false; USR = null; render(); srvLogin('Session expirée : reconnectez-vous.') } return f } };
  AB.list = (hasP('absences.read') || hasP('absences.read.own') || hasP('absences.read.summary')) ? await g('/api/absences', []) : [];
  AB.forms = hasP('forms.manage') ? await g('/api/forms', []) : [];
  AB.alerts = (hasP('alerts.read') || hasP('alerts.read.own')) ? await g('/api/alerts', []) : [];
  AB.notifs = hasP('notifs.read') ? await g('/api/notifications', []) : [];
  AB.policies = hasP('policies.manage') ? await g('/api/policies', {}) : {};
  AB.alertsLoaded = true;
}
function srvSyncLater() { if (!(SRV.on && SRV.auth) || !hasP('sessions.sync')) return; clearTimeout(SYNCT); SYNCT = setTimeout(srvSyncNow, 1500) }
function polView() { return hasP('policies.manage') ? polView0() : '' }
function absDlg(sid) { if (isTeacher()) { const ex = abOf(sid); return absEntry(sid, ex && ex.id) } return absDlg0(sid) }
async function srvPing() {
  if (!SRV.on) return true; let ok = true; try { await api('GET', '/api/ping') } catch (e) { ok = false }
  const c = $('#srvst'); if (c) { c.style.display = ''; c.style.background = ok ? 'var(--ok)' : 'var(--bad)'; c.textContent = ok ? 'Serveur connecté' : 'Serveur injoignable'; c.title = ok ? 'Connecté au serveur central' : 'Le serveur ne répond pas : vos modifications restent sur ce poste et seront envoyées au retour de la connexion' }
  if (!ok) SRV.wasDown = true;
  else if (SRV.wasDown) { SRV.wasDown = false; if (SRV.auth) { if (!ST.on) stStart(); else if (ST.dirty) stPush(); else stPull(); abLoad() } else if (SRV.checked) srvMe() }
  return ok;
}
/* ---------- synchronisation de l'état central ---------- */
const stWritable = () => !!(USR && USR.writable && USR.writable.length);
function stSchedule() {
  if (!ST || !ST.on || ST.skip) return;
  if (!stWritable()) { if (stNorm(S) !== ST.lastNorm && !ST.roWarned) { ST.roWarned = 1; toast('Consultation seule : les modifications ne sont pas enregistrées sur le serveur', true) } ST.roDirty = true; return }
  ST.v++; stDirt(true); clearTimeout(ST.t); ST.t = setTimeout(stPush, ST.ms); stBadge();
}
function stApply(data, rev) {
  try { localStorage.setItem('unitt-v1-pre-sync', localStorage.getItem(KEY) || '') } catch (e) { }
  const raw = JSON.stringify(data); try { localStorage.setItem(KEY, raw) } catch (e) { }
  const gi = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return k === KEY ? raw : gi.call(this, k) };   // charge ces données même si le stockage du navigateur est plein
  try { load() } finally { Storage.prototype.getItem = gi } stRev(rev); stDirt(false); ST.conflict = false; ST.err = ''; ST.roDirty = false; ST.lastNorm = stNorm(S);
  if (syncStatuses()) { ST.skip = true; save(); ST.skip = false } render(); stBadge();
}
async function stPush() {
  if (!ST.on || ST.busy || ST.conflict || !ST.dirty) return; ST.busy = true; const sent = ST.v;
  if (!ST.op) ST.op = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try {
    const j = await api('PUT', '/api/state', { baseRev: ST.rev, data: S, opId: ST.op }); ST.op = null; ST.err = '';
    if (j.merged && j.data) {
      if (ST.v === sent) { stApply(j.data, j.rev); toast('Vos modifications ont été fusionnées avec celles d’un autre poste') }
      else { clearTimeout(ST.t); ST.t = setTimeout(stPush, ST.ms) }   // nouvelle saisie entre-temps : on garde l'ancienne base, le serveur refusionnera
    } else { stRev(j.rev); if (ST.v === sent) { stDirt(false); ST.lastNorm = stNorm(S) } else { clearTimeout(ST.t); ST.t = setTimeout(stPush, ST.ms) } }
  } catch (e) {
    if (e.status === 409) { ST.op = null; ST.busy = false; await stConflict(e.body); return }
    if (e.status === 403) { ST.op = null; ST.busy = false; stForbidden(e); return }
    if (e.status === 401) { stStop(); SRV.auth = false; USR = null; render(); srvLogin('Session expirée : reconnectez-vous. Vos modifications non envoyées sont conservées sur ce poste.') }
    else { ST.err = e.message; clearTimeout(ST.t); ST.t = setTimeout(stPush, ST.retry || 8000) }   // même opId à la nouvelle tentative : pas de doublon
  }
  ST.busy = false; stBadge();
}
async function stPull() {
  if (!ST.on || ST.busy || ST.dirty || ST.conflict || document.querySelector('#modal.show')) return;
  try { const j = await api('GET', '/api/state?since=' + (ST.roDirty ? -1 : ST.rev)); ST.err = ''; if (!j.same && j.data) { const ext = j.rev !== ST.rev; stApply(j.data, j.rev); if (ext) toast('Données mises à jour depuis un autre poste') } }
  catch (e) { if (e.status === 401) { stStop(); SRV.auth = false; USR = null; render(); srvLogin('Session expirée : reconnectez-vous.') } else ST.err = e.message }
  stBadge();
}
function stForbidden(e) {
  ST.conflict = true; stBadge();
  modal(`<h3 style="margin-top:0">Modification refusée par le serveur</h3><p>${esc(e.message)}</p><p class="mu" style="font-size:13px">Votre rôle (${esc(USR ? USR.roleLabel : '')}) ne permet pas d’enregistrer ce type de modification. Rechargez les données du serveur ; vous pouvez d’abord enregistrer votre version dans un fichier.</p><div class="row"><button onclick="exportAll()">⬇ Enregistrer ma version (fichier)</button><button class="pri" onclick="stReloadServer()">Recharger les données du serveur</button></div>`);
  $('#modal').onclick = null;
}
async function stReloadServer() { try { const j = await api('GET', '/api/state'); closeModal(); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal() }; stApply(j.data, j.rev); ST.on = true; toast('Données du serveur rechargées') } catch (e) { toast(e.message, true) } }
async function stConflict(b) {
  if (!b || !b.conflicts) { try { b = await api('GET', '/api/state'); b.conflicts = [{ collection: '*', label: 'toutes les données' }]; b.needFull = true } catch (e) { ST.err = e.message; stBadge(); return } }
  if (b.data && stNorm(b.data) === stNorm(S)) { stApply(b.data, b.rev); return }
  if (b.empty) { ST.conflict = true; stBadge(); modal('<h3 style="margin-top:0">Serveur vide</h3><p>Le serveur ne contient encore aucune donnée. L’administrateur doit d’abord les initialiser (import d’une sauvegarde).</p><div class="row"><button onclick="closeModal()">Fermer</button></div>'); return }
  ST.conflict = true; stBadge(); try { localStorage.setItem(KEY + '-pre-conflict', JSON.stringify({ at: new Date().toISOString(), rev: ST.rev, data: S })) } catch (e) { }
  stDialog(b, true);
}
const COLL_FR = { sessions: 'Séance', subjects: 'Matière', teachers: 'Enseignant', rooms: 'Salle', levels: 'Groupe', programs: 'Filière', students: 'Étudiant', templates: 'Modèle', volumes: 'Volume horaire', cal: 'Calendrier', cfg: 'Configuration', tplCats: 'Catégories de modèles', '*': 'Données' };
function stDialog(j, conflict) {
  ST.pend = j; const L = (j.conflicts || []).slice(0, 30), admin = hasP('state.force');
  const list = L.length ? `<div class="tw" style="max-height:220px;overflow:auto"><table><tr><th>Type</th><th>Élément</th><th>Ce poste</th><th>Autre poste</th></tr>${L.map(c => `<tr><td>${esc(COLL_FR[c.collection] || c.collection)}</td><td>${esc(c.label || c.id)}</td><td>${esc(c.mine || '')}</td><td>${esc(c.theirs || '')}</td></tr>`).join('')}</table></div>${(j.conflicts || []).length > 30 ? '<p class="mu">… et ' + ((j.conflicts || []).length - 30) + ' autre(s)</p>' : ''}` : '';
  modal(`<div style="min-width:min(92vw,560px)"><h3 style="margin-top:0">${conflict ? 'Conflit de modification' : 'Données déjà présentes sur le serveur'}</h3><p>${conflict ? (j.needFull ? 'Les données de ce poste sont trop anciennes pour être fusionnées automatiquement.' : 'Les éléments ci-dessous ont été modifiés en même temps sur un autre poste. Vos autres modifications ont été conservées ; seuls ces éléments demandent votre choix.') : 'Le serveur contient déjà les données de l’établissement (révision ' + j.rev + ') et ce poste possède ses propres données locales.'}</p>${list}
  <div class="row" style="margin-top:8px"><button onclick="exportAll()">⬇ Enregistrer ma version (fichier)</button></div>
  <div class="row" style="margin-top:8px"><button class="pri" onclick="stUseServer()">Utiliser la version du serveur</button>${conflict && !j.needFull && stWritable() ? '<button onclick="stUseMine()">Garder ma version pour ces éléments</button>' : ''}${admin && (!conflict || j.needFull) ? '<button class="dng" onclick="stForceReplace()">Remplacer toutes les données du serveur (administrateur)</button>' : ''}</div>
  <p class="mu" style="font-size:12px">Avec « serveur », votre version reste dans une copie de sécurité sur ce poste. « Garder ma version » crée d’abord une sauvegarde sur le serveur et le choix est inscrit au journal d’audit.</p></div>`);
  $('#modal').onclick = null;
}
function stUseServer() { const j = ST.pend; closeModal(); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal() }; stApply(j.data, j.rev); ST.on = true; if (!ST.poll) ST.poll = setInterval(stPull, ST.pollMs); stBadge(); toast('Version du serveur chargée') }
async function stUseMine() {
  closeModal(); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal() };
  try { const j = await api('PUT', '/api/state', { baseRev: ST.rev, data: S, resolve: 'mine', opId: 'r' + Date.now().toString(36) + uid() }); ST.conflict = false; if (j.data) stApply(j.data, j.rev); else { stRev(j.rev); stDirt(false) } ST.on = true; stBadge(); toast('Votre version a été conservée (sauvegarde serveur créée)') }
  catch (e) { ST.conflict = false; if (e.status === 409) return stConflict(e.body); if (e.status === 403) return stForbidden(e); toast(e.message, true) }
}
async function stForceReplace() {
  if (!confirm('Remplacer TOUTES les données du serveur par celles de ce poste ? Une sauvegarde du serveur est créée avant. Les modifications faites sur les autres postes depuis seront retirées.')) return;
  closeModal(); $('#modal').onclick = e => { if (e.target.id === 'modal') closeModal() };
  try { const j = await api('PUT', '/api/state', { baseRev: ST.rev, data: S, force: true, reason: 'remplacement depuis ce poste', opId: 'f' + Date.now().toString(36) + uid() }); stRev(j.rev); stDirt(false); ST.conflict = false; ST.on = true; if (!ST.poll) ST.poll = setInterval(stPull, ST.pollMs); stBadge(); toast('Données du serveur remplacées (sauvegarde créée)') } catch (e) { toast(e.message, true) }
}
async function stStart() {
  if (ST.on || ST.starting) return; ST.starting = true; let j;
  try { j = await api('GET', '/api/state') } catch (e) { ST.starting = false; ST.err = e.message; stBadge(); if (e.status !== 403 && e.status !== 401) setTimeout(() => { if (SRV.auth && !ST.on) stStart() }, 10000); return }
  const go = () => { ST.on = true; ST.starting = false; clearInterval(ST.poll); ST.poll = setInterval(stPull, ST.pollMs); stBadge() };
  if (!j.data) { if (hasP('state.force')) { go(); stDirt(true); ST.v++; await stPush(); if (!ST.dirty) toast('Données centralisées sur le serveur') } else { ST.starting = false; stConflict({ empty: true, conflicts: [] }) } return }
  if (!stWritable() || (!hasP('state.read') && !ST.dirty)) { stApply(j.data, j.rev); go(); return }   // consultation seule / vue restreinte : toujours la version du serveur
  if (ST.rev === j.rev && !ST.dirty) { ST.lastNorm = stNorm(S); return go() }
  if ((!ST.dirty && ST.rev > 0) || stSeedLike()) { stApply(j.data, j.rev); go(); toast('Données chargées depuis le serveur'); return }
  if (ST.dirty && ST.rev > 0) { go(); stPush(); return }   // modifications locales en attente (coupure réseau) : envoi, le serveur fusionne
  ST.starting = false; stDialog(j, false);
}
/* ---------- sauvegarde / restauration en mode serveur ---------- */
function backupDlg() {
  if (!(SRV.on && SRV.auth && USR)) return backupDlg0();
  modal(`<div style="min-width:min(92vw,520px)"><h3 style="margin-top:0">Sauvegarde et restauration</h3><p class="mu">Les données sont centralisées sur le serveur (révision ${ST.rev}). Le serveur fait lui-même des sauvegardes automatiques.</p><div class="row"><button class="pri" onclick="exportAll()">⬇ Exporter les données visibles (JSON)</button>${hasP('server.manage') ? '<button onclick="closeModal();go(\'admin\')">Sauvegardes du serveur…</button>' : ''}</div>${hasP('state.force') ? `<hr style="border:0;border-top:1px solid var(--bd);margin:14px 0"><b>Restaurer un fichier de sauvegarde (remplace les données du serveur)</b><p class="mu" style="font-size:12px">Réservé à l’administrateur. Une sauvegarde du serveur est faite avant le remplacement ; une copie de l’état actuel est aussi téléchargée.</p><input type="file" accept=".json,application/json" onchange="restorePick(this.files[0]);this.value=''"><div id="bkinfo"></div>` : ''}<div class="row" style="margin-top:12px"><button onclick="closeModal()">Fermer</button></div></div>`);
}
async function restoreDo() {
  if (!(SRV.on && SRV.auth && USR)) return restoreDo0();
  if (!hasP('state.force')) return toast('Réservé à l’administrateur', true);
  const before = JSON.stringify(S); ST.skip = true; try { await restoreDo0() } finally { ST.skip = false }
  if (JSON.stringify(S) === before) return;   // restauration annulée (confirmation non cochée…)
  try { const j = await api('PUT', '/api/state', { baseRev: ST.rev, data: S, force: true, reason: 'restauration d’un fichier de sauvegarde', opId: 'b' + Date.now().toString(36) + uid() }); stRev(j.rev); stDirt(false); ST.lastNorm = stNorm(S); toast('Données restaurées sur le serveur (révision ' + j.rev + ')') }
  catch (e) { toast('Restauration locale faite mais non envoyée au serveur : ' + e.message, true); stDirt(true) }
}
/* ---------- administration : comptes, sauvegardes, journal ---------- */
var ADM = { users: [], roles: null, info: null, backups: [], audit: [], err: '' };
function admView() {
  setTimeout(admLoad, 0);
  return `<div class="card"><div class="row"><h2 style="margin:0;flex:1">Établissement</h2>${hasP('institution.manage') ? '<button onclick="instDlg()">Modifier</button>' : ''}</div><div id="adm_inst" class="mu">Chargement…</div></div>
  <div class="card"><div class="row"><h2 style="margin:0;flex:1">Comptes des employés</h2><button class="pri" onclick="usrDlg()">+ Nouveau compte</button></div><div id="adm_users" class="mu">Chargement…</div></div>
  <div class="card"><div class="row"><h2 style="margin:0;flex:1">Rôles personnalisés</h2><button onclick="roleDlg()">+ Nouveau rôle</button></div><p class="mu" style="font-size:12px;margin:4px 0">En plus des rôles standards (Administrateur, Scolarité, Planning, Enseignant, Direction, Finance). Les droits d’administration ne peuvent pas être donnés à un rôle personnalisé.</p><div id="adm_roles" class="mu">Chargement…</div></div>
  <div class="card"><div class="row"><h2 style="margin:0;flex:1">Serveur et sauvegardes</h2><button onclick="admBackup()">Créer une sauvegarde maintenant</button></div><div id="adm_info" class="mu">Chargement…</div><div id="adm_bk"></div><p class="mu" style="font-size:12px">La restauration d’une sauvegarde du serveur se fait sur le PC serveur, serveur arrêté : <code>windows\\restore.ps1</code> (voir README-LOCAL-WINDOWS.md).</p></div>
  ${hasP('server.manage') && window.electronAPI && window.electronAPI.serverControl ? `<div class="card"><h2 style="margin-top:0">Gestion du serveur local</h2><p class="mu" style="font-size:13px">Commandes exécutées par l’application de bureau sur CE PC (serveur local). Fermer l’application ou se déconnecter n’arrête pas le serveur.</p><p>État : <b id="lsc_st">…</b> <span class="mu" id="lsc_dt"></span></p><div class="row"><button class="pri" id="lsc_start" onclick="lscDo('start')">Démarrer le serveur</button><button id="lsc_restart" onclick="lscDo('restart')">Redémarrer le serveur</button><button class="dng" id="lsc_stop" onclick="lscDo('stop')">Arrêter le serveur</button><button onclick="electronAPI.serverControl.openLogs()">Voir les journaux</button></div><p class="mu" style="font-size:12px" id="lsc_info"></p><div class="err" id="lsc_err"></div></div>` : ''}
  <div class="card"><h2 style="margin-top:0">Journal d’audit (historique d’activité)</h2><div class="row" style="margin-bottom:8px"><select id="aud_user" onchange="admAudit()"><option value="">Tous les utilisateurs</option></select><select id="aud_sec" onchange="admAudit()"><option value="">Toutes les rubriques</option>${['authentification', 'comptes', 'étudiants', 'emploi du temps', 'enseignants', 'groupes', 'filières', 'absences', 'liens de déclaration', 'documents', 'paramètres', 'établissement', 'système', 'consultation Super Admin'].map(x => `<option>${x}</option>`).join('')}</select><input id="aud_ev" placeholder="Action (ex. suppression, connexion)" onchange="admAudit()" style="width:200px"><input id="aud_rec" placeholder="Élément (nom, matricule…)" onchange="admAudit()" style="width:180px"><input id="aud_from" type="date" onchange="admAudit()"><input id="aud_to" type="date" onchange="admAudit()"></div><div id="adm_audit" class="mu">Chargement…</div></div>`;
}
/* ---------- gestion du serveur local (application de bureau ; contrôle réel dans le processus principal) ---------- */
const LSC = { stopped: 'Arrêté', starting: 'Démarrage…', running: 'En marche', error: 'Erreur' };
function lscPaint(s) { const e = $('#lsc_st'); if (!e || !s) return; e.textContent = LSC[s.state] || s.state; e.style.color = { running: 'var(--ok)', error: 'var(--bad)', starting: '#d97706' }[s.state] || ''; $('#lsc_dt').textContent = s.detail || ''; $('#lsc_info').textContent = s.configured ? 'Dossier : ' + s.serverRoot + ' · port ' + s.port + ' · moteur : ' + s.runtime : 'Dossier du serveur non configuré sur ce poste (menu Fichier > Configurer le serveur… > Gestion du serveur local).'; $('#lsc_start').disabled = !s.configured || s.state === 'running' || s.state === 'starting'; $('#lsc_stop').disabled = $('#lsc_restart').disabled = s.state !== 'running' }
async function lscInit() { const C = window.electronAPI && window.electronAPI.serverControl; if (!C || !$('#lsc_st')) return; if (!lscInit.sub) { lscInit.sub = 1; C.onStatus(lscPaint) } const r = await C.status(); if (!r.ok) { $('#lsc_err').textContent = r.error || 'Refusé'; return } lscPaint(r.status) }
async function lscDo(a) { const C = window.electronAPI.serverControl; $('#lsc_err').textContent = ''; const r = await C[a](); if (r.canceled) return; if (!r.ok) $('#lsc_err').textContent = r.error || 'Échec'; else toast(r.already ? 'Le serveur était déjà en marche' : a === 'stop' ? 'Serveur arrêté' : 'Serveur en marche'); const s = await C.status(); if (s.ok) lscPaint(s.status) }
async function admLoad() {
  lscInit();
  try {
    const [u, r, i, b, a, t] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/roles'), api('GET', '/api/server/info'), api('GET', '/api/backups'), api('GET', '/api/audit?limit=300' + admAuditQ()), api('GET', '/api/institution')]);
    ADM.users = u.items; ADM.roles = r; ADM.info = i; ADM.backups = b.items; ADM.audit = a; ADM.inst = t.tenant; admPaint();
  } catch (e) { const x = $('#adm_users'); if (x) x.textContent = 'Erreur : ' + e.message }
}
function admAuditQ() { const v = id => (($('#' + id) || {}).value || '').trim(), q = [['user', 'aud_user'], ['section', 'aud_sec'], ['event', 'aud_ev'], ['record', 'aud_rec'], ['from', 'aud_from'], ['to', 'aud_to']].filter(([, id]) => v(id)).map(([k, id]) => '&' + k + '=' + encodeURIComponent(v(id))).join(''); return q }
async function admAudit() { try { ADM.audit = await api('GET', '/api/audit?limit=300' + admAuditQ()); admPaintAudit() } catch (e) { toast(e.message, true) } }
function instDlg() {
  const t = ADM.inst || {}, c = t.contact || {};
  modal(`<div style="min-width:min(92vw,520px)"><h3 style="margin-top:0">Informations de l’établissement</h3><label>Nom (français)</label><input id="in_n" value="${esc(t.name || '')}"><label>Nom (arabe)</label><input id="in_a" dir="rtl" value="${esc(t.nameAr || '')}"><label>Nom court (affiché dans l’application)</label><input id="in_s" value="${esc(t.shortName || '')}"><div class="row"><div style="flex:1"><label>E-mail</label><input id="in_e" value="${esc(c.email || '')}"></div><div style="flex:1"><label>Téléphone</label><input id="in_p" value="${esc(c.phone || '')}"></div></div><label>Adresse</label><input id="in_ad" value="${esc(c.address || '')}"><div class="row"><div style="flex:1"><label>Ville</label><input id="in_c" value="${esc(c.city || '')}"></div><div style="flex:1"><label>Responsable / contact</label><input id="in_r" value="${esc(c.person || '')}"></div></div><p class="mu" style="font-size:12px">Code de connexion : <b>${esc(t.slug || '')}</b> · statut et abonnement gérés par l’administrateur de la plateforme.</p><div class="err" id="ferr"></div><div class="row" style="margin-top:12px"><button class="pri" onclick="instSave()">Enregistrer</button><button onclick="closeModal()">Annuler</button></div></div>`);
}
async function instSave() { try { const r = await api('PUT', '/api/institution', { name: $('#in_n').value, nameAr: $('#in_a').value, shortName: $('#in_s').value, contact: { email: $('#in_e').value, phone: $('#in_p').value, address: $('#in_ad').value, city: $('#in_c').value, person: $('#in_r').value } }); TEN = Object.assign(TEN || {}, r.tenant); closeModal(); toast('Informations enregistrées'); admLoad(); lanBadge() } catch (e) { $('#ferr').textContent = e.message } }
function roleDlg(key) {
  const R = ADM.roles.roles, r = key ? R[key] : null, G = ADM.roles.grantable, P = ADM.roles.perms, have = new Set(r ? r.perms : []);
  modal(`<div style="min-width:min(92vw,520px)"><h3 style="margin-top:0">${r ? 'Modifier le rôle ' + esc(r.label) : 'Nouveau rôle personnalisé'}</h3>${r ? '' : '<label>Clé technique (ex. secretariat)</label><input id="ro_k" autocapitalize="none" placeholder="secretariat">'}<label>Nom du rôle</label><input id="ro_l" value="${esc(r ? r.label : '')}" placeholder="ex. Secrétariat pédagogique"><label>Autorisations</label>${G.map(p => `<label style="display:flex;gap:6px;align-items:center;font-weight:normal;margin:2px 0"><input type="checkbox" style="width:auto" class="ro_p" value="${p}" ${have.has(p) ? 'checked' : ''}> ${esc(P[p])}</label>`).join('')}<div class="err" id="ferr"></div><div class="row" style="margin-top:12px"><button class="pri" onclick="roleSave('${key || ''}')">Enregistrer</button>${r ? `<button class="dng" onclick="roleDel('${key}')">Supprimer</button>` : ''}<button onclick="closeModal()">Annuler</button></div></div>`);
}
async function roleSave(key) { const k = key || 'c_' + ($('#ro_k').value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'); try { await api('PUT', '/api/roles/custom/' + k, { label: $('#ro_l').value, perms: [...document.querySelectorAll('.ro_p:checked')].map(x => x.value) }); closeModal(); toast('Rôle enregistré'); admLoad() } catch (e) { $('#ferr').textContent = e.message } }
async function roleDel(key) { if (!confirm('Supprimer ce rôle personnalisé ?')) return; try { await api('DELETE', '/api/roles/custom/' + key); closeModal(); toast('Rôle supprimé'); admLoad() } catch (e) { $('#ferr').textContent = e.message } }
const tName = id => { const t = (S.teachers || []).find(x => x.id === id); return t ? t.name : (id ? id + ' (fiche introuvable)' : '') };
function admPaint() {
  const R = ADM.roles.roles, now = Date.now(), e = $('#adm_users'); if (!e) return;
  e.classList.remove('mu');
  e.innerHTML = `<div class="tw"><table><tr><th>Identifiant</th><th>Nom</th><th>Poste</th><th>Rôle</th><th>Enseignant</th><th>État</th><th>Dernière connexion</th><th></th></tr>${ADM.users.map(u => {
    const st = u.disabled ? '<span style="color:var(--bad)">désactivé</span>' : (u.lockedUntil && Date.parse(u.lockedUntil) > now) ? '<span style="color:#d97706">verrouillé</span>' : u.mustChange ? 'mot de passe à changer' : 'actif';
    return `<tr><td>${esc(u.username)}</td><td>${esc(u.displayName)}${u.email ? '<br><span class="mu" style="font-size:11px">' + esc(u.email) + '</span>' : ''}</td><td>${esc(u.jobTitle || '')}</td><td>${esc((R[u.role] || {}).label || u.role)}${u.extraPerms.length ? ' <span class="mu">+' + u.extraPerms.length + '</span>' : ''}</td><td>${esc(tName(u.teacherId))}</td><td>${st}</td><td>${u.lastLoginAt ? esc(u.lastLoginAt.slice(0, 16).replace('T', ' ')) : '—'}</td><td style="white-space:nowrap"><button onclick="usrDlg('${u.id}')">Modifier</button> <button onclick="usrReset('${u.id}')">Mot de passe</button> ${u.lockedUntil && Date.parse(u.lockedUntil) > now ? `<button onclick="usrUnlock('${u.id}')">Déverrouiller</button> ` : ''}${u.id === USR.id ? '' : `<button class="${u.disabled ? '' : 'dng'}" onclick="usrToggle('${u.id}',${!u.disabled})">${u.disabled ? 'Réactiver' : 'Désactiver'}</button>`}</td></tr>`
  }).join('')}</table></div>`;
  const i = ADM.info, ie = $('#adm_info'); ie.classList.remove('mu');
  ie.innerHTML = (i.vendorMissing && i.vendorMissing.length ? `<p style="color:#d97706"><b>⚠ Bibliothèques absentes du serveur :</b> ${esc(i.vendorMissing.join(', '))}. Les imports/exports Excel ou PDF correspondants ne fonctionnent pas. Sur le PC serveur, exécutez une fois <code>windows\\fetch-vendor.ps1</code> (connexion Internet nécessaire uniquement pendant cette commande).</p>` : '') + `<p style="font-size:13px">Version ${esc(i.version)} · Node ${esc(i.node)} · ${i.https ? 'HTTPS ✔' : '<span style="color:#d97706">HTTP (non chiffré)</span>'} · port ${i.port} · révision des données ${i.stateRev}${i.stateBy ? ' (' + esc(i.stateBy) + ', ' + esc((i.stateAt || '').slice(0, 16).replace('T', ' ')) + ')' : ''} · ${i.activeSessions} session(s) ouverte(s)<br><span class="mu">Données : ${esc(i.dataDir)} · Sauvegardes : ${esc(i.backupDir)} (toutes les ${i.backupIntervalHours} h, ${i.backupKeep} conservées) · Journaux : ${esc(i.logDir)}</span></p>`;
  $('#adm_bk').innerHTML = ADM.backups.length ? `<div class="tw" style="max-height:240px;overflow:auto"><table><tr><th>Sauvegarde</th><th>Date</th><th>Motif</th><th>Taille</th></tr>${ADM.backups.slice(0, 50).map(b => `<tr><td>${esc(b.name)}</td><td>${esc((b.createdAt || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(b.reason || '')}</td><td>${b.files ? Math.round(Object.values(b.files).reduce((s, f) => s + f.bytes, 0) / 1024) + ' Ko' : ''}</td></tr>`).join('')}</table></div>` : '<p class="mu">Aucune sauvegarde pour l’instant.</p>';
  const ins = ADM.inst || {}, ie2 = $('#adm_inst'); if (ie2) { ie2.classList.remove('mu'); ie2.innerHTML = `<p style="margin:4px 0"><b>${esc(ins.name || '')}</b>${ins.nameAr ? ' · <span dir="rtl">' + esc(ins.nameAr) + '</span>' : ''}<br><span class="mu" style="font-size:13px">Code de connexion : <b>${esc(ins.slug || '')}</b>${ins.contact && ins.contact.email ? ' · ' + esc(ins.contact.email) : ''}${ins.subscription && ins.subscription.endsAt ? ' · abonnement jusqu’au ' + esc(ins.subscription.endsAt) : ''}</span></p>` }
  const re = $('#adm_roles'), CR = Object.entries(R).filter(([, r]) => r.custom); if (re) { re.classList.remove('mu'); re.innerHTML = CR.length ? `<div class="tw"><table><tr><th>Rôle</th><th>Autorisations</th><th>Comptes</th><th></th></tr>${CR.map(([k, r]) => `<tr><td>${esc(r.label)} <span class="mu" style="font-size:11px">${esc(k)}</span></td><td style="font-size:12px">${r.perms.map(x => esc(ADM.roles.perms[x] || x)).join(' · ') || '—'}</td><td>${ADM.users.filter(u => u.role === k && !u.disabled).length}</td><td><button onclick="roleDlg('${k}')">Modifier</button></td></tr>`).join('')}</table></div>` : '<p class="mu">Aucun rôle personnalisé.</p>' }
  const us = $('#aud_user'); if (us && us.options.length <= 1) us.innerHTML = '<option value="">Tous les utilisateurs</option>' + ADM.users.map(u => `<option value="${esc(u.username)}">${esc(u.displayName)} (${esc(u.username)})</option>`).join('');
  admPaintAudit();
}
function admPaintAudit() {
  const A = ADM.audit, ae = $('#adm_audit'); if (!ae) return; ae.classList.remove('mu');
  const val = v => v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v);
  ae.innerHTML = `<p>${A.valid ? '<span style="color:var(--ok)">Chaîne d’intégrité valide ✔</span>' : '<b style="color:var(--bad)">Chaîne d’intégrité ROMPUE ✖ (le journal a été modifié en dehors du serveur)</b>'} · ${A.total !== undefined ? A.total : A.items.length} entrée(s)${A.total > A.items.length ? ' (300 plus récentes affichées : affinez avec les filtres)' : ''}</p><div class="tw" style="max-height:420px;overflow:auto"><table><tr><th>Date</th><th>Utilisateur</th><th>Rubrique</th><th>Action</th><th>Résultat</th><th>Poste (IP)</th></tr>${A.items.map(x => `<tr><td>${esc((x.at || '').slice(0, 19).replace('T', ' '))}</td><td>${esc(x.user || '')}${x.superAdmin ? ' <span style="color:#b91c1c;font-size:11px">Super Admin</span>' : ''}</td><td class="mu" style="font-size:12px">${esc(x.section || '')}</td><td>${esc(x.event)}${x.compte ? ' : ' + esc(x.compte) : ''}${x.motif ? ' <span class="mu">(motif : ' + esc(x.motif) + ')</span>' : ''}${x.collections ? ' <span class="mu">(' + esc(x.collections) + ')</span>' : ''}${x.avant && x.apres ? `<details><summary class="mu">anciennes / nouvelles valeurs</summary>${Object.keys(Object.assign({}, x.avant, x.apres)).filter(k => JSON.stringify((x.avant || {})[k]) !== JSON.stringify((x.apres || {})[k])).map(k => `<div style="font-size:12px">${esc(k)} : ${esc(val((x.avant || {})[k]))} → ${esc(val((x.apres || {})[k]))}</div>`).join('')}</details>` : ''}${x.modifications && x.modifications.length ? `<details><summary class="mu">${x.nbModifications} modification(s) — anciennes / nouvelles valeurs</summary>${x.modifications.map(c => `<div style="font-size:12px;margin:2px 0"><b>${esc(c.op)}</b> ${esc(COLL_FR[c.collection] || c.collection)} « ${esc(c.label)} »${c.champs ? ' : ' + Object.entries(c.champs).map(([f, v]) => esc(f) + ' : ' + esc(JSON.stringify(v.ancien)) + ' → ' + esc(JSON.stringify(v.nouveau))).join(' ; ') : ''}</div>`).join('')}${x.nbModifications > x.modifications.length ? '<div class="mu">… et ' + (x.nbModifications - x.modifications.length) + ' autre(s)</div>' : ''}</details>` : ''}</td><td style="font-size:12px;color:${x.result === 'succès' || !x.result ? 'inherit' : 'var(--bad)'}">${esc(x.result || '')}</td><td>${esc(x.ip || '')}</td></tr>`).join('')}</table></div>`;
}
function genPw() { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = new Uint32Array(14); crypto.getRandomValues(a); return Array.from(a, x => c[x % c.length]).join('').replace(/(.{4})(.{5})(.{5})/, '$1-$2-$3') }
/* cases d'autorisations : état effectif = rôle + accordées − retirées (les droits administrateur ne se retirent pas) */
function permBoxes(role, u) {
  const R = ADM.roles.roles, G = ADM.roles.grantable, P = ADM.roles.perms, rp = new Set((R[role] || {}).perms || []);
  const sameRole = u && u.role === role, ex = new Set(sameRole ? u.extraPerms || [] : []), de = new Set(sameRole ? u.deniedPerms || [] : []);
  return G.map(p => { const eff = (rp.has(p) && !de.has(p)) || ex.has(p), tag = rp.has(p) ? (de.has(p) ? ' <span style="color:var(--bad)">(retirée)</span>' : ' <span class="mu">(rôle)</span>') : (ex.has(p) ? ' <span style="color:var(--ok)">(accordée)</span>' : '');
    return `<label style="display:flex;gap:6px;align-items:center;font-weight:normal;margin:2px 0"><input type="checkbox" style="width:auto" class="u_xp" value="${p}" ${eff ? 'checked' : ''} ${role === 'admin' ? 'disabled' : ''}> ${esc(P[p])}${tag}</label>` }).join('');
}
function usrDlg(id) {
  const u = id ? ADM.users.find(x => x.id === id) : null, R = ADM.roles.roles, G = ADM.roles.grantable, P = ADM.roles.perms;
  const tOpts = ['<option value="">— aucune —</option>'].concat((S.teachers || []).slice().sort((a, b) => String(a.name).localeCompare(b.name, 'fr')).map(t => `<option value="${esc(t.id)}" ${u && u.teacherId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`)).join('');
  modal(`<div style="min-width:min(92vw,520px)"><h3 style="margin-top:0">${u ? 'Modifier le compte ' + esc(u.username) : 'Nouveau compte'}</h3>
  ${u ? '' : '<label>Identifiant (minuscules, chiffres, . _ -)</label><input id="u_us" autocapitalize="none" placeholder="ex. m.amrani">'}
  <label>Nom complet</label><input id="u_dn" value="${esc(u ? u.displayName : '')}">
  <div class="row"><div style="flex:1"><label>Poste (ex. Responsable scolarité)</label><input id="u_jt" value="${esc(u ? u.jobTitle || '' : '')}"></div><div style="flex:1"><label>E-mail</label><input id="u_em" type="email" value="${esc(u ? u.email || '' : '')}"></div></div>
  <label>Rôle</label><select id="u_ro" onchange="$('#u_tw').style.display=this.value==='teacher'?'':'none';$('#u_perms').innerHTML=permBoxes(this.value,null)">${Object.entries(R).map(([k, r]) => `<option value="${k}" ${u && u.role === k ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
  <div id="u_tw" style="${u && u.role === 'teacher' ? '' : 'display:none'}"><label>Fiche enseignant reliée (obligatoire pour un enseignant)</label><select id="u_ti">${tOpts}</select></div>
  ${u ? '' : `<label>Mot de passe temporaire (à communiquer en main propre ; changement obligatoire à la 1<sup>re</sup> connexion)</label><div class="row"><input id="u_pw" style="flex:1" value="${genPw()}"><button onclick="$('#u_pw').value=genPw()">Générer</button></div>`}
  <details style="margin-top:8px" open><summary>Autorisations (cochées = accordées). Décocher retire une autorisation du rôle ; cocher en accorde une en plus.</summary><div id="u_perms">${permBoxes(u ? u.role : Object.keys(R)[0], u)}</div></details>
  <div class="err" id="ferr"></div><div class="row" style="margin-top:12px"><button class="pri" onclick="usrSave('${id || ''}')">Enregistrer</button><button onclick="closeModal()">Annuler</button></div></div>`);
}
async function usrSave(id) {
  const role = $('#u_ro').value, rp = new Set(ADM.roles.roles[role].perms), on = new Set([...document.querySelectorAll('.u_xp:checked')].map(x => x.value));
  const b = { displayName: $('#u_dn').value.trim(), jobTitle: $('#u_jt').value.trim(), email: $('#u_em').value.trim(), role, teacherId: role === 'teacher' ? $('#u_ti').value : '', extraPerms: [...on].filter(p => !rp.has(p)), deniedPerms: role === 'admin' ? [] : ADM.roles.grantable.filter(p => rp.has(p) && !on.has(p)) };
  try {
    if (id) await api('PUT', '/api/users/' + id, b);
    else { b.username = $('#u_us').value.trim().toLowerCase(); b.password = $('#u_pw').value; if (!b.displayName) b.displayName = b.username; await api('POST', '/api/users', b) }
    closeModal(); toast(id ? 'Compte modifié' : 'Compte créé : communiquez le mot de passe temporaire à son titulaire'); admLoad();
  } catch (e) { $('#ferr').textContent = e.message }
}
function usrReset(id) {
  const u = ADM.users.find(x => x.id === id);
  modal(`<h3 style="margin-top:0">Réinitialiser le mot de passe de ${esc(u.username)}</h3><p class="mu">Ses sessions ouvertes seront fermées et il devra choisir un nouveau mot de passe à la prochaine connexion.</p><label>Mot de passe temporaire</label><div class="row"><input id="u_pw" style="flex:1" value="${genPw()}"><button onclick="$('#u_pw').value=genPw()">Générer</button></div><div class="err" id="ferr"></div><div class="row" style="margin-top:12px"><button class="pri" onclick="usrResetDo('${id}')">Réinitialiser</button><button onclick="closeModal()">Annuler</button></div>`);
}
async function usrResetDo(id) { try { await api('POST', '/api/users/' + id + '/reset-password', { password: $('#u_pw').value }); closeModal(); toast('Mot de passe réinitialisé'); admLoad() } catch (e) { $('#ferr').textContent = e.message } }
async function usrToggle(id, dis) { const u = ADM.users.find(x => x.id === id); if (dis && !confirm('Désactiver le compte ' + u.username + ' ? Ses sessions seront fermées immédiatement.')) return; try { await api('PUT', '/api/users/' + id, { disabled: dis }); toast(dis ? 'Compte désactivé' : 'Compte réactivé'); admLoad() } catch (e) { toast(e.message, true) } }
async function usrUnlock(id) { try { await api('POST', '/api/users/' + id + '/unlock', {}); toast('Compte déverrouillé'); admLoad() } catch (e) { toast(e.message, true) } }
async function admBackup() { try { const r = await api('POST', '/api/backups', {}); toast('Sauvegarde créée : ' + r.backup); admLoad() } catch (e) { toast(e.message, true) } }
/* ---------- appartenance aux groupes à la date de la séance (historique géré par le serveur) ---------- */
function grpAt(x, date) {
  const h = Array.isArray(x.groupHistory) && x.groupHistory.length ? x.groupHistory : null;
  if (!h || !date) return x;
  let c = null; for (const e of h) if (!e.from || e.from <= date) c = e;
  return c || h[0];
}
function studentsOf(s) {
  const p = sprog(s), y = syear(s), g = sgrp(s), a = s.date ? acy(s.date) : '';
  return S.students.filter(x => { const t = grpAt(x, s.date); return (by('programs', t.programId) || {}).name === p && p && String(t.year) === String(y) && y && (!g || t.group === g) && !SSTAT_OUT.test(x.status || '') && (!t.ay || !a || t.ay === a) }).sort((a, b) => stuName(a).localeCompare(stuName(b), 'fr'));
}
/* ===== fin du bloc LAN ===== */

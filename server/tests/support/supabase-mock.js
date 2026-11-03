'use strict';
/* Simulateur minimal de l'API REST de Supabase (PostgREST) pour les tests, adossé à un VRAI PostgreSQL
   (fonctions et tables de supabase/schema.sql). Usage : node tests/support/supabase-mock.js <port> <clé> <psql-args…>
   Seuls les appels utilisés par lib/supabase.js sont pris en charge. */
const http = require('http'), { spawn } = require('child_process');
const [port, key, ...psqlArgs] = process.argv.slice(2);
function sql(q) {
  return new Promise(res => {
    const p = spawn('psql', [...psqlArgs, '-v', 'ON_ERROR_STOP=1', '-qAt'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '', e = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    p.on('close', code => res({ code, out: o.trim(), err: e.trim() }));
    p.stdin.end(q);
  });
}
const lit = j => { const t = JSON.stringify(j === undefined ? null : j); if (t.includes('$UNITTJ$')) throw new Error('valeur interdite'); return '$UNITTJ$' + t + '$UNITTJ$::json'; };
http.createServer(async (req, res) => {
  const send = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
  if (req.headers.apikey !== key || req.headers.authorization !== 'Bearer ' + key) return send(401, { message: 'Invalid API key' });
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  let body = ''; for await (const c of req) body += c;
  let q;
  try {
    if (req.method === 'GET' && p === '/rest/v1/unitt_docs') q = "select coalesce(json_agg(json_build_object('id',id,'data',data,'version',version)),'[]') from unitt_docs where id in ('store','state')";
    else if (req.method === 'GET' && p === '/rest/v1/unitt_history') q = "select coalesce(json_agg(json_build_object('data',data)),'[]') from unitt_history where rev = " + parseInt(u.searchParams.get('rev').replace('eq.', ''), 10);
    else if (req.method === 'GET' && p === '/rest/v1/unitt_backups') q = "select coalesce(json_agg(x),'[]') from (select id, created_at, reason, bytes from unitt_backups order by id desc limit 50) x";
    else if (req.method === 'POST' && p === '/rest/v1/rpc/unitt_save') {
      const b = JSON.parse(body || '{}'), n = v => v === null || v === undefined ? 'null' : String(parseInt(v, 10));
      q = `select unitt_save((case when ${lit(b.p_store)}::text = 'null' then null else ${lit(b.p_store)} end), ${n(b.p_store_version)}, (case when ${lit(b.p_state)}::text = 'null' then null else ${lit(b.p_state)} end), ${n(b.p_state_version)}, ${n(b.p_hist_rev)}, (case when ${lit(b.p_hist_data)}::text = 'null' then null else ${lit(b.p_hist_data)} end), ${n(b.p_hist_keep)})`;
    } else if (req.method === 'POST' && p === '/rest/v1/rpc/unitt_backup') { const b = JSON.parse(body || '{}'); q = `select unitt_backup(${lit(b.p_reason)}->>0, ${parseInt(b.p_keep, 10) || 30})`.replace(`${lit(b.p_reason)}->>0`, `(${lit([b.p_reason])}->>0)`); }
    else return send(404, { message: 'non simulé : ' + req.method + ' ' + p });
  } catch (e) { return send(400, { message: e.message }); }
  const r = await sql(q);
  if (r.code !== 0) { const m = /ERROR:\s+(.*)/.exec(r.err); return send(400, { code: 'P0001', message: m ? m[1] : r.err }); }
  send(200, r.out || 'null');
}).listen(+port, '127.0.0.1', () => console.log('mock supabase prêt ' + port));

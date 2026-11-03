/* Lance toutes les suites de tests : node tests/run-all.js  (ou npm test) */
const cp = require('child_process'), path = require('path');
const suites = ['rules.test.js', 'lan.test.js', 'phase1.test.js', 'cloud.test.js', 'e2e.ui.test.js'];
let bad = 0;
for (const s of suites) {
  console.log('\n===== ' + s + ' =====');
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { bad++; console.log('>>> ' + s + ' : ÉCHEC (code ' + r.status + ')'); }
}
console.log('\n' + (bad ? bad + ' suite(s) en échec' : 'Toutes les suites ont réussi'));
process.exit(bad ? 1 : 0);

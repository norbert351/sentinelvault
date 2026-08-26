// Test harness for the Telegraph CVE_LOOKUP scoring module.
// Mirrors the node's calling convention: writes the three strings into the
// module's memory via alloc(), then calls rank_answer(q, gt, ma) -> f32.
import { readFileSync } from 'node:fs';

const bytes = readFileSync('/home/ubuntu/sentinelvault/scoring-module/target/wasm32-unknown-unknown/release/cve_scoring_module.wasm');
const module = new WebAssembly.Module(bytes);

const imports = WebAssembly.Module.imports(module);
console.log('imports (must be 0):', imports.length);
const instance = await WebAssembly.instantiate(module, {});
const { alloc, rank_answer, memory } = instance.exports;

const enc = new TextEncoder();
function run(question, groundTruth, minerAnswer) {
  const put = (s) => {
    const b = enc.encode(s);
    const p = alloc(b.length);
    new Uint8Array(memory.buffer, p, b.length).set(b);
    return { p, len: b.length };
  };
  const q = put(question);
  const g = put(groundTruth);
  const m = put(minerAnswer);
  const score = rank_answer(q.p, q.len, g.p, g.len, m.p, m.len);
  return score;
}

const GT =
  'CVE-2021-44228 CRITICAL 10.0 Apache Log4j2 2.0-beta9 through 2.15.0 JNDI features do not protect against attacker controlled LDAP and other JNDI related endpoints leading to remote code execution';

const Q = 'Look up CVE-2021-44228';

const cases = [
  ['PERFECT (self-match)', Q, GT, GT],
  [
    'GOOD (reworded, same id+sev+cvss)',
    Q,
    GT,
    'CVE-2021-44228 severity CRITICAL cvss 10.0 attackers controlling log messages can reach JNDI endpoints and execute remote code',
  ],
  [
    'WRONG CVE',
    Q,
    GT,
    'CVE-2022-22963 HIGH 7.5 Spring Cloud Function allows routing based expression injection leading to RCE',
  ],
  ['EMPTY', Q, GT, ''],
  ['UNRELATED', Q, GT, 'The weather in Paris is sunny today.'],
  [
    'WRONG SEV same CVE',
    Q,
    GT,
    'CVE-2021-44228 LOW 3.1 the apache log4j jndi issue has minimal impact',
  ],
];

let pass = 0;
for (const [name, q, g, m] of cases) {
  let s;
  try {
    s = run(q, g, m);
  } catch (e) {
    console.log(`FAIL crashed: ${name} -> ${e.message}`);
    continue;
  }
  const s4 = Math.round(s * 10000) / 10000;
  const ok =
    (name.startsWith('EMPTY') && s === 0) ||
    (name.startsWith('PERFECT') && s >= 0.9) ||
    (name.startsWith('GOOD') && s >= 0.75) ||
    (name.startsWith('WRONG CVE') && s <= 0.35) ||
    (name.startsWith('WRONG SEV') && s < 0.6) ||
    (name.startsWith('UNRELATED') && s <= 0.25);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} score=${s4}`);
}
console.log(`\n${pass}/${cases.length} checks passed`);
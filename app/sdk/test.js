// B2B SDK smoke test — hits a running SentinelVault API.
const { SentinelVault } = await import('./index.js');
const baseUrl = process.env.SV_BASE || 'http://localhost:8090';
const key = process.env.SV_KEY || '';
const sv = new SentinelVault({ baseUrl, apiKey: key });

const health = await sv.health();
console.log('health:', health);

const v = await sv.screen('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'token');
console.log('screen verdict:', v.verdict, '| risk', v.riskScore, '| proof mode', v.proof && v.proof.mode);
console.log('SDK OK');
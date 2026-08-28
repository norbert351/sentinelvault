// SentinelVault paywall e2e — real on-chain payment through the gate.
// Buyer = the app's own funded wallet. It transfers USDC to payTo (itself),
// signs the EIP-712 Payment proof, and replays /screen — exactly what a real
// requester's wallet modal does. Proves the full 402->pay->sign->replay loop.
import { JsonRpcProvider, Contract, Wallet } from 'ethers';

const PK = process.env.SENTINEL_PK;
const API = process.env.SV_API || 'http://localhost:8098';
const RPC = process.env.SV_RPC || 'https://base-sepolia.publicnode.com';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(PK, provider);

const DOMAIN = (c) => ({ name: 'x402', version: '2', chainId: Number(c.chainId) });
const TYPES = { Payment: [
  { name: 'scheme', type: 'string' }, { name: 'network', type: 'string' }, { name: 'chainId', type: 'uint256' },
  { name: 'asset', type: 'address' }, { name: 'amount', type: 'string' }, { name: 'payTo', type: 'address' },
  { name: 'maxTimeoutSeconds', type: 'uint256' }, { name: 'description', type: 'string' }, { name: 'extra', type: 'string' },
] };
const msgOf = (a) => ({
  scheme: a.scheme, network: `eip155:${a.chainId}`, chainId: BigInt(a.chainId),
  asset: a.asset, amount: String(a.amount), payTo: a.payTo,
  maxTimeoutSeconds: BigInt(a.maxTimeoutSeconds), description: a.description || '',
  extra: typeof a.extra === 'string' ? a.extra : JSON.stringify(a.extra || {}),
});

async function main() {
  // 1. probe /screen -> expect 402
  const probe = await fetch(API + '/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '0x28C6c06298d514Db089934071355E5743bf21d60', kind: 'token' }) });
  console.log('probe status:', probe.status, '(expect 402)');
  if (probe.status !== 402) { console.log('FAIL: expected 402'); process.exit(1); }

  // 2. get accepted entry from /screen/quote
  const q = await (await fetch(API + '/screen/quote')).json();
  const accepted = q.challenge.accepts[0];
  console.log('price:', q.priceUsdc, 'USDC | payTo:', accepted.payTo);

  // 3. payer address (buyer wallet)
  const payer = (await wallet.getAddress()).toLowerCase();
  const usdc = new Contract(USDC, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], wallet);
  const bal = await usdc.balanceOf(payer);
  console.log('buyer USDC balance:', Number(bal) / 1e6);
  if (bal < BigInt(accepted.amount)) { console.log('FAIL: buyer lacks USDC'); process.exit(1); }

  // 4. pay on-chain: transfer USDC to payTo
  console.log('transferring', Number(accepted.amount) / 1e6, 'USDC to payTo...');
  const tx = await usdc.transfer(accepted.payTo, BigInt(accepted.amount));
  await tx.wait();
  console.log('paid tx:', tx.hash);

  // 5. sign EIP-712 proof
  const signature = await wallet.signTypedData(DOMAIN(accepted), TYPES, msgOf(accepted));
  const header = btoa(JSON.stringify({ accepted, signature, payer }));

  // 6. replay /screen with PAYMENT-SIGNATURE
  const res = await fetch(API + '/screen', { method: 'POST', headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': header }, body: JSON.stringify({ target: '0x28C6c06298d514Db089934071355E5743bf21d60', kind: 'token' }) });
  const data = await res.json();
  console.log('replay status:', res.status, '(expect 200)');
  if (res.status === 200) {
    console.log('VERDICT:', data.verdict, '| risk', data.riskScore, '| proof', data.proof && data.proof.mode);
    console.log('E2E PASS ✅ payment accepted -> verdict returned');
  } else {
    console.log('E2E FAIL:', data);
    process.exit(1);
  }
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
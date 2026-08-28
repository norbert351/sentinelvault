// SentinelVault payment gate (seller-side x402) — Option A: requesters pay.
// POST /screen is a PAID endpoint. First contact returns HTTP 402 with a
// PAYMENT-REQUIRED challenge (exact USDC, payTo = app wallet). The requester's
// wallet transfers USDC on-chain, signs an EIP-712 Payment proof, and replays
// with PAYMENT-SIGNATURE. We verify amount/chainId/payTo + on-chain settlement
// + replay protection, then run the upstream miners (funded from the requester).
//
// Modeled on the verified VeriForge seller-side gate (x402-asp-builder skill).
import { createPublicClient, http, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const CHAIN_ID = 84532;
export const USDC = process.env.SENTINEL_USDC || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC = process.env.SENTINEL_RPC || 'https://base-sepolia.publicnode.com';
// receive into the app wallet; override if you want a separate payTo.
export const PAY_TO = (process.env.SENTINEL_PAY_TO ||
  (process.env.SENTINEL_PK ? privateKeyToAccount(process.env.SENTINEL_PK).address : '')).toLowerCase();
export const PRICE_USDC = Number(process.env.SENTINEL_PRICE_USDC || 0.10); // $ per screen

const USDC_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { type: 'address', name: 'from', indexed: true },
      { type: 'address', name: 'to', indexed: true },
      { type: 'uint256', name: 'value', indexed: false },
    ],
  },
];

// EIP-712 domain + types MUST match the client wallet modal exactly.
export const EIP712_DOMAIN = { name: 'x402', version: '2', chainId: CHAIN_ID };
export const EIP712_TYPES = {
  Payment: [
    { name: 'scheme', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'string' },
    { name: 'payTo', type: 'address' },
    { name: 'maxTimeoutSeconds', type: 'uint256' },
    { name: 'description', type: 'string' },
    { name: 'extra', type: 'string' },
  ],
};

let _public = null;
function publicClient() {
  if (_public) return _public;
  _public = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  return _public;
}

export function buildChallenge(resource) {
  const amount = String(Math.round(PRICE_USDC * 1e6)); // atomic (micro USDC)
  const payload = {
    x402Version: 2,
    error: 'Payment required',
    resource,
    accepts: [{
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      chainId: CHAIN_ID,
      asset: USDC,
      amount,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      description: `SentinelVault: ${resource}`,
      extra: { name: 'USDC', version: '2' },
    }],
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// Normalize an accepted entry into the exact EIP-712 message shape.
export function toPaymentMessage(accepted) {
  return {
    scheme: 'exact',
    network: `eip155:${CHAIN_ID}`,
    chainId: BigInt(accepted.chainId),
    asset: accepted.asset,
    amount: String(accepted.amount),
    payTo: accepted.payTo,
    maxTimeoutSeconds: BigInt(accepted.maxTimeoutSeconds),
    description: accepted.description || '',
    extra: typeof accepted.extra === 'string' ? accepted.extra : JSON.stringify(accepted.extra || {}),
  };
}

// Consumed-payment ring for replay protection (one transfer = one request).
const MAX_CONSUMED = 500;
const consumedSet = new Set();
const consumedQueue = [];
function markConsumed(txHash) {
  if (consumedSet.has(txHash)) return false;
  consumedSet.add(txHash);
  consumedQueue.push(txHash);
  if (consumedQueue.length > MAX_CONSUMED) {
    const oldest = consumedQueue.shift();
    if (oldest) consumedSet.delete(oldest);
  }
  return true;
}

// Verify a PAYMENT-SIGNATURE header against on-chain settlement. Throws with
// {code} on failure; returns { payer, txHash } on success.
export async function verifyPayment(signatureHeader) {
  if (!signatureHeader) throw { code: 'payment_required' };
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(signatureHeader, 'base64').toString('utf8'));
  } catch {
    throw { code: 'bad_signature', detail: 'PAYMENT-SIGNATURE not base64 JSON' };
  }
  const { accepted, signature, payer } = decoded;
  if (!accepted || !signature || !payer) throw { code: 'bad_signature', detail: 'missing accepted/signature/payer' };

  // 1. cheap field checks
  if (String(accepted.amount) !== String(Math.round(PRICE_USDC * 1e6)))
    throw { code: 'amount_mismatch', detail: `expected ${Math.round(PRICE_USDC * 1e6)}` };
  if (String(accepted.chainId) !== String(CHAIN_ID)) throw { code: 'chain_mismatch' };
  if (String(accepted.payTo).toLowerCase() !== PAY_TO) throw { code: 'payto_mismatch' };

  // 2. signature recovers to the payer — viem verifyTypedData returns boolean
  const ok = await verifyTypedData({
    address: String(payer).toLowerCase(),
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: 'Payment',
    message: toPaymentMessage(accepted),
    signature,
  });
  if (!ok) throw { code: 'signer_mismatch', detail: 'signature does not recover to payer' };

  // 3. on-chain settlement — newest Transfer(payer -> PAY_TO, value) wins
  const amount = BigInt(accepted.amount);
  const latest = await publicClient().getBlockNumber();
  const events = await publicClient().getLogs({
    address: USDC,
    event: USDC_ABI[0],
    args: { from: payer, to: PAY_TO },
    fromBlock: latest - 100n,
    toBlock: latest,
  });
  const match = [...events].reverse().find((e) => e.args.value === amount);
  if (!match) throw { code: 'payment_not_settled' };

  // 4. replay protection
  if (!markConsumed(match.transactionHash)) throw { code: 'payment_already_used' };

  return { payer: String(payer).toLowerCase(), txHash: match.transactionHash };
}

// 402 response helper
export function send402(res, challenge, opts = {}) {
  res.writeHead(402, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE',
    'PAYMENT-REQUIRED': challenge,
    'WWW-Authenticate': 'Payment x402Version="2"',
  });
  res.end(JSON.stringify({
    error: 'payment required',
    reason: 'Pay to verify this target (exact USDC on Base Sepolia)',
    ...(opts.code ? { code: opts.code } : {}),
    ...(opts.detail ? { detail: opts.detail } : {}),
  }));
}
// SentinelVault LIVE signal source — consumes real Telegraph miners via x402.
// Every call is a paid engine ask (/engine/v1/ask) settled on-chain in USDC via
// EIP-3009. The payment-response header carries the on-chain transaction hash,
// giving each signal real provenance (no mocks — Track 3 compliant).
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const ENGINE = process.env.TELEGRAPH_ENGINE || 'https://devnode.telegraphprotocol.com/engine/v1/ask';

// Per-intent query template (crafted to elicit the field the verdict engine needs)
const INTENT_QUERIES = {
  URL_SCAN: (t) => `Scan and judge this URL safe or unsafe, give a risk from 0 (safe) to 1 (unsafe): ${t}`,
  FRAUD_DETECTION: (t) => `Evaluate likelihood ${t} is fraudulent or a honeypot. Return probability 0 to 1 and a % risk.`,
  CVE_LOOKUP: (t) => `Look up this CVE identifier and report its severity (LOW/MEDIUM/HIGH/CRITICAL) and CVSS score: ${t}`,
  ONCHAIN_TX_LOOKUP: (t) => `Is on-chain transaction ${t} successful (status success/ok/confirmed) or failed/pending?`,
  TOKEN_HOLDER_COUNT: (t) => `For token ${t}, report total holder count and what percent the largest single holder owns (top-1 concentration).`,
  TVL_LOOKUP: (t) => `What is the total value locked (TVL) in USD for protocol/token ${t}?`,
  SENTIMENT_ANALYSIS: (t) => `What is the general sentiment (positive, negative, or neutral) toward token/contract ${t}?`,
};

function parseAnswer(raw) {
  // engine result may be deep-free-text or structured JSON; get the most useful slice
  if (raw && typeof raw === 'object') {
    // some miners return {answer: ...}, others put fields at top of result
    const ans = raw.answer ?? raw;
    if (typeof ans === 'object') return ans;
    return { _text: String(ans) };
  }
  return { _text: String(raw ?? '') };
}

const LOW = /low/i, MED = /medium/i, HIGH = /high/i, CRIT = /critic/i;
const SEVERITY_OF = (t) => (CRIT.test(t) ? 'CRITICAL' : HIGH.test(t) ? 'HIGH' : MED.test(t) ? 'MEDIUM' : LOW.test(t) ? 'LOW' : null);

function extractRiskText(text) {
  // look for a 0..1 probability / percent / score number near risk-ish keywords
  const m = text.match(/(?:probability|likelihood|risk|score)\D{0,8}(\d{1,3}(?:\.\d+)?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (n > 100) return null;
  return n > 1 ? n / 100 : n;
}

// Map a real miner answer into { risk-bearing field(s) } the verdict engine reads.
function toEvidence(intent, doc) {
  const t = JSON.stringify(doc).toLowerCase();
  const text = doc._text ? String(doc._text) : t;
  switch (intent) {
    case 'URL_SCAN':
      if (/unsafe|malicious|phish|honeypot|dangerous|block/i.test(text)) return { score: 0.9 };
      if (/safe|clean|benign|legitimate/i.test(text)) return { score: extractRiskText(text) ?? 0.05 };
      return { score: extractRiskText(text) };
    case 'FRAUD_DETECTION': {
      const p = extractRiskText(text);
      if (p !== null && p !== undefined) return { probability: p };
      if (/high (risk|likelihood|probability)|likely fraudulent|confirmed scam|honeypot/i.test(text)) return { probability: 0.85 };
      if (/low risk|not (fraudulent|scam)|legitimate|safe/i.test(text)) return { probability: 0.1 };
      return {};
    }
    case 'CVE_LOOKUP': {
      const sev = doc.severity || SEVERITY_OF(text);
      if (sev) return { severity: sev };
      const cvss = parseFloat(doc.cvss_score ?? doc.cvss ?? NaN);
      if (Number.isFinite(cvss)) return { severity: cvss >= 9 ? 'CRITICAL' : cvss >= 7 ? 'HIGH' : cvss >= 4 ? 'MEDIUM' : 'LOW' };
      return {};
    }
    case 'ONCHAIN_TX_LOOKUP': {
      const s = doc.status || text;
      if (/success|ok|confirmed|mined/i.test(String(s))) return { status: 'success' };
      if (/fail|reverted|pending|dropped/i.test(String(s))) return { status: 'failed' };
      return {};
    }
    case 'TOKEN_HOLDER_COUNT': {
      const m = text.match(/(\d{1,3}(?:\.\d+)?)\s*%|\btop[- ]?\d?\D{0,10}(\d{1,3}(?:\.\d+)?)\s*%/i);
      if (m) return { top1Percent: parseFloat(m[1] || m[2]) };
      return {};
    }
    case 'TVL_LOOKUP': {
      const m = text.match(/\$\s?([\d.,]+)\s*(m|mn|million|k|thousand)?/i);
      if (m) {
        let n = parseFloat(m[1].replace(/,/g, ''));
        const suf = (m[2] || '').toLowerCase();
        if (suf.startsWith('m')) n *= 1e6;
        else if (suf.startsWith('k')) n *= 1e3;
        return { tvlUsd: n };
      }
      if (/no tvl|not.*tracked|does not exist|no.*value locked/i.test(text)) return { tvlUsd: 0 };
      return {};
    }
    case 'SENTIMENT_ANALYSIS': {
      const s = doc.sentiment || doc.label || text;
      if (/negative|bearish|scam|concern/i.test(String(s))) return { sentiment: 'negative' };
      if (/positive|bullish|confident/i.test(String(s))) return { sentiment: 'positive' };
      if (/neutral|mixed/i.test(String(s))) return { sentiment: 'neutral' };
      return {};
    }
    default:
      return {};
  }
}

let _payFetch = null;
function payFetch() {
  if (_payFetch) return _payFetch;
  const pk = process.env.SENTINEL_PK;
  if (!pk) throw new Error('LIVE source requires SENTINEL_PK (EVM key). Set it or keep SIGNAL_SOURCE=simulated.');
  const account = privateKeyToAccount(pk);
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(account));
  _payFetch = wrapFetchWithPayment(fetch, client);
  return _payFetch;
}

export async function askIntent(intent, target) {
  const makeQuery = INTENT_QUERIES[intent];
  if (!makeQuery) return { intent, confidence: 0, data: {}, txHash: null };
  try {
    const res = await payFetch()(ENGINE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: makeQuery(target), intent }),
    });
    if (!res.ok) return { intent, confidence: 0, data: {}, reason: `HTTP ${res.status}`, txHash: null };
    const body = await res.json();
    const result = body.result ?? {};
    const doc = parseAnswer(result);
    const evidence = toEvidence(intent, doc);
    let txHash = null;
    const pr = res.headers.get('payment-response');
    if (pr) {
      try {
        const b64 = pr.length % 4 ? pr + '='.repeat(4 - (pr.length % 4)) : pr;
        const dec = JSON.parse(Buffer.from(b64, 'base64').toString());
        txHash = dec.transaction || null;
      } catch {}
    }
    const hasSignal = Object.keys(evidence).length > 0;
    return { intent, confidence: hasSignal ? 0.85 : 0.3, data: evidence, txHash };
  } catch (e) {
    return { intent, confidence: 0, data: {}, txHash: null };
  }
}

export async function liveSignals(target) {
  const asks = Object.keys(INTENT_QUERIES).map(async (intent) => askIntent(intent, target));
  return Promise.all(asks);
}

// Attach a per-intent re-ask (used by the confidence-threshold re-route).
liveSignals.rerouteOne = async (intent, target) => askIntent(intent, target);
liveSignals.setIntent = true; // marker: this source supports per-intent re-ask

export function createSignalSource(mode) {
  if (mode === 'live') return liveSignals;
  return null; // telegraph.js selects simulated fallback
}
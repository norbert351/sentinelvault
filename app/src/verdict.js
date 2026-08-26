// SentinelVault verdict engine (Track 3).
// Fuses verified multi-intent evidence from Telegraph miners into a single
// weighted risk score and a decision. Pure logic, fully deterministic, no I/O.
//
// Convention: each raw signal is normalized to a 0..1 risk (1 = worst). Missing
// signals are not penalized, but low coverage is surfaced as lower confidence so
// the verdict never overstates certainty when little verified evidence exists.

const SEVERITY_RISK = { CRITICAL: 1.0, HIGH: 0.8, MEDIUM: 0.5, LOW: 0.25 };

// Decision bands. Defaults, overridable in config.
export const THRESHOLDS = { approve: 45, block: 70 };

// Relative weight of each intent in the vetting story. Weights only apply over
// signals that are actually present (present-weight normalization).
export const SIGNAL_WEIGHTS = {
  url_scan: 0.25,
  fraud: 0.25,
  cve: 0.18,
  onchain_tx: 0.12,
  holder_concentration: 0.08,
  tvl: 0.06,
  sentiment: 0.06,
};

// Normalize a raw signal to a 0..1 risk given its intent + the miner's fields.
export function normalizeRisk(intent, doc = {}) {
  switch (intent) {
    case 'URL_SCAN':
      return clamp01(doc.risk ?? doc.score ?? 0);
    case 'FRAUD_DETECTION':
      return clamp01(doc.risk ?? doc.score ?? doc.probability ?? 0);
    case 'CVE_LOOKUP': {
      const sev = (doc.severity || '').toUpperCase();
      return SEVERITY_RISK[sev] ?? 0;
    }
    case 'ONCHAIN_TX_LOOKUP': {
      // tx hashes whose status is NOT success are a signal of trouble
      return /success|ok|confirmed/i.test(String(doc.status || '')) ? 0 : 0.7;
    }
    case 'TOKEN_HOLDER_COUNT': {
      // high concentration in a single holder = single point of failure
      const top1 = Number(doc.top1Percent ?? doc.concentration ?? NaN);
      if (!Number.isFinite(top1)) return 0;
      return clamp01(Math.max(0, (top1 - 30) / 60)); // >90% -> 1.0
    }
    case 'TVL_LOOKUP': {
      // minimal liquidity is risky for a treasury-grade token
      const tvl = Number(doc.tvlUsd ?? doc.tvl ?? NaN);
      if (!Number.isFinite(tvl) || tvl <= 0) return 0;
      const $k = tvl / 1000;
      return clamp01(Math.max(0, 1 - $k / 1000)); // <$1k tvl -> high risk
    }
    case 'SENTIMENT_ANALYSIS': {
      const s = String(doc.sentiment || doc.label || '').toLowerCase();
      if (s.includes('neg')) return 0.8;
      if (s.includes('pos')) return 0.1;
      return 0.4;
    }
    default:
      return 0;
  }
}

export function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

// Main entry: fuse raw miner evidence into a decision.
// signals: [{ intent, label, confidence, data {...}, txHash }]
// Returns { verdict, riskScore, confidence, reasons[] }.
export function screen(signals, opts = {}) {
  const weights = { ...SIGNAL_WEIGHTS, ...(opts.weights || {}) };
  const th = { ...THRESHOLDS, ...(opts.thresholds || {}) };

  const present = [];
  for (const s of signals) {
    const evidence = s.data || {};
    const risk = normalizeRisk(s.intent, evidence);
    const sigConf = clamp01(s.confidence ?? 1.0);
    present.push({
      intent: s.intent,
      risk,
      contribution: risk * sigConf,
      confidence: sigConf,
      evidence,
      txHash: s.txHash || null,
    });
  }
  if (present.length === 0) {
    return {
      verdict: 'FLAG',
      riskScore: 50,
      confidence: 0,
      reasons: ['No verified signals returned. Treat as unknown.'],
      signals: present,
    };
  }

  // present-weight normalization: divide by the weights of signals we have.
  const wsum = present.reduce((a, s) => a + (weights[s.intent] ?? 0.15), 0);
  let weighted = 0;
  for (const s of present) {
    const w = weights[s.intent] ?? 0.15;
    weighted += (s.contribution * w) / wsum;
  }
  const riskScore = Math.round(clamp01(weighted) * 100);

  // confidence from coverage: how much of the weight budget we actually saw.
  const coverage = Math.min(1, wsum);
  const maxContrib = Math.max(0, ...present.map((s) => s.contribution));
  const confidence = Math.round(clamp01(coverage * (0.4 + 0.6 * maxContrib)) * 100);

  const reasons = buildReasons(present, riskScore, confidence);
  let verdict = riskScore < th.approve ? 'APPROVE' : riskScore <= th.block ? 'FLAG' : 'BLOCK';

  // Safety escalation: a moderately risky URL or fraud signal always forces at
  // least human review, no matter where the numeric score lands.
  const autoReview = present.some(
    (s) => (s.intent === 'URL_SCAN' || s.intent === 'FRAUD_DETECTION') && s.risk >= 0.4
  );
  if (verdict === 'APPROVE' && autoReview) {
    verdict = 'FLAG';
    reasons.push('URL/fraud signal above review threshold, escalated to human review');
  }

  return { verdict, riskScore, confidence, reasons, signals: present };
}

function buildReasons(signals, riskScore, confidence) {
  const r = [];
  const hot = signals.filter((s) => s.contribution >= 0.55);
  if (hot.length) {
    for (const h of hot) {
      r.push(`${h.intent} flagged (risk ${h.risk.toFixed(2)})`);
    }
  }
  if (riskScore >= 70) r.push('Combined score exceeds BLOCK threshold');
  else if (riskScore >= 45) r.push('Combined score in FLAG band, human review advised');
  if (confidence < 40) r.push('Low verified-signal coverage, decision has reduced confidence');
  if (r.length === 0) r.push('All verified signals clean within thresholds');
  return r;
}
// SentinelVault signal-source seam (Track 3).
// The app consumes verified intelligence from the Telegraph network (live mode,
// x402-paid) or a deterministic simulated source (used for tests/demo until the
// wallet holds USDC). Switching SIGNAL_SOURCE swaps the whole backend, so the
// verdict + storage + server are fully testable end to end before real funds.

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// --- simulated source (deterministic, no funds) ---------------------------
export async function simulatedSignals(target) {
  const hl = target.toLowerCase();
  const risky =
    hl.includes('scam') ||
    hl.includes('honeypot') ||
    hl.includes('0xdead') ||
    hl.startsWith('0x') && hl.slice(2).includes('beef');
  const base = risky ? 0.9 : 0.08;
  const jitter = (hashStr(target) % 40) / 1000 - 0.02; // small deterministic spread
  const c = Math.min(1, Math.max(0.6, base + jitter));

  // One per intent the app fuses, matching the verdict engine's weights.
  const signals = [
    { intent: 'URL_SCAN', confidence: 0.97, data: { risk: base } },
    { intent: 'FRAUD_DETECTION', confidence: 0.96, data: { risk: base * 0.9 } },
    {
      intent: 'CVE_LOOKUP',
      confidence: 0.98,
      data: { severity: risky ? 'CRITICAL' : null },
    },
    { intent: 'ONCHAIN_TX_LOOKUP', confidence: 0.9, data: { status: risky ? 'pending' : 'success' } },
    { intent: 'TOKEN_HOLDER_COUNT', confidence: 0.85, data: { top1Percent: risky ? 92 : 22 } },
    { intent: 'TVL_LOOKUP', confidence: 0.82, data: { tvlUsd: risky ? 400 : 3_000_000 } },
    {
      intent: 'SENTIMENT_ANALYSIS',
      confidence: 0.8,
      data: { sentiment: risky ? 'negative' : 'positive' },
    },
  ];
  // simulated signals carry no on-chain provenance yet
  const sigs = signals.map((s) => ({ ...s, txHash: null }));
  simulatedSignals.rerouteOne = async (intent, target) => {
    const all = await simulatedSignals(target);
    return all.find((s) => s.intent === intent) || { intent, confidence: 0, data: {}, txHash: null };
  };
  simulatedSignals.setIntent = true;
  return sigs;
}

export async function createSignalSource(mode) {
  if (mode === 'live') {
    // Real Telegraph network via x402 (requires SENTINEL_PK + funded USDC).
    const mod = await import('./live.js');
    return mod.liveSignals;
  }
  return simulatedSignals;
}
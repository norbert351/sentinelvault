// SentinelVault confidence-threshold re-route (diagram: "confidence-threshold re-route").
// Before fusing a verdict, any high-weight intent that came back with low
// confidence (no usable evidence) is re-asked ONCE via a fresh miner call. If the
// retry yields real evidence, its risk replaces the weak signal. This stops a
// single unhelpful miner from dragging a verdict's confidence down.
import { screen } from './verdict.js';

const REROUTE_CONF_THRESHOLD = 0.5; // below this, if the intent is important, re-ask
const RETRIED_SIGNALS = ['URL_SCAN', 'FRAUD_DETECTION', 'CVE_LOOKUP', 'ONCHAIN_TX_LOOKUP'];

export async function screenWithReroute(signalsFor, target, firstRun) {
  // firstRun: array of { intent, confidence, data, txHash } from the parallel ask.
  // Decide which intents to re-ask by weight × (lack of usable evidence).
  const weak = firstRun.filter(
    (s) => REROUTE_CONF_THRESHOLD > 0 &&
           s.confidence < REROUTE_CONF_THRESHOLD &&
           RETRIED_SIGNALS.includes(s.intent)
  );

  let merged = [...firstRun];
  if (weak.length) {
    // re-ask only the weak intents, once, still through the paid live rail
    const asked = weak.map(async (w) => {
      try {
        const [signal] = await signalsFor.setIntent ? [] : [w]; // proxy fallback
        // live source is parallel-all; call per-intent via a re-ask fn passed here
        const fresh = await signalsFor.rerouteOne
          ? await signalsFor.rerouteOne(w.intent, target)
          : null;
        if (fresh && Object.keys(fresh.data || {}).length) return fresh;
        return w;
      } catch { return w; }
    });
    const results = await Promise.all(asked);
    const byIntent = new Map(results.map((r) => [r.intent, r]));
    merged = firstRun.map((s) => (byIntent.has(s.intent) ? byIntent.get(s.intent) : s));
  }

  return screen(merged);
}
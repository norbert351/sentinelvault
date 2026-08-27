// SentinelVault Auto Watcher — monitors inbound deals & contracts on a schedule.
// Every tick, screens each active watchlist target (x402, live) and pushes the
// verdict to that watch's webhook (or all verdict-webhooks). Low-concurrency and
// time-boxed so a slow miner never wedges the loop.
import { screen } from './verdict.js';
import { commitVerdict } from './proof.js';

export function startWatcher({ store, signalsFor, recordProof }) {
  // helper shared with /screen: run target through pipeline, persist, return proof + ids
  async function runScreen(store, target, kind) {
    const rawSignals = await signalsFor(target);
    const verdict = screen(rawSignals);
    const { submissionId, verdictId } = await store.insertScreen({ target, kind, verdict, signals: verdict.signals });
    const commit = commitVerdict(verdict);
    const proof = await recordProof({ commit, verdictId, signals: verdict.signals });
    await store.insertProof({ verdictId, mode: proof.mode, commit, ref: proof.ref, onChain: proof.onChain, txCount: proof.txCount || 0 });
    return { submissionId, verdictId, verdict, proof };
  }

  let running = false;
  async function tick() {
    if (running) return; // don't overlap ticks
    running = true;
    try {
      const watches = await store.pendingWatches();
      // time-box: at most 5 watches per tick, 60s each
      for (const w of watches.slice(0, 5)) {
        try {
          const out = await runScreen(store, w.target, w.kind || 'token');
          await store.flagWatchRunning(w.id, new Date().toISOString());
          const { deliver } = await import('./webhook.js');
          const payload = { target: w.target, ...out.verdict, proof: out.proof, submissionId: out.submissionId };
          await deliver(store, 'verdict', payload);
        } catch {
          /* skip — wait for next tick */
        }
      }
    } catch {
      /* store transient error — next tick */
    } finally {
      running = false;
    }
  }

  const minuteMs = 60_000;
  const intervalId = setInterval(tick, (Number(process.env.SENTINEL_WATCH_INTERVAL_S) || 60) * 1000);
  // first run shortly after boot
  const bootTimer = setTimeout(tick, (Number(process.env.SENTINEL_WATCH_FIRST_DELAY_S) || 15) * 1000);

  return {
    stop() { clearInterval(intervalId); clearTimeout(bootTimer); },
    tick,
    runScreen,
    get intervalMs() { return intervalId._repeat || minuteMs; },
  };
}
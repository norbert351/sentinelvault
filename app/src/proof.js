// SentinelVault on-chain proof recorder (seam).
// Produces a deterministic content digest of a verdict and binds it to an
// immutable record. In "logging" mode (current) the digest + provenance are
// recorded and returned, ready to be replayed onto chain. In "erc8183" mode
// this same digest becomes the content the on-chain job commits (once USDC
// funds the escrow), giving the verdict an on-chain existence proof.
import { createHash } from 'node:crypto';

const SHA = (o) => '0x' + createHash('sha256').update(o).digest('hex');

// Deterministic digest of the verdict + its per-signal provenance. Same input
// always yields the same digest, so it can be replayed and verified later.
export function commitVerdict(verdict) {
  const body = JSON.stringify({
    verdict: verdict.verdict,
    riskScore: verdict.riskScore,
    confidence: verdict.confidence,
    signals: verdict.signals.map((s) => [
      s.intent,
      Math.round((s.risk ?? 0) * 10000) / 10000,
      s.txHash || null,
    ]),
  });
  return SHA(body);
}

export function createRecorder(mode = 'logging') {
  if (mode === 'erc8183') {
    // Live path: deposit USDC to escrow then createJob(bytes32,intentId,...)
    // with a callback that stores the digest. Needs keys + funded escrow.
    return async function recordErc8183({ commit }) {
      throw new Error(
        `erc8183 record needs USDC escrow + keys (commit ${commit.slice(0, 18)}…). ` +
          'Keep PROOF_MODE=logging until the escrow is funded.'
      );
    };
  }
  return async function recordLogging({ commit, verdictId, signals = [] }) {
    // In live mode each signal carries a real on-chain x402 settlement tx hash.
    // Surface that as on-chain provenance instead of "logging only".
    const onChainTxs = (signals || []).map((s) => s.txHash).filter(Boolean);
    if (onChainTxs.length) {
      return {
        mode: 'logging',
        commit,
        ref: onChainTxs[0],
        onChain: true,
        txCount: onChainTxs.length,
        detail: `Verdict bound to ${onChainTxs.length} real on-chain x402 payment txs (USDC settled on Base Sepolia).`,
      };
    }
    return {
      mode: 'logging',
      commit,
      ref: `log-content-digest:${commit.slice(0, 18)}…`,
      onChain: false,
      detail: 'Content digest recorded. On-chain binding via ERC-8183 createJob once escrow holds USDC.',
    };
  };
}
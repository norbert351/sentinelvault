# SentinelVault — Future Roadmap (expand-after-the-hackathon)

This is the honest "where it goes next" — grounded in what's already real, not fantasy. It maps
demo → product and gives judges (and us) the growth signal.

## Thesis
Telegraph's ranked, paid, provable miners are the missing trust layer for **whoever moves money
into a counterparty**. SentinelVault productizes that layer: any treasury, listing team, security
or risk desk gets one provable verdict instead of assembling five contradictory free scanners.

## Where it goes next

### 1. Close the loop toward autonomy (the "autonomous treasury" promise)
- **Decide, don't just report.** Today the app screens and returns `APPROVE/FLAG/BLOCK`. The next
  step is policy-gated action: a treasury can authorize "transfer X only if verdict == APPROVE and
  confidence ≥ 0.9". The verdict becomes an **executable gate**, not a memo.
- Wire the verdict gate to a smart account (the agent never holds the key — it enforces policy on
  chain). This is the natural bridge to the `onchain-agent-marketplaces` primitives we already hold.

### 2. Persistent monitoring, not one-shot scans
- **Watch a target continuously.** The auto-watcher already re-screens on a schedule; extend it to
  stream and alert the moment a watched counterparty's verdict **deteriorates** (e.g. a CVE lands,
  a honeypot relationship hardens, an on-chain pattern flips). "Sync your treasury with reality."

### 3. Multi-chain + more intents
- Current signals target the ranked Bitcoin/token/contract set on Base Sepolia. Expand to more
  intents (FRAUD_DETECTION, SSL_VERIFICATION, NEWS_SEARCH already natural fits) and more chains as
  Telegraph brings them up — a single verdict across the whole portfolio, not per-chain silos.

### 4. B2B trust product
- The B2B SDK + webhook layer already exist. Productize as: **Verification API with SLAs** —
  listing teams and multi-sig signers subscribe to "verdict on any counterparty, with an immutable
  on-chain digest they can re-derive for an auditor." Priced per screen (the x402 economics already
  set the unit cost).

### 5. Proof-to-auditor surface
- Build a public `/proof` page per verdict (already supported by the data model) that a judge or
  external auditor opens to re-derive exactly which miners, which tx hashes, and which on-chain
  digest support a verdict. This is the trust flywheel: provable today, *auditable at scale* next.

## Demo → product: what changes
| Today (hackathon) | Product (post) |
| --- | --- |
| One user screen at a time | Policy-gated treasury actions + persistent monitoring |
| Base Sepolia signals | Multi-chain, more intents |
| SDK + webhooks exist | Verification API with SLAs + pricing |
| On-chain digest per verdict | Public /proof page + auditor re-derivation |

## Honesty guard
Nothing above is claimed as implemented. Everything in this section is *proposed*; the
**"Implemented"** list in the README is the only source of truth for what ships today. The roadmap
exists to show the build keeps growing — the expand-after-the-hackathon signal — not to overclaim
what's done.
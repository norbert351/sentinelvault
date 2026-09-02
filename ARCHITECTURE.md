# SentinelVault — Architecture

Autonomous treasury & partner vetting on the **Telegraph** protocol (Season I). One weighted,
on-chain-provable verdict for any token, contract, URL or partner.

## System diagram

```
                 ┌─────────────────────────────────────────────────────────┐
                 │                     JUDGE / USER                         │
                 │  browser (app/web)  ·  curl /screen  ·  B2B SDK  ·  hooks │
                 └───────────────┬─────────────────────────────────────────┘
                                 │ POST /screen → 402 → pay → replay(Payment-Signature)
                                 ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │                   TRACK 3: VETTING APP (app/)            │
                 │  payment-gate.js  (x402 live)  →  verdict.js (weighted    │
                 │  fusion)  →  reroute.js (confidence re-ask)               │
                 │  storage.js (Neon/Postgres or sqlite)  ·  webhook + watch  │
                 │  erc8183.js (createJob digest)  ·  auth.js (Bearer)       │
                 └───────┬──────────────────────────────────┬───────────────┘
                         │ x402 paid signal (USDC, EIP-3009) │ ERC-8183 proof
                         ▼                                  ▼
          ┌──────────────────────────┐           ┌──────────────────────────┐
          │  TELEGRAPH ENGINE         │           │  BASE SEPOLIA DIAMOND     │
          │  /engine/v1/ask (multi-    │           │  0x5a23…ff8               │
          │  intent) — ranked miners   │           │  → createJob (verdict     │
          │  URL_SCAN · CVE_LOOKUP ·   │           │    digest anchored)       │
          │  ONCHAIN_TX_LOOKUP · TVL · │           └──────────────────────────┘
          │  WALLET_BALANCE · NEWS …   │
          └───────────┬───────────────┘
                      │
          ┌───────────┴───────────────┐
          │  TRACK 1: SENTINELVAULT     │   TRACK 2: wasm scorer
          │  CVE_LOOKUP MINER (service) │   scoring-module/ (regId 1111)
          │  wraps free CIRCL CVE API   │
          └─────────────────────────────┘
```

## The core value flow (the spine)

1. **Submit** a target (`POST /screen`, `target` + `kind`).
2. **402 → pay**: the x402 gate returns a `PAYMENT-REQUIRED` challenge. Buyer's wallet signs
   EIP-712, transfers USDC on Base Sepolia, replays with `PAYMENT-SIGNATURE`.
3. **Ask live miners**: the app pays Telegraph for real signals across multiple intents (each a
   real `engine/v1/ask`, settled on-chain — no mocks; the `payment-response` header carries the tx hash).
4. **Weighted fusion**: `verdict.js` turns per-signal risk + confidence into one risk score →
   `APPROVE / FLAG / BLOCK`; `reroute.js` **re-asks once** any high-weight intent that came back
   low-confidence.
5. **Prove**: per-signal tx hashes are recorded, and under `PROOF_MODE=erc8183` the whole verdict
   digest is sealed on-chain via ERC-8183 `createJob`.
6. **Act**: webhook fan-out + auto-watcher re-screens a target on a schedule; B2B SDK for
   programmatic consumers.

The mechanism that wins the judged axis is **verified multi-source intelligence that is paid-for
and provable** — not a static scan, not a model's confidence, and not a mock.

## Where the sponsor tech sits — the counterfactual

Telegraph's ranked, x402-paid intelligence **is** the product's verification layer. Remove it and
the verdict loses its entire evidential basis.

| After removing Telegraph / x402 | What happens |
| --- | --- |
| live x402 signals (`SIGNAL_SOURCE=live`) | falls to `simulated` — canned scores, **no on-chain provenance**, no real miner answers |
| on-chain settlement | the `payment-response` tx hash disappears → no per-signal proof a judge can re-verify |
| ERC-8183 `createJob` (Track 3 proof) | verdict is only a server-side log entry, not an immutable on-chain digest |
| ranked miners (multi-intent routing) | degrade to a single hard-coded source → "one source of truth" risk the product exists to kill |
| CVE_LOOKUP miner (Track 1) | the app still works but the track's own servant miner disappears → weaker multi-track story |

**This is the anti-VeriForge counterfactual made visible:** the product would materially stop
producing *the thing judges reward* (provable, paid, verified multi-intent intelligence) the moment
Telegraph/x402 is removed. It is load-bearing, not decorative.

## Key modules (Track 3 app)

| Module | File | Responsibility |
| --- | --- | --- |
| HTTP API | `server.js` | routes: `/screen`, `/submissions/:id`, `/health`, webhooks, watch, `/metrics` |
| x402 payment gate | `payment-gate.js` | 402 challenge, EIP-712 verify, on-chain settlement check, replay protection |
| Live signals | `live.js` | real `engine/v1/ask` + EIP-3009 settlement, reads `payment-response` |
| Verdict engine | `verdict.js` | weighted risk fusion + confidence → APPROVE/FLAG/BLOCK |
| Re-route | `reroute.js` | re-ask one low-confidence high-weight intent |
| Proof | `proof.js`, `erc8183.js` | logging/x402-tx proof; ERC-8183 `createJob` on-chain digest |
| Storage | `storage.js` | Neon/Postgres or `node:sqlite`, same store shape |
| Webhooks | `webhook.js` | register/list/delete callback URLs |
| Auto-watcher | `watcher.js` | scheduled re-screens of watched targets |
| Auth | `auth.js` | Bearer token; `SENTINEL_ANON_READONLY=1` for judging |
| Miner (Track 1) | `miner-service/` | `GET /cve` normalized lookup + durable `/metrics` |

## Frontend

Single `app/web/index.html`, mobile-first, served **same-origin** by the API — no separate static
host, no CORS. Contract: `POST /screen` → 402 → wallet modal (connect, transfer USDC, sign EIP-712)
→ replay with `PAYMENT-SIGNATURE` → verdict + audit trail.
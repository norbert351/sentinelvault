# SentinelVault — Technical

Stack, mechanisms, data model, API, chain facts, and the exact on-chain commands a maintainer or
judge needs.

## Stack & dependencies

| Layer | Tech | Notes |
| --- | --- | --- |
| Miner (Track 1) | Node 22 ESM, `node:http`/`node:https`, `pg` | IPv4-pinned DNS for CIRCL upstream; **durable** `/metrics` |
| Scoring (Track 2) | Rust → `wasm32-unknown-unknown` | `#![no_std]`, bump allocator, exports `rank_answer` |
| App (Track 3) | Node 22 ESM, `@x402/fetch` + `@x402/evm`, `viem`, `pg` | zero heavy frameworks |
| Storage | Postgres/Neon (`SENTINEL_DATABASE_URL`) or `node:sqlite` | backend-agnostic store |
| Frontend | single `index.html` (no build) | mobile-first, same-origin |

Run everything with IPv4 first on this VM: `NODE_OPTIONS=--dns-result-order=ipv4first`.

## Core mechanisms

### x402 paid gate (Track 3)
- `POST /screen` returns **HTTP 402** with a `PAYMENT-REQUIRED` challenge when `SENTINEL_PAYWALL`
  is on (default).
- Buyer signs **EIP-712** `Payment`, transfers USDC on Base Sepolia to `payTo`, replays with the
  `PAYMENT-SIGNATURE` header.
- `payment-gate.js` verifies: amount · chainId · payTo · recovered signer · on-chain `Transfer`
  settlement · replay protection (once per tx).

### Weighted verdict fusion
`verdict.js` maps each signal to a risk + confidence, then combines:
- escalate to **FLAG/BLOCK** when a high-weight risk intent (e.g. URL_SCAN, FRAUD) ≥ 0.4;
- `reroute.js` **re-asks once** any high-weight intent that returned low confidence;
- no signals at all → FLAG with confidence 0 (never overtrusts an empty answer).

### Durable miner counters (Track 1, cash-prize guardrail)
`miner-service/stats-store.js`:
- **Neon/Postgres** when `SENTINEL_DATABASE_URL` is set (survives Render free-tier restart);
- **JSON sidecar** (`stats.json`) fallback for VMs/local;
- loads prior counters on boot (never starts at zero), flushes per request + on a 60s interval +
  on SIGTERM/SIGINT.
- `GET /metrics` reports `backend: pg|file` + cumulative `totalRequests/errors/cacheHits/byCve`.
- Guardrail: the CVE_LOOKUP intent needs ≥3 miners and ≥100 real requests to be cash-prize eligible.

### ERC-8183 on-chain verdict digest (Track 3 proof)
`app/src/erc8183.js`, active when `PROOF_MODE=erc8183`:
1. `approve(USDC, Diamond)` → **await** the receipt (a `transferFrom` before the approve is mined
   reverts with "insufficient allowance").
2. `depositUSDC` into escrow (floor ≥ $5 to cover real `createJob` cost).
3. `createJob` — commits the verdict digest on-chain.
4. On chain error, gracefully falls back to x402-tx proof so a transient RPC issue never blocks a
   verdict.

## Chain facts (Base Sepolia, chainId 84532)

| Item | Value |
| --- | --- |
| Telegraph Diamond | `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8` |
| MINER registration | slug `sentinelvault-cve`, id `205`, fee/wallet `0x73b16058d57a6337060677496d4a8e97a9554539`, `min_price_usdc 10000` |
| Miner WASM scorer | regId `1111` (keccak-of-bytes registered, eval logged) |
| ERC-8183 createJob | `0xa3b4…45ca` (verified) |
| x402 settlement | USDC (EIP-3009), per-call; app `payTo` from `SENTINEL_PAY_TO` or derived from `SENTINEL_PK` |

## ⚠️ Exact on-chain fix before submit — re-point the miner `base_url`

The miner is registered on-chain with a prior hostname. The **live** service is
`https://sentinelvault-cve.onrender.com`, and `miner.yaml` now reflects it. Push `miner.yaml`, then
run `updateMiner` with the NEW SHA-256 of the served bytes (from this repo, `master`):

```bash
# 1. compute the hash of the exact miner.yaml bytes that raw.githubusercontent.com serves now
git push   # ensure miner.yaml above is on master and public first
curl -s https://raw.githubusercontent.com/norbert351/sentinelvault/master/miner.yaml | sha256sum
# → d732a2afc377f8ec7d92aa1df47068fd3cbda9a1975eeb5e9ebc975930924fb1

# 2. updateMiner with cast (from ~/.foundry/bin; Base Sepolia):
# cast send 0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8 \
#   "updateMiner(string,bytes32,address,uint256,string[])" \
#   "https://raw.githubusercontent.com/norbert351/sentinelvault/master/miner.yaml" \
#   "<sha256-above>" \
#   0x73b16058d57a6337060677496d4a8e97a9554539 \
#   10000 '["CVE_LOOKUP"]' \
#   --rpc-url https://base-sepolia.publicnode.com --private-key "$SENTINEL_PK" --legacy
```

>`updateMiner` issues a **new registrationId** (old goes `superseded`), and nodes rehydrate within
>1–5 min. Verify: `GET /api/miners`, then `/api/miners/<newId>` until `base_url` = the live host.

## Data model

Postgres/sqlite tables:
- `submissions(id, target, kind, created_at)`
- `signals(id, submission_id, intent, risk, confidence, contribution, tx_hash, raw_json)`
- `proofs(id, submission_id, mode, commit_digest, ref, on_chain, tx_count)`
- `webhooks(id, url, events_json)`
- `watchers(id, target, kind, interval_min)`
- `miner_stats(miner, requests, errors, cache_hits, by_cve jsonb, updated_at)` ← durable counters
  (column is `commit_digest`, not `commit` — `commit` is a reserved word in SQLite).

## API surface

| Method & path | Purpose |
| --- | --- |
| `GET /` | SPA frontend (same origin) |
| `POST /screen` | paywalled verdict — 402 → pay → replay → `{verdict, riskScore, confidence, signals, proof}` |
| `GET /submissions/:id` | full audit trail (verdict + per-signal evidence + tx hashes + proofs) |
| `GET /health` | liveness + `source/db/paywall/chainId/payTo` |
| `GET /screen/quote` | the 402 challenge JSON without paying |
| `POST /webhooks` / `GET /webhooks` / `DELETE /webhooks/:id` | callbacks |
| `POST /watch` / `GET /watch` / `DELETE /watch/:id` | auto re-screen watchers |
| `GET /watch/status` | watcher scheduler health |
| Miner `GET /cve?cve_id=CVE-…` | miner signal (Track 1) |
| Miner `GET /metrics` / `GET /health` | durable counters / liveness |

## Environment variables (names only — set secrets in Render, never commit)

`SENTINEL_PK` · `SENTINEL_PAY_TO` · `SENTINEL_PRICE_USDC` · `SENTINEL_API_KEY` ·
`SENTINEL_ANON_READONLY` · `SENTINEL_DATABASE_URL` · `SIGNAL_SOURCE` (live|simulated) ·
`PROOF_MODE` (logging|erc8183) · `SENTINEL_PAYWALL` · `PORT` · `NODE_VERSION`

Copy `app/.env.example` / `miner-service` env as placeholders. **Never paste keys or private keys
into docs or git.**

## Tests

```bash
# app verdict engine (6/6)
cd app && npm test

# miner e2e (start, hit /cve, durable counters)
cd miner-service && bash run_local_verify.sh   # or: node index.js; curl /cve & /metrics

# WASM scorer structural checks
cd scoring-module && node test.mjs

# full
npm test --workspaces
```

Expected: 6/6 app verdict tests pass; miner /cve returns a real CVE; wasm scorer blank-answer = 0.
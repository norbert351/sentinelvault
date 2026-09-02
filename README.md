# SentinelVault — Telegraph Hackathon (Season I)

Autonomous treasury & partner vetting on ranked, verified multi-intent intelligence.

**One-line pitch:** verify any token, contract, URL or partner across live, paid, on-chain-provable
Telegraph intelligence before the money moves — one weighted verdict with evidence you can re-derive.

**Who it's for:** DAO treasurers, security/risk teams, listing teams and multisig signers who move
real money and can't afford to trust a single scan or a single source. *Not for* one-off retail
scanners that need a free, instant answer with no audit trail.

## Live deployment & on-chain state (verified 2026-09-03)

| Surface | Where | Status |
|---|---|---|
| Miner data service (Track 1) | `https://sentinelvault-cve.onrender.com` | ✅ live, serves real CVE data + durable `/metrics` |
| Vetting app (Track 3) | `https://sentinelvault-app.onrender.com` | ✅ live (health 200) |
| Miner registration | Base Sepolia Diamond `0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8`, slug `sentinelvault-cve`, id `205` | ✅ `activation_status: active` |
| WASM scorer (Track 2) | regId `1111` | ✅ submitted on-chain (eval logged, structural pass) |
| ERC-8183 verdict digest | `createJob` on Base Sepolia `0xa3b4…45ca` (chainId 84532) | ✅ verified |
| Repo | `github.com/norbert351/sentinelvault` (public, `master`) | ✅ |

> ⚠️ **Base URL**: the miner's registered on-chain `base_url` must be updated to
> `https://sentinelvault-cve.onrender.com` (currently a prior hostname). Command in `docs/TECHNICAL.md`.

## Repo layout

| Path | What it is |
|---|---|
| `miner-service/` | **Track 1** CVE_LOOKUP miner data service (Node, zero deps). Wraps the free CIRCL CVE API → normalized `{cve_id, severity, cvss_score, confidence, description}`. |
| `miner.yaml` | Telegraph Miner Standard config for the CVE miner (id `205`, slug `sentinelvault-cve`, `supported_intents: [CVE_LOOKUP]`, `on_chain` transform). |
| `scoring-module/` | **Track 2** WASM scoring module (Rust → `wasm32-unknown-unknown`) that judges CVE_LOOKUP miner answers. `test.mjs` verifies the required behaviors. |
| `app/` | **Track 3** product — treasury/partner vetting app. Verdict engine + HTTP API + sqlite audit trail + x402 live signal source. |

## Tracks

- **Track 1 (Miner):** registered the CVE miner (`registerMiner`) on the Base Sepolia Diamond. Live & active.
- **Track 2 (Script):** registered WASM scoring module (`registerWasm`) for CVE_LOOKUP.
- **Track 3 (Application):** the SentinelVault vetting app, consuming REAL live miners via x402.

## Track 3 app — live-x402 verified, no mocks

The app (`app/`) screens a treasury/partner target by asking the live Telegraph network across
multiple intents, fusing the answers into a weighted risk verdict with an on-chain audit trail.

**`SIGNAL_SOURCE` seam (the key design):**
- `SIGNAL_SOURCE=live` → every signal is a real **x402 engine ask** paid in USDC on Base Sepolia
  (EIP-3009 via `@x402/evm`). The `payment-response` header carries the on-chain settlement tx
  hash, so each signal has real provenance. No mocks.
- `SIGNAL_SOURCE=simulated` → deterministic local source for tests/demos before funding.

**`PROOF_MODE` seam:**
- `logging` → records the verdict digest + real per-signal x402 tx hashes (on-chain provenance
  when present).
- `erc8183` → binds the whole verdict digest on-chain via ERC-8183 `createJob` (approve →
  deposit escrow → createJob, `app/src/erc8183.js`). Auto-falls back to x402-tx proof on chain
  error so a transient RPC issue never blocks a verdict.

### App feature set (matches the architecture diagram)

| Feature | Endpoint / file | Status |
|---|---|---|
| Submission API + verdict | `POST /screen`, `GET /submissions/:id` | ✅ |
| Confidence-threshold re-route | `screenWithReroute` (`reroute.js`) — low-confidence high-weight intents re-asked once | ✅ |
| Auth (Bearer) | `auth.js` — `SENTINEL_API_KEY`; `SENTINEL_ANON_READONLY=1` opens for judging | ✅ |
| Webhook callbacks | `POST /webhooks`, `GET /webhooks`, `DELETE /webhooks/:id` → `webhook.js` | ✅ |
| Auto Watcher | `POST /watch`, `GET /watch`, `DELETE /watch/:id` → `watcher.js` (scheduled re-screens) | ✅ |
| B2B SDK | `app/sdk/` (`@sentinelvault/sdk`, `SentinelVault` client) | ✅ |
| Postgres (Neon) storage | `SENTINEL_DATABASE_URL` → `pg` backend; else node:sqlite | ✅ |
| On-chain ERC-8183 digest | `PROOF_MODE=erc8183` → `erc8183.js` | ✅ **live in prod** (verified createJob on Base Sepolia) |
| **Paid API (Option A)** | `SENTINEL_PAYWALL` (default on) → `/screen` returns 402, requester's wallet pays USDC + signs EIP-712, replays for the verdict. `payment-gate.js` verifies amount/chainId/payTo + on-chain settlement + replay protection. | ✅ verified e2e |

### Run (live)

```bash
cd app
npm install
SIGNAL_SOURCE=live \
SENTINEL_PK=0x… \                  # EVM key holding USDC on Base Sepolia
npm start                            # starts on $PORT or :8090
```

Then:

```bash
# verdict on a contract/token (add -H 'Authorization: Bearer <key>' if SENTINEL_API_KEY set)
curl -X POST localhost:8090/screen -H 'Content-Type: application/json' \
  -d '{"target":"0x…","kind":"token"}'
# → returns 402 with a PAYMENT-REQUIRED challenge (payable /screen)

# the wallet modal (app/web) handles the flow: connect → USDC transfer to payTo →
# sign EIP-712 → replay with PAYMENT-SIGNATURE header → verdict.
# E2E reference (real on-chain payment through the gate):
cd app && SENTINEL_PK=0x… SV_API=http://localhost:8090 node e2e_paywall.mjs

# full audit trail (verdict + per-signal evidence + on-chain tx hashes)
curl localhost:8090/submissions/1

# B2B SDK
cd app/sdk && SV_BASE=http://localhost:8090 node test.js

# register a callback + auto-watch a target
curl -X POST localhost:8090/webhooks -H 'Content-Type: application/json' \
  -d '{"url":"https://your-service/hook","events":["verdict"]}'
curl -X POST localhost:8090/watch -H 'Content-Type: application/json' \
  -d '{"target":"0x…","kind":"token","intervalMin":60}'
```

Frontend + API share one origin: `GET /` serves `app/web/index.html`, `POST /screen` and
`/submissions/:id` are the same host — no separate static host or CORS needed.

### Verified live behaviors (Base Sepolia, 2026-08)

- Scam/honeypot targets → **FLAG/BLOCK** with real flagged signals (URL/fraud risk) + per-signal
  on-chain x402 tx hashes.
- Benign contract → **APPROVE** (risk 5, all clean), proof `onChain: true`, `txCount: 5`.
- Each screen settles ~$0.01–0.05 USDC on-chain through real Telegraph miners.

### Durable miner request counters (Track 1 volume / cash-prize guardrail)

The miner exposes `GET /metrics` (`miner-service`). Counters are **durable** — persisted to the
same Neon Postgres (`SENTINEL_DATABASE_URL`) when set, else a JSON sidecar for VMs/local, so a
Render free-tier restart no longer zeroes the accumulated `requests served` volume
(guardrail: an intent needs ≥3 miners and **≥100 real requests** to be cash-prize eligible).
Set `SENTINEL_DATABASE_URL` on the **`sentinelvault-cve`** service in Render (same value the app
uses). `backend: pg|file` in the `/metrics` response tells you which is active.

## Stack

- **Backend:** Node 22 ESM, `@x402/fetch` + `@x402/evm` (EIP-3009), `viem`. Zero heavy frameworks.
- **Storage:** Postgres/Neon via `SENTINEL_DATABASE_URL`, or bundled `node:sqlite` for dev.
- **Frontend:** single `index.html`, mobile-first, served same-origin by the API (no build step, no CORS).
- **Network:** Base Sepolia (84532) — Diamond `0x5a23…ff8` receives x402 USDC payments.

## Honest status (2026-09-03)

- **Implemented & tested:** miner (6/6 app verdict tests, miner e2e), WASM scorer (structural pass),
  x402 paywall (verified e2e on-chain), ERC-8183 verdict digest (verified `createJob`), webhooks,
  auto-watcher, B2B SDK, Neon/Postgres storage, durable miner `/metrics`.
- **Deployed & live:** miner service + vetting app on Render.
- **Still to do before submit:** re-point the miner's registered on-chain `base_url` to
  `sentinelvault-cve.onrender.com` (see `docs/TECHNICAL.md`), and set `SENTINEL_DATABASE_URL` on the
  miner service in Render so its volume counters are Postgres-backed on the free tier.
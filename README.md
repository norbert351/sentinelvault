# SentinelVault — Telegraph Hackathon (Season I)

Autonomous treasury & partner vetting on ranked, verified multi-intent intelligence.

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
| On-chain ERC-8183 digest | `PROOF_MODE=erc8183` → `erc8183.js` | ✅ |

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

## Stack

- **Backend:** Node 22 ESM, `@x402/fetch` + `@x402/evm` (EIP-3009), `viem`. Zero heavy frameworks.
- **Storage:** Postgres/Neon via `SENTINEL_DATABASE_URL`, or bundled `node:sqlite` for dev.
- **Frontend:** single `index.html`, mobile-first, served same-origin by the API (no build step, no CORS).
- **Network:** Base Sepolia (84532) — Diamond `0x5a23…ff8` receives x402 USDC payments.
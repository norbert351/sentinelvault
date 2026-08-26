# SentinelVault — Telegraph Hackathon (Season I)

Autonomous treasury & partner vetting on ranked, verified multi-intent intelligence.

## Repo layout

| Path | What it is |
|---|---|
| `miner-service/` | **Track 1** CVE_LOOKUP miner data service (Node, zero deps). Wraps the free CIRCL CVE API → normalized `{cve_id, severity, cvss_score, confidence, description}`. Deployed to Render. |
| `miner.yaml` | Telegraph Miner Standard config for the CVE miner (id `205`, slug `sentinelvault-cve`, `supported_intents: [CVE_LOOKUP]`, `on_chain` transform). |
| `scoring-module/` | **Track 2** WASM scoring module (Rust → `wasm32-unknown-unknown`) that judges CVE_LOOKUP miner answers. `test.mjs` verifies the required behaviors. |

## Tracks

- **Track 1 (Miner):** register the CVE miner via `registerMiner(yamlUrl, yamlHash, feeAddress, minPrice, [CVE_LOOKUP])` on the Base Sepolia Diamond.
- **Track 2 (Script):** register `registerWasm(wasmHash, wasmUrl, CVE_LOOKUP)`.

Both stay live through Track 3 (Aug 31 → Sep 7), then the SentinelVault application builds on top of the CVE miner + the network's other verified intents.
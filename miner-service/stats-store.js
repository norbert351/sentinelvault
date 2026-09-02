// SentinelVault miner durable stats store.
// Loads request counters from Postgres (Neon) on boot, increments in memory,
// and persists periodically + on exit so a Render free-tier restart does NOT
// zero the accumulated "requests served" volume (the cash-prize guardrail is
// >=100 real requests). Falls back to pure in-memory when no DB is configured.
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEF_FILE = join(__dir, '..', 'stats.json');

export async function createStatsStore({ databaseUrl, filePath = DEF_FILE }) {
  // ---- Postgres / Neon backend (durable across restarts) ----
  if (databaseUrl) {
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
      await client.connect();
      await client.query(`CREATE TABLE IF NOT EXISTS miner_stats (
        miner text PRIMARY KEY,
        requests bigint NOT NULL DEFAULT 0,
        errors bigint NOT NULL DEFAULT 0,
        cache_hits bigint NOT NULL DEFAULT 0,
        by_cve jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      // Load persisted counters (never start from zero again).
      const row = await client.query(`SELECT requests, errors, cache_hits, by_cve FROM miner_stats WHERE miner='sentinelvault-cve'`);
      const prior = row.rows[0] ? {
        requests: Number(row.rows[0].requests) || 0,
        errors: Number(row.rows[0].errors) || 0,
        cacheHits: Number(row.rows[0].cache_hits) || 0,
        byCve: (() => {
          try { return JSON.parse(row.rows[0].by_cve || '{}') || {}; } catch { return {}; }
        })(),
      } : null;
      const state = {
        backend: 'pg',
        startedAt: new Date().toISOString(),
        requests: 0,
        errors: 0,
        cacheHits: 0,
        byCve: {},
        _priorRequests: prior?.requests ?? 0,
        _priorErrors: prior?.errors ?? 0,
        _priorHits: prior?.cacheHits ?? 0,
      };
      const persist = async () => {
        try {
          await client.query(
            `INSERT INTO miner_stats (miner, requests, errors, cache_hits, by_cve, updated_at)
             VALUES ('sentinelvault-cve', $1, $2, $3, $4::jsonb, now())
             ON CONFLICT (miner) DO UPDATE SET
               requests = EXCLUDED.requests,
               errors = EXCLUDED.errors,
               cache_hits = EXCLUDED.cache_hits,
               by_cve = EXCLUDED.by_cve,
               updated_at = now()`,
            [state.requests + state._priorRequests, state.errors + state._priorErrors,
             state.cacheHits + state._priorHits, JSON.stringify(state.byCve)]
          );
        } catch (e) { console.error('stats persist error', e?.message); }
      };
      return { state, persist, flush: persist };
    } catch (e) {
      console.error('pg stats store unavailable, falling back to file+memory:', e?.message);
    }
  }

  // ---- JSON file backend (durable on VMs / volumes, survives process restarts) ----
  try { await fs.mkdir(dirname(filePath), { recursive: true }); } catch {}
  let prior = { requests: 0, errors: 0, cacheHits: 0, byCve: {} };
  try { prior = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch {}
  const state = {
    backend: 'file',
    startedAt: new Date().toISOString(),
    requests: 0,
    errors: 0,
    cacheHits: 0,
    byCve: {},
    _priorRequests: Number(prior.requests) || 0,
    _priorErrors: Number(prior.errors) || 0,
    _priorHits: Number(prior.cacheHits) || 0,
  };
  const persist = async () => {
    const snap = {
      backend: state.backend,
      startedAt: state.startedAt,
      requests: state.requests + state._priorRequests,
      errors: state.errors + state._priorErrors,
      cacheHits: state.cacheHits + state._priorHits,
      byCve: state.byCve,
    };
    try { await fs.writeFile(filePath, JSON.stringify(snap)); } catch (e) { console.error('stats write error', e?.message); }
  };
  // debounce pad so bursts don't hammer the disk
  let t;
  const flush = () => { clearTimeout(t); t = setTimeout(persist, 800); };
  return { state, persist, flush };
}
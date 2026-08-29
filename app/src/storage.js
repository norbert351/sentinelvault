// SentinelVault storage layer (audit trail + submissions + watchlist + webhooks).
// Backend-agnostic: Postgres (Neon) when SENTINEL_DATABASE_URL is set, else the
// bundled node:sqlite file DB. Both expose the same async store shape so the rest
// of the app is storage-agnostic.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEF_DB = join(__dir, '..', 'sentinelvault.db');

// ------------------- shared row mappers -------------------
function proofRow(p) {
  return { mode: p.mode, commit: p.commit_digest || p.commit, ref: p.ref, onChain: !!p.on_chain || !!p.onchain, txCount: p.tx_count || p.txcount || 0 };
}
function auditFrom(sub, v, sigRows, proofs) {
  return {
    submission: sub,
    verdict: {
      verdict: v.verdict,
      riskScore: v.risk_score || v.riskscore,
      confidence: v.confidence,
      reasons: typeof v.reasons_json === 'string' ? JSON.parse(v.reasons_json || '[]') : (v.reasons || []),
    },
    signals: sigRows.map((s) => ({
      intent: s.intent,
      risk: s.risk,
      contribution: s.contribution,
      confidence: s.confidence,
      txHash: s.tx_hash || s.txhash,
      evidence: (() => {
        try {
          return JSON.parse(s.raw_json || s.rawevidence || '{}').evidence || {};
        } catch {
          return {};
        }
      })(),
    })),
    proofs: proofs.map(proofRow),
  };
}

// ------------------- SQLite backend -------------------
function sqliteStore(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES submissions(id),
      verdict TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      confidence INTEGER NOT NULL,
      reasons_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verdict_id INTEGER NOT NULL REFERENCES verdicts(id),
      intent TEXT NOT NULL,
      risk REAL,
      contribution REAL,
      confidence REAL,
      tx_hash TEXT,
      raw_json TEXT
    );
    CREATE TABLE IF NOT EXISTS proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verdict_id INTEGER NOT NULL REFERENCES verdicts(id),
      mode TEXT NOT NULL,
      commit_digest TEXT NOT NULL,
      ref TEXT,
      on_chain INTEGER DEFAULT 0,
      tx_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      webhook_id INTEGER,
      interval_min INTEGER DEFAULT 60,
      last_run_at TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["verdict"]',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  return {
    async insertScreen({ target, kind, verdict, signals }) {
      const si = run('INSERT INTO submissions (target, kind) VALUES (?, ?)', target, kind);
      const submissionId = Number(si.lastInsertRowid);
      const vi = run('INSERT INTO verdicts (submission_id, verdict, risk_score, confidence, reasons_json) VALUES (?,?,?,?,?)',
        submissionId, verdict.verdict, verdict.riskScore, verdict.confidence, JSON.stringify(verdict.reasons));
      const verdictId = Number(vi.lastInsertRowid);
      for (const s of signals) {
        run('INSERT INTO signals (verdict_id, intent, risk, contribution, confidence, tx_hash, raw_json) VALUES (?,?,?,?,?,?,?)',
          verdictId, s.intent, s.risk, s.contribution, s.confidence, s.txHash || null, JSON.stringify({ evidence: s.evidence }));
      }
      return { submissionId, verdictId };
    },
    async insertProof(o) {
      run('INSERT INTO proofs (verdict_id, mode, commit_digest, ref, on_chain, tx_count) VALUES (?,?,?,?,?,?)',
        o.verdictId, o.mode, o.commit, o.ref, o.onChain ? 1 : 0, o.txCount || 0);
    },
    async getVerdictAudit(submissionId) {
      const sub = get('SELECT * FROM submissions WHERE id = ?', submissionId);
      if (!sub) return null;
      const v = get('SELECT * FROM verdicts WHERE submission_id = ?', submissionId);
      if (!v) return null;
      const sigRows = all('SELECT * FROM signals WHERE verdict_id = ?', v.id);
      const proofs = all('SELECT * FROM proofs WHERE verdict_id = ?', v.id);
      return auditFrom(sub, v, sigRows, proofs);
    },
    async addWebhook({ url, events = ['verdict'] }) {
      const r = run('INSERT INTO webhooks (url, events) VALUES (?, ?)', url, JSON.stringify(events));
      return Number(r.lastInsertRowid);
    },
    async listWebhooks() {
      return all('SELECT * FROM webhooks').map((w) => ({ id: w.id, url: w.url, events: JSON.parse(w.events || '[]'), active: !!w.active }));
    },
    async deleteWebhook(id) { run('DELETE FROM webhooks WHERE id = ?', id); },
    async addWatch({ target, kind = 'token', webhookId = null, intervalMin = 60 }) {
      const r = run('INSERT INTO watchlist (target, kind, webhook_id, interval_min) VALUES (?,?,?,?)', target, kind, webhookId, intervalMin);
      return Number(r.lastInsertRowid);
    },
    async listWatches() { return all('SELECT * FROM watchlist'); },
    async deleteWatch(id) { run('DELETE FROM watchlist WHERE id = ?', id); },
    async flagWatchRunning(id, at) { run('UPDATE watchlist SET last_run_at = ? WHERE id = ?', at, id); },
    async pendingWatches() { return all('SELECT * FROM watchlist WHERE status = ?', 'active'); },
    // watch list joined with each target's latest verdict (for the dashboard)
    async watchStatus() {
      const rows = all('SELECT * FROM watchlist WHERE status = ?', 'active');
      const out = [];
      for (const w of rows) {
        const v = get(`
          SELECT v.verdict, v.risk_score, v.confidence, v.created_at
          FROM verdicts v JOIN submissions s ON s.id = v.submission_id
          WHERE s.target = ? ORDER BY v.id DESC LIMIT 1`, w.target);
        out.push({ id: w.id, target: w.target, kind: w.kind, intervalMin: w.interval_min, lastRunAt: w.last_run_at, createdAt: w.created_at, latestVerdict: v ? { verdict: v.verdict, riskScore: v.risk_score, confidence: v.confidence, at: v.created_at } : null });
      }
      return out;
    },
    async close() { db.close(); },
    get backend() { return 'sqlite'; },
  };
}

// ------------------- Postgres (Neon) backend -------------------
// Uses a dedicated schema (default `sentinelvault`) so it never collides with
// other projects sharing the same Neon database. Override with SENTINEL_PG_SCHEMA.
async function pgStore(databaseUrl) {
  const { default: pg } = await import('pg');
  const schema = process.env.SENTINEL_PG_SCHEMA || 'sentinelvault';
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS submissions (id SERIAL PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS verdicts (id SERIAL PRIMARY KEY, submission_id INT REFERENCES submissions(id), verdict TEXT NOT NULL, risk_score INT NOT NULL, confidence INT NOT NULL, reasons_json TEXT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS signals (id SERIAL PRIMARY KEY, verdict_id INT REFERENCES verdicts(id), intent TEXT NOT NULL, risk REAL, contribution REAL, confidence REAL, tx_hash TEXT, raw_json TEXT);
    CREATE TABLE IF NOT EXISTS proofs (id SERIAL PRIMARY KEY, verdict_id INT REFERENCES verdicts(id), mode TEXT NOT NULL, commit_digest TEXT NOT NULL, ref TEXT, on_chain BOOLEAN DEFAULT false, tx_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS watchlist (id SERIAL PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, webhook_id INT, interval_min INT DEFAULT 60, last_run_at TIMESTAMPTZ, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS webhooks (id SERIAL PRIMARY KEY, url TEXT NOT NULL, events TEXT DEFAULT '["verdict"]', active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
  `);
  const q = (text, params = []) => client.query(text, params);
  return {
    async insertScreen({ target, kind, verdict, signals }) {
      const si = await q('INSERT INTO submissions (target, kind) VALUES ($1,$2) RETURNING id', [target, kind]);
      const submissionId = si.rows[0].id;
      const vi = await q('INSERT INTO verdicts (submission_id, verdict, risk_score, confidence, reasons_json) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [submissionId, verdict.verdict, verdict.riskScore, verdict.confidence, JSON.stringify(verdict.reasons)]);
      const verdictId = vi.rows[0].id;
      for (const s of signals) {
        await q('INSERT INTO signals (verdict_id, intent, risk, contribution, confidence, tx_hash, raw_json) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [verdictId, s.intent, s.risk, s.contribution, s.confidence, s.txHash || null, JSON.stringify({ evidence: s.evidence })]);
      }
      return { submissionId, verdictId };
    },
    async insertProof(o) {
      await q('INSERT INTO proofs (verdict_id, mode, commit_digest, ref, on_chain, tx_count) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.verdictId, o.mode, o.commit, o.ref, !!o.onChain, o.txCount || 0]);
    },
    async getVerdictAudit(submissionId) {
      const s = await q('SELECT * FROM submissions WHERE id=$1', [submissionId]);
      if (!s.rows.length) return null;
      const v = await q('SELECT * FROM verdicts WHERE submission_id=$1', [submissionId]);
      if (!v.rows.length) return null;
      const sigRows = await q('SELECT * FROM signals WHERE verdict_id=$1', [v.rows[0].id]);
      const proofs = await q('SELECT * FROM proofs WHERE verdict_id=$1', [v.rows[0].id]);
      const m = (r) => ({ id: r.id, target: r.target, kind: r.kind, created_at: r.created_at });
      return auditFrom(m(s.rows[0]), { verdict: v.rows[0].verdict, risk_score: v.rows[0].risk_score, confidence: v.rows[0].confidence, reasons_json: v.rows[0].reasons_json },
        sigRows.rows.map(m2), proofs.rows.map(m2));
    },
    async addWebhook({ url, events = ['verdict'] }) {
      const r = await q('INSERT INTO webhooks (url, events) VALUES ($1,$2) RETURNING id', [url, JSON.stringify(events)]);
      return r.rows[0].id;
    },
    async listWebhooks() {
      const r = await q('SELECT * FROM webhooks');
      return r.rows.map((w) => ({ id: w.id, url: w.url, events: JSON.parse(w.events || '[]'), active: !!w.active }));
    },
    async deleteWebhook(id) { await q('DELETE FROM webhooks WHERE id=$1', [id]); },
    async addWatch({ target, kind = 'token', webhookId = null, intervalMin = 60 }) {
      const r = await q('INSERT INTO watchlist (target, kind, webhook_id, interval_min) VALUES ($1,$2,$3,$4) RETURNING id', [target, kind, webhookId, intervalMin]);
      return r.rows[0].id;
    },
    async listWatches() { const r = await q('SELECT * FROM watchlist'); return r.rows; },
    async deleteWatch(id) { await q('DELETE FROM watchlist WHERE id=$1', [id]); },
    async flagWatchRunning(id, at) { await q('UPDATE watchlist SET last_run_at=$2 WHERE id=$1', [id, at]); },
    async pendingWatches() { const r = await q("SELECT * FROM watchlist WHERE status='active'"); return r.rows; },
    async watchStatus() {
      const ws = await q("SELECT * FROM watchlist WHERE status='active'");
      const out = [];
      for (const w of ws.rows) {
        const v = await q(
          `SELECT v.verdict, v.risk_score, v.confidence, v.created_at
           FROM verdicts v JOIN submissions s ON s.id = v.submission_id
           WHERE s.target=$1 ORDER BY v.id DESC LIMIT 1`, [w.target]);
        const row = v.rows[0];
        out.push({ id: w.id, target: w.target, kind: w.kind, intervalMin: w.interval_min, lastRunAt: w.last_run_at, createdAt: w.created_at, latestVerdict: row ? { verdict: row.verdict, riskScore: row.risk_score, confidence: row.confidence, at: row.created_at } : null });
      }
      return out;
    },
    async close() { await client.end(); },
    get backend() { return 'postgres'; },
  };
}

async function m2(r) {
  return { id: r.id, intent: r.intent, risk: r.risk, contribution: r.contribution, confidence: r.confidence, tx_hash: r.tx_hash, raw_json: r.raw_json };
}

// ------------------- factory -------------------
export async function openStore() {
  const dbUrl = process.env.SENTINEL_DATABASE_URL;
  if (dbUrl) return pgStore(dbUrl);
  return sqliteStore(process.env.APP_DB || DEF_DB);
}
// SentinelVault storage (audit trail + submissions).
// Uses Node's built-in sqlite (node:sqlite) so dev/tests run with no external
// DB. Swap to Postgres/Neon by replacing this module behind the same fence.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function openDb(path) {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
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
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function insertScreen(db, { target, kind, verdict, signals }) {
  const insSub = db.prepare('INSERT INTO submissions (target, kind) VALUES (?, ?)');
  const info = insSub.run(target, kind);
  const submissionId = Number(info.lastInsertRowid);

  const insV = db.prepare(
    'INSERT INTO verdicts (submission_id, verdict, risk_score, confidence, reasons_json) VALUES (?,?,?,?,?)'
  );
  const vi = insV.run(
    submissionId,
    verdict.verdict,
    verdict.riskScore,
    verdict.confidence,
    JSON.stringify(verdict.reasons)
  );
  const verdictId = Number(vi.lastInsertRowid);

  const insS = db.prepare(
    'INSERT INTO signals (verdict_id, intent, risk, contribution, confidence, tx_hash, raw_json) VALUES (?,?,?,?,?,?,?)'
  );
  for (const s of signals) {
    insS.run(
      verdictId,
      s.intent,
      s.risk,
      s.contribution,
      s.confidence,
      s.txHash || null,
      JSON.stringify({ evidence: s.evidence })
    );
  }
  return { submissionId, verdictId };
}

export function insertProof(db, { verdictId, mode, commit, ref, onChain = false }) {
  db.prepare(
    'INSERT INTO proofs (verdict_id, mode, commit_digest, ref, on_chain) VALUES (?,?,?,?,?)'
  ).run(verdictId, mode, commit, ref, onChain ? 1 : 0);
}

export function getVerdictAudit(db, submissionId) {
  const sub = db
    .prepare('SELECT * FROM submissions WHERE id = ?')
    .get(submissionId);
  if (!sub) return null;
  const v = db
    .prepare('SELECT * FROM verdicts WHERE submission_id = ?')
    .get(submissionId);
  const sigRows = db
    .prepare('SELECT * FROM signals WHERE verdict_id = ?')
    .all(v.id);
  const proofs = db
    .prepare('SELECT * FROM proofs WHERE verdict_id = ?')
    .all(v.id)
    .map((p) => ({ mode: p.mode, commit: p.commit_digest, ref: p.ref, onChain: p.on_chain === 1 }));
  return {
    submission: sub,
    verdict: {
      verdict: v.verdict,
      riskScore: v.risk_score,
      confidence: v.confidence,
      reasons: JSON.parse(v.reasons_json || '[]'),
    },
    signals: sigRows.map((s) => ({
      intent: s.intent,
      risk: s.risk,
      contribution: s.contribution,
      confidence: s.confidence,
      txHash: s.tx_hash,
      evidence: (() => {
        try {
          return JSON.parse(s.raw_json || '{}').evidence;
        } catch {
          return {};
        }
      })(),
    })),
    proofs,
  };
}
// SentinelVault HTTP API (Track 3).
// POST /screen        -> run a target through verified multi-intent intelligence and return a verdict.
// GET  /submissions/:id -> full audit trail (verdict + per-signal provenance).
// GET  /health
import http from 'node:http';
import { URL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from './verdict.js';
import { createSignalSource } from './telegraph.js';
import { commitVerdict, createRecorder } from './proof.js';
import { openDb, insertScreen, insertProof, getVerdictAudit } from './storage.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8090;
const SOURCE_MODE = process.env.SIGNAL_SOURCE === 'live' ? 'live' : 'simulated';
const PROOF_MODE = process.env.PROOF_MODE === 'erc8183' ? 'erc8183' : 'logging';
const DB_PATH = process.env.APP_DB || join(__dir, '..', 'sentinelvault.db');

const db = openDb(DB_PATH);
const signalsFor = createSignalSource(SOURCE_MODE);
const recordProof = createRecorder(PROOF_MODE);
console.log(`SentinelVault API on :${PORT} | signal source: ${SOURCE_MODE} | proof: ${PROOF_MODE}`);

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function handleScreen(req, res) {
  const body = await readBody(req);
  const { target, kind = 'token' } = body;
  if (!target || typeof target !== 'string' || !target.trim()) {
    return send(res, 422, { error: 'target_required', detail: 'POST a "target" (address or url)' });
  }
  try {
    const rawSignals = await signalsFor(target.trim());
    const verdict = screen(rawSignals);
    const { submissionId, verdictId } = insertScreen(db, {
      target: target.trim(),
      kind,
      verdict,
      signals: verdict.signals,
    });
    const commit = commitVerdict(verdict);
    const proof = await recordProof({ commit, verdictId });
    insertProof(db, {
      verdictId,
      mode: proof.mode,
      commit,
      ref: proof.ref,
      onChain: proof.onChain,
    });
    return send(res, 200, { id: submissionId, verdictId, target, ...verdict, proof });
  } catch (err) {
    return send(res, 500, { error: 'screen_failed', detail: err.message });
  }
}

function handleGet(req, res, idStr) {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return send(res, 400, { error: 'bad_id' });
  const audit = getVerdictAudit(db, id);
  if (!audit) return send(res, 404, { error: 'not_found' });
  return send(res, 200, audit);
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/health') return send(res, 200, { status: 'ok', source: SOURCE_MODE });
    if (url.pathname === '/screen' && req.method === 'POST') return handleScreen(req, res);
    const subMatch = /^\/submissions\/(\d+)$/.exec(url.pathname);
    if (subMatch && req.method === 'GET') return handleGet(req, res, subMatch[1]);
    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    return send(res, 500, { error: 'server_error', detail: err.message });
  }
});

server.listen(PORT);
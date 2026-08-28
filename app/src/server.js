// SentinelVault HTTP API (Track 3).
// POST /screen          -> run a target through verified multi-intent intelligence, return a verdict (+ webhook fan-out)
// GET  /submissions/:id -> full audit trail (verdict + per-signal provenance)
// POST /webhooks        -> register a callback URL (events: verdict)
// GET  /webhooks        -> list callbacks
// DELETE /webhooks/:id  -> remove a callback
// POST /watch           -> add an auto-watched target (scheduled re-screen)
// GET  /watch           -> list watched targets
// DELETE /watch/:id     -> stop watching
// GET  /health
import http from 'node:http';
import { URL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { screen } from './verdict.js';
import { screenWithReroute } from './reroute.js';
import { createSignalSource } from './telegraph.js';
import { commitVerdict, createRecorder } from './proof.js';
import { openStore } from './storage.js';
import { checkAuth } from './auth.js';
import { deliver, addVerdictWebhook } from './webhook.js';
import { startWatcher } from './watcher.js';
import { buildChallenge, verifyPayment, send402, PAY_TO, PRICE_USDC, CHAIN_ID } from './payment-gate.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dir, '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PORT = process.env.PORT || 8090;
const SOURCE_MODE = process.env.SIGNAL_SOURCE === 'live' ? 'live' : 'simulated';
const PROOF_MODE = process.env.PROOF_MODE === 'erc8183' ? 'erc8183' : 'logging';
const REROUTE = process.env.SENTINEL_REROUTE !== '0';
const PAYWALL = process.env.SENTINEL_PAYWALL !== '0'; // 0 disables the 402 gate (dev)

const store = await openStore();
const signalsFor = await createSignalSource(SOURCE_MODE);
const recordProof = createRecorder(PROOF_MODE);

// shared: run a target through the full pipeline, persist, fan out to webhooks
async function runAndRecord(target, kind) {
  let rawSignals = await signalsFor(target);
  const verdict = REROUTE
    ? await screenWithReroute(signalsFor, target, rawSignals)
    : screen(rawSignals);

  const { submissionId, verdictId } = await store.insertScreen({ target, kind, verdict, signals: verdict.signals });
  const commit = commitVerdict(verdict);
  const proof = await recordProof({ commit, verdictId, signals: verdict.signals });
  await store.insertProof({ verdictId, mode: proof.mode, commit, ref: proof.ref, onChain: proof.onChain, txCount: proof.txCount || 0 });
  return { submissionId, verdictId, verdict, proof };
}

const watcher = startWatcher({ store, signalsFor, recordProof });

console.log(`SentinelVault API on :${PORT} | signal source: ${SOURCE_MODE} | proof: ${PROOF_MODE} | db: ${store.backend}`);

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}

async function handleScreen(req, res) {
  const body = await readBody(req);
  const { target, kind = 'token' } = body;
  if (!target || typeof target !== 'string' || !target.trim()) {
    return send(res, 422, { error: 'target_required', detail: 'POST a "target" (address or url)' });
  }
  // Paid endpoint: require a valid PAYMENT-SIGNATURE unless the gate is disabled.
  if (PAYWALL) {
    const challenged = buildChallenge('/screen');
    const sigHeader = req.headers['payment-signature'];
    try {
      if (!sigHeader) throw { code: 'payment_required' };
      await verifyPayment(sigHeader); // throws {code,detail} on any failure
    } catch (e) {
      return send402(res, challenged, { code: e && e.code, detail: e && e.detail });
    }
  }
  try {
    const out = await runAndRecord(target.trim(), kind);
    deliver(store, 'verdict', { target, ...out.verdict, proof: out.proof, submissionId: out.submissionId });
    return send(res, 200, { id: out.submissionId, verdictId: out.verdictId, target, ...out.verdict, proof: out.proof });
  } catch (err) {
    return send(res, 500, { error: 'screen_failed', detail: err.message });
  }
}

async function handleGet(req, res, idStr) {
  const id = Number(idStr);
  if (!Number.isInteger(id)) return send(res, 400, { error: 'bad_id' });
  const audit = await store.getVerdictAudit(id);
  if (!audit) return send(res, 404, { error: 'not_found' });
  return send(res, 200, audit);
}

async function handleWebhooks(req, res) {
  if (req.method === 'GET') {
    if (!checkAuth(req, res, false)) return;
    return send(res, 200, await store.listWebhooks());
  }
  if (req.method === 'POST') {
    if (!checkAuth(req, res, true)) return;
    const body = await readBody(req);
    if (!body.url || typeof body.url !== 'string') return send(res, 422, { error: 'url_required' });
    const id = await addVerdictWebhook(store, { url: body.url, events: body.events || ['verdict'] });
    return send(res, 201, { id, ok: true });
  }
  return send(res, 405, { error: 'method_not_allowed' });
}

async function handleWatch(req, res) {
  if (req.method === 'GET') {
    if (!checkAuth(req, res, false)) return;
    return send(res, 200, await store.listWatches());
  }
  if (req.method === 'POST') {
    if (!checkAuth(req, res, true)) return;
    const body = await readBody(req);
    if (!body.target || typeof body.target !== 'string') return send(res, 422, { error: 'target_required' });
    const id = await store.addWatch({ target: body.target, kind: body.kind || 'token', webhookId: body.webhookId || null, intervalMin: body.intervalMin || 60 });
    return send(res, 201, { id, ok: true });
  }
  return send(res, 405, { error: 'method_not_allowed' });
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE',
  });
  res.end(JSON.stringify(obj));
}

// Serve the frontend (app/web) so a single URL hosts UI + API.
// Routing: /  = marketing landing, /app = the live screening product.
async function serveStatic(req, res, pathname) {
  let rel;
  if (pathname === '/') rel = 'landing.html';
  else if (pathname === '/app') rel = 'app.html';
  else rel = pathname.slice(1);
  // prevent path traversal
  if (rel.includes('..') || rel.startsWith('/')) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(join(WEB_DIR, rel));
    const ext = '.' + rel.split('.').pop().toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    return send(res, 404, { error: 'not_found', detail: rel });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/health') return send(res, 200, { status: 'ok', source: SOURCE_MODE, db: store.backend, paywall: PAYWALL, priceUsdc: PRICE_USDC, payTo: PAY_TO, chainId: CHAIN_ID });
    if (url.pathname === '/screen/quote' && req.method === 'GET') {
      // Expose the payment challenge + metadata so the wallet modal can drive it.
      const ch = JSON.parse(Buffer.from(buildChallenge('/screen'), 'base64').toString());
      return send(res, 200, { requiresPayment: PAYWALL, challenge: ch, payTo: PAY_TO, priceUsdc: PRICE_USDC, chainId: CHAIN_ID });
    }
    if (url.pathname === '/screen' && req.method === 'POST') {
      // Payment is the authorization for /screen (paywall) — API key not required here.
      return handleScreen(req, res);
    }
    if (url.pathname === '/webhooks') return handleWebhooks(req, res);
    if (url.pathname === '/watch') return handleWatch(req, res);
    const wDel = /^\/webhooks\/(\d+)$/.exec(url.pathname);
    if (wDel && req.method === 'DELETE') {
      if (!checkAuth(req, res, true)) return;
      await store.deleteWebhook(Number(wDel[1]));
      return send(res, 200, { ok: true });
    }
    const wtDel = /^\/watch\/(\d+)$/.exec(url.pathname);
    if (wtDel && req.method === 'DELETE') {
      if (!checkAuth(req, res, true)) return;
      await store.deleteWatch(Number(wtDel[1]));
      return send(res, 200, { ok: true });
    }
    const subMatch = /^\/submissions\/(\d+)$/.exec(url.pathname);
    if (subMatch && req.method === 'GET') {
      if (!checkAuth(req, res, false)) return;
      return handleGet(req, res, subMatch[1]);
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    return send(res, 500, { error: 'server_error', detail: err.message });
  }
});

server.listen(PORT);
process.on('SIGTERM', () => { watcher && watcher.stop(); process.exit(0); });
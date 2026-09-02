// SentinelVault CVE_LOOKUP miner data service.
// Wraps the free CIRCL CVE API (cve.circl.lu, no API key) into a normalized
// Telegraph signal: severity (label), cvss score, confidence, description.
//
// Endpoint exposed for Telegraph:
//   GET /cve?cve_id=CVE-2021-44228
//
// Response shape (matches semantics.signal_mapping in miner.yaml):
//   { cve_id, severity, cvss_score, confidence, description }

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { URL } from 'node:url';
import { createStatsStore } from './stats-store.js';

// This VM's IPv6 egress is broken and undici/fetch cannot reach the upstream;
// use node:https pinned to IPv4 (proven to work) for the CVE upstream call.
dns.setDefaultResultOrder('ipv4first');

const PORT = process.env.PORT || 8085;
const UPSTREAM = 'https://cve.circl.lu/api/cve';
const UA = 'sentinelvault-miner/1.0';
const SEVERITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function getJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        family: 4,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            const err = new Error(`upstream ${res.statusCode}`);
            err.status = res.statusCode;
            return reject(err);
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('bad json from upstream'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

// In-memory cache (TTL'd). The Telegraph node also caches via cache_ttl_sec.
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Request/usage counters for the guardrail (≥100 real requests per intent) + health.
// Durable: persisted to Postgres (Neon) when SENTINEL_DATABASE_URL is set so a Render
// free-tier restart does NOT zero the accumulated volume; else JSON file / in-memory.
let stats;
let flushStats;
async function initStats() {
  const store = await createStatsStore({ databaseUrl: process.env.SENTINEL_DATABASE_URL });
  stats = store.state;
  flushStats = store.flush;
}
const recordHit = (cached) => {
  stats.requests += 1;
  if (cached) stats.cacheHits += 1;
};
const recordCve = (cveId) => {
  const k = (cveId || 'unknown').toUpperCase();
  stats.byCve[k] = (stats.byCve[k] || 0) + 1;
};

function normalizeSeverity(vendorSeverity, score) {
  const s = vendorSeverity ? String(vendorSeverity).toUpperCase() : '';
  if (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(s)) return s;
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  return 'LOW';
}

function extractDescription(cna) {
  const arr = cna?.descriptions || [];
  const en = arr.find((d) => d?.lang === 'en');
  const fallback = arr[0];
  return (en || fallback)?.value || '';
}

function extractScore(containers = {}) {
  const found = [];
  const push = (m) => {
    if (!m) return;
    for (const fam of ['cvssV4_0', 'cvssV3_1', 'cvssV3_0', 'cvssV2_0']) {
      const v = m[fam];
      if (v && typeof v?.baseScore === 'number') {
        found.push(v);
        break;
      }
    }
  };
  // CNA block holds vendor metrics; ADP block (NVD) holds the authoritative CVSS.
  ((containers?.cna || {}).metrics || []).forEach(push);
  (containers?.adp || []).forEach((a) => (a?.metrics || []).forEach(push));
  const best = found[0] || {};
  return {
    score: typeof best.baseScore === 'number' ? best.baseScore : null,
    baseSeverity: best.baseSeverity || null,
  };
}

async function fetchCve(cveId) {
  const cached = cache.get(cveId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const raw = await getJson(`${UPSTREAM}/${cveId}`);
  const meta = raw?.cveMetadata || {};
  const cna = raw?.containers?.cna || {};
  const { score, baseSeverity } = extractScore(raw?.containers);
  const severity = normalizeSeverity(baseSeverity, score);
  const data = {
    cve_id: cveId.toUpperCase(),
    severity,
    cvss_score: typeof score === 'number' ? Math.round(score * 10) / 10 : null,
    confidence: 1.0,
    description: extractDescription(cna).trim(),
    cve_title: String(cna?.title || '').trim(),
    published: meta?.datePublished || null,
    modified: meta?.dateUpdated || null,
  };
  cache.set(cveId, { ts: Date.now(), data });
  return data;
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/health') return send(res, 200, { status: 'ok', miner: 'sentinelvault-cve', requests: stats.requests, errors: stats.errors });

    if (url.pathname === '/metrics') {
      const body = {
        miner: 'sentinelvault-cve',
        backend: stats.backend,
        startedAt: stats.startedAt,
        totalRequests: stats.requests + (stats._priorRequests || 0),
        errors: stats.errors + (stats._priorErrors || 0),
        cacheHits: stats.cacheHits + (stats._priorHits || 0),
        byIntent: { CVE_LOOKUP: stats.requests + (stats._priorRequests || 0) },
        byCve: stats.byCve,
      };
      return send(res, 200, body);
    }

    if (url.pathname === '/cve') {
      const cveId = (url.searchParams.get('cve_id') || '').trim();
      if (!/^CVE-\d{4}-\d{4,7}$/i.test(cveId)) {
        stats.errors += 1;
        return send(res, 422, { error: 'invalid_cve_id', detail: `Expected CVE-YYYY-XXXX, got '${cveId}'` });
      }
      const cached = cache.get(cveId) && Date.now() - cache.get(cveId).ts < CACHE_TTL_MS;
      recordHit(!!cached);
      const data = await fetchCve(cveId);
      recordCve(cveId);
      flushStats();
      return send(res, 200, data);
    }

    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err?.status === 404) return send(res, 404, { error: 'cve_not_found', detail: 'Unknown CVE identifier' });
    if (err?.code === 'ABORT_ERR') return send(res, 504, { error: 'upstream_timeout' });
    console.error('handler error', err?.message);
    return send(res, 502, { error: 'upstream_error', detail: err?.message });
  }
});

server.listen(PORT, () => console.log(`CVE miner service listening on :${PORT}`));

// Flush counters so the last moments of a restart aren't lost.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await flushStats?.(); } catch {}
    process.exit(0);
  });
}
setInterval(() => flushStats?.().catch(() => {}), 60000).unref();

initStats();
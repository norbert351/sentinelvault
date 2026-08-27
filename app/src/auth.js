// SentinelVault API auth. If ANON_READONLY is not set and SENTINEL_API_KEY is,
// /screen and /watch writes require `Authorization: Bearer <key>`. Read endpoints
// (GET /submissions) stay public so the verdict audit is shareable to judges.
import crypto from 'node:crypto';

const KEY = process.env.SENTINEL_API_KEY || '';
const ANON = process.env.SENTINEL_ANON_READONLY === '1';

function timingSafeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Returns true when the request is authorized for a WRITE (screen/watch/delete).
export function authorizedWrite(req) {
  if (!KEY) return true; // no key configured -> open (dev)
  if (ANON) return true; // explicitly opened for demo/judging
  const token = bearer(req);
  return !!token && timingSafeEq(token, KEY);
}

// Read guard: when key set, return 401 to authorized clients on reads too unless anon.
export function checkAuth(req, res, write) {
  if (write) {
    if (!authorizedWrite(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'unauthorized', detail: 'Bearer token required' }));
      return false;
    }
    return true;
  }
  if (KEY && !ANON) {
    const token = bearer(req);
    if (!token || !timingSafeEq(token, KEY)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'unauthorized', detail: 'Bearer token required' }));
      return false;
    }
  }
  return true;
}
// SentinelVault B2B SDK — wraps the /screen API for programmatic vetting.
// Usage:
//   import SentinelVault from '@sentinelvault/sdk';
//   const sv = new SentinelVault({ baseUrl: 'https://app.example.com', apiKey: '...' });
//   const verdict = await sv.screen('0xdeadbeef...', 'token');
//   const history = await sv.verdict(1);
export class SentinelVault {
  constructor({ baseUrl, apiKey, timeoutMs = 120_000 }) {
    if (!baseUrl) throw new Error('SentinelVault: baseUrl required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.timeoutMs = timeoutMs;
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async _req(path, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...opts, headers: this._headers(opts.headers), signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(body.error || `HTTP ${res.status}`);
        err.status = res.status; err.detail = body.detail; throw err;
      }
      return body;
    } finally { clearTimeout(t); }
  }

  // Run a vetting verdict on a target (address, url, CVE, or text).
  async screen(target, kind = 'token') {
    return this._req('/screen', { method: 'POST', body: JSON.stringify({ target, kind }) });
  }

  // Fetch a full audit trail (verdict + per-signal provenance).
  async verdict(id) {
    return this._req(`/submissions/${id}`);
  }

  // Register a callback webhook for verdict events.
  async addWebhook(url, events = ['verdict']) {
    return this._req('/webhooks', { method: 'POST', body: JSON.stringify({ url, events }) });
  }

  // Add a target to the auto-watcher (scheduled re-screens).
  async watch(target, kind = 'token', intervalMin = 60) {
    return this._req('/watch', { method: 'POST', body: JSON.stringify({ target, kind, intervalMin }) });
  }

  async watches() { return this._req('/watch'); }
  async stopWatch(id) { return this._req(`/watch/${id}`, { method: 'DELETE' }); }

  async health() { return this._req('/health'); }
}

export default SentinelVault;
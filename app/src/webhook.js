// SentinelVault webhook deliverer. When a verdict lands (screened or watched),
// POSTs a JSON payload to each registered webhook URL subscribed to 'verdict'.
// Fire-and-forget with a short retry (once), no backoff queue — keep it simple.

export function deliver(store, event, payload) {
  const deliverOne = async (hook) => {
    try {
      await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SentinelVault/1.0' },
        body: JSON.stringify({ event, data: payload }),
      });
    } catch {
      // one retry
      try {
        await fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event, data: payload }),
        });
      } catch {}
    }
  };
  return (async () => {
    try {
      const hooks = await store.listWebhooks();
      const matches = hooks.filter((h) => h.active && (h.events || []).includes(event));
      await Promise.all(matches.map(deliverOne));
      return matches.length;
    } catch {
      return 0;
    }
  })();
}

export async function addVerdictWebhook(store, { url, events = ['verdict'] }) {
  return store.addWebhook({ url, events });
}
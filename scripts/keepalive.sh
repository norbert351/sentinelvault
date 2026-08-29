#!/usr/bin/env bash
# SentinelVault keep-alive: ping the free Render service so it doesn't idle-sleep
# (free tier sleeps after ~15 min without traffic). Runs every ~12 min via cron.
# Quiet on success; only prints when something's wrong (watchdog pattern — an empty
# stdout means "all good, nothing to report").
set -u
URL="${URL:-https://sentinelvault-app.onrender.com/health}"
code=""
code=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$URL" 2>/dev/null)
if [ "$code" = "200" ] || [ "$code" = "402" ]; then
  # 200 = healthy; 402 = healthy AND paywall active (still served). Both mean alive.
  exit 0
fi
echo "SENTINELVAULT KEEPALIVE WARN: health check returned HTTP ${code:-<timeout/no-response>} for ${URL}"
exit 1
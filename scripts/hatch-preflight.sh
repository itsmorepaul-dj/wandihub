#!/bin/bash
# hatch-preflight.sh — Verify the Hatch platform is reachable before a deploy.
#
# Run this FIRST, before building the tar / uploading. The Hatch platform host
# is internal-only (reachable solely over the GlobalProtect VPN). When the VPN
# tunnel goes half-open (common after sleep/wake or a long idle), packets to it
# silently black-hole — which surfaces mid-deploy as HTTP 000, hung uploads, or
# TLS "certificate verification" errors. Catching it up front turns a failed
# mid-deploy into a 5-second "re-toggle your VPN" before any work is done.
#
# Exit 0 = reachable, proceed. Exit 1 = tunnel looks stale, fix VPN first.
#
# Usage: ./scripts/hatch-preflight.sh

set -uo pipefail

HOST="platform.hatch.internal.ai.dowjones.io"
URL="https://$HOST/"

# A TCP+TLS reach is all we need — any HTTP response (even 401/403) proves the
# tunnel + DNS + TLS path is live. Only a connection failure (000) means the
# tunnel is dead. --max-time keeps a black-holed route from hanging.
code="$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' "$URL" 2>/dev/null)"

if [[ "$code" == "000" || -z "$code" ]]; then
  echo "❌ Hatch platform ($HOST) is UNREACHABLE."
  echo ""
  echo "   This almost always means the GlobalProtect VPN tunnel is stale"
  echo "   (half-open after sleep/wake or idle). Fix it, then retry:"
  echo ""
  echo "     1. Quit GlobalProtect completely (menu bar → Quit), then relaunch."
  echo "        (A full quit+relaunch rebuilds routes — more reliable than"
  echo "         the disable/enable toggle.)"
  echo "     2. Wait ~10s for the tunnel + routes to re-establish."
  echo "     3. Re-run this preflight (or just say 'deploy' again)."
  echo ""
  exit 1
fi

echo "✅ Hatch platform reachable (HTTP $code) — VPN tunnel is healthy. OK to deploy."
exit 0

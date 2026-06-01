#!/bin/bash
# maintenance.sh - Toggle maintenance mode on Railway
#
# Usage:
#   ./scripts/maintenance.sh off        # turn off maintenance mode
#   ./scripts/maintenance.sh on         # turn on maintenance mode (immediate lockout)
#   ./scripts/maintenance.sh status     # check current state

set -euo pipefail

if [[ -z "${DCC_SEED_SECRET:-}" ]]; then
  _SETTINGS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.claude/settings.local.json"
  if [[ -f "$_SETTINGS" ]]; then
    DCC_SEED_SECRET="$(python3 -c "import json; print(json.load(open('$_SETTINGS')).get('env',{}).get('DCC_SEED_SECRET',''))" 2>/dev/null)"
    export DCC_SEED_SECRET
  fi
fi
if [[ -z "${DCC_SEED_SECRET:-}" && -f "$HOME/.openclaw/.env" ]]; then
  export $(grep '^DCC_SEED_SECRET=' "$HOME/.openclaw/.env" | head -1)
fi

RAILWAY_URL="https://wandihub.up.railway.app"

if [[ -z "${DCC_SEED_SECRET:-}" ]]; then
  echo "ERROR: DCC_SEED_SECRET not set."
  exit 1
fi

ACTION="${1:-status}"

case "$ACTION" in
  off)
    curl -s -X POST "$RAILWAY_URL/api/maintenance" \
      -H "Content-Type: application/json" \
      -H "X-Seed-Secret: $DCC_SEED_SECRET" \
      -d '{"enabled": false}' | python3 -m json.tool
    ;;
  on)
    curl -s -X POST "$RAILWAY_URL/api/maintenance" \
      -H "Content-Type: application/json" \
      -H "X-Seed-Secret: $DCC_SEED_SECRET" \
      -d '{"enabled": true}' | python3 -m json.tool
    ;;
  status)
    curl -s "$RAILWAY_URL/api/maintenance" | python3 -m json.tool
    ;;
  *)
    echo "Usage: $0 {on|off|status}"
    exit 1
    ;;
esac

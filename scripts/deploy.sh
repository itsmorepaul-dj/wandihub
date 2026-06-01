#!/bin/bash
# deploy.sh - Deploy code to Railway
#
# Usage:
#   DCC_DEPLOY_OK=1 ./scripts/deploy.sh          # push code, verify data intact
#   DCC_DEPLOY_OK=1 ./scripts/deploy.sh --data    # upload local DB to Railway (no code push)
#
# Railway volume at /app/data persists the SQLite DB across deploys.
# Code pushes rebuild the container but the volume survives.
# Production data is NEVER overwritten by a code deploy.
#
# --data mode is for intentionally seeding/replacing the Railway DB
# with the local copy (e.g., after schema changes or data migrations).
#
# Requires:
#   DCC_SEED_SECRET env var (shared with Railway)
#   DCC_DEPLOY_OK=1 env var (deployment gate)

set -euo pipefail

# Source seed secret: prefer the project-local Claude settings, then fall back
# to the legacy ~/.openclaw/.env (deprecated — being removed).
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DCC_DIR="$(dirname "$SCRIPT_DIR")"
LOCAL_DB="$DCC_DIR/data/shared.db"
RAILWAY_URL="https://wandihub.up.railway.app"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARNING:${NC} $1"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $1"; }

DATA_ONLY=false
[[ "${1:-}" == "--data" ]] && DATA_ONLY=true

# ── Preflight checks ──────────────────────────────────────────────
if [[ -z "${DCC_DEPLOY_OK:-}" ]]; then
  err "DCC_DEPLOY_OK not set. Deployment blocked."
  exit 1
fi

if [[ -z "${DCC_SEED_SECRET:-}" ]]; then
  err "DCC_SEED_SECRET not set. Cannot authenticate with Railway."
  echo "  Set it: export DCC_SEED_SECRET=<token>"
  exit 1
fi

# ── Data-only deploy: upload local DB to Railway ──────────────────
if [[ "$DATA_ONLY" == "true" ]]; then
  if [[ ! -f "$LOCAL_DB" ]]; then
    err "Local database not found: $LOCAL_DB"
    exit 1
  fi

  # Stop local servers so DB file is authoritative
  API_PID=$(lsof -ti:3001 2>/dev/null || true)
  VITE_PID=$(lsof -ti:5173 2>/dev/null || true)
  if [[ -n "$API_PID" || -n "$VITE_PID" ]]; then
    log "Stopping local servers..."
    [[ -n "$API_PID" ]] && kill $API_PID 2>/dev/null || true
    [[ -n "$VITE_PID" ]] && kill $VITE_PID 2>/dev/null || true
    sleep 2
    log "Local servers stopped."
  fi

  if ! sqlite3 "$LOCAL_DB" "PRAGMA integrity_check;" | grep -q "ok"; then
    err "Local database failed integrity check!"
    exit 1
  fi

  DB_SIZE=$(wc -c < "$LOCAL_DB" | tr -d ' ')

  # Download Railway DB as safety backup before overwriting
  log "Downloading Railway DB backup before overwrite..."
  BACKUP_TS=$(date +%Y%m%d_%H%M%S)
  BACKUP_DIR="$DCC_DIR/backups/railway/pre_data_${BACKUP_TS}"
  mkdir -p "$BACKUP_DIR"
  BACKUP_HTTP=$(curl -s -w "%{http_code}" -o "$BACKUP_DIR/shared.db" \
    -H "X-Seed-Secret: $DCC_SEED_SECRET" \
    "$RAILWAY_URL/api/download-db")
  if [[ "$BACKUP_HTTP" == "200" ]]; then
    log "Railway backup saved: $BACKUP_DIR/shared.db"
  else
    warn "Could not download Railway backup (HTTP $BACKUP_HTTP). Proceeding anyway."
  fi

  log "Uploading local database to Railway ($DB_SIZE bytes)..."
  UPLOAD_RESULT=$(curl -s -w "\n%{http_code}" -X POST "$RAILWAY_URL/api/upload-db" \
    -H "Content-Type: application/octet-stream" \
    -H "X-Seed-Secret: $DCC_SEED_SECRET" \
    --data-binary @"$LOCAL_DB")

  HTTP_CODE=$(echo "$UPLOAD_RESULT" | tail -1)
  BODY=$(echo "$UPLOAD_RESULT" | sed '$d')

  if [[ "$HTTP_CODE" != "200" ]]; then
    err "Upload failed with HTTP $HTTP_CODE"
    echo "$BODY"
    exit 1
  fi

  log "Upload response:"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"

  # Verify
  sleep 3
  LIVE_COUNTS=$(curl -sf "$RAILWAY_URL/api/table-counts" 2>/dev/null)
  TABLES=$(sqlite3 "$LOCAL_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
  PASS=true
  echo ""
  printf "%-30s %10s %10s %s\n" "Table" "Local" "Railway" "Status"
  printf "%-30s %10s %10s %s\n" "─────" "─────" "───────" "──────"
  for TABLE in $TABLES; do
    L_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";")
    R_COUNT=$(echo "$LIVE_COUNTS" | jq -r ".counts.\"$TABLE\" // \"?\"" 2>/dev/null)
    if [[ "$L_COUNT" == "$R_COUNT" ]]; then
      printf "%-30s %10s %10s ${GREEN}MATCH${NC}\n" "$TABLE" "$L_COUNT" "$R_COUNT"
    else
      printf "%-30s %10s %10s ${RED}MISMATCH${NC}\n" "$TABLE" "$L_COUNT" "$R_COUNT"
      PASS=false
    fi
  done

  # Restart local servers
  cd "$DCC_DIR"
  log "Restarting local servers..."
  NODE_ENV=production npm start >> /tmp/dcc-server.log 2>&1 &
  for i in {1..15}; do curl -sf http://localhost:3001/api/health &>/dev/null && break; sleep 1; done
  npm run dev >> /tmp/dcc-vite.log 2>&1 &
  for i in {1..10}; do curl -sf http://localhost:5173 &>/dev/null && break; sleep 1; done
  log "Local servers restarted."

  echo ""
  if [[ "$PASS" == "true" ]]; then
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  DATA UPLOAD COMPLETE — VERIFIED                 ${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
  else
    echo -e "${RED}══════════════════════════════════════════════════${NC}"
    echo -e "${RED}  DATA UPLOAD — VERIFICATION FAILED               ${NC}"
    echo -e "${RED}══════════════════════════════════════════════════${NC}"
    exit 1
  fi
  exit 0
fi

# ── Code deploy ───────────────────────────────────────────────────
cd "$DCC_DIR"
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  err "Not on main branch (on: $BRANCH)"
  exit 1
fi

# Capture pre-deploy state for verification
log "Recording Railway state before deploy..."
PRE_COUNTS=$(curl -sf "$RAILWAY_URL/api/table-counts" -H "X-Seed-Secret: $DCC_SEED_SECRET" 2>/dev/null || echo "")
if [[ -n "$PRE_COUNTS" ]]; then
  echo ""
  echo -e "${BLUE}RAILWAY (before deploy):${NC}"
  echo "$PRE_COUNTS" | jq '.counts' 2>/dev/null
  echo ""
else
  warn "Could not reach Railway for pre-deploy state."
fi

OLD_VERSION=$(curl -sf "$RAILWAY_URL/api/versions" 2>/dev/null | jq -r '.site_version // "unknown"' 2>/dev/null || echo "unknown")
log "Current Railway version: $OLD_VERSION"

log "Pushing code to Railway..."
DCC_DEPLOY_ACTIVE=1 git push origin main

log "Waiting for Railway to rebuild..."
ATTEMPTS=0
while [[ $ATTEMPTS -lt 60 ]]; do
  sleep 5
  NEW_VERSION=$(curl -sf "$RAILWAY_URL/api/versions" 2>/dev/null | jq -r '.site_version // "unknown"' 2>/dev/null || echo "unreachable")
  if [[ "$NEW_VERSION" != "unknown" && "$NEW_VERSION" != "unreachable" && "$NEW_VERSION" != "$OLD_VERSION" ]]; then
    log "Railway rebuilt with new version: $NEW_VERSION"
    break
  fi
  echo -n "."
  ATTEMPTS=$((ATTEMPTS + 1))
done
echo ""

if [[ $ATTEMPTS -eq 60 ]]; then
  err "Railway deploy timeout after 300s. New version not detected."
  err "Old version: $OLD_VERSION — check Railway dashboard."
  exit 1
fi

# ── Verify data survived the rebuild ──────────────────────────────
echo ""
log "=== POST-DEPLOYMENT VERIFICATION ==="
echo ""

sleep 3
PASS=true

LIVE_HEALTH=$(curl -sf "$RAILWAY_URL/api/health" 2>/dev/null)
if [[ -n "$LIVE_HEALTH" ]]; then
  log "Railway health: PASS"
else
  err "Railway health: FAIL (could not reach /api/health)"
  PASS=false
fi

POST_COUNTS=$(curl -sf "$RAILWAY_URL/api/table-counts" -H "X-Seed-Secret: $DCC_SEED_SECRET" 2>/dev/null)
if [[ -z "$POST_COUNTS" ]]; then
  err "Could not reach /api/table-counts on Railway."
  PASS=false
elif [[ -n "$PRE_COUNTS" ]]; then
  # Compare pre and post counts — they should be identical (volume persists)
  echo ""
  PRE_TABLES=$(echo "$PRE_COUNTS" | jq -r '.counts | keys[]' 2>/dev/null)
  printf "%-30s %10s %10s %s\n" "Table" "Before" "After" "Status"
  printf "%-30s %10s %10s %s\n" "─────" "──────" "─────" "──────"
  for TABLE in $PRE_TABLES; do
    PRE_C=$(echo "$PRE_COUNTS" | jq -r ".counts.\"$TABLE\" // \"?\"" 2>/dev/null)
    POST_C=$(echo "$POST_COUNTS" | jq -r ".counts.\"$TABLE\" // \"?\"" 2>/dev/null)
    if [[ "$PRE_C" == "$POST_C" ]]; then
      printf "%-30s %10s %10s ${GREEN}MATCH${NC}\n" "$TABLE" "$PRE_C" "$POST_C"
    else
      printf "%-30s %10s %10s ${RED}MISMATCH${NC}\n" "$TABLE" "$PRE_C" "$POST_C"
      PASS=false
    fi
  done
else
  # No pre-counts available, just show post state
  echo ""
  echo -e "${BLUE}RAILWAY (after deploy):${NC}"
  echo "$POST_COUNTS" | jq '.counts' 2>/dev/null
fi

# ── Restart local servers ──────────────────────────────────────────
echo ""
cd "$DCC_DIR"

# Stop if running
API_PID=$(lsof -ti:3001 2>/dev/null || true)
VITE_PID=$(lsof -ti:5173 2>/dev/null || true)
[[ -n "$API_PID" ]] && kill $API_PID 2>/dev/null || true
[[ -n "$VITE_PID" ]] && kill $VITE_PID 2>/dev/null || true
[[ -n "$API_PID" || -n "$VITE_PID" ]] && sleep 2

log "Starting local API server on :3001..."
NODE_ENV=production npm start >> /tmp/dcc-server.log 2>&1 &
for i in {1..15}; do
  if curl -sf http://localhost:3001/api/health &>/dev/null; then
    log "API server ready."
    break
  fi
  sleep 1
done
if ! curl -sf http://localhost:3001/api/health &>/dev/null; then
  warn "API server did not start. Check /tmp/dcc-server.log"
fi

log "Starting Vite dev server on :5173..."
npm run dev >> /tmp/dcc-vite.log 2>&1 &
for i in {1..10}; do
  if curl -sf http://localhost:5173 &>/dev/null; then
    log "Vite dev server ready."
    break
  fi
  sleep 1
done
if ! curl -sf http://localhost:5173 &>/dev/null; then
  warn "Vite did not start. Check /tmp/dcc-vite.log"
fi

# ── Final status ──────────────────────────────────────────────────
echo ""
if [[ "$PASS" == "true" ]]; then
  echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  DEPLOY COMPLETE — DATA INTACT                   ${NC}"
  echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Code deployed. Production data persisted via volume."
else
  echo -e "${RED}══════════════════════════════════════════════════${NC}"
  echo -e "${RED}  DEPLOY — VERIFICATION ISSUES                    ${NC}"
  echo -e "${RED}══════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Code deployed but verification had issues. Check above."
  exit 1
fi

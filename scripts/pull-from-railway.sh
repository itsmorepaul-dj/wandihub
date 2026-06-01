#!/bin/bash
# pull-from-railway.sh - Download entire Railway DB to local
#
# Usage:
#   ./scripts/pull-from-railway.sh
#
# Downloads the byte-for-byte SQLite file from Railway's /api/download-db.
# Backs up local DB first, then replaces it.
#
# Requires:
#   DCC_SEED_SECRET env var (shared with Railway)

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

# ── Preflight ────────────────────────────────────────────────────
if [[ -z "${DCC_SEED_SECRET:-}" ]]; then
  err "DCC_SEED_SECRET not set. Cannot authenticate with Railway."
  echo "  Set it: export DCC_SEED_SECRET=<token>"
  exit 1
fi

# ── Show Railway DB summary ──────────────────────────────────────
echo ""
echo -e "${BLUE}=== RAILWAY DATABASE ===${NC}"
echo ""

HEALTH=$(curl -sf "$RAILWAY_URL/api/health" 2>/dev/null) || {
  err "Railway is not reachable at $RAILWAY_URL"
  exit 1
}
log "Railway is up."

# ── Back up local DB ─────────────────────────────────────────────
if [[ -f "$LOCAL_DB" ]]; then
  BACKUP_TS=$(date +%Y%m%d_%H%M%S)
  BACKUP_DIR="$DCC_DIR/backups/local/pre_pull_${BACKUP_TS}"
  mkdir -p "$BACKUP_DIR"
  cp "$LOCAL_DB" "$BACKUP_DIR/shared.db"
  log "Local DB backed up to: $BACKUP_DIR/shared.db"

  echo ""
  echo -e "${BLUE}LOCAL (before pull):${NC}"
  TABLES=$(sqlite3 "$LOCAL_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
  printf "%-30s %s\n" "Table" "Rows"
  printf "%-30s %s\n" "─────" "────"
  for TABLE in $TABLES; do
    COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";")
    printf "%-30s %s\n" "$TABLE" "$COUNT"
  done
  echo ""
fi

# ── Download Railway DB ──────────────────────────────────────────
TEMP_DB="$DCC_DIR/data/shared.db.downloading"

log "Downloading Railway database..."
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$TEMP_DB" \
  -H "X-Seed-Secret: $DCC_SEED_SECRET" \
  "$RAILWAY_URL/api/download-db")

if [[ "$HTTP_CODE" != "200" ]]; then
  err "Download failed with HTTP $HTTP_CODE"
  rm -f "$TEMP_DB"
  exit 1
fi

# Validate downloaded file
DOWNLOAD_SIZE=$(wc -c < "$TEMP_DB" | tr -d ' ')
log "Downloaded $DOWNLOAD_SIZE bytes"

HEADER=$(head -c 16 "$TEMP_DB" | strings | head -1)
if [[ "$HEADER" != *"SQLite format 3"* ]]; then
  err "Downloaded file is not a valid SQLite database"
  rm -f "$TEMP_DB"
  exit 1
fi

if ! sqlite3 "$TEMP_DB" "PRAGMA integrity_check;" | grep -q "ok"; then
  err "Downloaded database failed integrity check!"
  rm -f "$TEMP_DB"
  exit 1
fi

# ── Stop local servers BEFORE replacing DB ───────────────────────
# Critical: a running server holds the old DB in memory and can overwrite
# the new file on any write operation (version bump, note edit, etc.)
WAS_RUNNING=false
API_PID=$(lsof -ti:3001 2>/dev/null || true)
VITE_PID=$(lsof -ti:5173 2>/dev/null || true)
if [[ -n "$API_PID" || -n "$VITE_PID" ]]; then
  WAS_RUNNING=true
  log "Stopping local servers before DB replacement..."
  [[ -n "$API_PID" ]] && kill $API_PID 2>/dev/null || true
  [[ -n "$VITE_PID" ]] && kill $VITE_PID 2>/dev/null || true
  sleep 2
fi

# ── Replace local DB ────────────────────────────────────────────
mv "$TEMP_DB" "$LOCAL_DB"
log "Local database replaced."

# ── Show result ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}LOCAL (after pull):${NC}"
TABLES=$(sqlite3 "$LOCAL_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
printf "%-30s %s\n" "Table" "Rows"
printf "%-30s %s\n" "─────" "────"
for TABLE in $TABLES; do
  COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";")
  printf "%-30s %s\n" "$TABLE" "$COUNT"
done

# ── Restart local servers ────────────────────────────────────────
cd "$DCC_DIR"

log "Starting API server on :3001..."
NODE_ENV=production npm start >> /tmp/dcc-server.log 2>&1 &
for i in {1..15}; do
  if curl -sf http://localhost:3001/api/health &>/dev/null; then
    log "API server ready."
    break
  fi
  sleep 1
done
if ! curl -sf http://localhost:3001/api/health &>/dev/null; then
  err "API server did not start. Check /tmp/dcc-server.log"
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

echo ""
log "PULL COMPLETE — local DB is now an exact copy of Railway."
log "View site at: http://localhost:5173"
echo ""
log "Rollback backup: ${BACKUP_DIR:-none}"

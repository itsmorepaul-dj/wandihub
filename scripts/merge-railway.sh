#!/bin/bash
# merge-railway.sh - Merge Railway production data into local DB
#
# Downloads Railway DB and integrates it into local:
#   - Railway-owned tables (projects, team, etc.): Railway REPLACES local
#   - Computed tables (note links): Local kept (rebuilt by code)
#   - Notes: merged (Railway hidden flags win, local new notes preserved)
#
# Usage:
#   ./scripts/merge-railway.sh          # merge + show report
#   ./scripts/merge-railway.sh --dry    # show report only, no changes
#
# This is the REQUIRED step before deploy.sh to ensure no data loss.

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DCC_DIR="$(dirname "$SCRIPT_DIR")"
LOCAL_DB="$DCC_DIR/data/shared.db"
RAILWAY_URL="https://wandihub.up.railway.app"
MERGE_TEMP="$DCC_DIR/data/.railway-merge-temp.db"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARNING:${NC} $1"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $1"; }
info() { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $1"; }

DRY_RUN=false
[[ "${1:-}" == "--dry" ]] && DRY_RUN=true

# ── Preflight ────────────────────────────────────────────────────
if [[ -z "${DCC_SEED_SECRET:-}" ]]; then
  err "DCC_SEED_SECRET not set."
  exit 1
fi

if [[ ! -f "$LOCAL_DB" ]]; then
  err "Local DB not found: $LOCAL_DB"
  exit 1
fi

# ── Download Railway DB ──────────────────────────────────────────
log "Downloading Railway database..."
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$MERGE_TEMP" \
  -H "X-Seed-Secret: $DCC_SEED_SECRET" \
  "$RAILWAY_URL/api/download-db")

if [[ "$HTTP_CODE" != "200" ]]; then
  err "Download failed (HTTP $HTTP_CODE). Cannot merge without Railway data."
  rm -f "$MERGE_TEMP"
  exit 1
fi

# Validate
HEADER=$(head -c 16 "$MERGE_TEMP" | strings | head -1)
if [[ "$HEADER" != *"SQLite format 3"* ]]; then
  err "Downloaded file is not a valid SQLite database."
  rm -f "$MERGE_TEMP"
  exit 1
fi

if ! sqlite3 "$MERGE_TEMP" "PRAGMA integrity_check;" | grep -q "ok"; then
  err "Railway DB failed integrity check."
  rm -f "$MERGE_TEMP"
  exit 1
fi

log "Railway DB downloaded and validated."

# ── Table classification ─────────────────────────────────────────
# Railway-owned: designer edits on production. Railway ALWAYS wins.
RAILWAY_TABLES="projects team project_assignments project_priorities business_lines brand_options users holidays app_versions activity_log"

# Local-computed: rebuilt by code (notes sync, etc.). Local kept.
LOCAL_TABLES="note_people_links note_project_links"

# Merged: notes come from gemini sync (local) + hidden flags (railway)
MERGE_TABLES="notes hidden_note_fingerprints"

# ── Diff Report ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}       RAILWAY ↔ LOCAL DATABASE DIFF REPORT       ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════${NC}"
echo ""

# Railway-owned tables
echo -e "${BLUE}── RAILWAY-OWNED TABLES (Railway wins) ──${NC}"
printf "%-30s %10s %10s %s\n" "Table" "Railway" "Local" "Action"
printf "%-30s %10s %10s %s\n" "─────" "───────" "─────" "──────"
for TABLE in $RAILWAY_TABLES; do
  R_COUNT=$(sqlite3 "$MERGE_TEMP" "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "?")
  L_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "?")
  if [[ "$R_COUNT" == "$L_COUNT" ]]; then
    STATUS="sync"
  elif [[ "$R_COUNT" -gt "$L_COUNT" ]] 2>/dev/null; then
    STATUS="${RED}RAILWAY HAS MORE (+$((R_COUNT - L_COUNT)))${NC}"
  else
    STATUS="${YELLOW}local has more (+$((L_COUNT - R_COUNT)))${NC}"
  fi
  printf "%-30s %10s %10s " "$TABLE" "$R_COUNT" "$L_COUNT"
  echo -e "$STATUS"
done
echo ""

# Show specific Railway-only rows for critical tables
for TABLE in projects team users holidays; do
  PK="id"
  R_IDS=$(sqlite3 "$MERGE_TEMP" "SELECT $PK FROM $TABLE ORDER BY $PK;" 2>/dev/null)
  L_IDS=$(sqlite3 "$LOCAL_DB" "SELECT $PK FROM $TABLE ORDER BY $PK;" 2>/dev/null)

  # Find Railway-only IDs
  RAILWAY_ONLY=""
  for ID in $R_IDS; do
    if ! echo "$L_IDS" | grep -qxF "$ID"; then
      RAILWAY_ONLY="$RAILWAY_ONLY $ID"
    fi
  done

  # Find local-only IDs
  LOCAL_ONLY=""
  for ID in $L_IDS; do
    if ! echo "$R_IDS" | grep -qxF "$ID"; then
      LOCAL_ONLY="$LOCAL_ONLY $ID"
    fi
  done

  if [[ -n "$RAILWAY_ONLY" ]]; then
    echo -e "  ${GREEN}+ Railway-only $TABLE:${NC}"
    for ID in $RAILWAY_ONLY; do
      if [[ "$TABLE" == "projects" ]]; then
        NAME=$(sqlite3 "$MERGE_TEMP" "SELECT name FROM projects WHERE id='$ID';" 2>/dev/null)
        echo "    $ID → $NAME"
      elif [[ "$TABLE" == "team" ]]; then
        NAME=$(sqlite3 "$MERGE_TEMP" "SELECT name FROM team WHERE id='$ID';" 2>/dev/null)
        echo "    $ID → $NAME"
      elif [[ "$TABLE" == "users" ]]; then
        EMAIL=$(sqlite3 "$MERGE_TEMP" "SELECT email FROM users WHERE id='$ID';" 2>/dev/null)
        echo "    $ID → $EMAIL"
      else
        NAME=$(sqlite3 "$MERGE_TEMP" "SELECT name FROM $TABLE WHERE id='$ID';" 2>/dev/null || echo "$ID")
        echo "    $ID → $NAME"
      fi
    done
  fi

  if [[ -n "$LOCAL_ONLY" ]]; then
    echo -e "  ${YELLOW}− Local-only $TABLE (will be REMOVED):${NC}"
    for ID in $LOCAL_ONLY; do
      if [[ "$TABLE" == "projects" ]]; then
        NAME=$(sqlite3 "$LOCAL_DB" "SELECT name FROM projects WHERE id='$ID';" 2>/dev/null)
        echo "    $ID → $NAME"
      elif [[ "$TABLE" == "team" ]]; then
        NAME=$(sqlite3 "$LOCAL_DB" "SELECT name FROM team WHERE id='$ID';" 2>/dev/null)
        echo "    $ID → $NAME"
      elif [[ "$TABLE" == "users" ]]; then
        EMAIL=$(sqlite3 "$LOCAL_DB" "SELECT email FROM users WHERE id='$ID';" 2>/dev/null)
        echo "    $ID → $EMAIL"
      else
        NAME=$(sqlite3 "$LOCAL_DB" "SELECT name FROM $TABLE WHERE id='$ID';" 2>/dev/null || echo "$ID")
        echo "    $ID → $NAME"
      fi
    done
  fi
done
echo ""

# Local-computed tables
echo -e "${BLUE}── LOCAL-COMPUTED TABLES (Local kept) ──${NC}"
printf "%-30s %10s %10s %s\n" "Table" "Railway" "Local" "Action"
printf "%-30s %10s %10s %s\n" "─────" "───────" "─────" "──────"
for TABLE in $LOCAL_TABLES; do
  R_COUNT=$(sqlite3 "$MERGE_TEMP" "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "?")
  L_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "?")
  printf "%-30s %10s %10s keep local\n" "$TABLE" "$R_COUNT" "$L_COUNT"
done
echo ""

# Merged tables
echo -e "${BLUE}── MERGED TABLES ──${NC}"
for TABLE in $MERGE_TABLES; do
  R_COUNT=$(sqlite3 "$MERGE_TEMP" "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "?")
  L_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "?")
  printf "%-30s railway=%-6s local=%-6s\n" "$TABLE" "$R_COUNT" "$L_COUNT"
done

# Notes merge detail
R_HIDDEN=$(sqlite3 "$MERGE_TEMP" "SELECT COUNT(*) FROM notes WHERE hidden = 1;" 2>/dev/null || echo "0")
L_HIDDEN=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM notes WHERE hidden = 1;" 2>/dev/null || echo "0")
R_NOTES_IDS=$(sqlite3 "$MERGE_TEMP" "SELECT id FROM notes ORDER BY id;" 2>/dev/null)
L_NOTES_IDS=$(sqlite3 "$LOCAL_DB" "SELECT id FROM notes ORDER BY id;" 2>/dev/null)

NOTES_RAILWAY_ONLY=0
NOTES_LOCAL_ONLY=0
for ID in $R_NOTES_IDS; do
  echo "$L_NOTES_IDS" | grep -qxF "$ID" || NOTES_RAILWAY_ONLY=$((NOTES_RAILWAY_ONLY + 1))
done
for ID in $L_NOTES_IDS; do
  echo "$R_NOTES_IDS" | grep -qxF "$ID" || NOTES_LOCAL_ONLY=$((NOTES_LOCAL_ONLY + 1))
done

echo "  Notes: railway-only=$NOTES_RAILWAY_ONLY, local-only=$NOTES_LOCAL_ONLY"
echo "  Hidden flags: railway=$R_HIDDEN, local=$L_HIDDEN (railway wins)"

R_FP=$(sqlite3 "$MERGE_TEMP" "SELECT COUNT(*) FROM hidden_note_fingerprints;" 2>/dev/null || echo "0")
L_FP=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM hidden_note_fingerprints;" 2>/dev/null || echo "0")
echo "  Fingerprints: railway=$R_FP, local=$L_FP (union)"
echo ""

# ── Dry run exit ─────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN — no changes made. Remove --dry to apply merge."
  rm -f "$MERGE_TEMP"
  exit 0
fi

# ── Backup local DB before merge ─────────────────────────────────
BACKUP_TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$DCC_DIR/backups/local/pre_merge_${BACKUP_TS}"
mkdir -p "$BACKUP_DIR"
cp "$LOCAL_DB" "$BACKUP_DIR/shared.db"
log "Local DB backed up to: $BACKUP_DIR/shared.db"

# ── Stop local servers ───────────────────────────────────────────
API_PID=$(lsof -ti:3001 2>/dev/null || true)
VITE_PID=$(lsof -ti:5173 2>/dev/null || true)
if [[ -n "$API_PID" || -n "$VITE_PID" ]]; then
  log "Stopping local servers..."
  [[ -n "$API_PID" ]] && kill $API_PID 2>/dev/null || true
  [[ -n "$VITE_PID" ]] && kill $VITE_PID 2>/dev/null || true
  sleep 2
fi

# ── Merge: Railway-owned tables ──────────────────────────────────
# Safety: skip merge if Railway DB is empty (fresh rebuild after code push)
RAILWAY_TOTAL=$(sqlite3 "$MERGE_TEMP" "SELECT SUM(c) FROM (SELECT COUNT(*) as c FROM projects UNION ALL SELECT COUNT(*) FROM team UNION ALL SELECT COUNT(*) FROM project_assignments);" 2>/dev/null || echo "0")

if [[ "$RAILWAY_TOTAL" -eq 0 ]] 2>/dev/null; then
  warn "Railway DB is empty (fresh rebuild). SKIPPING Railway-owned table merge — local data preserved."
else
  log "Merging Railway-owned tables into local DB..."
  for TABLE in $RAILWAY_TABLES; do
    # Get column list from Railway DB
    COLS=$(sqlite3 "$MERGE_TEMP" "PRAGMA table_info($TABLE);" 2>/dev/null | cut -d'|' -f2 | tr '\n' ',' | sed 's/,$//')
    if [[ -z "$COLS" ]]; then
      warn "Table $TABLE not found in Railway DB, skipping."
      continue
    fi

    # Delete local rows, insert Railway rows using explicit columns
    sqlite3 "$LOCAL_DB" "
      DELETE FROM \"$TABLE\";
      ATTACH '$MERGE_TEMP' AS railway;
      INSERT INTO \"$TABLE\" ($COLS) SELECT $COLS FROM railway.\"$TABLE\";
      DETACH railway;
    "

    NEW_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM \"$TABLE\";")
    info "  $TABLE: replaced with $NEW_COUNT Railway rows"
  done
fi

# ── Merge: Notes (union + Railway hidden flags win) ──────────────
log "Merging notes (union, Railway hidden flags win)..."

# Insert Railway-only notes into local
NOTE_COLS=$(sqlite3 "$MERGE_TEMP" "PRAGMA table_info(notes);" | cut -d'|' -f2 | tr '\n' ',' | sed 's/,$//')
L_NOTE_IDS=$(sqlite3 "$LOCAL_DB" "SELECT quote(id) FROM notes;" | tr '\n' ',' | sed 's/,$//')
INSERTED=$(sqlite3 "$LOCAL_DB" "
  ATTACH '$MERGE_TEMP' AS railway;
  INSERT OR IGNORE INTO notes ($NOTE_COLS) SELECT $NOTE_COLS FROM railway.notes WHERE id NOT IN ($L_NOTE_IDS);
  SELECT changes();
  DETACH railway;
")
if [[ "$INSERTED" -gt 0 ]] 2>/dev/null; then
  info "  Notes: inserted $INSERTED Railway-only notes"
else
  info "  Notes: no Railway-only notes to insert"
fi

# Update hidden flags from Railway (Railway wins for existing notes)
sqlite3 "$LOCAL_DB" "
  ATTACH '$MERGE_TEMP' AS railway;
  UPDATE notes SET
    hidden = COALESCE((SELECT r.hidden FROM railway.notes r WHERE r.id = notes.id), notes.hidden),
    hidden_at = COALESCE((SELECT r.hidden_at FROM railway.notes r WHERE r.id = notes.id AND r.hidden = 1), notes.hidden_at)
  WHERE id IN (SELECT id FROM railway.notes);
  DETACH railway;
"
R_HIDDEN_AFTER=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM notes WHERE hidden = 1;")
info "  Notes: hidden flags synced from Railway ($R_HIDDEN_AFTER hidden)"

# ── Merge: Hidden note fingerprints (union) ──────────────────────
log "Merging hidden_note_fingerprints (union)..."
FP_COLS=$(sqlite3 "$MERGE_TEMP" "PRAGMA table_info(hidden_note_fingerprints);" | cut -d'|' -f2 | tr '\n' ',' | sed 's/,$//')
LOCAL_FPS=$(sqlite3 "$LOCAL_DB" "SELECT quote(fingerprint) FROM hidden_note_fingerprints;" | tr '\n' ',' | sed 's/,$//')
if [[ -n "$LOCAL_FPS" ]]; then
  sqlite3 "$LOCAL_DB" "
    ATTACH '$MERGE_TEMP' AS railway;
    INSERT OR IGNORE INTO hidden_note_fingerprints ($FP_COLS) SELECT $FP_COLS FROM railway.hidden_note_fingerprints WHERE fingerprint NOT IN ($LOCAL_FPS);
    DETACH railway;
  " 2>/dev/null || true
else
  sqlite3 "$LOCAL_DB" "
    ATTACH '$MERGE_TEMP' AS railway;
    INSERT OR IGNORE INTO hidden_note_fingerprints ($FP_COLS) SELECT $FP_COLS FROM railway.hidden_note_fingerprints;
    DETACH railway;
  " 2>/dev/null || true
fi
FP_COUNT=$(sqlite3 "$LOCAL_DB" "SELECT COUNT(*) FROM hidden_note_fingerprints;")
info "  Fingerprints: $FP_COUNT total after merge"

# ── Local-computed tables: kept as-is ────────────────────────────
log "Local-computed tables (note_people_links, note_project_links): kept as-is."

# ── Clean up ─────────────────────────────────────────────────────
rm -f "$MERGE_TEMP"

# ── Final counts ─────────────────────────────────────────────────
echo ""
echo -e "${BLUE}── MERGED LOCAL DB (final state) ──${NC}"
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

log "Starting Vite dev server on :5173..."
npm run dev >> /tmp/dcc-vite.log 2>&1 &
for i in {1..10}; do
  if curl -sf http://localhost:5173 &>/dev/null; then
    log "Vite dev server ready."
    break
  fi
  sleep 1
done

echo ""
log "MERGE COMPLETE."
log "Railway data preserved. Local computed tables kept."
log "Pre-merge backup: $BACKUP_DIR/shared.db"
echo ""
log "Next steps:"
echo "  1. Verify site at http://localhost:5173"
echo "  2. If notes links need updating: curl -X POST http://localhost:3001/api/notes/sync"
echo "  3. When ready to deploy: DCC_DEPLOY_OK=1 ./scripts/deploy.sh"

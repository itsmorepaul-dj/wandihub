# Design Command Center — Project Log

**GitHub:** https://github.com/ItsMorePaul/design-command-center  
**Railway (Production):** https://design-command-center-production.up.railway.app  
**Local dev:** http://192.168.0.22:5173 (Vite) + http://localhost:3001 (API)  
**Local repo:** `~/.openclaw/workspace/work/design-command-center/`

---

## How to Run Locally

```bash
cd ~/.openclaw/workspace/work/design-command-center

# Start API server (port 3001)
NODE_ENV=production npm start &>> /tmp/dcc-server.log &

# Start Vite dev server (port 5173, network-accessible)
npm run dev &>> /tmp/dcc-vite.log &
```

---

## Versioning Rules (CRITICAL — read before touching versions)

**UI display format:** `Site: 2026.02.26 2059` / `DB: 2026.02.26 2059`

### Site Version — MANUAL, set on every commit
- Two constants in `server.ts` — **update BOTH, every single time, no exceptions:**
  ```ts
  // Format: YYYY.MM.DD.hhmm (periods, no pipe, full year)
  const SITE_VERSION = '2026.02.26.2059'  // Internal code format
  const SITE_TIME = '2059'                 // Just the time portion
  ```
- Use Pacific Time (PST/PDT).
- The internal format is nearly identical to display — just replace last `.` with ` `

### DB Version — FULLY AUTOMATIC. NEVER SET MANUALLY.
- Updates itself on every DB write via `updateDbVersion()` → `generateDbVersionParts()` in `server.ts`
- **Internal format:** `YYYY.MM.DD.hhmm` (e.g., `2026.02.26.2059`)
- **DB storage:** Same format as site version
- ❌ **NEVER** run `sqlite3 ... UPDATE app_versions SET db_version` manually
- ❌ **NEVER** hardcode DB version anywhere outside `generateDbVersionParts()`
- ✅ To READ current DB version for documentation: `sqlite3 data/shared.db "SELECT db_version, db_time FROM app_versions WHERE key='dcc_versions';"`

### UI Display (what users actually see)
- Sidebar footer shows: `Site: 2026.02.26 2059` / `DB: 2026.02.26 2059`
- Formatted by `formatVersionDisplay()` in `src/App.tsx` — simply replaces last `.` with space
- Legacy format `v260226|2059` still supported for backwards compatibility

### On every "save site" checkpoint
1. Update `SITE_VERSION` and `SITE_TIME` in `server.ts` to current PST time
2. Commit: `git add -A && git commit -m "..."`
3. Tag the commit (see format below)
4. READ (never set) DB version: `sqlite3 data/shared.db "SELECT db_version, db_time FROM app_versions WHERE key='dcc_versions';"`
5. Document checkpoint in this file

---

## "Save Site" Protocol

When Paul says **"save site"**, Wilson will:

1. Update `SITE_VERSION` + `SITE_TIME` in `server.ts` to current PST time
2. `git add -A && git commit -m "<description of session work>"`
3. `git tag -a <tag-name> -m "<description>"`
4. READ (never set) current DB version: `sqlite3 data/shared.db "SELECT db_version, db_time FROM app_versions WHERE key='dcc_versions';"`
5. Document the checkpoint in this file with full rollback instructions

> ⚠️ DB version is AUTOMATIC. Wilson must NEVER manually update the DB version table.  
> Only READ it for documentation. The server sets it on every write.

### Tag naming format
```
v<YYMMDD>-<short-descriptor>
```
Examples: `v260226-modal-polish`, `v260226-capacity-gauges`, `v260227-search-redesign`

---

## DEPLOYMENT PROTOCOL (CRITICAL — POST-INCIDENT 2026-03-03)

**Incident:** Deployment overwrote Railway production DB with local data, losing capacity percentages.
**Root Cause:** The `/api/seed` endpoint in `server.ts` clears and rewrites all tables. Deploying code that includes seed operations overwrites production data.
**Status:** FIXED — Procedures below prevent recurrence.

### The Golden Rule
**Code deployments and data syncs are SEPARATE operations.**
- Deploy code = push to GitHub (Railway auto-deploys)
- Sync data = manual operation with explicit backup

### Pre-Deployment Checklist (MUST VERIFY)

Before ANY `git push` to origin/main:

```bash
# 1. Verify NO seed/sync operations in the commit
# Check server.ts for any dangerous endpoints being called
grep -n "DELETE FROM\|run('DELETE\|seed\|sync.*railway" server.ts

# 2. Verify the seed endpoint is NOT being auto-called on startup
grep -n "app.listen\|seed\|init.*data" server.ts | head -10

# 3. Confirm what files changed
git diff --name-only HEAD~1

# 4. If data/shared.db is in the diff, STOP and ask Paul
```

### Safe Deployment Procedure

**Step 1: Backup Railway DB (BEFORE any risky operation)**
```bash
cd ~/.openclaw/workspace/work/design-command-center
./scripts/backup-railway.sh  # Creates timestamped backup
```

**Step 2: Deploy code only (if only code changed)**
```bash
git push origin main
# Wait for Railway deploy (check /api/versions)
```

**Step 3: Verify data intact after deploy**
```bash
curl -s https://design-command-center-production.up.railway.app/api/capacity | jq '.assignments | length'
# Should match expected count (was 28)
```

### Data Sync Procedure (Manual, Explicit)

**ONLY when Paul explicitly says "sync data to Railway":**

```bash
# 1. Create backup first
./scripts/backup-railway.sh

# 2. Verify local data is correct
sqlite3 data/shared.db "SELECT COUNT(*) FROM project_assignments;"

# 3. Sync with confirmation
./scripts/sync-to-railway-safe.sh  # Interactive confirmation required
```

### What Is NEVER Allowed

❌ **NEVER push local `data/shared.db` file to GitHub**  
❌ **NEVER run `/api/seed` against Railway without explicit backup**  
❌ **NEVER assume in-memory API data is persisted to SQLite**  
❌ **NEVER deploy without verifying the commit doesn't include DB files**

### Post-Incident Verification Commands

After ANY deployment, verify within 60 seconds:
```bash
# Check assignment counts match
echo "Railway assignments: $(curl -s https://design-command-center-production.up.railway.app/api/capacity | jq '.assignments | length')"
echo "Local assignments: $(sqlite3 data/shared.db 'SELECT COUNT(*) FROM project_assignments;')"

# Check specific designer data
curl -s https://design-command-center-production.up.railway.app/api/capacity | jq '.assignments[] | select(.designer_name | contains("Fariah")) | {project_name, allocation_percent}'
```

### To roll back to any checkpoint (local)
```bash
cd ~/.openclaw/workspace/work/design-command-center
git checkout <tag-name>
# or
git checkout <commit-hash>
```

### To roll back Railway (production)
```bash
# Deploy a specific commit to Railway
git push origin <commit-hash>:main --force
# Then wait ~2 minutes for Railway to redeploy
# Verify: curl https://design-command-center-production.up.railway.app/api/versions
```

> ⚠️ Railway DB is independent. Rolling back code does not roll back Railway's SQLite data.  
> Local DB (`data/shared.db`) and Railway DB are separate — seed endpoint exists at `POST /api/seed` to push local data to Railway.

---

## Checkpoints

---

### ✅ 2026-04-10
**Date:** 2026-04-10
**Site version:** `2026.04.10.0720`

#### What was built

**New "Pending" project status**
- Slate gray (`#94a3b8`) status added across entire stack: type system, UI maps, switches, filter pills, form buttons, status badges, sort order (last, after done)
- Treated like "done" in capacity: excluded from utilization gauges, allocation calculations, designer project counts, weekly heatmap, and active assignment lists
- Shown as grayed-out chips in designer capacity cards (same visual as done)
- Excluded from: overdue warnings, "no designer"/"no estimate" warnings, weekly update forms, report designer counts
- Added to: summary stats bar, project statistics report, weekly status card stats, server-side review status maps
- CSS class `.bg-slate-400`, DESIGN.md color map updated

**W&I Open Critiques report (replaced Project Review)**
- Two-section report: review projects grouped by business line (with notes, t-shirt size pills, per-designer User icons, links) + all active projects (concise listing by BL)
- Uses review site notes from `editingReview?.items` instead of weekly highlights/lowlights
- Individual `<User size={10} />` icons per designer, size pills via `.rr-size-pill`, "Project end:" date prefix
- Legacy W&I Open Crits card disabled (30% opacity, bottom of page, `pointerEvents: 'none'`)

**Review snapshot system**
- New `review_snapshots` DB table (same schema as `weekly_snapshots`)
- `generateReviewSnapshot(week)` captures latest review items + all active projects
- API: `GET/POST /api/review-snapshots`, `GET /api/review-snapshots/:week`
- Tuesday 5pm ET cron via `startReviewCron()` (30-second check interval)
- Frontend accordion for past review reports (mirrors weekly snapshot UI)

**Optimistic locking for review notes**
- `PUT /api/review-items/:id/notes` accepts `expected_updated_at`, compares against DB `notes_updated_at`
- Returns 409 with `updated_by` and `updated_at` on conflict
- Client-side conflict toast (red, bottom-center, auto-dismiss 6s) with `save-error` CSS class

#### Bug fixes
- **Orphaned weekly updates** — Fixed "General/Unknown" entries in weekly status report on production. Two orphaned `weekly_updates` rows referenced deleted projects. Deleted orphans from production DB and changed `LEFT JOIN projects` → `INNER JOIN` in weekly updates list query and `generateSnapshot()` to prevent future display of orphaned records
- **Market Data custom links** — Removed junk test data from Market Data project in local DB

---

### ✅ v260316-capacity-model
**Date:** 2026-03-16
**Time:** ~3:10 PM PST
**Git tag:** (pending)
**Site version:** `2026.03.16 1510`

#### What was built

**Capacity Model Improvements**
- **Estimated hours on projects**: New `estimatedHours` REAL column on projects table with ALTER TABLE migration. T-shirt sizing dropdown (XXS–XXL at 35h/week increments) populates a manual hours input.
- **Range slider allocation**: Assignment chips now use `<input type="range">` instead of number inputs. 0.5h step increments. Saves on mouseUp/touchEnd. Draft-aware header totals update in real-time as sliders move.
- **Blocked projects pause capacity**: Blocked assignments excluded from gauge totals and per-designer utilization. Shown in separate section with red styling. Allocation preserved for when unblocked.
- **Project Funding stats**: New section in capacity gauge showing `projected hours` (allocation × weeks remaining to endDate) vs `estimated hours` (sum of estimatedHours). Color-coded delta bar (green = overfunded, red = underfunded).
- **Required fields**: Projects now require estimatedHours > 0 and at least one designer to save.
- **Project card warnings**: Red "No estimate" warning on cards missing estimated hours. Clock icon + hours display on cards with estimates.
- **Active project count**: Designer cards show "N active projects" instead of "35h/week".
- **Modal reorder**: Basic Info (name, url, business lines, designers) → Status & Schedule → Timeline → Design Artifacts → Custom Links.
- **Tighter modal styling**: Smaller section padding, smaller brand/designer pills, compact status options.

**Deployment Script Fixes**
- **ATTACH-based merge**: Replaced `.mode insert` (positional VALUES) with `ATTACH db AS alias` + explicit column names in both `deploy.sh` and `merge-railway.sh`. Prevents silent data loss when schemas differ between local and Railway.
- **Auto-merge in deploy.sh**: Railway data automatically merged into local before upload, even if merge-railway.sh was skipped.
- **Maintenance mode re-enable**: deploy.sh re-enables maintenance after upload for admin testing.

**Bug Fixes**
- `authFetch` for capacity endpoints (exclude switch, weekly hours) — was silently failing with plain `fetch`
- Exclude state now persists across page reloads (initialized from DB on load)
- Server PUT `/api/capacity/availability/:designerId` only updates explicitly sent fields (prevents exclude toggle from resetting hours)

---

### ✅ v260310-3features
**Date:** 2026-03-10
**Time:** ~4:10 PM PST
**Git tag:** `v260310-3features`
**Commit:** `fa3e034`
**Site version:** `2026.03.10 2310`
**DB version at save:** `2026.03.10 1556`

**To restore:**
```bash
git checkout v260310-3features
```

#### What was built

- **Maintenance mode defaults**: Banner prefilled "Save your work. Wandi Hub maintenance about to begin in 5 minutes.", lockout "Wandi Hub in maintenance mode and will be back soon.", timer default 5 min
- **Holidays in Settings**: New `holidays` table + CRUD API (`/api/holidays`). All users can add/remove holidays from Settings. Default US holidays seed on first load. Replaced hardcoded `usHolidays2026` with DB-driven holidays via calendar endpoint
- **Multi-day calendar spanning**: Week-row layout with positioned spanning event bars — multi-day events render as continuous bars across day columns (Google Calendar month-view style). Row stacking for overlaps, week-boundary splitting, start/end rounding

---

### ✅ v260310-deploy-hardening
**Date:** 2026-03-10
**Time:** ~3:35 PM PST
**Git tag:** `v260310-deploy-hardening`
**Commit:** (this commit)
**Site version:** `2026.03.10 2235`
**DB version at save:** `2026.03.10 0845`

**To restore:**
```bash
git checkout v260310-deploy-hardening
```

#### What was built

- **Deploy script kills servers first**: `deploy.sh` now stops API (:3001) and Vite (:5173) before reading the DB file, preventing the stale in-memory DB overwrite that caused recurring note bloat (365 → 223 corruption happened 3 times)
- **Version-aware Railway rebuild wait**: After `git push`, deploy.sh now polls `/api/versions` for a new `site_version` instead of just checking `/api/health` (which could return 200 from the old instance), ensuring the DB upload goes to the new deployment
- **Auto-restart after deploy**: Both local servers restart automatically after deploy completes
- **Designer edits recovered**: Merged Railway backup data (MW Typography timeline + UAT Feedback link, W&I Ad Block Recovery project, Mansion Global timestamp) into clean 223-note DB

---

### ✅ v260310-healthcheck-fix
**Date:** 2026-03-10
**Time:** ~3:14 PM PST
**Git tag:** `v260310-healthcheck-fix`
**Commit:** `f5b1ced`
**Site version:** `2026.03.10 2210`
**DB version at save:** `2026.03.10 1339`

**To restore:**
```bash
git checkout v260310-healthcheck-fix
```

#### What was built

- **Healthcheck crash fix**: `/api/health` referenced undefined `maintenanceMode` instead of `maintenanceState.enabled`, throwing `ReferenceError` on every request. This caused Railway deploys to fail healthcheck and roll back. Fixed variable name.
- **Full maintenance mode** (from prior commits): Two-phase system with amber countdown banner → lockout screen, DB-persisted state, admin bypass, Settings UI panel, and maintenance middleware exempting health/auth/DB endpoints.
- **Status priority sorting**: Projects sort by status (blocked → review → active → done) as primary sort before user-selected criteria.
- **Railway deploy verified**: All 12 tables match, health returns 200, maintenance endpoint operational.

---

### ✅ v260310-notes-cleanup
**Date:** 2026-03-10
**Time:** ~10:41 AM PST
**Git tag:** `v260310-notes-cleanup`
**Commit:** `037a010`
**Site version:** `2026.03.10 1741`
**DB version at save:** `2026.03.10 1041`

**To restore:**
```bash
git checkout v260310-notes-cleanup
```

#### What was built

- **Content preview cleaning**: Added `cleanContentPreview()` to Gemini notes sync that strips raw `.md` header blocks — `📝 Notes`, date lines, title, `Invited` name lists, `Attachments` lines — leaving only the actual meeting content summary. Fixed 59 notes that previously showed headers instead of summaries.
- **Person highlighting removed**: Removed person name matching and pink highlight `<span>` with `+` button from `highlightTextWithLinks()` in notes detail body. Project highlighting (blue) remains.
- **Notes re-synced**: All 223 notes updated with cleaned content_previews via `/api/notes/sync`.

---

### ✅ v260310-optimistic-locking
**Date:** 2026-03-10
**Time:** ~10:05 AM PST
**Git tag:** `v260310-optimistic-locking`
**Commit:** `e08a0cf`
**Site version:** `2026.03.10 1005`
**DB version at save:** `2026.03.10 0856`

**To restore:**
```bash
git checkout v260310-optimistic-locking
```

#### What was built

- **Optimistic locking**: Projects, team members, and business lines check `updatedAt` before saving. If another user modified the record, save is rejected with 409 Conflict and the page refreshes. Prevents silent overwrites from concurrent edits.

---

### ✅ v260310-deployment-pipeline
**Date:** 2026-03-10
**Time:** ~9:30 AM PST
**Git tag:** `v260310-deployment-pipeline`
**Commit:** `162be9f`
**Site version:** `2026.03.10 0930`
**DB version at save:** `2026.03.10 0856`

**To restore:**
```bash
git checkout v260310-deployment-pipeline
```

#### What was built in this session

- **Whole-file DB sync pipeline**: Replaced table-by-table `/api/seed` with binary SQLite upload/download (`/api/upload-db`, `/api/download-db`). No hardcoded table lists — new tables flow automatically.
- **Pull script** (`pull-from-railway.sh`): Downloads entire Railway DB, kills servers before replacing file, restarts API + Vite after. Prevents stale-DB-in-memory race condition.
- **Deploy script** (`deploy.sh`): Uploads entire SQLite file, verifies all table counts match.
- **Hidden note fingerprints**: `hidden_note_fingerprints` table keyed on `source_filename`. Prevents hidden notes from reappearing after Gemini re-sync with new IDs.
- **Cleaned 142 garbage notes**: Corrupted records from old `/api/seed` with content fragments as IDs.
- **Drag-and-drop fix**: Jitter-free InProgressDropZone for empty business lines (Mansion Global).
- **Business line selector**: `width: auto` override for global `select { width: 100% }`.
- **Login form autofill**: Browser-friendly `name="username"`, `autoComplete="username"`, delayed reload.
- **Jason Miller password**: Reset to `dj_wandihub!`.
- **Users list auto-fetch**: Settings tab now loads user accounts on open (was empty until "+ Add User" clicked).
- **8 user accounts**: All team members can now log in.
- **Documentation overhaul**: AGENTS.md, TOOLS.md, DEPLOYMENT_LOCK.md, MEMORY.md all updated. Legacy scripts explicitly marked as causing corruption.

---

### ✅ v260309-hidden-fingerprints
**Date:** 2026-03-09
**Time:** ~10:25 PM PST
**Git tag:** `v260309-hidden-fingerprints`
**Commit:** `d2b99fb`
**Site version:** `2026.03.09 2225`
**DB version at save:** `2026.03.09 2159`

**To restore:**
```bash
git checkout v260309-hidden-fingerprints
```

#### What was built in this session

- **Hidden note fingerprints**: Notes hidden via PIN now store a `source_filename` fingerprint in `hidden_note_fingerprints` table. During Gemini sync, new notes are checked against fingerprints — previously hidden sources are auto-hidden regardless of new Gemini DB ID. Hidden notes are never overwritten on sync update.
- **Drag-and-drop fix**: Projects can now be dragged from Done back to In Progress even when In Progress is empty (single-project business lines like Mansion Global). Jitter-free implementation using `useDroppable` with `min-height` zone instead of dynamic placeholders.
- **Business line selector**: Added `width: auto` to `.priority-bl-select` to override global `select { width: 100% }`.
- **Jason Miller login**: Reset password for `jason.miller@dowjones.com`.
- **Deployment pipeline**: New `deploy.sh` script uploads entire SQLite file via `/api/upload-db` — no hardcoded table lists, future-proof.

---

### ✅ v260226-modal-polish
**Date:** 2026-02-26  
**Time:** ~6:05 PM PST  
**Git tag:** `v260226-modal-polish`  
**Commit:** `e655a9c`  
**Site version:** `2026.2.26 1905`  
**DB version at save:** `2026.2.26 1905`

**To restore:**
```bash
git checkout v260226-modal-polish
```

#### What was built in this session

**Version display fix**
- `server.ts` now has `SITE_VERSION` + `SITE_TIME` as separate constants (both must be updated together)
- `formatVersionDisplay()` added to `App.tsx` — parses `vYYMMDD|HHMM` and renders `YYYY.M.D HHMM`
- Sidebar footer now shows formatted human-readable versions for both Site and DB

**Modal structure — Project + Team Member**
- Both modals converted to consistent `modal-header` / `modal-body` / `modal-footer` layout
- Fixed header (title, bordered bottom), scrollable body, fixed footer (Cancel + Save)
- Old bare `<h2>` + `modal-actions` pattern removed everywhere

**Floating label inputs**
- New `.float-field` CSS class — label sits inside field, animates up + shrinks when focused or filled
- Label color when floated: `var(--color-text-muted)` (gray, not accent blue)
- Works via CSS `:focus ~ label` + `:not(:placeholder-shown) ~ label` + `.has-value` class on wrapper
- Inputs require `placeholder=" "` (single space) for the `:not(:placeholder-shown)` selector to work

**Paired form rows**
- Project modal pairs: Name/Link, Deck Name/Deck Link, PRD Name/PRD Link, Brief Name/Brief Link, Start/End Date
- Team modal pairs: Name/Role, Slack/Email
- Uses existing `.form-row` CSS (2-column grid)

**Project modal section order**
1. Basic Info (Name, Link, Business Lines)
2. Design Artifacts (Deck, PRD, Brief, Figma — paired name+link rows)
3. Custom Links (up to 3, paired columns with trash button)
4. Status (button group) + Schedule (Start/End dates, Timeline Ranges)
5. Designers (checkboxes)

**Team modal section order**
1. Identity (Name, Role — side by side)
2. Contact (Slack, Email — side by side)
3. Status (Online / Away / Offline buttons)
4. Business Lines (checkboxes)
5. Time Off (timeline-style list with edit modal)

**Custom links**
- Layout: `grid-template-columns: 1fr 1fr auto` — two float-field inputs + trash button
- Remove button styled identically to `action-btn delete` (36×36px, gray bg, red on hover, trash icon)

**Time Off — new pattern**
- Replaced inline-editing rows with timeline-range pattern:
  - Header row: "Time Off" label + "+ Add" button
  - List of items: label + formatted date range + pencil/trash actions
  - Pencil opens `showTimeOffModal` — same compact modal as timeline ranges
- New state: `showTimeOffModal`, `editingTimeOff`, `timeOffFormData`
- New handlers: `handleAddTimeOff`, `handleEditTimeOff`, `handleDeleteTimeOff`, `handleSaveTimeOff`

**Timeline modal — also updated**
- Converted from bare layout to `modal-header` / `modal-body` / `modal-footer`
- Uses floating labels + paired Start/End date row
- `maxWidth: 360` (compact)

**Date formatting**
- `formatShortDate(dateStr)` added — converts `2026-02-01` → `Feb 1, 2026`
- Applied to both timeline ranges and time off date displays

---

### ✅ v260226-operating-rules
**Date:** 2026-02-26  
**Time:** ~6:48 PM PST  
**Git tag:** `v260226-operating-rules`  
**Commit:** `618a902`  
**Site version:** `2026.2.26 1848`  
**DB version at save:** `2026.2.26 1905`

**To restore:**
```bash
git checkout v260226-operating-rules
```

#### What was built in this checkpoint
- `DCC_PROJECT_LOG.md` created — full operating manual for this project
- `MEMORY.md` updated with complete DCC operating rules:
  - Versioning rules (SITE_VERSION + SITE_TIME both required)
  - "Save site" protocol (6-step process)
  - Local dev startup commands
  - No-deploy-without-permission rule
  - Railway vs local DB independence note
- VS Code open command documented: `open -a "Visual Studio Code" <path>`

---

### ✅ v260226-dnd-timeline
**Date:** 2026-02-26  
**Time:** 7:14 PM PST  
**Git tag:** `v260226-dnd-timeline`  
**Commit:** `578cf2c`  
**Site version:** `2026.2.26 1914`  
**DB version at save:** `2026.2.26 1912`

**To restore:**
```bash
git checkout v260226-dnd-timeline
```

#### What was built in this checkpoint

**Drag-and-drop timeline reordering**
- Library: `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` — React 19 compatible, clean build confirmed before implementing
- New component: `SortableTimelineItem` — wraps each timeline range with drag handle (grip icon), edit, and delete buttons
- `DragEndEvent` imported as type-only (required by `verbatimModuleSyntax`)
- Drag updates `projectFormData.timeline` state via `arrayMove` — persists to DB on Save Changes
- Activation constraint: 5px distance prevents accidental drags on click
- Drag handle: `GripVertical` icon, 40% opacity, full opacity on hover, `cursor: grab`
- `.drag-handle` CSS added to `App.css`

**DB version format bug fixed**
- `generateDbVersionParts()` was returning `vYYMMDD` without the time — now returns `vYYMMDD|HHMM`
- DB version is AUTOMATIC — server sets it on every write, never touch manually

**Docs updated**
- `MEMORY.md` and `DCC_PROJECT_LOG.md` both updated with unambiguous rule: DB version = automatic, never set manually

---

### ✅ v260226-calendar-filter-default
**Date:** 2026-02-26  
**Time:** 8:39 PM PST  
**Git tag:** `v260226-calendar-filter-default`  
**Commit:** `f367382`  
**Site version:** `2026.2.26 2039`  
**DB version at save:** `2026.2.26 1941`

**To restore:**
```bash
git checkout v260226-calendar-filter-default
```

#### What was built in this checkpoint
- Calendar filter default now selects all designers on initial load
- Added useEffect in `App.tsx` that initializes `calendarFilters.designers` with all team member names once team data is loaded
- Only initializes if designers array is empty (preserves user selections after first load)
- Site version updated to `2026.2.26 2039`

---

### ✅ v260226-version-format-docs
**Date:** 2026-02-26  
**Time:** 8:44 PM PST  
**Git tag:** `v260226-version-format-docs`  
**Commit:** `7329564`  
**Site version:** `2026.2.26 2044`  
**DB version at save:** `2026.2.26 1941`

**To restore:**
```bash
git checkout v260226-version-format-docs
```

#### What was built in this checkpoint
**Documentation clarity — version formats**
- Updated `DCC_PROJECT_LOG.md` versioning rules section:
  - Added "INTERNAL CODE FORMAT — used in server.ts only, never shown to users" comment
  - Added explicit warning: "⚠️ CRITICAL: The `vYYMMDD|HHMM` format is INTERNAL CODE ONLY"
  - Clarified that checkpoints must always use DISPLAY format (`2026.2.26 2039`)
- Updated `MEMORY.md` with same clarifications:
  - Added "INTERNAL CODE FORMAT (server.ts only)" labels
  - Added "Display format" vs "Internal format" distinctions
  - Updated all examples to use consistent time (2039)
- Removed all `v260226|2039` → `2026.2.26 2039` conversion arrows from checkpoint entries
- Site version updated to `v260226|2044`

---

### ✅ v260226-save-site
**Date:** 2026-02-26  
**Time:** 8:46 PM PST  
**Git tag:** `v260226-save-site`  
**Commit:** `11763a2`  
**Site version:** `2026.2.26 2046`  
**DB version at save:** `2026.2.26 1941`

**To restore:**
```bash
git checkout v260226-save-site
```

#### What was built in this checkpoint
- "Save site" protocol checkpoint — no new features, just capturing current state
- Site version updated to `v260226|2046`

---

### ✅ v260226-priority-hide-filters
**Date:** 2026-02-26  
**Time:** 8:53 PM PST  
**Git tag:** `v260226-priority-hide-filters`  
**Commit:** `e4f24a4`  
**Site version:** `2026.2.26 2053`  
**DB version at save:** `2026.2.26 1941`

**To restore:**
```bash
git checkout v260226-priority-hide-filters
```

#### What was built in this checkpoint
**Priority view UI cleanup**
- When Priority tab is selected, the "Filter:" row is now completely hidden
- The filter pills (Business Line, Designer, Status) no longer appear in priority mode
- The sort row still shows the "Business Line:" dropdown (required for priority view functionality)
- Changed condition from `{showProjectFilter() && (...)}` to `{projectViewMode === 'list' && showProjectFilter() && (...)}`

---

### ✅ v260226-period-version-format
**Date:** 2026-02-26  
**Time:** 8:59 PM PST  
**Git tag:** `v260226-period-version-format`  
**Commit:** `4c693b6`  
**Site version:** `2026.02.26 2059`  
**DB version at save:** `2026.02.26 2055`

**To restore:**
```bash
git checkout v260226-period-version-format
```

#### What was built in this checkpoint
**Period-based version format**
- Changed internal version format from `v260226|2059` to `2026.02.26.2059`
- Display conversion is now trivial: replace last `.` with space
- `generateDbVersionParts()` now uses full year (2026) instead of 2-digit year (26)
- `formatVersionDisplay()` supports both new and legacy formats for backwards compatibility
- Updated all documentation to reflect new format
- Site version updated to `2026.02.26.2059`

---

### ⚠️ v260306-3phase-workflow (SUPERSEDED — scripts deprecated)
**Date:** 2026-03-06
**Time:** ~8:40 AM PST
**Git tag:** `v260306-3phase-workflow`
**Commit:** (pending — create after testing workflow)
**Site version:** `2026.03.06.0840`
**DB version at save:** (current)

> **⚠️ WARNING:** The scripts created in this checkpoint (`dcc-data-workflow.sh`, `dcc-push-to-railway.sh`) use table-by-table `/api/seed` sync which causes data corruption. They were replaced by `deploy.sh` and `pull-from-railway.sh` in v260310-deployment-pipeline. **NEVER use the scripts from this checkpoint.**

**To restore:**
```bash
git checkout v260306-3phase-workflow
```

#### What was built in this checkpoint
**New 3-Phase Bidirectional Sync Workflow**

**Problem solved:**
- Old workflow had dangerous gaps: pulls overwrote local, pushes overwrote Railway, no preview, no rollback
- Designers enter data online (Railway), Paul works locally, needs safe merge process
- No documentation of the complete Pull → Work → Push cycle

**Solution: 3-Phase Workflow**

| Phase | Direction | Script | Safety |
|-------|-----------|--------|--------|
| 1. Pull | Railway → Local | `dcc-data-workflow.sh pull` | Auto-backup local before overwrite |
| 2. Work | Local only | `dcc-data-workflow.sh backup` | Manual backup anytime |
| 3. Push | Local → Railway | `dcc-push-to-railway.sh` | Auto-backup Railway, requires `DCC_DEPLOY_OK=1` |

**New files created:**
1. `scripts/dcc-data-workflow.sh` — Phase 1 & 2 management
   - `status` — Compare Railway vs Local
   - `preview` — Show diff before pull
   - `pull` — Pull with auto-backup
   - `backup` — Manual local backup
   - `restore` — Restore from backup

2. `scripts/dcc-push-to-railway.sh` — Phase 3 (integrated deployment)
   - Backs up Railway before any changes
   - Shows deployment preview
   - Pushes code (GitHub → Railway auto-deploy)
   - Syncs data via `/api/seed`
   - Verifies deployment (health, counts, Fariah's data)

**Updated files:**
- `DEPLOYMENT_LOCK.md` — Completely rewritten with 3-phase workflow documentation
- `AGENTS.md` — Added DCC workflow section (separate update)
- `scripts/` — New commands added to standard workflow

**Usage workflow:**
```bash
# Phase 1: Pull designer changes
cd ~/.openclaw/workspace/work/design-command-center
./scripts/dcc-data-workflow.sh status    # See current state
./scripts/dcc-data-workflow.sh preview   # Preview changes
./scripts/dcc-data-workflow.sh pull      # Pull with backup

# Phase 2: Work locally
# ... make changes ...
./scripts/dcc-data-workflow.sh backup    # Manual backup

# Phase 3: Push (when Paul says "deploy dcc")
# Wilson runs: ./scripts/dcc-push-to-railway.sh
# (Requires DCC_DEPLOY_OK=1, enforced by pre-push hook)
```

**Safety guarantees:**
- Every pull: Local backed up to `backups/local/<timestamp>_pre_pull/`
- Every push: Railway backed up to `backups/railway/pre_deploy_<timestamp>/`
- Undo scripts auto-generated in each backup folder
- Verification after every operation
- No destructive operations without explicit preview

**Legacy script status:**
- `pull-from-railway.sh` — Still works, but lacks backup safety
- `sync-to-railway-safe.sh` — Still works, but new integrated script preferred
- `backup-railway.sh` — Used internally by new scripts

---

*Log started: 2026-02-26*  
*Maintained by: Wilson 🦉*

# WandiHub (Design Command Center)

A capacity management and project tracking dashboard for Dow Jones design teams. Track projects, team workload, calendars, and weekly updates with real-time data sync.

**Live URL:** https://design-command-center-production.up.railway.app

## Features

### Projects
- CRUD with status (active, in review, blocked, done), due dates, business lines, designers, estimated hours, and timeline
- Project images (upload, drag/paste, lightbox with captions)
- Custom links (Deck, PRD, Brief, Figma)
- Designer assignments with allocation percentages
- Priority reordering per business line (drag-and-drop)
- Archive/restore by quarter
- Filter by business line, designer, or status; sort by name, business line, due date, or status

### Capacity
- Per-designer workload dashboard with utilization stats
- Weekly hours configuration and available hours calculation (accounts for time-off)
- Project-to-designer allocation with percentage sliders

### Calendar
- Year-long month view with project timelines, team time-off, and holidays
- Auto-scroll to current month

### Team
- Manage members with roles, brands, Slack/email links, avatar, and time-off periods
- Weekly hours and availability tracking

### Reports
- Weekly update form with rich text editor
- Missing updates warnings (deadline-gated, Friday 5pm ET)
- Project status summaries

### Settings (admin)
- Maintenance mode with lockout countdown and banner
- User management (create, delete, role assignment)
- Password management

### Cross-cutting
- **Authentication** — Session-based login, role-based access (admin/user)
- **Search** — Cmd+K global search across projects, team, and business lines
- **Real-time sync** — Server-Sent Events for maintenance and version broadcasts
- **Activity logging** — All CRUD actions timestamped with user

## Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS 4, Vite 7
- **Backend:** Express 5, SQLite
- **Deployment:** Railway (auto-deploy on push)

## Local Development

```bash
# Install dependencies
npm install

# Run development server (frontend + API)
npm run dev:all
```

Or run separately:

```bash
# Terminal 1: API server
npm run server

# Terminal 2: Frontend
npm run dev
```

Open http://localhost:5173

### Understanding the Two Servers

| Port | Command | Serves From | Use For |
|------|---------|-------------|---------|
| **5173** | `npm run dev` | `src/` (live) | Development — changes hot-reload instantly |
| **3001** | `npm start` | `dist/` (built) | Production preview — requires build step |

**CRITICAL: Making Changes Visible**

Changes made in `src/` are only visible on:
- Port 5173 (dev server) — instantly
- Port 3001 (production server) — **after running `npm run build`**

Workflow to test changes on port 3001:
```bash
# Make changes in src/
# Then:
npm run build          # Compile src/ → dist/
npm start              # Restart production server
```

Or use port 5173 for faster iteration during development.

## Deployment

Connected to GitHub → Railway auto-deploys on push. **Railway uses an ephemeral filesystem** — every code push destroys the SQLite database. Always use the deploy script which safely backs up and restores data.

### Deploy workflow

```bash
./scripts/maintenance.sh on            # Block designers from editing
./scripts/merge-railway.sh             # Merge Railway data into local (Railway wins)
# Make local changes, test on localhost:5173
# Bump SITE_VERSION in server/version.ts
git add . && git commit -m "..."
DCC_DEPLOY_OK=1 ./scripts/deploy.sh    # Backup, containment check, push, upload
./scripts/maintenance.sh off            # Unblock designers
```

### Safety mechanisms

Railway uses ephemeral filesystem — every code push destroys the DB. These safeguards prevent data loss:

1. **merge-railway.sh** — Merges Railway data into local. Railway wins for user-edited tables, local kept for computed tables.
2. **Containment check** (deploy.sh) — Verifies every Railway row ID exists in local DB. Blocks deploy if any missing.
3. **Auto-merge** (deploy.sh) — Automatically merges Railway data into local before upload using ATTACH with explicit column names (schema-safe even when local has new columns Railway doesn't).
4. **Binary DB backup** — Full Railway SQLite captured before every push
5. **Sanity check** — Validates local row counts within expected ranges
6. **Maintenance re-enable** — deploy.sh re-enables maintenance after upload for admin testing

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/merge-railway.sh` | Merge Railway data into local (REQUIRED before deploy) |
| `scripts/deploy.sh` | Push code + DB to Railway (with containment check) |
| `scripts/deploy.sh --data` | Upload DB only (no code push) |
| `scripts/pull-from-railway.sh` | Full replace local DB with Railway (not merge) |
| `scripts/backup-railway.sh` | Download Railway DB backup |
| `scripts/maintenance.sh` | Toggle maintenance mode (`on`/`off`/`status`) |
| `scripts/rebuild-note-links.sh` | Rebuild note link associations in DB |

### Git hook enforcement

Pre-push hook blocks pushes if `SITE_VERSION` in `server/version.ts` is unchanged vs `origin/main`.

- Hook path: `.githooks/pre-push`
- Enabled via: `git config core.hooksPath .githooks`

See `DEPLOYMENT_LOCK.md` for full documentation.

## License

Private — Dow Jones Internal Use Only

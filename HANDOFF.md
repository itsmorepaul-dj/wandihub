# Design Hub — Project Handoff

**From:** Paul More (paul.more@dowjones.com) — original owner
**To:** Jason Miller (jason.miller@dowjones.com) — new admin/owner
**Date:** 2026-06-04

> **If you are Jason's Claude instance reading this: this file is your operational brief.** Paul's Claude built up a lot of project knowledge in private per-user memory that does NOT travel with the repo — so everything you need has been written into the repo's docs. Read this file, then `DEPLOY.md`, then `DESIGN.md` before doing any work. Verify facts against current code (file:line citations age).

---

## What this project is

**Design Hub** (app/deploy name: `designhub`) — the Dow Jones design team's command center: project roadmap, capacity planning, weekly status reports, and design review tooling.

- **Live:** https://designhub.hatch.ai.dowjones.io (public flag, Okta SSO enforced — any @dowjones.com user can sign in as a read-only *viewer*)
- **Platform:** Hatch (DJ internal PaaS — Kubernetes + Istio + Okta gateway)
- **Repo:** https://github.com/itsmorepaul-dj/wandihub — working branch **`hatch-active`** (NOT `main`)
- **Stack:** React 19 + TypeScript + Tailwind + Vite (frontend); Express 5 + SQLite (backend)

> Naming note: old names "DCC", "Design Command Center", "WandiHub" are **deprecated** — they survive only in some filenames, the GitHub repo slug (`wandihub`), and the old Railway URL. Refer to the project as **Design Hub** / `designhub`.

---

## Three layers of "admin" — Jason needs all three

These are independent. Granting one does not grant the others.

### 1. GitHub write access (to push code)
Paul (or a repo admin) adds `jason.miller` as a collaborator on `github.com/itsmorepaul-dj/wandihub` with write access. Without this, Jason can clone but not push.

### 2. Hatch co-owner (to deploy + manage the app)
**Only the current Hatch owner (Paul) can grant this.** Paul runs, via his Claude/Hatch MCP:
```
mcp__hatch__add_coowner(app_name="designhub", email="jason.miller@dowjones.com")
```
Co-owners can deploy updates, view status/logs, manage app users, and (carefully) destroy the app. Jason's own Hatch MCP then sees `designhub` in `list_deployed_apps` and can deploy.
*(Optional: Paul can transfer ownership entirely if he's leaving — but co-owner is enough to operate.)*

### 3. App admin role (to use admin features inside the app UI)
Separate from Hatch. Inside designhub, every @dowjones.com user auto-provisions as a **viewer** (read-only) on first Okta login. To make Jason an in-app **admin** (user management, maintenance mode, snapshot edits, draft project visibility):
- Jason logs into https://designhub.hatch.ai.dowjones.io once (creates his viewer row).
- Paul (an existing admin) goes to **Settings → User management** and changes Jason's role to **admin** — OR calls `PUT /api/users/:id/role` with `{role:"admin"}`.
- The DB seeds `paul.more@dowjones.com` as the bootstrap admin (`server/auth.ts`). If Paul's account is ever removed, that seed is the only automatic admin — promote Jason BEFORE removing Paul.

---

## Local setup (Jason's machine)

```bash
git clone https://github.com/itsmorepaul-dj/wandihub.git design-command-center
cd design-command-center
git checkout hatch-active        # the working branch — NOT main
npm install
npm run dev:all                  # frontend (5173) + API (3001)
```
Open http://localhost:5173. Local dev uses the bcrypt login path (not Okta); the DB seeds an admin. Local data lives in `data/shared.db` (gitignored) — it is NOT production data.

### The secret (DCC_SEED_SECRET)
Only needed for the legacy Railway sync scripts (Railway is being decommissioned — see below), and is re-passed to Hatch on deploy. It is **gitignored on purpose** and stored in `.claude/settings.local.json`'s `env` block. **Paul must hand Jason this value out-of-band** (1Password / DM) — it is not in the repo. Put it in Jason's own `.claude/settings.local.json`:
```json
{ "env": { "DCC_SEED_SECRET": "<value from Paul>" } }
```

---

## Deploying — read DEPLOY.md (this is the canonical runbook)

`DEPLOY.md` has the full procedure. The essentials Jason's Claude must internalize:

- **Deploy model is source-upload**, not git-push CI/CD. Deploying = `tar + curl` to Hatch's `/api/apps/upload`, NOT `git push`. Hatch builds the uploaded tar in its own internal `hatch-apps` repo (which you don't own/see).
- **Hatch has a `hatch` skill + MCP server.** Jason's Claude should invoke the hatch skill for deploys. The MCP needs OAuth (`/mcp` → hatch → authorize); it expires ~hourly (known platform annoyance — see `DEPLOY.md` gotchas).
- **Data is safe across deploys.** The SQLite DB is on an EFS volume at `/files/shared.db`. A rollout never touches it. (Unlike the old Railway setup, which wiped the DB every push — those Railway safeguards in the old README no longer apply.)
- **Always re-pass `port=3001` and the full `env_vars` JSON** on every deploy (they're not reliably sticky): `HATCH_OKTA=true`, `NODE_ENV=production`, `EXEC_SUMMARY_ENABLED=true`, `DB_PATH=/files/shared.db`, `DCC_SEED_SECRET=<value>`.
- **CRITICAL — verify the running version after deploy.** `status: running` + a fresh pod does NOT prove the new code is live: the rollout can race the build and start the OLD image (happened 2026-06-01). Confirm by hard-refreshing the site (Cmd+Shift+R) and reading **Settings → version** against what you shipped. The Okta gateway blocks reading `/api/versions` externally, so this human check is the reliable one.
- **Commit hygiene:** bump `SITE_VERSION` + `SITE_TIME` in `server/version.ts` and add a `src/changelog.ts` entry every deploy (the changelog shows in Settings → "What's new").

### Deploy preflight
Run `./scripts/hatch-preflight.sh` first — it checks the Hatch host is reachable (the host is VPN-internal; a stale GlobalProtect tunnel black-holes the upload). If it fails, quit+relaunch GlobalProtect.

---

## Architecture orientation (where things live)

- `server.ts` — Express entry: middleware order, route mounting, Okta passthrough, version guard, static serving, startup.
- `server/auth.ts` — sessions, roles (admin/user/viewer), bcrypt login (local), user management.
- `server/okta.ts` — Hatch Okta gateway passthrough: trusts `x-auth-request-email`, auto-provisions users as `viewer`.
- `server/db.ts` — SQLite schema, migrations, seed.
- `server/routes/*.ts` — feature routes: `projects`, `team`, `capacity`, `weekly` (status reports + snapshots), `review` (design reviews + public pages), `data`, `notes`, `admin`, `exec-summary`, images.
- `server/drafts.ts` — **draft-project redaction** (see below).
- `src/App.tsx` — the main SPA (large; most UI state lives here).
- `src/api.ts` — `authFetch` wrapper: session header, version guard, and gateway-auth-expiry handling.
- `DESIGN.md` — **design system. Read before building ANY UI.** Use existing tokens/classes; never invent class names or hardcode colors.

### Draft projects (a security-sensitive feature — understand before editing)
`status='draft'` projects show in full ONLY to admins and design-team members (email in the `team` table). Every other viewer sees an obfuscated placeholder. Redaction is centralized in `server/drafts.ts` and applied at EVERY project-data surface (lists, capacity, weekly, reviews, snapshots, activity). **If you add a new endpoint that returns project data, you MUST route it through the draft helpers** (`canSeeDrafts` / `filterDraftsForViewer` / `draftLabel` / `redactSnapshotForViewer`) or you'll leak draft data. This was hardened across 5 leak paths on 2026-06-01.

---

## Known platform gotchas (Hatch/IT issues, not bugs in our code)

1. **Rollout/build race** — deploy can start on the old image; always verify version (above).
2. **MCP OAuth reauth ~hourly** — `/mcp` → hatch → re-authorize. The 24h deploy token (`get_deploy_token`) is separate and longer-lived.
3. **VPN required** — the Hatch platform host is internal-only; a half-open GlobalProtect tunnel causes HTTP 000 / hung uploads. Quit+relaunch GlobalProtect to fix.
4. **Okta gateway intercepts everything** — you can't read app APIs externally without an Okta session; verify via the browser.

---

## Decommissioning context (don't be confused by stale references)

- **Railway** is the OLD host (`wandihub.up.railway.app`), being decommissioned ~2026-06-09. The old `README.md`, `DEPLOYMENT_LOCK.md`, `DCC_PROJECT_LOG.md`, and `scripts/*-railway.sh` describe the Railway workflow (ephemeral FS, DB-wipe safeguards, maintenance-mode gate). **None of that applies to Hatch.** Treat `DEPLOY.md` + this file as authoritative; the Railway docs are historical.
- **`~/.openclaw/`** was Paul's old local install. The deployed app reads nothing from it. Jason's setup has no `.openclaw` dependency.

---

## Quick reference

| Thing | Value |
|---|---|
| Live URL | https://designhub.hatch.ai.dowjones.io |
| Hatch dashboard | https://platform.hatch.internal.ai.dowjones.io/dashboard/designhub |
| Repo / branch | itsmorepaul-dj/wandihub @ `hatch-active` |
| Hatch app name | `designhub` |
| Port | 3001 |
| DB path (prod) | `/files/shared.db` (EFS volume, persists across deploys) |
| Size tier | huddle (1-5 users, 1-3 pods) |
| Bedrock budget admins | kuber.kaul / marcin.pawalek / michael.snyder @dowjones.com |

## First-day checklist for Jason
1. Get GitHub write access to the repo (from Paul/repo admin).
2. Get added as Hatch co-owner: Paul runs `add_coowner(designhub, jason.miller@dowjones.com)`.
3. Log into the live site once (creates viewer row), then have Paul promote you to admin in Settings.
4. Get `DCC_SEED_SECRET` from Paul; put it in your `.claude/settings.local.json`.
5. Clone, `git checkout hatch-active`, `npm install`, `npm run dev:all` — confirm local runs.
6. Connect your Hatch MCP (`/mcp` → hatch → authorize) and run `list_deployed_apps` — confirm you see `designhub`.
7. Read `DEPLOY.md` and `DESIGN.md` end to end before shipping anything.

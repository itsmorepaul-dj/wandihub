# Deploying Design Hub (designhub) to Hatch

Canonical deploy runbook. **Supersedes `DEPLOYMENT_LOCK.md`** (that doc is Railway-era; Railway is being decommissioned ~2026-06-09 and is no longer the deploy target).

Design Hub runs on **Hatch**, Dow Jones's internal PaaS (Kubernetes + Istio + Okta gateway).

- **Live URL:** https://designhub.hatch.ai.dowjones.io (public flag on, Okta SSO enforced)
- **Hatch app name:** `designhub`
- **Repo:** this repo (`itsmorepaul-dj/wandihub`), working branch `hatch-active`
- **Stack:** React 19 + TS + Vite (frontend), Express + SQLite (backend)

---

## The deploy model: source-upload (not git-push CI/CD)

We use Hatch's **source-upload** path: we tar the working tree and POST it to Hatch, which builds and deploys it. We do **not** use git-push-triggered CI/CD.

- Deploying is a `tar + curl` to `https://platform.hatch.internal.ai.dowjones.io/api/apps/upload`, NOT `git push`.
- Hatch builds the uploaded source inside its own internal repo (`newscorp-djpe/hatch-apps`) via GitHub Actions. **That repo is Hatch's machinery — we don't own it, can't see it, and aren't meant to.** Our source of truth stays this repo.
- This is a fully supported, first-class Hatch workflow — appropriate for a single app with one deployer. Git-integrated CI/CD only pays off for many apps / many contributors / deploy-on-merge, which we don't have.

## Persistent data — the volume is safe across deploys

The SQLite DB lives on an **EFS volume mounted at `/files`** (`DB_PATH=/files/shared.db`). Unlike the old Railway setup (ephemeral FS — every push wiped the DB), **a Hatch rollout NEVER touches the volume.** Redeploying is data-safe. Do not panic about data on redeploy.

---

## Deploy sequence

> Two-verb contract: "commit" and "deploy" are distinct. Committing is NOT deploy authorization — deploy only on an explicit "deploy" in the same turn.

### 0. VPN preflight (REQUIRED)
```bash
./scripts/hatch-preflight.sh
```
The Hatch platform host is internal-only (GlobalProtect VPN). A half-open tunnel (after sleep/wake or idle) black-holes packets and surfaces mid-deploy as HTTP 000 / hung upload / TLS cert errors. If preflight fails: **quit + relaunch GlobalProtect** (more reliable than disable/enable toggle), wait ~10s, retry.

### 1. Confirm there's something to ship
On branch `hatch-active`, with the intended commits at HEAD. Bump `SITE_VERSION` + `SITE_TIME` in `server/version.ts` and add a `src/changelog.ts` entry as part of the commit (see commit contract).

### 2. Get a deploy token
`mcp__hatch__get_deploy_token` — Bearer token, valid **24h**, independent of the MCP OAuth session. (So even if `/mcp` needs reauth, a token grabbed earlier still works for the curl upload.)

### 3. Build the tar (excludes BEFORE `-C`)
Read `.gitignore`, convert every pattern to `--exclude`, plus the standard defaults, plus **`./.claude/settings.local.json`** (holds the seed secret — never upload). Verify size < 50 MB. The deployed app doesn't need `dist/` or `node_modules` — Hatch builds them.

### 4. Upload — ALWAYS re-pass `port` and full `env_vars`
`port` and `env_vars` are **NOT reliably sticky** (observed 2026-05-26: a redeploy without them brought the pod up on port 3000 with `DB_PATH` unset → wrong DB path, stalled rollout). Always include:
```
port=3001
env_vars={"HATCH_OKTA":"true","NODE_ENV":"production","EXEC_SUMMARY_ENABLED":"true","DB_PATH":"/files/shared.db","DCC_SEED_SECRET":"<value>"}
```
Sticky params (`size`, `auth`, `public`, `bedrock`, `volume_mount_path`, `description`) can be omitted. `DCC_SEED_SECRET` is read from `.claude/settings.local.json` (gitignored). Bedrock AWS creds are injected automatically by `bedrock=true` provisioning.

### 5. Wait for the build to FULLY publish, then verify the running version
**The single most important step — do not trust `status: running` alone.**

Build takes ~3-5 min. Then poll `mcp__hatch__get_status`. But: **`running` + a fresh pod name does NOT mean the new code is live.**

> **Rollout/build race (observed 2026-06-01):** The upload triggers a build AND an immediate rollout. If the rollout's image pull beats the build's publish, the new pod starts on the **PREVIOUS** image. Status shows "running" with a new pod → looks successful, but prod is serving stale code (old version, missing the new feature).

So **confirm the live `SITE_VERSION` actually equals what HEAD shipped:**
- The Okta gateway blocks an external `/api/versions` curl (returns login HTML), and pod logs don't print the version.
- **Reliable check: hard-refresh the site (Cmd+Shift+R) and read Settings → version.** A hard refresh matters — the browser may cache the old client bundle even after the server updates.
- If it still shows the old version → the rollout raced the build. **Wait for the build to publish, then redeploy.** (Data-safe — volume persists.)

### 6. Done
Report the verified version, pod age, and live URL. (Per `DEPLOYMENT_LOCK.md` history, the maintenance-mode quality gate was a Railway-era practice; Hatch rollouts are zero-downtime so it's optional now.)

---

## Known platform gotchas (Hatch/IT issues, not our setup)

These are upstream problems we work around, not misconfigurations on our side:

1. **Rollout/build race** — see step 5. Mitigation: verify version, redeploy if stale.
2. **MCP OAuth reauth ~hourly** — the `/mcp` hatch session expires fast and doesn't refresh silently (distinct from the 24h deploy token). A stale VPN tunnel makes the refresh black-hole, forcing reauth. Mitigation: keep the tunnel healthy (preflight), grab the deploy token early. Fix: `/mcp` → hatch → re-authorize.
3. **No non-gated deploy verification** — the Okta gateway blocks reading `/api/versions` externally, so version confirmation requires either MCP or a human browser check.

If these keep recurring, raise with the Hatch team — they're platform-side, not fixable in our code.

---

## Quick reference
- Sizes: huddle (1-5 users, 1-3 pods, current), meetup (≤30), town-hall (50-100)
- Limits: 50 MB archive, 7 apps/user max
- Bedrock: $100/mo default budget, $250 self-service cap; budget admins are kuber.kaul / marcin.pawalek / michael.snyder @dowjones.com
- Dashboard: https://platform.hatch.internal.ai.dowjones.io/dashboard/designhub

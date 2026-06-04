# Design Hub — Claude Instructions

This project is **Design Hub** (deploy name `designhub`), the Dow Jones design team's command center. Older names — "DCC", "Design Command Center", "WandiHub" — are deprecated; use "Design Hub".

## Start here (especially on a fresh machine / handoff)

- **`HANDOFF.md`** — project orientation, the three layers of admin access, local setup, architecture map, and platform gotchas. Read this first if you're new to the project.
- **`DEPLOY.md`** — the canonical deploy runbook (Hatch source-upload model, env vars, the mandatory post-deploy version verification, known gotchas). Read before any deploy.
- Deploys go to **Hatch** (use the `hatch` skill), NOT Railway and NOT `git push`. The working branch is **`hatch-active`**, not `main`.
- The old `README.md`, `DEPLOYMENT_LOCK.md`, and `DCC_PROJECT_LOG.md` describe the retired **Railway** workflow — treat them as historical, not current.

## Design System

Before creating any UI — components, pages, modals, styles — read `DESIGN.md` in this repo. It contains all design tokens, reusable CSS classes, component patterns, and rules. Use existing patterns. Never invent new class names, hardcode colors, or create ad-hoc button/card/modal styles.

## Drafts (security-sensitive)

Draft projects (`status='draft'`) must stay hidden from non-team viewers. Any new endpoint returning project data MUST route through the helpers in `server/drafts.ts` (`canSeeDrafts` / `filterDraftsForViewer` / `draftLabel` / `redactSnapshotForViewer`). See `HANDOFF.md`.

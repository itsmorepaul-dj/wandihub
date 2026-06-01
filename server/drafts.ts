import express from 'express';
import { all } from './db.js';
import { sessions, getSessionIdFromRequest } from './auth.js';

// Visibility: who can see a draft project's real data?
// - Admins always (they're the only recovery path if a designer is removed)
// - Anyone whose email matches a row in `team` (designers, regardless of
//   whether they're assigned to that specific project)
// - Everyone else gets the obfuscated copy from `obfuscateProject`

let cachedTeamEmails: Set<string> | null = null
let cacheUntil = 0
const CACHE_MS = 30_000

// Separately cached set of project ids that are CURRENTLY drafts. Used to
// redact stored snapshot blobs (weekly + review) at serve time: a snapshot is
// frozen point-in-time data and doesn't carry live status, so we decide what to
// hide from a non-team viewer by checking which referenced projects are still
// drafts right now. Matches the live-list semantics (a project promoted out of
// draft becomes visible everywhere, including in older snapshots).
let cachedDraftIds: Set<string> | null = null
let draftCacheUntil = 0

export const invalidateDraftViewerCache = () => {
  cachedTeamEmails = null
  cacheUntil = 0
  cachedDraftIds = null
  draftCacheUntil = 0
}

const loadTeamEmails = async (): Promise<Set<string>> => {
  if (cachedTeamEmails && Date.now() < cacheUntil) return cachedTeamEmails
  const rows = await all('SELECT email FROM team WHERE email IS NOT NULL AND email != ""') as { email: string }[]
  cachedTeamEmails = new Set(rows.map(r => r.email.toLowerCase()))
  cacheUntil = Date.now() + CACHE_MS
  return cachedTeamEmails
}

const loadDraftProjectIds = async (): Promise<Set<string>> => {
  if (cachedDraftIds && Date.now() < draftCacheUntil) return cachedDraftIds
  const rows = await all("SELECT id FROM projects WHERE status = 'draft'") as { id: string }[]
  cachedDraftIds = new Set(rows.map(r => r.id))
  draftCacheUntil = Date.now() + CACHE_MS
  return cachedDraftIds
}

// Localhost-only test override: append ?redact=1 to any URL to force the
// obfuscated path even if you're an admin / team member. Lets a single
// authenticated session preview what a non-team viewer sees.
const isLocalhostReq = (req: express.Request): boolean => {
  const host = (req.headers.host || '').split(':')[0]
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export const canSeeDrafts = async (req: express.Request): Promise<boolean> => {
  if (req.query?.redact === '1' && isLocalhostReq(req)) return false
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) return false
  const session = sessions.get(sessionId)
  if (!session) return false
  if (session.role === 'admin') return true
  const emails = await loadTeamEmails()
  return emails.has(session.email.toLowerCase())
}

// Return a redacted copy of a draft project. Hours and businessLine are
// preserved so capacity totals stay correct; everything else is stripped.
// `_isDraftRedacted: true` lets the client render the obfuscated state.
export const obfuscateDraftProject = (project: any): any => {
  if (!project || project.status !== 'draft') return project
  const businessLines = (() => {
    if (Array.isArray(project.businessLines) && project.businessLines.length) return project.businessLines
    if (project.businessLine) {
      try {
        const parsed = JSON.parse(project.businessLine)
        if (Array.isArray(parsed)) return parsed
      } catch { /* fall through */ }
      return [project.businessLine]
    }
    return []
  })()
  const blLabel = businessLines.length ? businessLines.join(' / ') : 'Hidden'
  return {
    id: project.id,
    name: `Draft project: ${blLabel}`,
    status: 'draft',
    estimatedHours: project.estimatedHours ?? 0,
    startDate: project.startDate ?? null,
    endDate: project.endDate ?? null,
    designers: [],
    businessLines,
    businessLine: project.businessLine ?? null,
    timeline: [],
    customLinks: [],
    description: null,
    url: null,
    deckLink: null,
    deckName: null,
    prdLink: null,
    prdName: null,
    briefLink: null,
    briefName: null,
    figmaLink: null,
    notes: null,
    assignee: null,
    dueDate: null,
    archivedQuarter: null,
    published: 0,
    public_slug: null,
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
    _isDraftRedacted: true,
  }
}

// Bulk-filter a list of projects for a given request. Authorized viewers get
// the list unchanged; everyone else gets each draft replaced with its
// obfuscated form.
export const filterDraftsForViewer = async (req: express.Request, projects: any[]): Promise<any[]> => {
  const allowed = await canSeeDrafts(req)
  if (allowed) return projects
  return projects.map(p => p?.status === 'draft' ? obfuscateDraftProject(p) : p)
}

// For JOIN-shaped rows that surface project_name + businessLine inline (e.g.
// /capacity assignments, /weekly-updates). Caller passes the field names so
// this works regardless of column aliasing.
export const draftLabel = (businessLineRaw: unknown): string => {
  if (!businessLineRaw) return 'Draft project: Hidden'
  if (typeof businessLineRaw === 'string') {
    try {
      const parsed = JSON.parse(businessLineRaw)
      if (Array.isArray(parsed) && parsed.length) return `Draft project: ${parsed.join(' / ')}`
      if (typeof parsed === 'string') return `Draft project: ${parsed}`
    } catch { /* fall through */ }
    return `Draft project: ${businessLineRaw}`
  }
  if (Array.isArray(businessLineRaw) && businessLineRaw.length) return `Draft project: ${businessLineRaw.join(' / ')}`
  return 'Draft project: Hidden'
}

// Resolve the project name to store in activity-log rows and SSE broadcasts.
// Those payloads fan out to EVERY connected client (including non-team
// viewers), so a draft project must contribute its obfuscated label, never its
// real name. Pass the project's name + status + raw businessLine column.
export const draftSafeProjectName = (
  name: string | null | undefined,
  status: string | null | undefined,
  businessLineRaw: unknown,
  fallback: string,
): string => {
  if (status === 'draft') return draftLabel(businessLineRaw)
  return name || fallback
}

// Serve-time redaction for STORED snapshot rows (weekly_snapshots,
// review_snapshots). A snapshot row has { plain_text, data_json } where
// data_json is a JSON object holding arrays of per-project entries (each with a
// `project_id`), and plain_text interleaves project names inline. Both ship in
// the HTTP response, so UI-only hiding is insufficient — a viewer can read the
// raw body. We therefore:
//   - drop every entry whose project_id is still a draft from each array in
//     data_json (rebuilt as a JSON string so the client parses it normally), and
//   - replace plain_text wholesale, since draft names are interleaved inline and
//     can't be surgically removed without re-deriving it.
// Admins and team members (canSeeDrafts === true) get the row untouched.
// `arrayKeys` lists which top-level data_json arrays hold project-keyed entries.
export const redactSnapshotForViewer = async (
  req: express.Request,
  snapshot: any,
  arrayKeys: string[],
): Promise<any> => {
  if (!snapshot) return snapshot
  if (await canSeeDrafts(req)) return snapshot

  const draftIds = await loadDraftProjectIds()
  if (draftIds.size === 0) return snapshot // nothing to hide

  let parsed: any = {}
  try { parsed = JSON.parse(snapshot.data_json || '{}') } catch { parsed = {} }

  let removedAny = false
  for (const key of arrayKeys) {
    const arr = parsed[key]
    if (!Array.isArray(arr)) continue
    const kept = arr.filter((entry: any) => {
      const pid = entry?.project_id
      const isDraft = pid != null && draftIds.has(pid)
      if (isDraft) removedAny = true
      return !isDraft
    })
    parsed[key] = kept
  }

  // If the snapshot referenced no drafts, leave plain_text intact so the
  // (unchanged) report text still renders. Only blank it when we actually
  // stripped draft content, since plain_text can't be cleaned in place.
  const safePlainText = removedAny
    ? 'Some entries in this report reference hidden draft projects and have been omitted from this view. Ask a design team member for the full report.'
    : snapshot.plain_text

  return {
    ...snapshot,
    plain_text: safePlainText,
    data_json: JSON.stringify(parsed),
    // Some callers also send a parsed `data` field alongside data_json (the
    // weekly preview does); keep it consistent so the client can't fall back
    // to an unredacted copy.
    ...(snapshot.data !== undefined ? { data: parsed } : {}),
  }
}

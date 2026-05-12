import express from 'express';
import { run, get, all } from '../db.js';
import { getUserEmail, requireAdmin } from '../auth.js';
import { logActivity } from '../version.js';
import { userIdForEmail, recipientsForAllActiveDesigners, pinRecipients } from '../activity.js';

const router = express.Router();

// Weekly deadline config (single source of truth)
const WEEKLY_DEADLINE = { day: 5, hour: 20, minute: 0 } // Friday 8pm ET



// ISO week string for a given date, e.g. "2026-W15"
const getISOWeek = (d: Date = new Date()) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

// "Active week" for form saves: before Monday noon ET, the just-completed
// ISO week (so late edits Sat/Sun/Mon-morning still belong to last Friday's
// report and can be regenerated into it). From Monday noon ET onward, the
// current ISO week (forward-dated to next Friday's report).
const getActiveWeek = (d: Date = new Date()): string => {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay() // 0=Sun, 1=Mon
  const hour = et.getHours()
  const inGrace = day === 0 || day === 6 || (day === 1 && hour < 12)
  if (!inGrace) return getISOWeek(d)
  // Walk back to the most recent Friday and take that date's ISO week.
  const back = new Date(d)
  for (let i = 0; i < 7; i++) {
    const t = new Date(back.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    if (t.getDay() === 5) break
    back.setDate(back.getDate() - 1)
  }
  return getISOWeek(back)
}

// ============ PROJECT WEEKLY UPDATES ============

// Live weekly_updates: one row per (project, designer, type). The `week`
// column is "last saved during this ISO week" — not a filter. Return all rows
// so forms can show the current state regardless of when it was last edited.
// Snapshots freeze a point-in-time copy, so historical weeks stay intact even
// though rows mutate in place going forward.
router.get('/weekly-updates', async (req, res) => {
  try {
    const projectId = req.query.project_id as string
    let sql = `SELECT wu.*, t.name as designer_name, p.name as project_name,
               p.businessLine as business_lines
               FROM weekly_updates wu
               LEFT JOIN team t ON wu.designer_id = t.id
               JOIN projects p ON wu.project_id = p.id`
    const params: any[] = []
    if (projectId) {
      sql += ' WHERE wu.project_id = ?'
      params.push(projectId)
    }
    sql += ' ORDER BY wu.updated_at DESC'
    const updates = await all(sql, params)
    res.json(updates)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Get updates for a project across all weeks (history)
router.get('/weekly-updates/history/:projectId', async (req, res) => {
  try {
    const updates = await all(
      `SELECT wu.*, t.name as designer_name
       FROM weekly_updates wu
       LEFT JOIN team t ON wu.designer_id = t.id
       WHERE wu.project_id = ?
       ORDER BY wu.week DESC, wu.created_at DESC`,
      [req.params.projectId]
    )
    res.json(updates)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Create or update a weekly update. The active week is computed server-side
// so late edits (Fri 8pm → Mon noon ET) still belong to the just-closed
// reporting week and can be picked up by a Regenerate on its snapshot.
router.post('/weekly-updates', async (req, res) => {
  try {
    const { id, project_id, designer_id, type, description, risk_reason, resolution } = req.body
    const updateId = id || `wu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const activeWeek = getActiveWeek()

    if (id) {
      await run(
        `UPDATE weekly_updates SET type = ?, description = ?, risk_reason = ?, resolution = ?, week = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [type, description || '', risk_reason || '', resolution || '', activeWeek, id]
      )
    } else {
      // One row per (project, designer, type). On conflict, update in place
      // and stamp the new active week so a later regenerate picks it up.
      await run(
        `INSERT INTO weekly_updates (id, project_id, designer_id, week, type, description, risk_reason, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, designer_id, type) DO UPDATE SET
           description = excluded.description,
           risk_reason = excluded.risk_reason,
           resolution = excluded.resolution,
           week = excluded.week,
           updated_at = datetime('now')`,
        [updateId, project_id, designer_id, activeWeek, type || 'highlight', description || '', risk_reason || '', resolution || '']
      )
    }

    const lookupId = id || updateId
    let saved = await get(
      `SELECT wu.*, t.name as designer_name, p.name as project_name, p.businessLine as business_lines
       FROM weekly_updates wu
       LEFT JOIN team t ON wu.designer_id = t.id
       LEFT JOIN projects p ON wu.project_id = p.id
       WHERE wu.id = ?`, [lookupId]
    )
    // On conflict the pre-existing row kept its original id — fall back to
    // the logical key so the client still gets the saved row.
    if (!saved && !id) {
      saved = await get(
        `SELECT wu.*, t.name as designer_name, p.name as project_name, p.businessLine as business_lines
         FROM weekly_updates wu
         LEFT JOIN team t ON wu.designer_id = t.id
         LEFT JOIN projects p ON wu.project_id = p.id
         WHERE wu.project_id = ? AND wu.designer_id = ? AND wu.type = ?`,
        [project_id, designer_id, type || 'highlight']
      )
    }
    res.json(saved)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Delete a weekly update
router.delete('/weekly-updates/:id', async (req, res) => {
  try {
    await run('DELETE FROM weekly_updates WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ GENERAL WEEKLY ENTRIES (FYIs, People Updates) ============

router.get('/weekly-general', async (req, res) => {
  try {
    const updates = await all(
      `SELECT wg.*, t.name as designer_name
       FROM weekly_general wg
       LEFT JOIN team t ON wg.designer_id = t.id
       ORDER BY wg.category, wg.updated_at DESC`
    )
    res.json(updates)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/weekly-general', async (req, res) => {
  try {
    const { id, designer_id, category, content, project_id, risk_reason, resolution } = req.body
    const entryId = id || `wg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const activeWeek = getActiveWeek()
    const projectId = project_id || null
    // Risk/Resolution are lowlight-only; zero them out for other categories so
    // a stale value can't follow a row that was repurposed from lowlight→fyi.
    const isLowlight = (category || 'fyi') === 'lowlight'
    const risk = isLowlight ? (risk_reason || '') : ''
    const resolutionText = isLowlight ? (resolution || '') : ''

    if (id) {
      await run(
        `UPDATE weekly_general SET content = ?, project_id = ?, week = ?, risk_reason = ?, resolution = ?, updated_at = datetime('now') WHERE id = ?`,
        [content || '', projectId, activeWeek, risk, resolutionText, id]
      )
    } else {
      // One row per (designer, category, project) — updates in place, week
      // shifts to whichever reporting week the edit belongs to.
      await run(
        `INSERT INTO weekly_general (id, designer_id, week, category, content, project_id, risk_reason, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(designer_id, category, COALESCE(project_id, '')) DO UPDATE SET
           content = excluded.content,
           week = excluded.week,
           risk_reason = excluded.risk_reason,
           resolution = excluded.resolution,
           updated_at = datetime('now')`,
        [entryId, designer_id, activeWeek, category || 'fyi', content || '', projectId, risk, resolutionText]
      )
    }

    const lookupId = id || entryId
    let saved = await get('SELECT * FROM weekly_general WHERE id = ?', [lookupId])
    if (!saved && !id) {
      saved = await get(
        `SELECT * FROM weekly_general WHERE designer_id = ? AND category = ? AND COALESCE(project_id, '') = COALESCE(?, '')`,
        [designer_id, category || 'fyi', projectId]
      )
    }
    res.json(saved)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/weekly-general/:id', async (req, res) => {
  try {
    await run('DELETE FROM weekly_general WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ CURRENT WEEK HELPERS ============

router.get('/current-week', (_req, res) => {
  res.json({ week: getISOWeek(), activeWeek: getActiveWeek() })
})

// ============ SNAPSHOT GENERATION ============

// Read-only: produces the same payload generateSnapshot would write, but
// without persisting. Used by the /preview endpoint so the "View Report"
// preview matches frozen snapshots byte-for-byte.
const generateSnapshotPayload = async (_week: string) => {
  const week = _week
  // Scope to THIS week's entries. Forms edit a single row per
  // (project, designer, type) in place and update the `week` column to the
  // reporting week on every save — so anything whose week != current is a
  // stale leftover from a previous reporting period and must not leak into
  // the new report. Also exclude archived-project rows regardless of week.
  const updatesRaw = await all(
    `SELECT wu.*, t.name as designer_name, p.name as project_name, p.businessLine as business_lines
     FROM weekly_updates wu
     LEFT JOIN team t ON wu.designer_id = t.id
     JOIN projects p ON wu.project_id = p.id
     WHERE p.status != 'archived' AND wu.week = ?
     ORDER BY wu.updated_at DESC`,
    [week]
  )
  const generalRaw = await all(
    `SELECT wg.*, t.name as designer_name, p.name as project_name
     FROM weekly_general wg
     LEFT JOIN team t ON wg.designer_id = t.id
     LEFT JOIN projects p ON wg.project_id = p.id
     WHERE wg.week = ? AND (wg.project_id IS NULL OR p.status != 'archived')
     ORDER BY wg.category, wg.updated_at DESC`,
    [week]
  )
  const projects = await all(`SELECT id, name, status, businessLine, startDate, endDate, estimatedHours, designers, deckLink, prdLink, briefLink, figmaLink, customLinks FROM projects WHERE status != 'archived'`)

  // Defensive dedup: a unique index on (week, project_id, designer_id, type)
  // already prevents duplicate rows at the DB layer, but we also dedup here so
  // the snapshot is clean even if the index is ever dropped or bypassed.
  // Newer rows win (input is ordered by created_at DESC, so the first seen is newest).
  const dedupBy = <T,>(rows: T[], keyFn: (row: T) => string): T[] => {
    const seen = new Set<string>()
    const out: T[] = []
    for (const row of rows) {
      const k = keyFn(row)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(row)
    }
    return out
  }
  const updates = dedupBy(updatesRaw, (u: any) => `${u.project_id}|${u.designer_id}|${u.type}`)
  const general = dedupBy(generalRaw, (e: any) => `${e.designer_id}|${e.category}|${e.content}|${e.project_id || ''}`)

  // Fetch thumbnails + past reviews for every project referenced in this week's
  // updates OR project-scoped general entries, so the snapshot is a self-
  // contained historical record. We cap both lists to keep data_json small.
  const referencedProjectIds = Array.from(new Set([
    ...updates.map((u: any) => u.project_id),
    ...general.map((e: any) => e.project_id),
  ].filter(Boolean)))
  const thumbnailsByProject: Record<string, Array<{ id: string; filename: string; caption: string }>> = {}
  const reviewsByProject: Record<string, Array<{ reviewId: string; title: string; review_date: string }>> = {}
  if (referencedProjectIds.length > 0) {
    const placeholders = referencedProjectIds.map(() => '?').join(',')
    const imageRows = await all(
      `SELECT id, project_id, filename, caption, sort_order, created_at
       FROM project_images
       WHERE project_id IN (${placeholders})
       ORDER BY project_id, sort_order ASC, created_at ASC`,
      referencedProjectIds
    )
    for (const row of imageRows as any[]) {
      if (!thumbnailsByProject[row.project_id]) thumbnailsByProject[row.project_id] = []
      if (thumbnailsByProject[row.project_id].length < 4) {
        thumbnailsByProject[row.project_id].push({ id: row.id, filename: row.filename, caption: row.caption || '' })
      }
    }
    const reviewRows = await all(
      `SELECT ri.project_id, ri.review_id, r.title, COALESCE(ri.review_date, r.review_date) AS review_date
       FROM review_items ri
       JOIN reviews r ON ri.review_id = r.id
       WHERE ri.project_id IN (${placeholders})
         AND (ri.deleted_at IS NULL) AND (r.deleted_at IS NULL)
       ORDER BY ri.project_id, COALESCE(ri.review_date, r.review_date) DESC`,
      referencedProjectIds
    )
    for (const row of reviewRows as any[]) {
      if (!reviewsByProject[row.project_id]) reviewsByProject[row.project_id] = []
      if (reviewsByProject[row.project_id].length < 5) {
        reviewsByProject[row.project_id].push({ reviewId: row.review_id, title: row.title || 'Review', review_date: row.review_date || '' })
      }
    }
  }

  // Parse the BL JSON array once per update so the UI can group on the first
  // BL and still show "Also in:" for multi-BL projects without re-parsing.
  const parseBLs = (raw: string | null | undefined): string[] => {
    if (!raw) return []
    try {
      const p = JSON.parse(raw)
      return Array.isArray(p) ? p.filter(Boolean) : (raw ? [String(raw)] : [])
    } catch {
      return raw ? [String(raw)] : []
    }
  }

  const enrich = (u: any) => {
    const bls = parseBLs(u.business_lines)
    return {
      ...u,
      business_lines_parsed: bls,
      primary_business_line: bls[0] || 'General',
      thumbnails: thumbnailsByProject[u.project_id] || [],
      past_reviews: reviewsByProject[u.project_id] || [],
    }
  }

  const highlights = updates.filter((u: any) => u.type === 'highlight').map(enrich)
  const lowlights = updates.filter((u: any) => u.type === 'lowlight').map(enrich)
  // Split general entries: project_id=null → true general (Reports-tab forms);
  // project_id set → project-scoped (entered from that project's card).
  const generalHighlights = general.filter((e: any) => e.category === 'highlight' && !e.project_id)
  const generalLowlights = general.filter((e: any) => e.category === 'lowlight' && !e.project_id)
  const fyis = general.filter((e: any) => e.category === 'fyi' && !e.project_id)
  const peopleUpdatesManual = general.filter((e: any) => e.category === 'people' && !e.project_id)
  const projectFyis = general.filter((e: any) => e.category === 'fyi' && e.project_id)
  const projectPeople = general.filter((e: any) => e.category === 'people' && e.project_id)

  // Report content is strictly what's in the form fields — no auto-injection.
  // If the general People field is empty, the People section stays empty (the
  // section only renders when there's content, per the SnapshotReportView
  // rules). Upcoming time off is visible elsewhere in the app (team page,
  // capacity view), so authors can mention it explicitly if they want it in
  // the report.
  const peopleUpdates = peopleUpdatesManual

  const highlightsText = (() => {
    const projectLines = highlights.map((u: any) => `    \u2022    ${u.primary_business_line}: ${u.project_name || 'Unknown'}\n    \u25E6    ${u.description}`)
    const splitLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
    const generalLines = generalHighlights.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    General: ${l}`))
    const all = [...generalLines, ...projectLines]
    return all.length > 0 ? all.join('\n') : '    \u2022    TK'
  })()

  const lowlightsText = (() => {
    const projectLines = lowlights.map((u: any) => {
      const lines = [`    \u2022    ${u.primary_business_line}: ${u.project_name || 'Unknown'}`, `    \u25E6    ${u.description}`]
      if (u.risk_reason) lines.push(`    \u25E6    At risk: ${u.risk_reason}`)
      if (u.resolution) lines.push(`    \u25E6    Path to resolution: ${u.resolution}`)
      return lines.join('\n')
    })
    const splitLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
    const generalLines = generalLowlights.flatMap((e: any) => {
      const body = splitLines(e.content).map(l => `    \u2022    General: ${l}`)
      if (e.risk_reason) body.push(`    \u25E6    At risk: ${e.risk_reason}`)
      if (e.resolution) body.push(`    \u25E6    Path to resolution: ${e.resolution}`)
      return body
    })
    const all = [...generalLines, ...projectLines]
    return all.length > 0 ? all.join('\n') : '    \u2022    TK'
  })()

  const splitLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
  const fyiGeneralLines = fyis.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    General: ${l}`))
  const fyiProjectLines = projectFyis.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    ${e.project_name || 'Project'}: ${l}`))
  const fyiAllLines = [...fyiGeneralLines, ...fyiProjectLines]
  const peopleGeneralLines = peopleUpdates.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    General: ${l}`))
  const peopleProjectLines = projectPeople.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    ${e.project_name || 'Project'}: ${l}`))
  const peopleAllLines = [...peopleGeneralLines, ...peopleProjectLines]
  const fyisText = fyiAllLines.length > 0 ? fyiAllLines.join('\n') : '    \u2022    TK'
  const peopleText = peopleAllLines.length > 0 ? peopleAllLines.join('\n') : '    \u2022    TK'

  const plainText = `Design\nHighlights\n${highlightsText}\n\nLowlights\n${lowlightsText}\n\nUpcoming FYIs\n${fyisText}\n\nPeople Updates\n${peopleText}`

  const dataJsonObj = {
    week,
    highlights: highlights.map((u: any) => ({ ...u })),
    lowlights: lowlights.map((u: any) => ({ ...u })),
    generalHighlights: generalHighlights.map((e: any) => ({ ...e })),
    generalLowlights: generalLowlights.map((e: any) => ({ ...e })),
    fyis: fyis.map((e: any) => ({ ...e })),
    peopleUpdates: peopleUpdates.map((e: any) => ({ ...e })),
    projectFyis: projectFyis.map((e: any) => ({ ...e })),
    projectPeople: projectPeople.map((e: any) => ({ ...e })),
    projectCount: projects.length,
  }

  return { week, plainText, dataJson: JSON.stringify(dataJsonObj), data: dataJsonObj }
}

// Full generate = build payload + persist. The cron and the /generate endpoint
// both go through here; /preview uses only generateSnapshotPayload.
const generateSnapshot = async (week: string) => {
  const payload = await generateSnapshotPayload(week)
  await run(
    `INSERT OR REPLACE INTO weekly_snapshots (id, week, generated_at, plain_text, data_json) VALUES (?, ?, datetime('now'), ?, ?)`,
    [week, week, payload.plainText, payload.dataJson]
  )
  console.log(`Weekly snapshot generated for ${week}`)
  return { week, plainText: payload.plainText, dataJson: payload.dataJson }
}

// ============ SNAPSHOT API ============

router.get('/weekly-snapshots', async (_req, res) => {
  try {
    const snapshots = await all('SELECT id, week, generated_at, edited_by, edited_at FROM weekly_snapshots ORDER BY week DESC')
    res.json(snapshots)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Read-only preview of what a snapshot for `week` would look like right now,
// built from live data. Does NOT write a weekly_snapshots row. Used by the
// "View Report" button on the Reports tab so the preview matches the real
// frozen snapshot format exactly (same enrichment, same data_json shape).
// Declared BEFORE the /:week route so Express matches it literally.
router.get('/weekly-snapshots/preview', async (req, res) => {
  try {
    const week = (req.query.week as string) || getActiveWeek()
    const preview = await generateSnapshotPayload(week)
    // Shape matches /weekly-snapshots/:week so the client can reuse its view code.
    res.json({
      week: preview.week,
      generated_at: new Date().toISOString(),
      plain_text: preview.plainText,
      data_json: preview.dataJson,
      data: preview.data,
      // Preview has no edited metadata — it's not a persisted row.
      edited_by: null,
      edited_at: null,
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/weekly-snapshots/:week', async (req, res) => {
  try {
    const snapshot = await get('SELECT * FROM weekly_snapshots WHERE week = ?', [req.params.week])
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' })
    res.json(snapshot)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/weekly-snapshots/generate', async (req, res) => {
  try {
    const week = (req.body.week as string) || getISOWeek()
    const initiatorEmail = getUserEmail(req)
    const result = await generateSnapshot(week)

    // Log the regeneration to the activity feed so the team can see who
    // refreshed the snapshot and when. Fan out to every active designer so
    // the entry appears in everyone's alerts — the snapshot is a shared
    // artifact, not a personal one.
    try {
      const details = JSON.stringify({
        week,
        summary: `Weekly Status snapshot for ${week} regenerated by ${initiatorEmail?.split('@')[0] || 'someone'}`,
      })
      const activityId = await logActivity('weekly', 'update', `Weekly Status snapshot — ${week}`, initiatorEmail || null, details)
      const initiatorUserId = await userIdForEmail(initiatorEmail)
      const recipients = await recipientsForAllActiveDesigners(initiatorUserId)
      await pinRecipients(activityId, recipients)
    } catch (logErr: any) {
      console.error('Snapshot regen activity log failed:', logErr.message)
    }

    res.json(result)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Admin-edit: patch the frozen data_json directly without touching live forms.
// Accepts a sparse object; merges onto existing data_json, stamps edited_by +
// edited_at. Does NOT update plain_text — consumers re-render rich from data_json.
router.patch('/weekly-snapshots/:week', requireAdmin, async (req, res) => {
  try {
    const week = req.params.week
    const patch = req.body?.data_json ?? {}
    const editorEmail = getUserEmail(req) || null

    const existing = await get('SELECT data_json FROM weekly_snapshots WHERE week = ?', [week])
    if (!existing) return res.status(404).json({ error: 'Snapshot not found' })

    let current: any = {}
    try { current = JSON.parse(existing.data_json || '{}') } catch { current = {} }

    // Shallow merge: the admin editor always sends full top-level arrays
    // (highlights/lowlights/generalHighlights/generalLowlights/fyis/peopleUpdates/
    //  projectFyis/projectPeople) so a shallow merge is correct and avoids
    // stale nested references.
    const merged = { ...current, ...patch }

    await run(
      `UPDATE weekly_snapshots SET data_json = ?, edited_by = ?, edited_at = datetime('now') WHERE week = ?`,
      [JSON.stringify(merged), editorEmail, week]
    )

    try {
      await logActivity('weekly', 'update', `Weekly Status snapshot — ${week} (admin edit)`, editorEmail, JSON.stringify({ week, summary: `Snapshot ${week} edited by ${editorEmail?.split('@')[0] || 'admin'}` }))
    } catch (logErr: any) {
      console.error('Snapshot admin-edit activity log failed:', logErr.message)
    }

    const updated = await get('SELECT * FROM weekly_snapshots WHERE week = ?', [week])
    res.json(updated)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ MISSING UPDATES CHECK ============

router.get('/weekly-updates/missing', async (req, res) => {
  try {
    const week = (req.query.week as string) || getISOWeek()
    const activeProjects = await all(`SELECT id, name, designers FROM projects WHERE status IN ('active', 'review', 'blocked')`)
    const updatedProjectIds = await all(
      `SELECT DISTINCT project_id FROM weekly_updates WHERE week = ?`, [week]
    )
    const updatedSet = new Set(updatedProjectIds.map((r: any) => r.project_id))
    const missing = activeProjects.filter((p: any) => !updatedSet.has(p.id))
    res.json({ projects: missing })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ FRIDAY 5PM ET CRON ============

let lastSnapshotCheck = ''

// One-shot startup migration: remove weekly_updates and weekly_general rows
// whose `week` is older than the current active week. The form edits a
// single row per (project, designer, type) in place, bumping the row's
// `week` on save — so anything with a stale week column is leftover content
// from a prior reporting period that the designer never re-edited. It
// clutters the live "View Report" preview even though the designer intended
// those entries as "last week". Frozen weekly_snapshots are untouched and
// remain the historical record. Idempotent: no-op once orphans are gone.
export const purgeStaleWeeklyRows = async () => {
  const currentWeek = getActiveWeek()
  try {
    const upd = await run('DELETE FROM weekly_updates WHERE week < ?', [currentWeek]) as any
    const updCount = typeof upd?.changes === 'number' ? upd.changes : 0
    if (updCount > 0) console.log(`stale cleanup: removed ${updCount} weekly_updates older than ${currentWeek}`)
  } catch (e: any) {
    console.error('stale weekly_updates cleanup failed:', e.message)
  }
  try {
    const gen = await run('DELETE FROM weekly_general WHERE week < ?', [currentWeek]) as any
    const genCount = typeof gen?.changes === 'number' ? gen.changes : 0
    if (genCount > 0) console.log(`stale cleanup: removed ${genCount} weekly_general older than ${currentWeek}`)
  } catch (e: any) {
    console.error('stale weekly_general cleanup failed:', e.message)
  }
}

export const startWeeklyCron = () => {
  setInterval(() => {
    const now = new Date()
    // Convert to ET (America/New_York)
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay() // 5 = Friday
    const hour = et.getHours()
    const minute = et.getMinutes()
    const checkKey = `${et.getFullYear()}-${et.getMonth()}-${et.getDate()}-${hour}-${minute}`

    if (day === WEEKLY_DEADLINE.day && hour === WEEKLY_DEADLINE.hour && minute === WEEKLY_DEADLINE.minute && checkKey !== lastSnapshotCheck) {
      lastSnapshotCheck = checkKey
      const week = getISOWeek(now)
      generateSnapshot(week).catch(e => console.error('Auto-snapshot failed:', e))
    }
  }, 30_000) // check every 30 seconds
  console.log('Weekly snapshot cron started (Friday 8pm ET)')
}

export default router;

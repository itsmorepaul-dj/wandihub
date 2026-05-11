import express from 'express';
import { run, get, all } from '../db.js';
import { getUserEmail } from '../auth.js';
import { logActivity } from '../version.js';
import { userIdForEmail, recipientsForAllActiveDesigners, pinRecipients } from '../activity.js';

const router = express.Router();

// Weekly deadline config (single source of truth)
const WEEKLY_DEADLINE = { day: 5, hour: 17, minute: 0 } // Friday 5pm ET



// ISO week string for a given date, e.g. "2026-W15"
const getISOWeek = (d: Date = new Date()) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

// ============ PROJECT WEEKLY UPDATES ============

// Get updates for a specific week (defaults to current week)
router.get('/weekly-updates', async (req, res) => {
  try {
    const week = (req.query.week as string) || getISOWeek()
    const projectId = req.query.project_id as string
    let sql = `SELECT wu.*, t.name as designer_name, p.name as project_name,
               p.businessLine as business_lines
               FROM weekly_updates wu
               LEFT JOIN team t ON wu.designer_id = t.id
               JOIN projects p ON wu.project_id = p.id
               WHERE wu.week = ?`
    const params: any[] = [week]
    if (projectId) {
      sql += ' AND wu.project_id = ?'
      params.push(projectId)
    }
    sql += ' ORDER BY wu.created_at DESC'
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

// Create or update a weekly update
router.post('/weekly-updates', async (req, res) => {
  try {
    const { id, project_id, designer_id, week, type, description, risk_reason, resolution } = req.body
    const updateId = id || `wu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const updateWeek = week || getISOWeek()

    if (id) {
      await run(
        `UPDATE weekly_updates SET type = ?, description = ?, risk_reason = ?, resolution = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [type, description || '', risk_reason || '', resolution || '', id]
      )
    } else {
      // Idempotent insert: the unique index on (week, project_id, designer_id, type)
      // means a retried submit for the same key updates the existing row instead
      // of duplicating. The RETURNING clause gives us the surviving row's id.
      await run(
        `INSERT INTO weekly_updates (id, project_id, designer_id, week, type, description, risk_reason, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(week, project_id, designer_id, type) DO UPDATE SET
           description = excluded.description,
           risk_reason = excluded.risk_reason,
           resolution = excluded.resolution,
           updated_at = datetime('now')`,
        [updateId, project_id, designer_id, updateWeek, type || 'highlight', description || '', risk_reason || '', resolution || '']
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
    // On conflict, the pre-existing row kept its original id — fall back to
    // the logical key so the client still gets the saved row.
    if (!saved && !id) {
      saved = await get(
        `SELECT wu.*, t.name as designer_name, p.name as project_name, p.businessLine as business_lines
         FROM weekly_updates wu
         LEFT JOIN team t ON wu.designer_id = t.id
         LEFT JOIN projects p ON wu.project_id = p.id
         WHERE wu.week = ? AND wu.project_id = ? AND wu.designer_id = ? AND wu.type = ?`,
        [updateWeek, project_id, designer_id, type || 'highlight']
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
    const week = (req.query.week as string) || getISOWeek()
    const updates = await all(
      `SELECT wg.*, t.name as designer_name
       FROM weekly_general wg
       LEFT JOIN team t ON wg.designer_id = t.id
       WHERE wg.week = ?
       ORDER BY wg.category, wg.created_at DESC`,
      [week]
    )
    res.json(updates)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/weekly-general', async (req, res) => {
  try {
    const { id, designer_id, week, category, content } = req.body
    const entryId = id || `wg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const entryWeek = week || getISOWeek()

    if (id) {
      await run(
        `UPDATE weekly_general SET content = ?, updated_at = datetime('now') WHERE id = ?`,
        [content || '', id]
      )
    } else {
      // Idempotent: unique index on (week, designer_id, category, content)
      // means duplicate submissions are a no-op update on the existing row.
      await run(
        `INSERT INTO weekly_general (id, designer_id, week, category, content)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(week, designer_id, category, content) DO UPDATE SET
           updated_at = datetime('now')`,
        [entryId, designer_id, entryWeek, category || 'fyi', content || '']
      )
    }

    const lookupId = id || entryId
    let saved = await get('SELECT * FROM weekly_general WHERE id = ?', [lookupId])
    if (!saved && !id) {
      saved = await get(
        `SELECT * FROM weekly_general WHERE week = ? AND designer_id = ? AND category = ? AND content = ?`,
        [entryWeek, designer_id, category || 'fyi', content || '']
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

// ============ CURRENT WEEK HELPER ============

router.get('/current-week', (_req, res) => {
  res.json({ week: getISOWeek() })
})

// ============ SNAPSHOT GENERATION ============

const generateSnapshot = async (week: string) => {
  const updatesRaw = await all(
    `SELECT wu.*, t.name as designer_name, p.name as project_name, p.businessLine as business_lines
     FROM weekly_updates wu
     LEFT JOIN team t ON wu.designer_id = t.id
     JOIN projects p ON wu.project_id = p.id
     WHERE wu.week = ? ORDER BY wu.created_at DESC`, [week]
  )
  const generalRaw = await all(
    `SELECT wg.*, t.name as designer_name
     FROM weekly_general wg
     LEFT JOIN team t ON wg.designer_id = t.id
     WHERE wg.week = ? ORDER BY wg.category, wg.created_at DESC`, [week]
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
  const general = dedupBy(generalRaw, (e: any) => `${e.designer_id}|${e.category}|${e.content}`)

  const highlights = updates.filter((u: any) => u.type === 'highlight')
  const lowlights = updates.filter((u: any) => u.type === 'lowlight')
  const generalHighlights = general.filter((e: any) => e.category === 'highlight')
  const generalLowlights = general.filter((e: any) => e.category === 'lowlight')
  const fyis = general.filter((e: any) => e.category === 'fyi')
  const peopleUpdates = general.filter((e: any) => e.category === 'people')

  const getBrand = (u: any) => {
    if (u.business_lines) {
      try { const p = JSON.parse(u.business_lines); return Array.isArray(p) ? p[0] : u.business_lines } catch { return u.business_lines }
    }
    return 'General'
  }

  const highlightsText = (() => {
    const projectLines = highlights.map((u: any) => `    \u2022    ${getBrand(u)}: ${u.project_name || 'Unknown'}\n    \u25E6    ${u.description}`)
    const splitLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
    const generalLines = generalHighlights.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    General: ${l}`))
    const all = [...generalLines, ...projectLines]
    return all.length > 0 ? all.join('\n') : '    \u2022    TK'
  })()

  const lowlightsText = (() => {
    const projectLines = lowlights.map((u: any) => {
      const lines = [`    \u2022    ${getBrand(u)}: ${u.project_name || 'Unknown'}`, `    \u25E6    ${u.description}`]
      if (u.risk_reason) lines.push(`    \u25E6    At risk: ${u.risk_reason}`)
      if (u.resolution) lines.push(`    \u25E6    Path to resolution: ${u.resolution}`)
      return lines.join('\n')
    })
    const splitLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
    const generalLines = generalLowlights.flatMap((e: any) => splitLines(e.content).map(l => `    \u2022    General: ${l}`))
    const all = [...generalLines, ...projectLines]
    return all.length > 0 ? all.join('\n') : '    \u2022    TK'
  })()

  const splitLines = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean)
  const fyiLines = fyis.flatMap((e: any) => splitLines(e.content))
  const peopleLines = peopleUpdates.flatMap((e: any) => splitLines(e.content))
  const fyisText = fyiLines.length > 0 ? fyiLines.map(l => `    \u2022    General: ${l}`).join('\n') : '    \u2022    TK'
  const peopleText = peopleLines.length > 0 ? peopleLines.map(l => `    \u2022    General: ${l}`).join('\n') : '    \u2022    TK'

  const plainText = `Design\nHighlights\n${highlightsText}\n\nLowlights\n${lowlightsText}\n\nUpcoming FYIs\n${fyisText}\n\nPeople Updates\n${peopleText}`

  const dataJson = JSON.stringify({
    week,
    highlights: highlights.map((u: any) => ({ ...u })),
    lowlights: lowlights.map((u: any) => ({ ...u })),
    generalHighlights: generalHighlights.map((e: any) => ({ ...e })),
    generalLowlights: generalLowlights.map((e: any) => ({ ...e })),
    fyis: fyis.map((e: any) => ({ ...e })),
    peopleUpdates: peopleUpdates.map((e: any) => ({ ...e })),
    projectCount: projects.length,
  })

  await run(
    `INSERT OR REPLACE INTO weekly_snapshots (id, week, generated_at, plain_text, data_json) VALUES (?, ?, datetime('now'), ?, ?)`,
    [week, week, plainText, dataJson]
  )

  console.log(`Weekly snapshot generated for ${week}`)
  return { week, plainText, dataJson }
}

// ============ SNAPSHOT API ============

router.get('/weekly-snapshots', async (_req, res) => {
  try {
    const snapshots = await all('SELECT id, week, generated_at FROM weekly_snapshots ORDER BY week DESC')
    res.json(snapshots)
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
  console.log('Weekly snapshot cron started (Friday 5pm ET)')
}

export default router;

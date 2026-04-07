import express from 'express';
import { run, get, all } from '../db.js';
import { getUserEmail } from '../auth.js';

const router = express.Router();

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
               LEFT JOIN projects p ON wu.project_id = p.id
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
      await run(
        `INSERT INTO weekly_updates (id, project_id, designer_id, week, type, description, risk_reason, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [updateId, project_id, designer_id, updateWeek, type || 'highlight', description || '', risk_reason || '', resolution || '']
      )
    }

    const saved = await get('SELECT * FROM weekly_updates WHERE id = ?', [id || updateId])
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
      await run(
        `INSERT INTO weekly_general (id, designer_id, week, category, content)
         VALUES (?, ?, ?, ?, ?)`,
        [entryId, designer_id, entryWeek, category || 'fyi', content || '']
      )
    }

    const saved = await get('SELECT * FROM weekly_general WHERE id = ?', [id || entryId])
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

export default router;

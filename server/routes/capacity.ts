import express from 'express';
import { run, get, all, upsertAssignment } from '../db.js';
import { updateDbVersion, logActivity } from '../version.js';
import { getUserEmail } from '../auth.js';
import { syncAssignmentToProjectDesigners } from './projects.js';
import { pinRecipients, userIdForEmail, recipientForTeamMember } from '../activity.js';

const router = express.Router();

// ============ PRIORITIES ============

router.get('/priorities', async (req, res) => {
  try {
    const rows = await all('SELECT business_line_id, project_id, rank FROM project_priorities ORDER BY business_line_id, rank ASC')
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

router.put('/priorities', async (req, res) => {
  const { business_line_id, project_ids } = req.body
  if (!business_line_id || !Array.isArray(project_ids)) {
    return res.status(400).json({ error: 'business_line_id and project_ids required' })
  }
  try {
    await run('DELETE FROM project_priorities WHERE business_line_id = ?', [business_line_id])
    for (let i = 0; i < project_ids.length; i++) {
      await run(
        'INSERT INTO project_priorities (business_line_id, project_id, rank) VALUES (?, ?, ?)',
        [business_line_id, project_ids[i], i + 1]
      )
    }
    await updateDbVersion()
    const blName = (await get('SELECT name FROM business_lines WHERE id = ?', [business_line_id]) as any)?.name || business_line_id
    await logActivity('priority', 'update', blName, getUserEmail(req), `${project_ids.length} projects reordered`)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ============ CAPACITY ============

router.get('/capacity', async (req, res) => {
  try {
    const team = await all('SELECT * FROM team ORDER BY name') as any[]
    const teamWithHours = team.map((m: any) => ({
      ...m,
      weekly_hours: m.weekly_hours || 35,
      excluded: !!m.excluded,
      timeOff: m.timeOff ? JSON.parse(m.timeOff) : []
    }))

    const assignments = await all(`
      SELECT pa.*, p.name as project_name, p.businessLine, p.status as project_status,
             t.name as designer_name, t.role as designer_role
      FROM project_assignments pa
      JOIN projects p ON pa.project_id = p.id
      JOIN team t ON pa.designer_id = t.id
      ORDER BY p.name, t.name
    `)

    res.json({ team: teamWithHours, assignments })
  } catch (e: any) { res.status(500).json({error: e.message}); }
})

router.post('/capacity/assignments', async (req, res) => {
  try {
    const { project_id, designer_id, allocation_percent } = req.body
    const id = `${project_id}_${designer_id}`
    await upsertAssignment({ id, project_id, designer_id, allocation_percent })
    await syncAssignmentToProjectDesigners(project_id, designer_id, true)
    await updateDbVersion()
    const projName = (await get('SELECT name FROM projects WHERE id = ?', [project_id]) as any)?.name || project_id
    const designerName = (await get('SELECT name FROM team WHERE id = ?', [designer_id]) as any)?.name || designer_id
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('capacity', 'update', projName, initiatorEmail, `${designerName} → ${allocation_percent}%`)
    // Fan out to the designer whose allocation changed (not the initiator).
    await pinRecipients(activityId, await recipientForTeamMember(designer_id, initiatorId))
    res.json({ success: true, id })
  } catch (e: any) { res.status(500).json({error: e.message}); }
})

router.delete('/capacity/assignments/:id', async (req, res) => {
  try {
    const existing = await get('SELECT pa.project_id, pa.designer_id, p.name as project_name, t.name as designer_name FROM project_assignments pa LEFT JOIN projects p ON pa.project_id = p.id LEFT JOIN team t ON pa.designer_id = t.id WHERE pa.id = ?', [req.params.id]) as any
    await run('DELETE FROM project_assignments WHERE id = ?', [req.params.id])
    if (existing?.project_id && existing?.designer_id) {
      await syncAssignmentToProjectDesigners(existing.project_id, existing.designer_id, false)
    }
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('capacity', 'delete', existing?.project_name || req.params.id, initiatorEmail, `Removed ${existing?.designer_name || 'assignment'}`)
    if (existing?.designer_id) {
      await pinRecipients(activityId, await recipientForTeamMember(existing.designer_id, initiatorId))
    }
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({error: e.message}); }
})

router.put('/capacity/availability/:designerId', async (req, res) => {
  try {
    const { weekly_hours, excluded } = req.body
    const updates: string[] = []
    const params: any[] = []
    if (weekly_hours !== undefined) { updates.push('weekly_hours = ?'); params.push(weekly_hours) }
    if (excluded !== undefined) { updates.push('excluded = ?'); params.push(excluded ? 1 : 0) }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })
    updates.push('updatedAt = datetime("now")')
    params.push(req.params.designerId)
    await run(`UPDATE team SET ${updates.join(', ')} WHERE id = ?`, params)
    await updateDbVersion()
    const designer = await get('SELECT name, weekly_hours, excluded FROM team WHERE id = ?', [req.params.designerId]) as any
    const detail = weekly_hours !== undefined ? `Weekly hours → ${weekly_hours}h` : `Excluded → ${excluded}`
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('capacity', 'update', designer?.name || req.params.designerId, initiatorEmail, detail)
    await pinRecipients(activityId, await recipientForTeamMember(req.params.designerId, initiatorId))
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({error: e.message}); }
})

export default router;

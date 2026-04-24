import express from 'express';
import { run, get, all, upsertTeamMember } from '../db.js';
import { updateDbVersion, logActivity } from '../version.js';
import { getUserEmail } from '../auth.js';
import { pinRecipients, userIdForEmail, recipientForTeamMember, recipientsForAllActiveDesigners } from '../activity.js';

const router = express.Router();

// ============ TEAM ============

router.get('/team', async (req, res) => {
  try {
    const team = await all('SELECT * FROM team ORDER BY name') as any[];
    res.json(team.map((m: any) => ({
      ...m,
      brands: JSON.parse(m.brands || '[]'),
      timeOff: m.timeOff ? JSON.parse(m.timeOff) : [],
      excluded: !!m.excluded
    })));
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.post('/team', async (req, res) => {
  try {
    const { id, name, role, brands, status, slack, email, avatar, timeOff, weekly_hours, excluded, updatedAt: clientUpdatedAt } = req.body;
    const memberId = id || Date.now().toString();

    if (id && clientUpdatedAt) {
      const existing = await get('SELECT updatedAt FROM team WHERE id = ?', [id]) as any
      if (existing && existing.updatedAt && existing.updatedAt !== clientUpdatedAt) {
        return res.status(409).json({ error: 'This team member was modified by another user. Please refresh and try again.' })
      }
    }

    // Detect timeOff changes so we can notify the team member when someone
    // else edited their PTO. Compare by id sets to avoid noise on resaves.
    const prior = id ? (await get('SELECT timeOff FROM team WHERE id = ?', [id]) as any) : null
    let priorTimeOffIds = new Set<string>()
    if (prior?.timeOff) {
      try { const arr = JSON.parse(prior.timeOff); priorTimeOffIds = new Set((arr || []).map((t: any) => t.id)) } catch { /* ignore */ }
    }
    const newTimeOffIds = new Set<string>((timeOff || []).map((t: any) => t.id))
    const added = [...newTimeOffIds].filter(x => !priorTimeOffIds.has(x))
    const removed = [...priorTimeOffIds].filter(x => !newTimeOffIds.has(x))
    const timeOffChanged = added.length > 0 || removed.length > 0

    await upsertTeamMember({
      id: memberId, name, role, brands, status, slack, email, avatar, timeOff, weekly_hours, excluded,
    });
    await updateDbVersion()

    if (timeOffChanged) {
      const initiatorEmail = getUserEmail(req)
      const initiatorId = await userIdForEmail(initiatorEmail)
      const memberUid = await userIdForEmail(email || '')
      // Only fan out if the editor is NOT the member themselves.
      if (memberUid && memberUid !== initiatorId) {
        const parts: string[] = []
        if (added.length) parts.push(`${added.length} added`)
        if (removed.length) parts.push(`${removed.length} removed`)
        const detail = `PTO ${parts.join(', ')}`
        const activityId = await logActivity('holiday', 'update', name || memberId, initiatorEmail, detail)
        await pinRecipients(activityId, await recipientForTeamMember(memberId, initiatorId))
      }
    }

    const saved = await get('SELECT * FROM team WHERE id = ?', [memberId])
    res.json(saved);
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.delete('/team/:id', async (req, res) => {
  try {
    await run('DELETE FROM team WHERE id = ?', [req.params.id]);
    await updateDbVersion()
    res.json({success: true});
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

// ============ HOLIDAYS ============

router.get('/holidays', async (_req, res) => {
  try {
    const holidays = await all('SELECT * FROM holidays ORDER BY date');
    res.json(holidays);
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.post('/holidays', async (req, res) => {
  try {
    const { id, name, date } = req.body;
    if (!name || !date) return res.status(400).json({ error: 'name and date required' });
    const holidayId = id || Date.now().toString();
    await run(
      'INSERT OR REPLACE INTO holidays (id, name, date) VALUES (?, ?, ?)',
      [holidayId, name, date]
    );
    updateDbVersion();
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('holiday', id ? 'update' : 'create', name, initiatorEmail, date)
    // Org-wide event → fan out to every active designer except the initiator.
    await pinRecipients(activityId, await recipientsForAllActiveDesigners(initiatorId))
    const holidays = await all('SELECT * FROM holidays ORDER BY date');
    res.json(holidays);
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.delete('/holidays/:id', async (req, res) => {
  try {
    const existing = await get('SELECT name FROM holidays WHERE id = ?', [req.params.id]) as any
    await run('DELETE FROM holidays WHERE id = ?', [req.params.id]);
    updateDbVersion();
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('holiday', 'delete', existing?.name || req.params.id, initiatorEmail)
    await pinRecipients(activityId, await recipientsForAllActiveDesigners(initiatorId))
    const holidays = await all('SELECT * FROM holidays ORDER BY date');
    res.json(holidays);
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

export default router;

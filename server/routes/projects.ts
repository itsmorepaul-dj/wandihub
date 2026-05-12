import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { run, get, all, upsertProject, upsertBusinessLine, IMAGES_DIR } from '../db.js';
import { updateDbVersion, logActivity } from '../version.js';
import { getUserEmail } from '../auth.js';
import { recipientsForProject, pinRecipients, userIdForEmail } from '../activity.js';

const router = express.Router();

// Remove a project and every row that references it. Live data goes away;
// review_items use the existing soft-delete column so the audit trail (past
// review appearances) is preserved but they no longer show up in live queries.
// Image files on disk are removed alongside their DB rows so we don't leak
// storage when a project is deleted.
export const deleteProjectCascade = async (projectId: string) => {
  const images = await all('SELECT filename FROM project_images WHERE project_id = ?', [projectId]) as { filename: string }[]
  for (const img of images) {
    try {
      const filePath = path.join(IMAGES_DIR, img.filename)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch (e: any) {
      console.error('project image file cleanup failed:', img.filename, e.message)
    }
  }
  await run('DELETE FROM project_images WHERE project_id = ?', [projectId])
  await run('DELETE FROM weekly_updates WHERE project_id = ?', [projectId])
  await run('DELETE FROM weekly_general WHERE project_id = ?', [projectId])
  await run('DELETE FROM project_priorities WHERE project_id = ?', [projectId])
  await run('DELETE FROM note_project_links WHERE project_id = ?', [projectId])
  await run('DELETE FROM project_assignments WHERE project_id = ?', [projectId])
  await run("UPDATE review_items SET deleted_at = datetime('now') WHERE project_id = ? AND deleted_at IS NULL", [projectId])
  await run('DELETE FROM projects WHERE id = ?', [projectId])
}

// ============ PROJECTS ============

router.get('/projects', async (req, res) => {
  try {
    const projects = await all('SELECT * FROM projects ORDER BY createdAt DESC');
    res.json((projects as any[]).map((p: any) => ({
      ...p,
      timeline: p.timeline ? JSON.parse(p.timeline) : [],
      customLinks: p.customLinks ? JSON.parse(p.customLinks) : [],
      designers: p.designers ? JSON.parse(p.designers) : [],
      businessLines: p.businessLine ? (() => { try { return JSON.parse(p.businessLine); } catch { return [p.businessLine]; } })() : []
    })));
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.post('/projects', async (req, res) => {
  try {
    const { id, name, status, dueDate, assignee, url, description, businessLines, deckName, deckLink, prdName, prdLink, briefName, briefLink, figmaLink, customLinks, designers, startDate, endDate, timeline, estimatedHours, updatedAt: clientUpdatedAt } = req.body;
    const projectId = id || Date.now().toString();

    if (id && clientUpdatedAt) {
      const existing = await get('SELECT updatedAt FROM projects WHERE id = ?', [id]) as any
      if (existing && existing.updatedAt && existing.updatedAt !== clientUpdatedAt) {
        return res.status(409).json({ error: 'This project was modified by another user. Please refresh and try again.' })
      }
    }

    await upsertProject({
      id: projectId, name, status, dueDate, assignee, url, description,
      businessLines, deckName, deckLink, prdName, prdLink, briefName, briefLink,
      figmaLink, customLinks, designers, startDate, endDate, timeline, estimatedHours,
    });

    await syncProjectDesignersToAssignments(projectId, designers || [])

    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('project', id ? 'update' : 'create', name || projectId, initiatorEmail)
    // Fan out to assigned designers (now reflects the new list), minus the editor.
    const recipients = await recipientsForProject(projectId, initiatorId)
    await pinRecipients(activityId, recipients)
    const saved = await get('SELECT * FROM projects WHERE id = ?', [projectId])
    res.json(saved);
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.delete('/projects/:id', async (req, res) => {
  try {
    const existing = await get('SELECT name FROM projects WHERE id = ?', [req.params.id]) as any
    // Snapshot recipients BEFORE delete — `projects.designers` disappears in the row-delete.
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const recipients = await recipientsForProject(req.params.id, initiatorId)
    await deleteProjectCascade(req.params.id)
    await updateDbVersion()
    const activityId = await logActivity('project', 'delete', existing?.name || req.params.id, initiatorEmail)
    await pinRecipients(activityId, recipients)
    res.json({success: true});
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.put('/projects/:id/done', async (req, res) => {
  try {
    const proj = await get('SELECT name FROM projects WHERE id = ?', [req.params.id]) as any
    await run("UPDATE projects SET status = 'done', updatedAt = datetime('now') WHERE id = ?", [req.params.id])
    await run('UPDATE project_assignments SET allocation_percent = 0 WHERE project_id = ?', [req.params.id])
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('project', 'update', proj?.name || req.params.id, initiatorEmail, 'Marked as done')
    await pinRecipients(activityId, await recipientsForProject(req.params.id, initiatorId))
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/projects/:id/undone', async (req, res) => {
  try {
    const proj = await get('SELECT name FROM projects WHERE id = ?', [req.params.id]) as any
    await run("UPDATE projects SET status = 'active', updatedAt = datetime('now') WHERE id = ?", [req.params.id])
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('project', 'update', proj?.name || req.params.id, initiatorEmail, 'Restored to active')
    await pinRecipients(activityId, await recipientsForProject(req.params.id, initiatorId))
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ ARCHIVE / QUARTER ROLLOVER ============

router.put('/projects/:id/archive', async (req, res) => {
  try {
    const { quarter } = req.body
    if (!quarter) return res.status(400).json({ error: 'quarter is required (e.g., Q3-FY26)' })
    const proj = await get('SELECT name FROM projects WHERE id = ?', [req.params.id]) as any
    await run("UPDATE projects SET status = 'archived', archivedQuarter = ?, updatedAt = datetime('now') WHERE id = ?", [quarter, req.params.id])
    await run('UPDATE project_assignments SET allocation_percent = 0 WHERE project_id = ?', [req.params.id])
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('project', 'update', proj?.name || req.params.id, initiatorEmail, `Archived to ${quarter}`)
    await pinRecipients(activityId, await recipientsForProject(req.params.id, initiatorId))
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/projects/:id/unarchive', async (req, res) => {
  try {
    const proj = await get('SELECT name, archivedQuarter FROM projects WHERE id = ?', [req.params.id]) as any
    await run("UPDATE projects SET archivedQuarter = NULL, status = 'active', updatedAt = datetime('now') WHERE id = ?", [req.params.id])
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const activityId = await logActivity('project', 'update', proj?.name || req.params.id, initiatorEmail, `Restored from archive (${proj?.archivedQuarter || 'unknown'})`)
    await pinRecipients(activityId, await recipientsForProject(req.params.id, initiatorId))
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Slugify a project name for the human-readable part of a public URL.
const slugifyBase = (name: string): string => {
  return (name || 'project')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project'
}

// Build a capability-style public slug: `<name>-<8-char-random>`. The random
// suffix keeps the URL unguessable so anonymous visitors need the shared link
// to find the page.
const buildPublicSlug = async (name: string, excludeId: string): Promise<string> => {
  const base = slugifyBase(name)
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = crypto.randomBytes(5).toString('base64url').slice(0, 8).toLowerCase()
    const slug = `${base}-${suffix}`
    const collision = await get('SELECT id FROM projects WHERE public_slug = ? AND id != ?', [slug, excludeId]) as any
    if (!collision) return slug
  }
  throw new Error('Failed to generate unique slug after 5 attempts')
}

router.put('/projects/:id/publish', async (req, res) => {
  try {
    const proj = await get('SELECT name, public_slug FROM projects WHERE id = ?', [req.params.id]) as any
    if (!proj) return res.status(404).json({ error: 'Project not found' })
    // Reuse existing slug if already set (preserves URLs across unpublish/republish),
    // otherwise mint a new capability-style slug.
    const slug = proj.public_slug || await buildPublicSlug(proj.name, req.params.id)
    await run("UPDATE projects SET published = 1, public_slug = ?, updatedAt = datetime('now') WHERE id = ?", [slug, req.params.id])
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    await logActivity('project', 'update', proj.name || req.params.id, initiatorEmail, 'Published public project page')
    res.json({ success: true, public_slug: slug })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/projects/:id/unpublish', async (req, res) => {
  try {
    const proj = await get('SELECT name FROM projects WHERE id = ?', [req.params.id]) as any
    if (!proj) return res.status(404).json({ error: 'Project not found' })
    // Keep public_slug around so the same URL is reused if re-published later.
    await run("UPDATE projects SET published = 0, updatedAt = datetime('now') WHERE id = ?", [req.params.id])
    await updateDbVersion()
    const initiatorEmail = getUserEmail(req)
    await logActivity('project', 'update', proj.name || req.params.id, initiatorEmail, 'Unpublished public project page')
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/quarter-rollover', async (req, res) => {
  try {
    const { quarter } = req.body
    if (!quarter) return res.status(400).json({ error: 'quarter is required (e.g., Q3-FY26)' })
    const initiatorEmail = getUserEmail(req)
    const initiatorId = await userIdForEmail(initiatorEmail)
    const doneProjects = await all("SELECT id, name FROM projects WHERE status = 'done' AND archivedQuarter IS NULL") as any[]

    // Build a recipient-level rollup BEFORE mutating, so we have access to
    // projects.designers and can collapse per user.
    const perUser = new Map<number, { count: number; names: string[] }>()
    for (const p of doneProjects) {
      const recipients = await recipientsForProject(p.id, initiatorId)
      for (const uid of recipients) {
        const e = perUser.get(uid) || { count: 0, names: [] }
        e.count++
        e.names.push(p.name)
        perUser.set(uid, e)
      }
    }

    for (const p of doneProjects) {
      await run("UPDATE projects SET status = 'archived', archivedQuarter = ?, updatedAt = datetime('now') WHERE id = ?", [quarter, p.id])
      await run('UPDATE project_assignments SET allocation_percent = 0 WHERE project_id = ?', [p.id])
    }
    await updateDbVersion()

    // Summary activity row (admin-only via normal firehose rules).
    await logActivity('project', 'update', `Quarter rollover: ${quarter}`, initiatorEmail, `Archived ${doneProjects.length} done projects`)

    // One collapsed "N of your projects archived" row per affected designer.
    for (const [uid, info] of perUser.entries()) {
      const preview = info.names.slice(0, 3).join(', ')
      const more = info.names.length > 3 ? ` +${info.names.length - 3} more` : ''
      const detail = JSON.stringify({
        quarter,
        project_names: info.names,
        summary: `${info.count} of your project${info.count !== 1 ? 's' : ''} archived: ${preview}${more}`,
      })
      const activityId = await logActivity('project', 'update', `Quarter rollover: ${quarter}`, null, detail)
      await pinRecipients(activityId, [uid])
    }

    res.json({ success: true, archived: doneProjects.length, projects: doneProjects.map((p: any) => p.name) })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ BUSINESS LINES ============

router.get('/business-lines', async (req, res) => {
  try {
    const lines = await all('SELECT * FROM business_lines ORDER BY name');
    res.json((lines as any[]).map((l: any) => ({
      ...l,
      customLinks: l.customLinks ? JSON.parse(l.customLinks) : []
    })));
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.post('/business-lines', async (req, res) => {
  try {
    const { id, name, deckName, deckLink, prdName, prdLink, briefName, briefLink, figmaLink, customLinks, originalName, updatedAt: clientUpdatedAt } = req.body;
    const lineId = id || Date.now().toString();

    if (id && clientUpdatedAt) {
      const existing = await get('SELECT updatedAt FROM business_lines WHERE id = ?', [id]) as any
      if (existing && existing.updatedAt && existing.updatedAt !== clientUpdatedAt) {
        return res.status(409).json({ error: 'This business line was modified by another user. Please refresh and try again.' })
      }
    }
    if (originalName && originalName !== name) {
      const allProjects = await all("SELECT id, businessLine FROM projects") as any[];
      for (const p of allProjects) {
        if (p.businessLine) {
          let bls: string[];
          try { bls = JSON.parse(p.businessLine) as string[]; } catch { bls = [p.businessLine]; }
          if (bls.includes(originalName)) {
            const updated = bls.map((b: string) => b === originalName ? name : b);
            await run("UPDATE projects SET businessLine = ? WHERE id = ?", [JSON.stringify(updated), p.id]);
          }
        }
      }
      const members = await all("SELECT id, brands FROM team") as any[];
      for (const m of members) {
        const brands = JSON.parse(m.brands || '[]');
        if (brands.includes(originalName)) {
          const updated = brands.map((b: string) => b === originalName ? name : b);
          await run("UPDATE team SET brands = ? WHERE id = ?", [JSON.stringify(updated), m.id]);
        }
      }
    }

    await upsertBusinessLine({
      id: lineId, name, deckName, deckLink, prdName, prdLink, briefName, briefLink, figmaLink, customLinks,
    });
    await updateDbVersion()
    res.json({id: lineId, ...req.body});
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

router.delete('/business-lines/:id', async (req, res) => {
  try {
    await run('DELETE FROM business_lines WHERE id = ?', [req.params.id]);
    await updateDbVersion()
    res.json({success: true});
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

// ============ BRAND OPTIONS ============

router.get('/brandOptions', async (req, res) => {
  try {
    const brands = await all('SELECT name FROM business_lines ORDER BY name') as any[];
    res.json(brands.map((b: any) => b.name));
  } catch (e: any) { res.status(500).json({error: e.message}); }
});

// ============ HELPERS ============

interface TeamIdentity { id: string; name: string }

export const syncProjectDesignersToAssignments = async (projectId: string, designerNames: string[]) => {
  const teamRows = await all('SELECT id, name FROM team') as TeamIdentity[]
  const normalizedNames = Array.from(new Set((designerNames || []).map(n => n.trim()).filter(Boolean)))
  const matchingTeam = teamRows.filter(t => normalizedNames.includes(t.name))
  const matchingIds = matchingTeam.map(t => t.id)

  for (const team of matchingTeam) {
    const assignmentId = `${projectId}_${team.id}`
    await run(
      `INSERT OR IGNORE INTO project_assignments (id, project_id, designer_id, allocation_percent, created_at)
       VALUES (?, ?, ?, 0, datetime('now'))`,
      [assignmentId, projectId, team.id]
    )
  }

  if (matchingIds.length > 0) {
    const placeholders = matchingIds.map(() => '?').join(',')
    await run(
      `DELETE FROM project_assignments WHERE project_id = ? AND designer_id NOT IN (${placeholders})`,
      [projectId, ...matchingIds]
    )
  } else {
    await run('DELETE FROM project_assignments WHERE project_id = ?', [projectId])
  }
}

export const syncAssignmentToProjectDesigners = async (projectId: string, designerId: string, add: boolean) => {
  const projectRow = await get('SELECT designers FROM projects WHERE id = ?', [projectId]) as { designers?: string } | undefined
  const teamRow = await get('SELECT name FROM team WHERE id = ?', [designerId]) as { name?: string } | undefined
  const designerName = teamRow?.name
  if (!designerName) return

  const currentDesigners = projectRow?.designers ? JSON.parse(projectRow.designers) as string[] : []
  const set = new Set(currentDesigners)

  if (add) { set.add(designerName) } else { set.delete(designerName) }

  await run(
    `UPDATE projects SET designers = ?, updatedAt = datetime('now') WHERE id = ?`,
    [JSON.stringify(Array.from(set)), projectId]
  )
}

export const reconcileProjectDesignerAssignments = async () => {
  const projects = await all('SELECT id, designers FROM projects') as Array<{ id: string; designers?: string }>
  for (const project of projects) {
    const designers = project.designers ? JSON.parse(project.designers) as string[] : []
    await syncProjectDesignersToAssignments(project.id, designers)
  }
}

export default router;

import express from 'express';
import fs from 'fs';
import path from 'path';
import { run, get, all, IMAGES_DIR } from '../db.js';
import { getUserEmail, sessions, getSessionIdFromRequest, setSessionCookie } from '../auth.js';
import { broadcast } from '../sse.js';
import { logActivity, updateDbVersion } from '../version.js';
import { recipientsForProject, pinRecipients } from '../activity.js';

// Resolve a user_id from a (possibly null) email. Returns null if no matching user.
async function userIdForEmail(email: string | null | undefined): Promise<number | null> {
  if (!email) return null
  const row = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
  return row?.id ?? null
}

// Resolve the recipient user_ids for a project: every designer assigned to it
// (projects.designers is a JSON array of display names), joined through team.email
// then users.id. Silent no-op for unmatched names.
async function recipientIdsForProject(projectId: string, excludeUserId: number | null): Promise<number[]> {
  const p = await get('SELECT designers FROM projects WHERE id = ?', [projectId]) as any
  if (!p?.designers) return []
  let names: string[] = []
  try { names = JSON.parse(p.designers) || [] } catch { names = [] }
  if (names.length === 0) return []
  const ids = new Set<number>()
  for (const n of names) {
    const t = await get('SELECT email FROM team WHERE name = ?', [n]) as any
    const email = t?.email
    if (!email) continue
    const u = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
    if (u?.id && u.id !== excludeUserId) ids.add(u.id)
  }
  return Array.from(ids)
}

const router = express.Router();

// ============ REVIEW API ENDPOINTS ============

router.get('/api/reviews', async (_req, res) => {
  try {
    const reviews = await all('SELECT * FROM reviews ORDER BY created_at DESC')
    // Attach item count
    const result = await Promise.all((reviews as any[]).map(async (r: any) => {
      const count = await get('SELECT COUNT(*) as count FROM review_items WHERE review_id = ?', [r.id])
      return { ...r, itemCount: count?.count || 0 }
    }))
    res.json(result)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Flat list of (project_id, review_id, week, created_at) for rendering gantt diamond markers
router.get('/api/review-markers', async (_req, res) => {
  try {
    const rows = await all(
      `SELECT ri.project_id, r.id as review_id, r.title, r.week, r.created_at
       FROM review_items ri JOIN reviews r ON ri.review_id = r.id`
    )
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/api/reviews/:id', async (req, res) => {
  try {
    const review = await get('SELECT * FROM reviews WHERE id = ?', [req.params.id])
    if (!review) return res.status(404).json({ error: 'Review not found' })
    const items = await all(
      `SELECT ri.*, p.name as project_name, p.status, p.designers, p.businessLine,
              p.startDate, p.endDate, p.timeline, p.estimatedHours,
              p.deckName, p.deckLink, p.prdName, p.prdLink, p.briefName, p.briefLink,
              p.figmaLink, p.customLinks, p.url
       FROM review_items ri
       LEFT JOIN projects p ON ri.project_id = p.id
       WHERE ri.review_id = ?
       ORDER BY ri.rank ASC`, [req.params.id]
    )
    const parsed = (items as any[]).map((item: any) => ({
      ...item,
      timeline: item.timeline ? JSON.parse(item.timeline) : [],
      customLinks: item.customLinks ? JSON.parse(item.customLinks) : [],
      designers: item.designers ? JSON.parse(item.designers) : [],
      businessLines: item.businessLine ? (() => { try { return JSON.parse(item.businessLine); } catch { return [item.businessLine]; } })() : [],
    }))
    res.json({ ...review, items: parsed })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/api/reviews', async (req, res) => {
  try {
    const { title, week, project_ids, description, review_date } = req.body
    const id = Math.random().toString(36).substring(2) + Date.now().toString(36)
    const email = getUserEmail(req)
    const reviewDate = typeof review_date === 'string' && review_date.match(/^\d{4}-\d{2}-\d{2}$/)
      ? review_date
      : new Date().toISOString().slice(0, 10)
    await run(
      'INSERT INTO reviews (id, title, week, created_by, description, review_date) VALUES (?, ?, ?, ?, ?, ?)',
      [id, title || 'Design Review', week || null, email, description || '', reviewDate]
    )
    if (project_ids && Array.isArray(project_ids)) {
      for (let i = 0; i < project_ids.length; i++) {
        const itemId = Math.random().toString(36).substring(2) + Date.now().toString(36) + i
        await run(
          'INSERT INTO review_items (id, review_id, project_id, rank) VALUES (?, ?, ?, ?)',
          [itemId, id, project_ids[i], i]
        )
      }
    }
    const review = await get('SELECT * FROM reviews WHERE id = ?', [id])
    res.json(review)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/api/reviews/:id', async (req, res) => {
  try {
    const { title, week, description, item_order, total_minutes, review_date } = req.body
    if (title !== undefined) {
      await run('UPDATE reviews SET title = ?, updated_at = datetime(\'now\') WHERE id = ?', [title, req.params.id])
    }
    if (week !== undefined) {
      await run('UPDATE reviews SET week = ?, updated_at = datetime(\'now\') WHERE id = ?', [week, req.params.id])
    }
    if (description !== undefined) {
      await run('UPDATE reviews SET description = ?, updated_at = datetime(\'now\') WHERE id = ?', [description, req.params.id])
    }
    if (total_minutes !== undefined) {
      const n = Math.max(0, Math.min(600, parseInt(total_minutes, 10) || 0))
      await run('UPDATE reviews SET total_minutes = ?, updated_at = datetime(\'now\') WHERE id = ?', [n, req.params.id])
    }
    if (review_date !== undefined) {
      const v = typeof review_date === 'string' && review_date.match(/^\d{4}-\d{2}-\d{2}$/) ? review_date : null
      await run('UPDATE reviews SET review_date = ?, updated_at = datetime(\'now\') WHERE id = ?', [v, req.params.id])
    }
    if (req.body.gemini_notes !== undefined) {
      await run('UPDATE reviews SET gemini_notes = ?, updated_at = datetime(\'now\') WHERE id = ?', [req.body.gemini_notes || '', req.params.id])
    }
    if (item_order && Array.isArray(item_order)) {
      for (let i = 0; i < item_order.length; i++) {
        await run('UPDATE review_items SET rank = ? WHERE id = ?', [i, item_order[i]])
      }
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/api/reviews/:id', async (req, res) => {
  try {
    const imgs = await all(
      `SELECT rii.filename FROM review_item_images rii
       JOIN review_items ri ON ri.id = rii.review_item_id
       WHERE ri.review_id = ?`,
      [req.params.id]
    ) as any[]
    for (const img of imgs) {
      try {
        const fp = path.join(IMAGES_DIR, img.filename)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      } catch (e: any) { console.error('review image file delete error:', e.message) }
    }
    await run(
      `DELETE FROM review_item_images WHERE review_item_id IN (SELECT id FROM review_items WHERE review_id = ?)`,
      [req.params.id]
    )
    await run('DELETE FROM review_items WHERE review_id = ?', [req.params.id])
    await run('DELETE FROM reviews WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/api/reviews/:id/items', async (req, res) => {
  try {
    const { project_id } = req.body
    const maxRank = await get('SELECT MAX(rank) as max FROM review_items WHERE review_id = ?', [req.params.id])
    const rank = (maxRank?.max ?? -1) + 1
    const id = Math.random().toString(36).substring(2) + Date.now().toString(36)
    await run(
      'INSERT INTO review_items (id, review_id, project_id, rank) VALUES (?, ?, ?, ?)',
      [id, req.params.id, project_id, rank]
    )
    res.json({ id, review_id: req.params.id, project_id, rank })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/api/review-items/:id', async (req, res) => {
  try {
    // Cascade: remove image rows + files owned by this review item
    const images = await all('SELECT filename FROM review_item_images WHERE review_item_id = ?', [req.params.id]) as any[]
    for (const img of images) {
      try {
        const fp = path.join(IMAGES_DIR, img.filename)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      } catch (e: any) { console.error('review item image file delete error:', e.message) }
    }
    await run('DELETE FROM review_item_images WHERE review_item_id = ?', [req.params.id])
    await run('DELETE FROM review_items WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/api/review-items/:id/review-date', async (req, res) => {
  try {
    const { review_date } = req.body
    const v = review_date === null || review_date === ''
      ? null
      : (typeof review_date === 'string' && review_date.match(/^\d{4}-\d{2}-\d{2}$/) ? review_date : null)
    await run('UPDATE review_items SET review_date = ? WHERE id = ?', [v, req.params.id])
    res.json({ ok: true, review_date: v })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Duplicate a review item into a target review. Deep-copies image files on disk so
// the two galleries have fully independent bytes — safe against deletes.
router.post('/api/review-items/:id/duplicate', async (req, res) => {
  try {
    const { target_review_id } = req.body as { target_review_id?: string }
    if (!target_review_id) return res.status(400).json({ error: 'target_review_id required' })

    const source = await get('SELECT * FROM review_items WHERE id = ?', [req.params.id]) as any
    if (!source) return res.status(404).json({ error: 'Source review item not found' })

    const target = await get('SELECT id FROM reviews WHERE id = ?', [target_review_id])
    if (!target) return res.status(404).json({ error: 'Target review not found' })

    const maxRank = await get('SELECT MAX(rank) as max FROM review_items WHERE review_id = ?', [target_review_id]) as any
    const rank = (maxRank?.max ?? -1) + 1
    const newItemId = Math.random().toString(36).substring(2) + Date.now().toString(36)

    await run(
      `INSERT INTO review_items
       (id, review_id, project_id, rank, notes, notes_updated_by, notes_updated_at,
        description, duration_minutes, excluded_from_time, review_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newItemId, target_review_id, source.project_id, rank,
       source.notes || '', source.notes_updated_by || '', source.notes_updated_at || '',
       source.description || '', source.duration_minutes,
       source.excluded_from_time ? 1 : 0, null]
    )

    // Deep-copy each image: new file on disk + new row pointing at the new filename.
    const srcImages = await all(
      'SELECT * FROM review_item_images WHERE review_item_id = ? ORDER BY sort_order ASC, created_at ASC',
      [req.params.id]
    ) as any[]
    for (const img of srcImages) {
      try {
        const ext = (img.filename.split('.').pop() || 'png')
        const newImgId = `rimg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const newFilename = `${newImgId}.${ext}`
        const srcPath = path.join(IMAGES_DIR, img.filename)
        const dstPath = path.join(IMAGES_DIR, newFilename)
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, dstPath)
        } else {
          console.error('Source image file missing, skipping copy:', srcPath)
          continue
        }
        await run(
          `INSERT INTO review_item_images
           (id, review_item_id, filename, original_name, mime_type, size_bytes, caption, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [newImgId, newItemId, newFilename, img.original_name || '', img.mime_type || 'image/png',
           img.size_bytes || 0, img.caption || '', img.sort_order || 0]
        )
      } catch (e: any) {
        console.error('Image deep-copy error for', img.id, e.message)
      }
    }

    res.json({ id: newItemId, review_id: target_review_id, project_id: source.project_id, rank })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/api/review-items/:id/description', async (req, res) => {
  try {
    const { description } = req.body
    await run('UPDATE review_items SET description = ? WHERE id = ?', [description || '', req.params.id])
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Update per-item time: duration_minutes (null = auto-split) and excluded_from_time (0/1)
router.put('/api/review-items/:id/time', async (req, res) => {
  try {
    const { duration_minutes, excluded_from_time } = req.body
    if (duration_minutes !== undefined) {
      const v = duration_minutes === null ? null : Math.max(0, Math.min(600, parseInt(duration_minutes, 10) || 0))
      await run('UPDATE review_items SET duration_minutes = ? WHERE id = ?', [v, req.params.id])
    }
    if (excluded_from_time !== undefined) {
      await run('UPDATE review_items SET excluded_from_time = ? WHERE id = ?', [excluded_from_time ? 1 : 0, req.params.id])
    }
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/api/review-items/:id/notes', async (req, res) => {
  try {
    const { notes, expected_updated_at } = req.body
    const email = getUserEmail(req)

    // Optimistic locking: reject if someone else saved since we last loaded
    if (expected_updated_at) {
      const current = await get('SELECT notes_updated_at, notes_updated_by FROM review_items WHERE id = ?', [req.params.id]) as any
      if (current?.notes_updated_at && current.notes_updated_at > expected_updated_at && current.notes_updated_by !== email) {
        return res.status(409).json({
          error: 'conflict',
          updated_by: current.notes_updated_by,
          updated_at: current.notes_updated_at,
        })
      }
    }

    await run(
      'UPDATE review_items SET notes = ?, notes_updated_by = ?, notes_updated_at = datetime(\'now\') WHERE id = ?',
      [notes || '', email || 'anonymous', req.params.id]
    )
    const updated = await get('SELECT notes_updated_at FROM review_items WHERE id = ?', [req.params.id]) as any
    res.json({ ok: true, notes_updated_at: updated?.notes_updated_at || null })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ REVIEW ITEM COMMENTS (chat) ============

// Resolve a display name for an authenticated user: team.name when the email
// matches a team member, otherwise the email local-part.
async function resolveDisplayName(email: string): Promise<string> {
  if (!email) return ''
  const t = await get('SELECT name FROM team WHERE LOWER(email) = LOWER(?)', [email]) as any
  if (t?.name) return t.name
  return email.split('@')[0]
}

router.get('/api/review-items/:id/comments', async (req, res) => {
  try {
    const rows = await all(
      'SELECT id, review_item_id, author_email, author_name, body, created_at, updated_at FROM review_item_comments WHERE review_item_id = ? ORDER BY created_at ASC',
      [req.params.id]
    )
    // Mark-read: viewing the thread counts as "seen" for any prior comment activity
    // on this review item (activity rows where details json encodes review_item_id).
    const email = getUserEmail(req)
    if (email) {
      const userId = await userIdForEmail(email)
      if (userId) {
        await run(
          `INSERT OR IGNORE INTO activity_reads (user_id, activity_id)
           SELECT ?, al.id
           FROM activity_log al
           WHERE al.category = 'review' AND al.action = 'comment'
             AND al.details LIKE ?`,
          [userId, `%"review_item_id":"${req.params.id}"%`]
        )
      }
    }
    res.json(rows)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/api/review-items/:id/comments', async (req, res) => {
  try {
    const email = getUserEmail(req)
    if (!email) return res.status(401).json({ error: 'Authentication required to comment' })
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty' })
    if (body.length > 5000) return res.status(400).json({ error: 'Comment too long (5000 char max)' })

    const item = await get(
      `SELECT ri.id, ri.review_id, ri.project_id, p.name AS project_name, r.title AS review_title, r.review_date
       FROM review_items ri
       LEFT JOIN projects p ON p.id = ri.project_id
       LEFT JOIN reviews r ON r.id = ri.review_id
       WHERE ri.id = ?`,
      [req.params.id]
    ) as any
    if (!item) return res.status(404).json({ error: 'Review item not found' })

    const authorName = await resolveDisplayName(email)
    const id = `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    await run(
      `INSERT INTO review_item_comments (id, review_item_id, author_email, author_name, body)
       VALUES (?, ?, ?, ?, ?)`,
      [id, req.params.id, email, authorName, body]
    )
    const saved = await get('SELECT * FROM review_item_comments WHERE id = ?', [id]) as any
    broadcast('review-comment', { type: 'created', review_id: item.review_id, comment: saved })

    // Log activity + fan out to every assigned designer except the commenter.
    // Details holds a JSON blob we re-use on the client to build the modal row.
    const commenterUserId = await userIdForEmail(email)
    const detailsJson = JSON.stringify({
      review_id: item.review_id,
      review_item_id: item.id,
      review_title: item.review_title || 'Review',
      review_date: item.review_date || null,
      project_id: item.project_id,
      project_name: item.project_name || 'Unknown project',
      author_name: authorName,
      comment_id: id,
    })
    const activityId = await logActivity('review', 'comment', item.project_name || 'Unknown project', email, detailsJson)
    if (activityId) {
      const recipients = item.project_id
        ? await recipientIdsForProject(item.project_id, commenterUserId)
        : []
      for (const uid of recipients) {
        await run('INSERT OR IGNORE INTO activity_recipients (activity_id, user_id) VALUES (?, ?)', [activityId, uid])
      }
      // The commenter has already engaged with the item — auto-mark all prior
      // comment activities on it as read for them.
      if (commenterUserId) {
        await run(
          `INSERT OR IGNORE INTO activity_reads (user_id, activity_id)
           SELECT ?, al.id FROM activity_log al
           WHERE al.category = 'review' AND al.action = 'comment'
             AND al.details LIKE ?`,
          [commenterUserId, `%"review_item_id":"${item.id}"%`]
        )
      }
      // Live push: let every open client know an activity arrived so they can
      // refresh their bell/risk counts without waiting for the 60s poll.
      broadcast('activity', {
        id: activityId,
        category: 'review',
        action: 'comment',
        target_name: item.project_name || 'Unknown project',
        user_email: email,
        details: detailsJson,
        recipients,
      })
    }

    res.json(saved)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/api/review-item-comments/:id', async (req, res) => {
  try {
    const email = getUserEmail(req)
    if (!email) return res.status(401).json({ error: 'Authentication required' })
    const session = (() => {
      const sid = getSessionIdFromRequest(req)
      return sid ? sessions.get(sid) : null
    })()
    const isAdmin = session?.role === 'admin'

    const existing = await get(
      `SELECT c.*, ri.review_id FROM review_item_comments c
       JOIN review_items ri ON ri.id = c.review_item_id
       WHERE c.id = ?`,
      [req.params.id]
    ) as any
    if (!existing) return res.status(404).json({ error: 'Comment not found' })
    if (!isAdmin && existing.author_email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: 'You can only edit your own comments' })
    }

    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty' })
    if (body.length > 5000) return res.status(400).json({ error: 'Comment too long (5000 char max)' })

    await run(
      'UPDATE review_item_comments SET body = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [body, req.params.id]
    )
    const saved = await get('SELECT * FROM review_item_comments WHERE id = ?', [req.params.id]) as any
    broadcast('review-comment', { type: 'updated', review_id: existing.review_id, comment: saved })
    res.json(saved)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/api/review-item-comments/:id', async (req, res) => {
  try {
    const email = getUserEmail(req)
    if (!email) return res.status(401).json({ error: 'Authentication required' })
    const session = (() => {
      const sid = getSessionIdFromRequest(req)
      return sid ? sessions.get(sid) : null
    })()
    const isAdmin = session?.role === 'admin'

    const existing = await get(
      `SELECT c.*, ri.review_id FROM review_item_comments c
       JOIN review_items ri ON ri.id = c.review_item_id
       WHERE c.id = ?`,
      [req.params.id]
    ) as any
    if (!existing) return res.status(404).json({ error: 'Comment not found' })
    if (!isAdmin && existing.author_email.toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ error: 'You can only delete your own comments' })
    }

    await run('DELETE FROM review_item_comments WHERE id = ?', [req.params.id])
    broadcast('review-comment', { type: 'deleted', review_id: existing.review_id, comment_id: req.params.id, review_item_id: existing.review_item_id })
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ PUBLIC REVIEW PAGE ============

function escHtml(s: string) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Given review items and a total minute budget, compute per-item minutes.
// Excluded items: 0. Locked items (explicit duration_minutes): their value.
// Auto items (duration_minutes == null): split the remaining budget evenly,
// with leftover integer-minutes distributed to the first few auto items so the sum matches total.
export function computeItemMinutes(
  items: { id: string; duration_minutes: number | null | undefined; excluded_from_time: number | boolean }[],
  total: number
): Record<string, number> {
  const out: Record<string, number> = {}
  const autoIds: string[] = []
  let lockedSum = 0
  for (const it of items) {
    if (it.excluded_from_time) { out[it.id] = 0; continue }
    if (it.duration_minutes != null) {
      const v = Math.max(0, Math.floor(it.duration_minutes))
      out[it.id] = v
      lockedSum += v
    } else {
      autoIds.push(it.id)
    }
  }
  const remaining = Math.max(0, total - lockedSum)
  if (autoIds.length > 0) {
    const base = Math.floor(remaining / autoIds.length)
    const extra = remaining - base * autoIds.length
    autoIds.forEach((id, i) => { out[id] = base + (i < extra ? 1 : 0) })
  }
  return out
}

const DAY_MS = 86400000

// Convert a review's stored week string into a Monday-of-that-week timestamp.
// Accepts "Week 15", "Week 15 2026", "2026-W15", or falls back to the review's created_at.
function reviewWeekToDate(weekStr: string | null | undefined, createdAt: string | null | undefined): number | null {
  const fallback = () => {
    if (!createdAt) return null
    const t = new Date(createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z').getTime()
    return isNaN(t) ? null : t
  }
  if (!weekStr) return fallback()
  // ISO form "YYYY-Www"
  const iso = weekStr.match(/^(\d{4})-W(\d{1,2})$/i)
  let year: number | null = null
  let week: number | null = null
  if (iso) { year = parseInt(iso[1], 10); week = parseInt(iso[2], 10) }
  else {
    const m = weekStr.match(/week\s*(\d{1,2})(?:\s*[,/-]?\s*(\d{4}))?/i)
    if (m) {
      week = parseInt(m[1], 10)
      year = m[2] ? parseInt(m[2], 10) : null
    }
  }
  if (week == null) return fallback()
  if (year == null) {
    // Infer year from created_at if possible, else current year
    if (createdAt) {
      const t = new Date(createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z')
      if (!isNaN(t.getTime())) year = t.getUTCFullYear()
    }
    if (year == null) year = new Date().getUTCFullYear()
  }
  // Monday of ISO week = Jan 4th of year, walked back to its Monday, plus (week-1)*7 days
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7 // Mon=1..Sun=7
  const mondayWeek1 = new Date(jan4.getTime() - (jan4Day - 1) * DAY_MS)
  const targetMs = mondayWeek1.getTime() + (week - 1) * 7 * DAY_MS
  return targetMs
}

type ReviewMarker = { date: number; url: string; label: string }

function renderFullGantt(item: any, reviewMarkers: ReviewMarker[] = []): string {
  const dates: number[] = []
  if (item.timeline) {
    for (const t of item.timeline) {
      if (t.startDate) dates.push(new Date(t.startDate + 'T12:00:00').getTime())
      if (t.endDate) dates.push(new Date(t.endDate + 'T12:00:00').getTime())
    }
  }
  if (item.startDate) dates.push(new Date(item.startDate + 'T12:00:00').getTime())
  if (item.endDate) dates.push(new Date(item.endDate + 'T12:00:00').getTime())
  for (const m of reviewMarkers) dates.push(m.date)

  if (dates.length === 0) return '<div class="gantt-empty">No timeline data</div>'

  const minDate = Math.min(...dates)
  const maxDate = Math.max(...dates)
  const totalMs = maxDate - minDate
  if (totalMs <= 0) return '<div class="gantt-empty">Single day</div>'

  const totalDays = Math.max(1, totalMs / DAY_MS)
  const today = new Date(); today.setHours(12, 0, 0, 0)
  const todayMs = today.getTime()
  const isTodayInRange = todayMs >= minDate && todayMs <= maxDate
  const todayPos = isTodayInRange ? (todayMs - minDate) / totalMs : null

  const formatRange = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const formatMonthDay = (d: string) => {
    const dt = new Date(d + 'T12:00:00')
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  const calcHours = (s: string, e: string) => {
    const ms = new Date(e + 'T12:00:00').getTime() - new Date(s + 'T12:00:00').getTime()
    return Math.round(ms / DAY_MS * 8)
  }

  // Weekly grid ticks
  const weekCount = Math.max(1, Math.ceil(totalDays / 7))
  let ticks = ''
  for (let i = 0; i <= weekCount; i++) {
    ticks += `<span class="gantt-weekly-tick" style="left:${(i / weekCount * 100).toFixed(1)}%"></span>`
  }

  // Today marker
  const todayHtml = todayPos !== null
    ? `<div class="gantt-today-global" style="--today-pos:${todayPos.toFixed(4)}"><span class="gantt-today-label">Today</span></div>`
    : ''

  // Review diamond track (own row labeled "Design Review")
  let reviewTrackHtml = ''
  if (reviewMarkers.length > 0) {
    let diamonds = ''
    for (const m of reviewMarkers) {
      if (m.date < minDate || m.date > maxDate) continue
      const pos = (m.date - minDate) / totalMs
      const dateLabel = new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      diamonds += `<a class="gantt-review-diamond" href="${escHtml(m.url)}" target="_blank" rel="noopener" style="left:${(pos * 100).toFixed(2)}%" title="${escHtml(m.label)} · ${dateLabel}"><span class="gantt-review-diamond-shape"></span></a>`
    }
    if (diamonds) {
      reviewTrackHtml = `<div class="gantt-track gantt-review-track">
        <span class="gantt-track-label" title="Design Review">Design Review</span>
        <div class="gantt-track-bars">${diamonds}</div>
      </div>`
    }
  }

  // Build tracks
  let tracks = ''
  if (item.timeline && item.timeline.length > 0) {
    item.timeline.forEach((t: any, i: number) => {
      const s = new Date(t.startDate + 'T12:00:00').getTime()
      const e = new Date(t.endDate + 'T12:00:00').getTime()
      const startDays = (s - minDate) / DAY_MS
      const durDays = Math.max(1, (e - s) / DAY_MS + 1)
      const left = Math.max(0, Math.min(100, (startDays / totalDays) * 100))
      const width = Math.max(0, Math.min(100 - left, (durDays / totalDays) * 100))
      const barClass = `bar-${(i % 5) + 1}`
      const name = escHtml(t.name || `Phase ${i + 1}`)
      const hours = calcHours(t.startDate, t.endDate)
      tracks += `<div class="gantt-track">
        <span class="gantt-track-label" title="${name}">${name}</span>
        <div class="gantt-track-bars">
          <div class="gantt-bar ${barClass}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%" title="${name}: ${formatMonthDay(t.startDate)} → ${formatMonthDay(t.endDate)} · ${hours} hrs">
            <span class="gantt-label">${formatMonthDay(t.startDate)} <span class="gantt-arrow">→</span> ${formatMonthDay(t.endDate)} · ${hours}h</span>
          </div>
        </div>
      </div>`
    })
  } else if (item.startDate && item.endDate) {
    const s = new Date(item.startDate + 'T12:00:00').getTime()
    const e = new Date(item.endDate + 'T12:00:00').getTime()
    const startDays = (s - minDate) / DAY_MS
    const durDays = Math.max(1, (e - s) / DAY_MS + 1)
    const left = Math.max(0, Math.min(100, (startDays / totalDays) * 100))
    const width = Math.max(0, Math.min(100 - left, (durDays / totalDays) * 100))
    tracks = `<div class="gantt-track">
      <span class="gantt-track-label" title="Duration">Duration</span>
      <div class="gantt-track-bars">
        <div class="gantt-bar bar-duration" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%" title="Duration: ${formatMonthDay(item.startDate)} → ${formatMonthDay(item.endDate)}">
          <span class="gantt-label">${formatMonthDay(item.startDate)} <span class="gantt-arrow">→</span> ${formatMonthDay(item.endDate)}</span>
        </div>
      </div>
    </div>`
  }

  return `<div class="project-gantt">
    <div class="gantt-header">
      <span class="gantt-header-spacer"></span>
      <div class="gantt-header-track">
        <span class="gantt-start"><span class="gantt-edge-line gantt-edge-line-start"></span>${formatRange(minDate)}</span>
        <span class="gantt-end">${formatRange(maxDate)}<span class="gantt-edge-line gantt-edge-line-end"></span></span>
      </div>
    </div>
    <div class="gantt-container">
      <div class="gantt-bars"${todayPos !== null ? ` style="--today-pos:${todayPos.toFixed(4)}"` : ''}>
        <div class="gantt-weekly-grid">${ticks}</div>
        ${todayHtml}
        ${tracks}
        ${reviewTrackHtml}
      </div>
    </div>
  </div>`
}

// SVG icons matching Lucide icons used in project cards
const svgPresentation = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/></svg>`
const svgFileText = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`
const svgFileEdit = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2h-5.5"/><polyline points="14 2 14 8 20 8"/><path d="M10.42 12.61a2.1 2.1 0 1 1 2.97 2.97L7.95 21 4 22l.99-3.95 5.43-5.44Z"/></svg>`
const svgFigma = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z"/><path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z"/><path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z"/><path d="M5 19.5A3.5 3.5 0 0 1 8.5 16H12v3.5a3.5 3.5 0 1 1-7 0z"/><path d="M5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z"/></svg>`
const svgLink = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
const svgTicket = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>`

function renderLinks(item: any): string {
  const links: string[] = []
  if (item.deckLink) links.push(`<a href="${escHtml(item.deckLink)}" target="_blank" rel="noopener">${svgPresentation}<span>Design deck: ${escHtml(item.deckName || 'Deck')}</span></a>`)
  if (item.prdLink) links.push(`<a href="${escHtml(item.prdLink)}" target="_blank" rel="noopener">${svgFileText}<span>PRD: ${escHtml(item.prdName || 'PRD')}</span></a>`)
  if (item.briefLink) links.push(`<a href="${escHtml(item.briefLink)}" target="_blank" rel="noopener">${svgFileEdit}<span>${escHtml(item.briefName || 'Brief')}</span></a>`)
  if (item.figmaLink) links.push(`<a href="${escHtml(item.figmaLink)}" target="_blank" rel="noopener">${svgFigma}<span>Figma</span></a>`)
  if (item.url) {
    const jiraMatch = String(item.url).match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i)
    const jiraLabel = jiraMatch ? jiraMatch[1].toUpperCase() : 'ticket'
    links.push(`<a href="${escHtml(item.url)}" target="_blank" rel="noopener">${svgTicket}<span>Jira: ${escHtml(jiraLabel)}</span></a>`)
  }
  if (item.customLinks) {
    for (const cl of item.customLinks) {
      if (cl.url) links.push(`<a href="${escHtml(cl.url)}" target="_blank" rel="noopener">${svgLink}<span>${escHtml(cl.name || 'Link')}</span></a>`)
    }
  }
  return links.join('<span class="card-link-sep">·</span>')
}

function markdownToHtml(text: string): string {
  if (!text) return ''
  return text.split('\n').map(line => {
    let html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Convert [name](url) markdown links to <a> tags
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="notes-inline-link">$1</a>'
    )
    return `<div>${html || '<br>'}</div>`
  }).join('')
}

// Render Gemini-generated meeting notes pasted from a Google Doc.
// Input is expected to be markdown-ish: headings (# ## ###), bullets (- * •),
// bold (**text**), and [name](url) links.
function renderGeminiNotesHtml(notes: string): string {
  if (!notes || !notes.trim()) return ''
  const lines = notes.split('\n')
  let html = ''
  let inList = false
  const closeList = () => { if (inList) { html += '</ul>'; inList = false } }
  const inlineReplace = (raw: string) => {
    let s = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    return s
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { closeList(); continue }
    const h = line.match(/^(#{1,3})\s+(.+)$/)
    if (h) {
      closeList()
      const level = h[1].length
      html += `<h${level}>${inlineReplace(h[2])}</h${level}>`
      continue
    }
    const bullet = line.match(/^\s*(?:[-*•])\s+(.+)$/)
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${inlineReplace(bullet[1])}</li>`
      continue
    }
    closeList()
    html += `<p>${inlineReplace(line)}</p>`
  }
  closeList()
  return html
}

function renderNotesHtml(notes: string): string {
  if (!notes || !notes.trim()) return ''
  let html = escHtml(notes)
  // Convert [name](url) markdown links
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="notes-inline-link">$1</a>'
  )
  // Convert bare URLs (not already inside an href)
  html = html.replace(/(?<!")(https?:\/\/[^\s<&]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
  // Process lines for bullets
  const lines = html.split('\n')
  let inList = false
  let result = ''
  for (const line of lines) {
    const bulletMatch = line.match(/^(?:[\u2022\-\*])\s?(.*)/)
    if (bulletMatch) {
      if (!inList) { result += '<ul>'; inList = true }
      result += `<li>${bulletMatch[1]}</li>`
    } else {
      if (inList) { result += '</ul>'; inList = false }
      if (line.trim() === '') {
        result += '<br>'
      } else {
        result += `<p>${line}</p>`
      }
    }
  }
  if (inList) result += '</ul>'
  return result
}

router.get('/review', async (req, res) => {
  try {
    const latest = await get('SELECT id FROM reviews ORDER BY created_at DESC LIMIT 1') as any
    if (!latest) {
      return res.status(404).send(renderPage('No Reviews', '<div class="empty-state">No reviews have been published yet.</div>', []))
    }
    // Legacy ?sid=… support: promote the query param into the HttpOnly cookie and scrub the URL
    if (req.query.sid && typeof req.query.sid === 'string' && sessions.has(req.query.sid)) {
      setSessionCookie(res, req.query.sid)
    }
    res.redirect(`/review/${latest.id}`)
  } catch (e: any) {
    res.status(500).send(renderPage('Error', `<div class="empty-state">Something went wrong: ${escHtml(e.message)}</div>`, []))
  }
})

router.get('/review/:id', async (req, res) => {
  try {
    // Legacy ?sid=… support: promote into HttpOnly cookie and redirect to the clean URL
    // so the address bar no longer exposes session material.
    if (req.query.sid && typeof req.query.sid === 'string') {
      if (sessions.has(req.query.sid)) setSessionCookie(res, req.query.sid)
      return res.redirect(`/review/${req.params.id}`)
    }
    const review = await get('SELECT * FROM reviews WHERE id = ?', [req.params.id]) as any
    if (!review) {
      return res.status(404).send(renderPage('Review Not Found', '<div class="empty-state">This review does not exist or has been deleted.</div>', []))
    }
    const items = await all(
      `SELECT ri.*, p.name as project_name, p.status, p.designers, p.businessLine,
              p.startDate, p.endDate, p.timeline, p.estimatedHours,
              p.deckName, p.deckLink, p.prdName, p.prdLink, p.briefName, p.briefLink,
              p.figmaLink, p.customLinks, p.url
       FROM review_items ri
       LEFT JOIN projects p ON ri.project_id = p.id
       WHERE ri.review_id = ?
       ORDER BY ri.rank ASC`, [req.params.id]
    ) as any[]

    const parsed = items.map((item: any) => ({
      ...item,
      timeline: item.timeline ? JSON.parse(item.timeline) : [],
      customLinks: item.customLinks ? JSON.parse(item.customLinks) : [],
      designers: item.designers ? JSON.parse(item.designers) : [],
    }))

    // Load review-item-scoped images. Each review_item has its own gallery —
    // project-level images are NOT included, so the same project in multiple
    // reviews can have independent sets of supporting images.
    for (const item of parsed) {
      item.images = await all(
        `SELECT * FROM review_item_images
         WHERE review_item_id = ?
         ORDER BY sort_order ASC, created_at ASC`,
        [item.id]
      ) as any[]
    }

    // Load comment thread for each item
    for (const item of parsed) {
      item.comments = await all(
        `SELECT id, review_item_id, author_email, author_name, body, created_at, updated_at
         FROM review_item_comments
         WHERE review_item_id = ?
         ORDER BY created_at ASC`,
        [item.id]
      ) as any[]
    }

    // Load review diamond markers for each item: all reviews that include this project
    for (const item of parsed) {
      const rows = await all(
        `SELECT r.id, r.title, r.week, r.created_at
         FROM reviews r JOIN review_items ri ON ri.review_id = r.id
         WHERE ri.project_id = ?`,
        [item.project_id]
      ) as any[]
      const markers: ReviewMarker[] = []
      for (const r of rows) {
        const t = reviewWeekToDate(r.week, r.created_at)
        if (t == null) continue
        markers.push({ date: t, url: `/review/${r.id}`, label: 'Design Review' })
      }
      item.reviewMarkers = markers
    }

    const allReviews = await all('SELECT id, title, week, created_at FROM reviews ORDER BY created_at DESC') as any[]
    const teamMembers = await all('SELECT name, slack FROM team') as { name: string; slack: string }[]
    const slackByName = new Map(teamMembers.map(t => [t.name, t.slack]))
    const sessionId = getSessionIdFromRequest(req) || ''
    const session = sessionId ? sessions.get(sessionId) : null
    const isAuthed = !!session

    const totalMinutes = typeof review.total_minutes === 'number' ? review.total_minutes : 45
    const itemMinutes = computeItemMinutes(parsed, totalMinutes)

    let cards = ''
    let awarenessCards = ''
    for (const item of parsed) {
      const designerNames: string[] = item.designers || []
      const slackSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
      const designers = designerNames.map((d: string) => {
        const firstName = d.split(' ')[0]
        const slack = slackByName.get(d)
        if (slack) return `<a href="${escHtml(slack)}" target="_blank" rel="noopener" class="status-badge designer-badge">${slackSvg} ${escHtml(firstName)}</a>`
        return `<span class="status-badge designer-badge">${escHtml(firstName)}</span>`
      }).join('')
      const statusColors: Record<string, string> = { active: '#3b82f6', review: '#f59e0b', done: '#22c55e', blocked: '#ef4444', pending: '#94a3b8', archived: '#78716c' }
      const statusLabels: Record<string, string> = { active: 'Active', review: 'In Review', done: 'Done', blocked: 'Blocked', pending: 'Pending', archived: 'Archived' }
      const statusColor = statusColors[item.status] || '#6b7280'
      const statusLabel = statusLabels[item.status] || item.status

      const gantt = renderFullGantt(item, item.reviewMarkers || [])
      const links = renderLinks(item)
      const linksSection = links ? `<div class="card-links">${links}</div>` : ''
      const hasNotes = !!(item.notes && item.notes.trim())

      const hasImages = item.images && item.images.length > 0

      // Editable image grid for inside the accordion (auth only)
      const editableImageGridHtml = (images: any[]) => {
        const thumbs = images.map((img: any, idx: number) => `
          <div class="review-image-item" draggable="true" data-image-id="${escHtml(img.id)}">
            <div class="review-image-thumb">
              <span class="review-image-drag" title="Drag to reorder"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>
              <img src="/api/review-item-images/${escHtml(img.id)}" alt="${escHtml(img.caption || img.original_name || '')}" loading="lazy"
                data-lightbox-trigger data-item-id="${escHtml(item.id)}" data-image-index="${idx}" />
              <button class="review-image-delete" data-image-id="${escHtml(img.id)}" title="Delete image"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg></button>
            </div>
            <input class="review-image-caption" placeholder="Add caption..." value="${escHtml(img.caption || '')}" data-image-id="${escHtml(img.id)}" data-original-caption="${escHtml(img.caption || '')}" />
          </div>`).join('')
        return images.length > 0 ? `<div class="review-image-grid">${thumbs}</div>` : ''
      }

      // Always-visible inline thumbnail strip (like project cards)
      const inlineImagesHtml = hasImages ? (() => {
        const imgs = item.images as any[]
        const shown = imgs.slice(0, 4)
        const thumbs = shown.map((img: any, idx: number) => `
          <div class="review-inline-thumb">
            <img src="/api/review-item-images/${escHtml(img.id)}" alt="${escHtml(img.caption || img.original_name || '')}" loading="lazy"
              data-lightbox-trigger data-item-id="${escHtml(item.id)}" data-image-index="${idx}" />
          </div>`).join('')
        const more = imgs.length > 4 ? `<span class="review-inline-more">+${imgs.length - 4} more</span>` : ''
        return `<div class="review-inline-images">
          <span class="review-inline-images-label">Attached images</span>
          <div class="review-inline-images-row">${thumbs}${more}</div>
        </div>`
      })() : ''

      const imagesDataTag = `<script type="application/json" class="review-images-data" data-item-id="${escHtml(item.id)}">${JSON.stringify(item.images || [])}</script>`

      const currentUserEmail = (session?.email || '').toLowerCase()
      const userIsAdmin = session?.role === 'admin'
      const renderCommentHtml = (c: any) => {
        const isAuthor = c.author_email && c.author_email.toLowerCase() === currentUserEmail
        const canEdit = isAuthed && (isAuthor || userIsAdmin)
        // SQLite datetime('now') returns UTC in 'YYYY-MM-DD HH:MM:SS' form (no 'T', no 'Z').
        // Emit the raw value in data-ts — JS in the browser formats it in the viewer's
        // local timezone on load, so Node's server-side locale doesn't leak through.
        const rawTs = c.created_at || ''
        const edited = c.updated_at && c.created_at && c.updated_at !== c.created_at
        const actions = canEdit
          ? `<div class="comment-actions">
               <button class="comment-edit-btn" data-comment-id="${escHtml(c.id)}" title="Edit">Edit</button>
               <button class="comment-delete-btn" data-comment-id="${escHtml(c.id)}" title="Delete">Delete</button>
             </div>`
          : ''
        return `<div class="comment" data-comment-id="${escHtml(c.id)}" data-author-email="${escHtml(c.author_email || '')}"${edited ? ' data-edited="1"' : ''}>
          <div class="comment-head">
            <span class="comment-author">${escHtml(c.author_name || (c.author_email || '').split('@')[0])}</span>
            <span class="comment-time" data-ts="${escHtml(rawTs)}"></span>
            ${actions}
          </div>
          <div class="comment-body">${renderNotesHtml(c.body)}</div>
        </div>`
      }
      const commentsHtml = (item.comments || []).map(renderCommentHtml).join('')
      const commentsDataTag = `<script type="application/json" class="review-comments-data" data-item-id="${escHtml(item.id)}">${JSON.stringify(item.comments || [])}</script>`
      const composerHtml = isAuthed
        ? `<div class="comment-composer" data-item-id="${escHtml(item.id)}">
             <input class="comment-input" type="text" placeholder="Add a comment..." />
             <button class="comment-send-btn" type="button">Post</button>
           </div>`
        : ''
      const commentsSection = `<div class="review-comments" data-item-id="${escHtml(item.id)}">
        <div class="review-comments-label">Feedback</div>
        <div class="comments-list">
          <div class="comments-scroll">${commentsHtml}</div>
          ${composerHtml}
        </div>
        ${commentsDataTag}
      </div>`
      const hasComments = (item.comments || []).length > 0

      let notesSection = ''
      if (isAuthed) {
        const commentCount = (item.comments || []).length
        const activity = hasNotes || hasComments
        const badgeParts: string[] = []
        if (hasNotes) badgeParts.push('<span class="notes-badge">has notes</span>')
        if (commentCount > 0) badgeParts.push(`<span class="notes-badge comment-count-badge">${commentCount} comment${commentCount !== 1 ? 's' : ''}</span>`)
        const badgeHtml = badgeParts.length > 0 ? ' ' + badgeParts.join(' ') : ''

        notesSection = `<div class="card-notes">
          <button class="notes-accordion${activity ? ' has-notes' : ''}" data-item-id="${escHtml(item.id)}">
            <svg class="notes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            Open Notes &amp; Feedback${badgeHtml}
          </button>
          <div class="notes-panel" style="display:none">
            <div class="review-images" data-item-id="${escHtml(item.id)}">
              <div class="review-images-label">Images</div>
              <div class="review-image-drop" data-item-id="${escHtml(item.id)}" tabindex="0">
                ${editableImageGridHtml(item.images)}
                <div class="review-image-placeholder"${hasImages ? ' style="display:none"' : ''}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Click here, then paste — or drag an image</div>
              </div>
            </div>
            ${imagesDataTag}
            <div class="notes-feedback-row">
              <div class="notes-column">
                <div class="notes-column-label">Notes</div>
                <div class="notes-toolbar">
                  <button class="notes-toolbar-btn" data-action="bullet" title="Insert bullet">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                  </button>
                  <div class="notes-link-anchor">
                    <button class="notes-toolbar-btn" data-action="link" title="Add link">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                    </button>
                    <div class="notes-link-popover" style="display:none">
                      <input type="text" class="notes-link-input" placeholder="Link name" data-field="name" />
                      <input type="url" class="notes-link-input" placeholder="https://..." data-field="url" />
                      <button class="notes-link-add-btn">Add link</button>
                    </div>
                  </div>
                </div>
                <div class="notes-editor" contenteditable="true" data-item-id="${escHtml(item.id)}" data-updated-at="${escHtml(item.notes_updated_at || '')}" data-placeholder="Add review notes...">${markdownToHtml(item.notes || '')}</div>
              </div>
              <div class="feedback-column">
                ${commentsSection}
              </div>
            </div>
            <div class="notes-feedback-resizer" title="Drag to resize notes and feedback"></div>
          </div>
        </div>`
      } else if (hasNotes || hasComments) {
        const commentCountLabel = hasComments ? `<span class="notes-badge comment-count-badge">${item.comments.length} comment${item.comments.length !== 1 ? 's' : ''}</span>` : ''
        notesSection = `<div class="card-notes">
          <button class="notes-accordion has-notes" data-item-id="${escHtml(item.id)}">
            <svg class="notes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            Open Notes &amp; Feedback ${hasNotes ? '<span class="notes-badge">has notes</span>' : ''} ${commentCountLabel}
          </button>
          <div class="notes-panel" style="display:none">
            ${imagesDataTag}
            <div class="notes-feedback-row">
              ${hasNotes ? `<div class="notes-column"><div class="notes-column-label">Notes</div><div class="notes-rendered">${renderNotesHtml(item.notes)}</div></div>` : ''}
              <div class="feedback-column">${commentsSection}</div>
            </div>
            <div class="notes-feedback-resizer" title="Drag to resize notes and feedback"></div>
          </div>
        </div>`
      }

      const mins = itemMinutes[item.id] ?? 0
      const timeChip = item.excluded_from_time
        ? ''
        : `<span class="status-badge time-chip" title="Approximate review time">~${mins} min</span>`

      const cardHtml = `<div class="project-card">
        <div class="card-header">
          <span class="card-number">${item.excluded_from_time ? '&bull;' : item.rank + 1}</span>
          <div class="card-title-area">
            <h2 class="card-title">${escHtml(item.project_name || 'Unknown Project')}</h2>
            <div class="card-meta">
              ${timeChip}
              <span class="status-badge" style="background:${statusColor}">${statusLabel}</span>
              ${designers ? `<div class="card-designers">${designers}</div>` : ''}
            </div>
          </div>
        </div>
        ${item.description ? `<div class="card-description">${markdownToHtml(item.description)}</div>` : ''}
        ${linksSection}
        ${gantt ? `<details class="card-gantt-accordion"><summary class="notes-accordion has-notes"><svg class="notes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>Open Project Schedule</summary>${gantt}</details>` : ''}
        ${notesSection}
        ${inlineImagesHtml}
        ${!hasImages && !isAuthed ? '' : imagesDataTag}
      </div>`
      if (item.excluded_from_time) {
        awarenessCards += cardHtml
      } else {
        cards += cardHtml
      }
    }

    const awarenessSection = awarenessCards
      ? `<div class="awareness-section"><h2 class="awareness-heading">For awareness&hellip;</h2>${awarenessCards}</div>`
      : ''

    const geminiNotesSection = review.gemini_notes && review.gemini_notes.trim()
      ? `<details class="gemini-notes-accordion">
          <summary class="gemini-notes-summary">
            <svg class="notes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            Gemini notes
          </summary>
          <div class="gemini-notes-body">${renderGeminiNotesHtml(review.gemini_notes)}</div>
        </details>`
      : ''

    const content = parsed.length > 0
      ? `<div class="cards-stack">${cards}${awarenessSection}</div>`
      : '<div class="empty-state">No projects in this review yet.</div>'

    const title = escHtml(review.title || 'Design Review')
    const week = review.week ? ` — ${escHtml(review.week)}` : ''
    const createdAt = review.created_at ? new Date(review.created_at + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''
    const descriptionHtml = review.description ? `<div class="page-description">${markdownToHtml(review.description)}</div>` : ''

    const countedItems = parsed.filter((it: any) => !it.excluded_from_time).length
    const timeSummary = parsed.length > 0
      ? ` · ${totalMinutes} min total${countedItems < parsed.length ? ` (${countedItems} of ${parsed.length} counted)` : ''}`
      : ''
    const header = `<div class="page-header">
      <h1>${title}${week}</h1>
      <div class="page-meta">${createdAt} · ${parsed.length} project${parsed.length !== 1 ? 's' : ''}${timeSummary}</div>
      ${descriptionHtml}
      ${geminiNotesSection}
    </div>`

    const notesScript = `<script>
      // Accordion toggle (notes) — scoped to <button> so <details><summary> accordions handle themselves natively
      document.querySelectorAll('button.notes-accordion').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var panel = btn.nextElementSibling;
          var isOpen = panel.style.display !== 'none';
          panel.style.display = isOpen ? 'none' : 'block';
          btn.classList.toggle('open', !isOpen);
          if (!isOpen) {
            // Opening: scroll each comment thread to the newest message
            panel.querySelectorAll('.comments-scroll').forEach(function(s) { s.scrollTop = s.scrollHeight; });
          }
        });
      });

      // ============ LIGHTBOX (all users) ============
      var rvLbOverlay = document.createElement('div');
      rvLbOverlay.className = 'rv-lightbox-overlay';
      rvLbOverlay.style.display = 'none';
      rvLbOverlay.innerHTML = '<button class="rv-lightbox-close">&times;</button>' +
        '<button class="rv-lightbox-nav rv-lightbox-prev">&lsaquo;</button>' +
        '<div class="rv-lightbox-content"><img /><div class="rv-lightbox-caption"></div><div class="rv-lightbox-counter"></div></div>' +
        '<button class="rv-lightbox-nav rv-lightbox-next">&rsaquo;</button>';
      document.body.appendChild(rvLbOverlay);

      var rvLbState = { images: [], index: 0 };

      // Parse images data from embedded JSON scripts
      var reviewItemImages = {};
      document.querySelectorAll('.review-images-data').forEach(function(el) {
        try { reviewItemImages[el.dataset.itemId] = JSON.parse(el.textContent || '[]'); } catch(e) {}
      });

      function rvLbRender() {
        var img = rvLbState.images[rvLbState.index];
        if (!img) return;
        rvLbOverlay.querySelector('.rv-lightbox-content img').src = '/api/review-item-images/' + img.id;
        rvLbOverlay.querySelector('.rv-lightbox-content img').alt = img.caption || img.original_name || '';
        var cap = rvLbOverlay.querySelector('.rv-lightbox-caption');
        cap.textContent = img.caption || '';
        cap.style.display = img.caption ? '' : 'none';
        var ctr = rvLbOverlay.querySelector('.rv-lightbox-counter');
        ctr.textContent = rvLbState.images.length > 1 ? (rvLbState.index + 1) + ' / ' + rvLbState.images.length : '';
        rvLbOverlay.querySelector('.rv-lightbox-prev').style.display = rvLbState.index > 0 ? '' : 'none';
        rvLbOverlay.querySelector('.rv-lightbox-next').style.display = rvLbState.index < rvLbState.images.length - 1 ? '' : 'none';
      }

      function rvLbOpen(itemId, index) {
        var imgs = reviewItemImages[itemId];
        if (!imgs || imgs.length === 0) return;
        rvLbState.images = imgs;
        rvLbState.index = Math.min(index || 0, imgs.length - 1);
        rvLbRender();
        rvLbOverlay.style.display = '';
        document.body.style.overflow = 'hidden';
      }

      function rvLbClose() {
        rvLbOverlay.style.display = 'none';
        document.body.style.overflow = '';
      }

      rvLbOverlay.querySelector('.rv-lightbox-close').addEventListener('click', rvLbClose);
      rvLbOverlay.addEventListener('click', function(e) {
        if (e.target === rvLbOverlay) rvLbClose();
      });
      rvLbOverlay.querySelector('.rv-lightbox-content').addEventListener('click', function(e) { e.stopPropagation(); });
      rvLbOverlay.querySelector('.rv-lightbox-prev').addEventListener('click', function(e) {
        e.stopPropagation();
        if (rvLbState.index > 0) { rvLbState.index--; rvLbRender(); }
      });
      rvLbOverlay.querySelector('.rv-lightbox-next').addEventListener('click', function(e) {
        e.stopPropagation();
        if (rvLbState.index < rvLbState.images.length - 1) { rvLbState.index++; rvLbRender(); }
      });
      document.addEventListener('keydown', function(e) {
        if (rvLbOverlay.style.display === 'none') return;
        if (e.key === 'Escape') rvLbClose();
        if (e.key === 'ArrowLeft' && rvLbState.index > 0) { rvLbState.index--; rvLbRender(); }
        if (e.key === 'ArrowRight' && rvLbState.index < rvLbState.images.length - 1) { rvLbState.index++; rvLbRender(); }
      });

      // Open lightbox on thumbnail click
      document.addEventListener('click', function(e) {
        var trigger = e.target.closest('[data-lightbox-trigger]');
        if (trigger) {
          e.preventDefault();
          rvLbOpen(trigger.dataset.itemId, parseInt(trigger.dataset.imageIndex || '0', 10));
        }
      });

      // ============ COMMENTS (read + SSE — available to all viewers) ============

      var CURRENT_USER_EMAIL = ${JSON.stringify((session?.email || '').toLowerCase())};
      var CURRENT_USER_IS_ADMIN = ${JSON.stringify(!!session && session.role === 'admin')};
      var CURRENT_REVIEW_ID = ${JSON.stringify(req.params.id)};

      function escHtmlJs(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }
      function linkifyComment(text) {
        var safe = escHtmlJs(text);
        safe = safe.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        safe = safe.replace(/(^|\\s)(https?:\\/\\/[^\\s<&]+)/g,
          '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
        return '<p>' + safe.replace(/\\n{2,}/g, '</p><p>').replace(/\\n/g, '<br>') + '</p>';
      }
      // SQLite datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS' (no 'T', no 'Z').
      // Reshape to ISO 8601 before parsing so Date sees it as UTC, then format in
      // the viewer's local timezone.
      function formatCommentTime(raw) {
        if (!raw) return '';
        try {
          var iso = raw;
          if (iso.indexOf('T') < 0) iso = iso.replace(' ', 'T');
          if (!/Z$|[+\\-]\\d{2}:?\\d{2}$/.test(iso)) iso = iso + 'Z';
          var d = new Date(iso);
          if (isNaN(d.getTime())) return raw;
          return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (e) { return raw; }
      }
      function buildCommentEl(c) {
        var isOwn = c.author_email && c.author_email.toLowerCase() === CURRENT_USER_EMAIL;
        var canEdit = CURRENT_USER_EMAIL && (isOwn || CURRENT_USER_IS_ADMIN);
        var wrapper = document.createElement('div');
        wrapper.className = 'comment' + (isOwn ? ' own' : '');
        wrapper.setAttribute('data-comment-id', c.id);
        wrapper.setAttribute('data-author-email', c.author_email || '');
        var edited = c.updated_at && c.created_at && c.updated_at !== c.created_at;
        if (edited) wrapper.setAttribute('data-edited', '1');
        var actions = canEdit
          ? '<div class="comment-actions">' +
              '<button class="comment-edit-btn" data-comment-id="' + escHtmlJs(c.id) + '">Edit</button>' +
              '<button class="comment-delete-btn" data-comment-id="' + escHtmlJs(c.id) + '">Delete</button>' +
            '</div>'
          : '';
        var timeLabel = formatCommentTime(c.created_at || '') + (edited ? ' · edited' : '');
        wrapper.innerHTML =
          '<div class="comment-head">' +
            '<span class="comment-author">' + escHtmlJs(c.author_name || (c.author_email || '').split('@')[0]) + '</span>' +
            '<span class="comment-time" data-ts="' + escHtmlJs(c.created_at || '') + '">' + escHtmlJs(timeLabel) + '</span>' +
            actions +
          '</div>' +
          '<div class="comment-body">' + linkifyComment(c.body || '') + '</div>';
        return wrapper;
      }
      // Hydrate server-rendered comments: format times in the viewer's local timezone,
      // tag own comments for styling.
      document.querySelectorAll('.comment').forEach(function(el) {
        var e = (el.getAttribute('data-author-email') || '').toLowerCase();
        if (e && e === CURRENT_USER_EMAIL) el.classList.add('own');
        var timeEl = el.querySelector('.comment-time');
        if (timeEl) {
          var raw = timeEl.getAttribute('data-ts') || '';
          var label = formatCommentTime(raw);
          if (el.getAttribute('data-edited') === '1') label += ' · edited';
          timeEl.textContent = label;
        }
      });

      // SSE: listen for new/updated/deleted comments
      (function() {
        if (typeof EventSource === 'undefined') return;
        try {
          var es = new EventSource('/api/events');
          es.addEventListener('review-comment', function(ev) {
            try {
              var payload = JSON.parse(ev.data);
              if (payload.review_id !== CURRENT_REVIEW_ID) return;
              if (payload.type === 'created') {
                var c = payload.comment;
                if (!c) return;
                // Don't double-add: skip if we already rendered it
                var existing = document.querySelector('.comment[data-comment-id="' + c.id + '"]');
                if (existing) return;
                var list = document.querySelector('.review-comments[data-item-id="' + c.review_item_id + '"] .comments-scroll');
                if (!list) return;
                list.appendChild(buildCommentEl(c));
                list.scrollTop = list.scrollHeight;
                bumpCommentBadge(c.review_item_id, 1);
              } else if (payload.type === 'updated') {
                var c2 = payload.comment;
                if (!c2) return;
                var el = document.querySelector('.comment[data-comment-id="' + c2.id + '"]');
                if (!el) return;
                var next = buildCommentEl(c2);
                el.replaceWith(next);
              } else if (payload.type === 'deleted') {
                var target = document.querySelector('.comment[data-comment-id="' + payload.comment_id + '"]');
                if (target) target.remove();
                if (payload.review_item_id) bumpCommentBadge(payload.review_item_id, -1);
              }
            } catch (e) { console.error('SSE comment parse error:', e); }
          });
        } catch (e) { console.error('SSE init error:', e); }
      })();

      function bumpCommentBadge(itemId, delta) {
        var card = document.querySelector('.review-comments[data-item-id="' + itemId + '"]');
        if (!card) return;
        var acc = card.closest('.card-notes') && card.closest('.card-notes').querySelector('.notes-accordion');
        if (!acc) return;
        var badge = acc.querySelector('.comment-count-badge');
        var list = card.querySelector('.comments-scroll');
        var newCount = list ? list.querySelectorAll('.comment').length : 0;
        if (newCount <= 0) {
          if (badge) badge.remove();
          return;
        }
        var label = newCount + ' comment' + (newCount !== 1 ? 's' : '');
        if (badge) { badge.textContent = label; return; }
        badge = document.createElement('span');
        badge.className = 'notes-badge comment-count-badge';
        badge.textContent = label;
        acc.appendChild(document.createTextNode(' '));
        acc.appendChild(badge);
        acc.classList.add('has-notes');
      }

      ${isAuthed ? `
      // ============ COMMENTS (write — authed only) ============
      document.querySelectorAll('.comment-composer').forEach(function(composer) {
        var itemId = composer.dataset.itemId;
        var input = composer.querySelector('.comment-input');
        var sendBtn = composer.querySelector('.comment-send-btn');
        function send() {
          var body = input.value.trim();
          if (!body) return;
          sendBtn.disabled = true;
          fetch('/api/review-items/' + itemId + '/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: body })
          }).then(function(r) {
            if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || 'Post failed'); });
            return r.json();
          }).then(function(c) {
            input.value = '';
            // Append locally (SSE will also fire, but buildCommentEl dedupes by id)
            var list = composer.parentElement.querySelector('.comments-scroll');
            if (list && !list.querySelector('.comment[data-comment-id="' + c.id + '"]')) {
              list.appendChild(buildCommentEl(c));
              list.scrollTop = list.scrollHeight;
              bumpCommentBadge(itemId, 1);
            }
          }).catch(function(err) {
            alert('Could not post comment: ' + err.message);
          }).finally(function() {
            sendBtn.disabled = false;
          });
        }
        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); send(); }
        });
      });

      // Edit + delete (event delegation)
      document.addEventListener('click', function(e) {
        var editBtn = e.target.closest('.comment-edit-btn');
        if (editBtn) {
          var el = editBtn.closest('.comment');
          if (!el || el.classList.contains('editing')) return;
          el.classList.add('editing');
          var bodyDiv = el.querySelector('.comment-body');
          var original = bodyDiv.textContent.trim();
          var ta = document.createElement('textarea');
          ta.className = 'comment-edit-textarea';
          ta.value = original;
          var actions = document.createElement('div');
          actions.className = 'comment-edit-actions';
          actions.innerHTML = '<button class="comment-cancel-btn">Cancel</button>' +
                              '<button class="comment-save-btn">Save</button>';
          bodyDiv.replaceWith(ta);
          el.appendChild(actions);
          ta.focus();
          actions.querySelector('.comment-cancel-btn').addEventListener('click', function() {
            ta.replaceWith(bodyDiv);
            actions.remove();
            el.classList.remove('editing');
          });
          actions.querySelector('.comment-save-btn').addEventListener('click', function() {
            var newBody = ta.value.trim();
            if (!newBody) { alert('Comment cannot be empty'); return; }
            fetch('/api/review-item-comments/' + el.dataset.commentId, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: newBody })
            }).then(function(r) {
              if (!r.ok) return r.json().then(function(e2) { throw new Error(e2.error || 'Save failed'); });
              return r.json();
            }).then(function(c) {
              var next = buildCommentEl(c);
              el.replaceWith(next);
            }).catch(function(err) { alert('Could not save: ' + err.message); });
          });
          return;
        }
        var delBtn = e.target.closest('.comment-delete-btn');
        if (delBtn) {
          if (!confirm('Delete this comment? This cannot be undone.')) return;
          var el = delBtn.closest('.comment');
          if (!el) return;
          var itemEl = delBtn.closest('.review-comments');
          var itemId = itemEl && itemEl.dataset.itemId;
          fetch('/api/review-item-comments/' + el.dataset.commentId, {
            method: 'DELETE'
          }).then(function(r) {
            if (!r.ok) return r.json().then(function(e2) { throw new Error(e2.error || 'Delete failed'); });
            el.remove();
            if (itemId) bumpCommentBadge(itemId, -1);
          }).catch(function(err) { alert('Could not delete: ' + err.message); });
          return;
        }
      });
      ` : ''}

      ${isAuthed ? `
      // htmlToMarkdown
      function htmlToMd(el) {
        var r = '';
        for (var i = 0; i < el.childNodes.length; i++) {
          var n = el.childNodes[i];
          if (n.nodeType === 3) { r += n.textContent || ''; }
          else if (n.nodeType === 1) {
            var tag = n.tagName;
            if (tag === 'A') { r += '[' + (n.textContent || '') + '](' + (n.getAttribute('href') || '') + ')'; }
            else if (tag === 'BR') { r += '\\n'; }
            else if (tag === 'DIV' || tag === 'P') {
              if (r && !r.endsWith('\\n')) r += '\\n';
              r += htmlToMd(n);
            } else { r += n.textContent || ''; }
          }
        }
        return r;
      }

      // Conflict toast
      var conflictToast = document.createElement('div');
      conflictToast.className = 'conflict-toast';
      conflictToast.style.display = 'none';
      document.body.appendChild(conflictToast);
      var conflictTimer;
      function showConflict(msg) {
        conflictToast.textContent = msg;
        conflictToast.style.display = 'block';
        clearTimeout(conflictTimer);
        conflictTimer = setTimeout(function() { conflictToast.style.display = 'none'; }, 6000);
      }

      // Auto-save with debounce + optimistic locking
      // Session lives in an HttpOnly cookie — fetches use same-origin default (cookie sent automatically)
      document.querySelectorAll('.notes-editor').forEach(function(editor) {
        var timer;
        editor.addEventListener('input', function() {
          // Wrap bare text nodes in divs
          for (var i = 0; i < editor.childNodes.length; i++) {
            var n = editor.childNodes[i];
            if (n.nodeType === 3 && n.textContent) {
              var div = document.createElement('div');
              editor.insertBefore(div, n);
              div.appendChild(n);
            }
          }
          if (editor.innerHTML === '<br>') editor.innerHTML = '';
          clearTimeout(timer);
          timer = setTimeout(function() {
            var md = htmlToMd(editor);
            fetch('/api/review-items/' + editor.dataset.itemId + '/notes', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notes: md, expected_updated_at: editor.dataset.updatedAt || '' })
            }).then(function(r) {
              if (r.status === 409) {
                r.json().then(function(data) {
                  var who = (data.updated_by || 'someone').split('@')[0];
                  showConflict('This note was just edited by ' + who + ' — reload to see their changes');
                  editor.classList.add('save-error');
                });
              } else if (!r.ok) {
                editor.classList.add('save-error');
              } else {
                r.json().then(function(data) {
                  if (data.notes_updated_at) editor.dataset.updatedAt = data.notes_updated_at;
                });
                editor.classList.remove('save-error');
                editor.classList.add('save-ok');
                setTimeout(function(){ editor.classList.remove('save-ok') }, 1500);
              }
            }).catch(function() { editor.classList.add('save-error'); });
          }, 800);
        });

        // Paste as plain text
        editor.addEventListener('paste', function(e) {
          e.preventDefault();
          var text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        });

        // Click on links: only follow with cmd/ctrl
        editor.addEventListener('click', function(e) {
          if (e.target.tagName === 'A' && !e.metaKey && !e.ctrlKey) e.preventDefault();
        });
      });

      // Toolbar: bullet insert
      document.querySelectorAll('.notes-toolbar-btn[data-action="bullet"]').forEach(function(btn) {
        btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        btn.addEventListener('click', function() {
          var panel = btn.closest('.notes-panel');
          var editor = panel.querySelector('.notes-editor');
          editor.focus();
          var isEmpty = !editor.textContent || !editor.textContent.trim();
          if (isEmpty) { document.execCommand('insertHTML', false, '\\u2022 '); }
          else { document.execCommand('insertHTML', false, '<br>\\u2022 '); }
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });

      // Toolbar: link popover
      var savedRange = null;
      document.querySelectorAll('.notes-toolbar-btn[data-action="link"]').forEach(function(btn) {
        btn.addEventListener('mousedown', function(e) { e.preventDefault(); });
        btn.addEventListener('click', function() {
          var anchor = btn.closest('.notes-link-anchor');
          var popover = anchor.querySelector('.notes-link-popover');
          var isOpen = popover.style.display !== 'none';
          popover.style.display = isOpen ? 'none' : 'flex';
          if (!isOpen) {
            var sel = window.getSelection();
            savedRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
            var nameInput = popover.querySelector('[data-field="name"]');
            nameInput.value = (sel && sel.toString()) || '';
            popover.querySelector('[data-field="url"]').value = '';
            if (nameInput.value) popover.querySelector('[data-field="url"]').focus();
            else nameInput.focus();
          }
        });
      });

      // Link popover: add button
      document.querySelectorAll('.notes-link-add-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var popover = btn.closest('.notes-link-popover');
          var name = popover.querySelector('[data-field="name"]').value.trim();
          var url = popover.querySelector('[data-field="url"]').value.trim();
          if (!name || !url) return;
          var panel = btn.closest('.notes-panel');
          var editor = panel.querySelector('.notes-editor');
          editor.focus();
          if (savedRange) {
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(savedRange);
            savedRange = null;
          }
          var safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          var safeUrl = url.replace(/"/g, '&quot;');
          document.execCommand('insertHTML', false, '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer" class="notes-inline-link">' + safeName + '</a>');
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          popover.style.display = 'none';
        });
      });

      // Link popover: keyboard shortcuts
      document.querySelectorAll('.notes-link-input').forEach(function(input) {
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') input.closest('.notes-link-popover').style.display = 'none';
          if (e.key === 'Enter') {
            e.preventDefault();
            if (input.dataset.field === 'name') input.closest('.notes-link-popover').querySelector('[data-field="url"]').focus();
            else input.closest('.notes-link-popover').querySelector('.notes-link-add-btn').click();
          }
        });
      });

      // Close link popovers on outside click
      document.addEventListener('mousedown', function(e) {
        document.querySelectorAll('.notes-link-popover').forEach(function(pop) {
          if (pop.style.display !== 'none' && !pop.closest('.notes-link-anchor').contains(e.target)) {
            pop.style.display = 'none';
          }
        });
      });

      // ============ SHARED RESIZER (notes + feedback) ============
      document.querySelectorAll('.notes-feedback-resizer').forEach(function(handle) {
        var row = handle.previousElementSibling;
        if (!row || !row.classList.contains('notes-feedback-row')) return;
        handle.addEventListener('mousedown', function(e) {
          e.preventDefault();
          handle.classList.add('dragging');
          var startY = e.clientY;
          var startH = row.getBoundingClientRect().height;
          document.body.style.cursor = 'ns-resize';
          document.body.style.userSelect = 'none';
          function onMove(ev) {
            var next = Math.max(140, Math.min(900, startH + ev.clientY - startY));
            row.style.setProperty('--nf-height', next + 'px');
          }
          function onUp() {
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      });

      // ============ IMAGE UPLOAD / DELETE / CAPTION ============

      function uploadReviewImage(itemId, file, originalName) {
        var dropZone = document.querySelector('.review-image-drop[data-item-id="' + itemId + '"]');
        if (!dropZone) return;
        dropZone.classList.add('uploading');
        fetch('/api/review-items/' + itemId + '/images', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'image/png',
            'X-Original-Name': originalName || 'image.png'
          },
          body: file
        }).then(function(r) { return r.json(); })
        .then(function(img) {
          dropZone.classList.remove('uploading');
          // Hide placeholder
          var ph = dropZone.querySelector('.review-image-placeholder');
          if (ph) ph.style.display = 'none';
          // Ensure grid exists
          var grid = dropZone.querySelector('.review-image-grid');
          if (!grid) {
            grid = document.createElement('div');
            grid.className = 'review-image-grid';
            dropZone.insertBefore(grid, ph);
          }
          // Append thumbnail
          var div = document.createElement('div');
          div.className = 'review-image-item';
          div.draggable = true;
          div.dataset.imageId = img.id;
          var idx = grid.children.length;
          var gripSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
          var trashSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
          div.innerHTML = '<div class="review-image-thumb">' +
            '<span class="review-image-drag" title="Drag to reorder">' + gripSvg + '</span>' +
            '<img src="/api/review-item-images/' + img.id + '" alt="" loading="lazy" data-lightbox-trigger data-item-id="' + itemId + '" data-image-index="' + idx + '" />' +
            '<button class="review-image-delete" data-image-id="' + img.id + '" title="Delete image">' + trashSvg + '</button>' +
            '</div>' +
            '<input class="review-image-caption" placeholder="Add caption..." value="" data-image-id="' + img.id + '" data-original-caption="" />';
          grid.appendChild(div);
          // Update images data for lightbox
          if (!reviewItemImages[itemId]) reviewItemImages[itemId] = [];
          reviewItemImages[itemId].push(img);
          // Update inline thumbnail strip
          var projectCard = dropZone.closest('.project-card');
          if (projectCard) {
            var inlineSection = projectCard.querySelector('.review-inline-images');
            if (!inlineSection) {
              inlineSection = document.createElement('div');
              inlineSection.className = 'review-inline-images';
              inlineSection.innerHTML = '<span class="review-inline-images-label">Attached images</span><div class="review-inline-images-row"></div>';
              projectCard.appendChild(inlineSection);
            }
            var row = inlineSection.querySelector('.review-inline-images-row');
            var thumbCount = row.querySelectorAll('.review-inline-thumb').length;
            if (thumbCount < 4) {
              var inlineThumb = document.createElement('div');
              inlineThumb.className = 'review-inline-thumb';
              var idx = reviewItemImages[itemId].length - 1;
              inlineThumb.innerHTML = '<img src="/api/review-item-images/' + img.id + '" alt="" loading="lazy" data-lightbox-trigger data-item-id="' + itemId + '" data-image-index="' + idx + '" />';
              row.insertBefore(inlineThumb, row.querySelector('.review-inline-more'));
            } else {
              var moreSpan = row.querySelector('.review-inline-more');
              var total = reviewItemImages[itemId].length;
              if (moreSpan) {
                moreSpan.textContent = '+' + (total - 4) + ' more';
              } else {
                moreSpan = document.createElement('span');
                moreSpan.className = 'review-inline-more';
                moreSpan.textContent = '+' + (total - 4) + ' more';
                row.appendChild(moreSpan);
              }
            }
          }
        })
        .catch(function(err) {
          dropZone.classList.remove('uploading');
          console.error('Image upload failed:', err);
        });
      }

      // Paste on drop zones
      document.querySelectorAll('.review-image-drop').forEach(function(drop) {
        drop.addEventListener('paste', function(e) {
          var items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') === 0) {
              e.preventDefault();
              e.stopPropagation();
              var file = items[i].getAsFile();
              if (file) uploadReviewImage(drop.dataset.itemId, file, file.name || 'pasted-image.png');
              return;
            }
          }
        });

        // Drag and drop
        drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.classList.add('dragover'); });
        drop.addEventListener('dragleave', function(e) { e.preventDefault(); drop.classList.remove('dragover'); });
        drop.addEventListener('drop', function(e) {
          e.preventDefault();
          drop.classList.remove('dragover');
          var files = e.dataTransfer && e.dataTransfer.files;
          if (!files) return;
          for (var i = 0; i < files.length; i++) {
            if (files[i].type.indexOf('image') === 0) {
              uploadReviewImage(drop.dataset.itemId, files[i], files[i].name);
            }
          }
        });
      });

      // Delete images (event delegation)
      document.addEventListener('click', function(e) {
        var delBtn = e.target.closest('.review-image-delete');
        if (!delBtn) return;
        var imageId = delBtn.dataset.imageId;
        if (!imageId) return;
        fetch('/api/review-item-images/' + imageId, {
          method: 'DELETE'
        }).then(function(r) {
          if (!r.ok) return;
          var item = delBtn.closest('.review-image-item');
          var grid = item && item.parentElement;
          var dropZone = grid && grid.closest('.review-image-drop');
          if (item) item.remove();
          // Update lightbox data
          for (var key in reviewItemImages) {
            reviewItemImages[key] = reviewItemImages[key].filter(function(img) { return img.id !== imageId; });
          }
          // Re-index remaining thumbnails
          if (grid) {
            var imgs = grid.querySelectorAll('[data-lightbox-trigger]');
            for (var i = 0; i < imgs.length; i++) imgs[i].dataset.imageIndex = i;
          }
          // Show placeholder if empty
          if (dropZone && grid && grid.children.length === 0) {
            grid.remove();
            var ph = dropZone.querySelector('.review-image-placeholder');
            if (ph) ph.style.display = '';
          }
          // Rebuild inline thumbnail strip
          var projectCard = delBtn.closest('.project-card');
          if (projectCard) {
            var itemIdForInline = dropZone ? dropZone.dataset.itemId : null;
            var remaining = itemIdForInline ? (reviewItemImages[itemIdForInline] || []) : [];
            var inlineSection = projectCard.querySelector('.review-inline-images');
            if (remaining.length === 0 && inlineSection) {
              inlineSection.remove();
            } else if (inlineSection) {
              var row = inlineSection.querySelector('.review-inline-images-row');
              row.innerHTML = '';
              remaining.slice(0, 4).forEach(function(img, idx) {
                var t = document.createElement('div');
                t.className = 'review-inline-thumb';
                t.innerHTML = '<img src="/api/review-item-images/' + img.id + '" alt="" loading="lazy" data-lightbox-trigger data-item-id="' + itemIdForInline + '" data-image-index="' + idx + '" />';
                row.appendChild(t);
              });
              if (remaining.length > 4) {
                var m = document.createElement('span');
                m.className = 'review-inline-more';
                m.textContent = '+' + (remaining.length - 4) + ' more';
                row.appendChild(m);
              }
            }
          }
        }).catch(function(err) { console.error('Delete failed:', err); });
      });

      // Image drag-and-drop reorder (native HTML5)
      var rvDragState = { el: null, grid: null };
      document.addEventListener('dragstart', function(e) {
        var item = e.target.closest && e.target.closest('.review-image-item');
        if (!item) return;
        rvDragState.el = item;
        rvDragState.grid = item.parentElement;
        item.classList.add('review-image-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', item.dataset.imageId || ''); } catch(_) {}
        }
      });
      document.addEventListener('dragend', function(e) {
        if (rvDragState.el) rvDragState.el.classList.remove('review-image-dragging');
        document.querySelectorAll('.review-image-drop-target').forEach(function(n) { n.classList.remove('review-image-drop-target'); });
        rvDragState.el = null; rvDragState.grid = null;
      });
      document.addEventListener('dragover', function(e) {
        if (!rvDragState.el) return;
        var target = e.target.closest && e.target.closest('.review-image-item');
        if (!target || target === rvDragState.el) return;
        if (target.parentElement !== rvDragState.grid) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var rect = target.getBoundingClientRect();
        var before = (e.clientX - rect.left) < rect.width / 2;
        if (before) rvDragState.grid.insertBefore(rvDragState.el, target);
        else rvDragState.grid.insertBefore(rvDragState.el, target.nextSibling);
      });
      document.addEventListener('drop', function(e) {
        if (!rvDragState.grid) return;
        e.preventDefault();
        var grid = rvDragState.grid;
        var drop = grid.closest('.review-image-drop');
        var itemId = drop && drop.dataset.itemId;
        var imageIds = Array.prototype.map.call(grid.querySelectorAll('.review-image-item'), function(n) { return n.dataset.imageId; });
        // Re-index lightbox triggers
        var triggers = grid.querySelectorAll('[data-lightbox-trigger]');
        for (var i = 0; i < triggers.length; i++) triggers[i].dataset.imageIndex = i;
        // Update in-memory images order for lightbox
        if (itemId && reviewItemImages[itemId]) {
          var byId = {};
          reviewItemImages[itemId].forEach(function(img) { byId[img.id] = img; });
          reviewItemImages[itemId] = imageIds.map(function(id) { return byId[id]; }).filter(Boolean);
        }
        if (!itemId) return;
        fetch('/api/review-items/' + itemId + '/images/reorder', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_ids: imageIds })
        }).catch(function(err) { console.error('Image reorder failed:', err); });
        // Rebuild inline thumbnail strip on the card
        var projectCard = drop && drop.closest('.project-card');
        if (projectCard && itemId) {
          var inlineRow = projectCard.querySelector('.review-inline-images-row');
          if (inlineRow) {
            inlineRow.innerHTML = '';
            (reviewItemImages[itemId] || []).slice(0, 4).forEach(function(img, idx) {
              var t = document.createElement('div');
              t.className = 'review-inline-thumb';
              t.innerHTML = '<img src="/api/review-item-images/' + img.id + '" alt="" loading="lazy" data-lightbox-trigger data-item-id="' + itemId + '" data-image-index="' + idx + '" />';
              inlineRow.appendChild(t);
            });
            var total = (reviewItemImages[itemId] || []).length;
            if (total > 4) {
              var m = document.createElement('span');
              m.className = 'review-inline-more';
              m.textContent = '+' + (total - 4) + ' more';
              inlineRow.appendChild(m);
            }
          }
        }
      });

      // Caption update on blur (event delegation)
      document.addEventListener('focusout', function(e) {
        if (!e.target.classList || !e.target.classList.contains('review-image-caption')) return;
        var input = e.target;
        var imageId = input.dataset.imageId;
        var newCaption = input.value.trim();
        var oldCaption = input.dataset.originalCaption || '';
        if (newCaption === oldCaption) return;
        input.dataset.originalCaption = newCaption;
        fetch('/api/review-item-images/' + imageId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caption: newCaption })
        }).then(function(r) { return r.json(); }).then(function(img) {
          // Update lightbox data
          for (var key in reviewItemImages) {
            reviewItemImages[key] = reviewItemImages[key].map(function(i) {
              return i.id === imageId ? Object.assign({}, i, { caption: newCaption }) : i;
            });
          }
        }).catch(function(err) { console.error('Caption update failed:', err); });
      });
      ` : ''}
    </script>`

    res.send(renderPage(title + week, header + content + notesScript, allReviews, req.params.id, sessionId))
  } catch (e: any) {
    res.status(500).send(renderPage('Error', `<div class="empty-state">Something went wrong: ${escHtml(e.message)}</div>`, []))
  }
})

function getISOWeek(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function renderPage(title: string, body: string, reviews: any[], activeId?: string, _sessionId?: string): string {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']

  // Group reviews by year → month → week
  const grouped: Map<number, Map<number, { week: number; review: any }[]>> = new Map()
  for (const r of reviews) {
    const d = new Date((r.created_at || '') + 'Z')
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth()
    const week = getISOWeek(d)
    if (!grouped.has(year)) grouped.set(year, new Map())
    const yearMap = grouped.get(year)!
    if (!yearMap.has(month)) yearMap.set(month, [])
    yearMap.get(month)!.push({ week, review: r })
  }

  const now = new Date()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()
  // Also open the month containing the active review
  let activeYear = -1, activeMonth = -1
  if (activeId) {
    const ar = reviews.find((r: any) => r.id === activeId)
    if (ar) {
      const ad = new Date((ar.created_at || '') + 'Z')
      activeYear = ad.getUTCFullYear()
      activeMonth = ad.getUTCMonth()
    }
  }

  let navItems = ''
  for (const [year, yearMap] of grouped) {
    navItems += `<div class="nav-year">${year}</div>`
    for (const [month, entries] of yearMap) {
      const isOpen = (year === currentYear && month === currentMonth) || (year === activeYear && month === activeMonth)
      navItems += `<button class="nav-month-toggle${isOpen ? ' open' : ''}" data-nav-toggle>
        <svg class="nav-month-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        ${months[month]}
      </button>`
      navItems += `<div class="nav-month-items" style="display:${isOpen ? 'block' : 'none'}">`
      for (const { week, review: r } of entries) {
        const isActive = r.id === activeId
        navItems += `<a href="/review/${r.id}" class="nav-item${isActive ? ' active' : ''}">Week ${week}</a>`
      }
      navItems += `</div>`
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — WandiHub</title>
  <style>
    :root {
      --rv-bg: #ffffff;
      --rv-bg-secondary: #f9fafb;
      --rv-bg-tertiary: #f3f4f6;
      --rv-text: #111827;
      --rv-text-secondary: #4b5563;
      --rv-text-muted: #6b7280;
      --rv-text-dim: #9ca3af;
      --rv-border: #e5e7eb;
      --rv-border-subtle: #f3f4f6;
      --rv-border-hover: #d1d5db;
      --rv-accent: #2563eb;
      --rv-link: #2563eb;
      --rv-hover: rgba(0,0,0,0.03);
      --rv-danger: #dc2626;
      --rv-success: #059669;
    }
    [data-theme="dark"] {
      --rv-bg: #09090b;
      --rv-bg-secondary: #111113;
      --rv-bg-tertiary: #1a1a1e;
      --rv-text: #fafafa;
      --rv-text-secondary: #a1a1aa;
      --rv-text-muted: #71717a;
      --rv-text-dim: #52525b;
      --rv-border: #27272a;
      --rv-border-subtle: #1e1e21;
      --rv-border-hover: #3f3f46;
      --rv-accent: #3b82f6;
      --rv-link: #60a5fa;
      --rv-hover: rgba(255,255,255,0.04);
      --rv-danger: #ef4444;
      --rv-success: #10b981;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      background: var(--rv-bg); color: var(--rv-text); line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      transition: background 0.2s, color 0.2s;
    }

    /* Layout */
    .layout { display: flex; min-height: 100vh; }
    .sidebar {
      width: 220px; flex-shrink: 0; background: var(--rv-bg-secondary);
      border-right: 1px solid var(--rv-border);
      display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0;
      transition: background 0.2s, border-color 0.2s;
    }
    .sidebar-title {
      font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--rv-text-muted); padding: 1.25rem 1.25rem 0.5rem; flex-shrink: 0;
    }
    .sidebar-nav {
      flex: 1; overflow-y: auto; padding: 0 0.75rem; display: flex; flex-direction: column; gap: 0.25rem;
      min-height: 0;
    }
    .sidebar-nav::-webkit-scrollbar { width: 4px; }
    .sidebar-nav::-webkit-scrollbar-track { background: transparent; }
    .sidebar-nav::-webkit-scrollbar-thumb { background: var(--rv-border); border-radius: 2px; }
    .nav-year {
      font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--rv-text-dim); padding: 0.75rem 0.5rem 0.15rem;
    }
    .nav-year:first-child { padding-top: 0.25rem; }
    .nav-month-toggle {
      display: flex; align-items: center; gap: 0.3rem; width: 100%;
      background: none; border: none; cursor: pointer; font-family: inherit;
      font-size: 0.75rem; font-weight: 600; color: var(--rv-text-muted);
      padding: 0.3rem 0.5rem; transition: color 0.15s;
    }
    .nav-month-toggle:hover { color: var(--rv-text); }
    .nav-month-chevron { transition: transform 0.15s; flex-shrink: 0; }
    .nav-month-toggle.open .nav-month-chevron { transform: rotate(90deg); }
    .nav-month-items { padding-left: 0.35rem; }
    .nav-item {
      display: block; padding: 0.3rem 0.5rem 0.3rem 0.75rem; border-radius: 6px; font-size: 0.75rem;
      color: var(--rv-text-secondary); text-decoration: none; transition: background 0.15s, color 0.15s;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
    }
    .nav-item:hover { background: var(--rv-hover); color: var(--rv-text); }
    .nav-item.active { background: var(--rv-accent); color: #fff; }
    .nav-review-title { opacity: 0.6; font-weight: 400; }
    .nav-item.active .nav-review-title { opacity: 0.8; }
    .sidebar-footer {
      flex-shrink: 0; padding: 0.75rem; border-top: 1px solid var(--rv-border-subtle);
      display: flex; align-items: center; justify-content: space-between;
    }
    .branding { font-size: 0.65rem; color: var(--rv-text-dim); }
    .theme-toggle {
      background: none; border: 1px solid var(--rv-border); border-radius: 6px;
      color: var(--rv-text-muted); cursor: pointer; padding: 0.3rem 0.45rem;
      font-size: 0.7rem; display: flex; align-items: center; gap: 0.3rem;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .theme-toggle:hover { background: var(--rv-hover); color: var(--rv-text); border-color: var(--rv-text-dim); }
    .theme-toggle svg { width: 14px; height: 14px; }

    /* Main content */
    .main { flex: 1; padding: 2rem 2.5rem; overflow-x: hidden; }

    /* Page header */
    .page-header { margin-bottom: 2rem; }
    .page-header h1 { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.025em; }
    .page-meta { font-size: 0.8rem; color: var(--rv-text-muted); margin-top: 0.25rem; }
    .page-description {
      font-size: 0.85rem; color: var(--rv-text-secondary); margin-top: 0.5rem;
      line-height: 1.6; max-width: 720px;
    }

    /* Cards stack */
    .cards-stack { display: flex; flex-direction: column; gap: 1.25rem; }

    /* Project card */
    .project-card {
      background: var(--rv-bg-secondary); border: 1px solid var(--rv-border);
      border-radius: 10px; overflow: hidden; transition: border-color 0.15s;
    }
    .project-card:hover { border-color: var(--rv-border-hover); }

    /* Card header */
    .card-header {
      display: flex; align-items: flex-start; gap: 0.75rem;
      padding: 1rem 1.25rem; border-bottom: 1px solid var(--rv-border-subtle);
    }
    .card-number {
      font-size: 0.72rem; font-weight: 700; color: #fff;
      background: #dc2626; border-radius: 50%;
      width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 0.1rem; font-variant-numeric: tabular-nums;
    }
    .card-title-area { flex: 1; min-width: 0; }
    .card-title { font-size: 0.9rem; font-weight: 600; letter-spacing: -0.01em; }
    .card-meta { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem; flex-wrap: wrap; }
    .card-description { padding: 0.4rem 1.25rem 0.75rem; font-size: 0.8rem; color: var(--rv-text-muted); line-height: 1.45; max-width: 70ch; }
    .status-badge {
      display: inline-block; padding: 0.1rem 0.5rem; border-radius: 99px;
      font-size: 0.65rem; font-weight: 500; color: #fff; letter-spacing: 0.01em;
    }
    .time-chip { background: var(--rv-bg-tertiary); color: var(--rv-text-secondary); }
    .time-chip-excluded { background: transparent; color: var(--rv-text-dim); border: 1px dashed var(--rv-border); }
    .awareness-section { margin-top: 2.5rem; display: flex; flex-direction: column; gap: 1.25rem; }
    .awareness-heading {
      font-size: 0.95rem; font-weight: 600; color: var(--rv-text-dim);
      text-transform: none; letter-spacing: 0.01em;
      padding: 0 0 0.75rem 0.25rem; margin: 0 0 0.75rem;
      border-bottom: 1px solid var(--rv-border-subtle);
    }
    .awareness-section .project-card { opacity: 0.85; }
    .card-designers { display: inline-flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
    .designer-badge {
      display: inline-flex; align-items: center; gap: 0.3rem;
      background: var(--rv-bg-tertiary); color: var(--rv-text-secondary);
    }
    a.designer-badge { text-decoration: none; transition: background 0.15s, color 0.15s; cursor: pointer; }
    a.designer-badge:hover { background: var(--rv-accent); color: #fff; }

    /* Gantt — mirrors project page exactly */
    .project-gantt {
      --gantt-label-col: 170px;
      --gantt-col-gap: 10px;
      --gantt-header-gap: 0.75rem;
      --gantt-bars-pad: 8px;
      --gantt-bars-border: 1px;
      display: flex; flex-direction: column; gap: var(--gantt-header-gap);
      padding: 1rem 1.25rem;
      background: linear-gradient(180deg, var(--rv-hover) 0%, transparent 100%);
      border-top: 1px solid var(--rv-border-subtle);
    }
    .gantt-header {
      display: grid; grid-template-columns: var(--gantt-label-col) minmax(0,1fr);
      column-gap: var(--gantt-col-gap); align-items: center;
      font-size: 0.65rem; color: var(--rv-text-dim); padding: 0 8px;
      font-weight: 600; letter-spacing: 0.05em;
    }
    .gantt-header-spacer { width: var(--gantt-label-col); }
    .gantt-header-track { display: flex; justify-content: space-between; min-width: 0; }
    .gantt-start, .gantt-end { position: relative; display: inline-flex; align-items: center; gap: 6px; }
    .gantt-start { padding-left: 5px; }
    .gantt-end { padding-right: 5px; }
    .gantt-edge-line {
      position: absolute; width: 1px; top: 0; height: calc(100% + 20px);
      background: linear-gradient(180deg, rgba(128,128,128,0.5) 0%, rgba(128,128,128,0.3) 60%, transparent 100%);
      pointer-events: none;
    }
    .gantt-edge-line-start { left: 0; }
    .gantt-edge-line-end { right: 0; }
    .gantt-container { position: relative; }
    .gantt-bars {
      position: relative; display: flex; flex-direction: column; gap: 6px;
      background: var(--rv-bg-tertiary); border-radius: 6px; overflow: visible;
      padding: var(--gantt-bars-pad); border: var(--gantt-bars-border) solid var(--rv-border-subtle);
    }
    .gantt-weekly-grid {
      position: absolute; top: var(--gantt-bars-pad); bottom: var(--gantt-bars-pad);
      left: calc(8px + var(--gantt-label-col) + var(--gantt-col-gap)); right: 8px;
      pointer-events: none; z-index: 1;
    }
    .gantt-weekly-tick {
      position: absolute; top: 0; bottom: 0; width: 1px;
      background: rgba(128,128,128,0.08); border-right: 1px dashed rgba(128,128,128,0.12);
    }
    [data-theme="dark"] .gantt-weekly-tick {
      background: rgba(255,255,255,0.06); border-right-color: rgba(255,255,255,0.08);
    }
    .gantt-track {
      height: 32px; width: 100%;
      display: grid; grid-template-columns: var(--gantt-label-col) minmax(0,1fr);
      column-gap: var(--gantt-col-gap); align-items: center;
    }
    .gantt-track-label {
      width: var(--gantt-label-col); font-size: 0.65rem; font-weight: 600;
      color: var(--rv-text-muted); text-transform: uppercase; letter-spacing: 0.05em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 25ch;
    }
    .gantt-track-bars { position: relative; height: 32px; min-width: 0; overflow: visible; }
    .gantt-bar {
      position: absolute; top: 4px; height: 24px; min-width: 40px;
      display: flex; align-items: center; padding: 0 0.75rem; box-sizing: border-box;
      border-radius: 4px; font-size: 0.7rem; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1); transition: all 0.2s ease;
    }
    .gantt-bar:hover { filter: brightness(1.1); box-shadow: 0 2px 6px rgba(0,0,0,0.15); z-index: 5; transform: scaleY(1.08); }
    .gantt-bar.bar-1 { background: linear-gradient(90deg, #4f46e5 0%, rgba(99,102,241,0.8) 100%); }
    .gantt-bar.bar-2 { background: linear-gradient(90deg, #7c3aed 0%, rgba(139,92,246,0.8) 100%); }
    .gantt-bar.bar-3 { background: linear-gradient(90deg, #db2777 0%, rgba(236,72,153,0.8) 100%); }
    .gantt-bar.bar-4 { background: linear-gradient(90deg, #0d9488 0%, rgba(20,184,166,0.8) 100%); }
    .gantt-bar.bar-5 { background: linear-gradient(90deg, #d97706 0%, rgba(245,158,11,0.8) 100%); }
    .gantt-bar.bar-duration { background: linear-gradient(90deg, #9ca3af 0%, rgba(156,163,175,0.7) 100%); }
    [data-theme="dark"] .gantt-bar.bar-1 { background: linear-gradient(90deg, #6366f1 0%, rgba(99,102,241,0.8) 100%); }
    [data-theme="dark"] .gantt-bar.bar-2 { background: linear-gradient(90deg, #8b5cf6 0%, rgba(139,92,246,0.8) 100%); }
    [data-theme="dark"] .gantt-bar.bar-3 { background: linear-gradient(90deg, #ec4899 0%, rgba(236,72,153,0.8) 100%); }
    [data-theme="dark"] .gantt-bar.bar-4 { background: linear-gradient(90deg, #14b8a6 0%, rgba(20,184,166,0.8) 100%); }
    [data-theme="dark"] .gantt-bar.bar-5 { background: linear-gradient(90deg, #f59e0b 0%, rgba(245,158,11,0.8) 100%); }
    .gantt-label {
      display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-weight: 600; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    }
    .gantt-arrow { opacity: 0.3; }
    .gantt-today-global {
      position: absolute; top: var(--gantt-bars-pad); bottom: var(--gantt-bars-pad); width: 2px;
      left: calc(8px + var(--gantt-label-col) + var(--gantt-col-gap) + (100% - 16px - var(--gantt-label-col) - var(--gantt-col-gap)) * var(--today-pos, 0));
      background: linear-gradient(180deg, transparent 0%, #f59e0b 20%, #f59e0b 80%, transparent 100%);
      z-index: 10; pointer-events: none;
    }
    .gantt-today-label {
      position: absolute; top: -20px; left: 50%; transform: translateX(-50%);
      font-size: 0.6rem; font-weight: 700; color: #f59e0b; white-space: nowrap;
      background: var(--rv-bg-secondary); padding: 2px 8px; border-radius: 4px;
      border: 1px solid #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.1);
    }
    .gantt-empty { padding: 0.5rem 1.25rem; font-size: 0.75rem; color: var(--rv-text-dim); }

    /* Review diamond track */
    .gantt-review-track .gantt-track-bars { position: relative; }
    .gantt-review-diamond {
      position: absolute; top: 50%; transform: translate(-50%, -50%);
      width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
      z-index: 6; text-decoration: none;
    }
    .gantt-review-diamond-shape {
      width: 13px; height: 13px; background: #f59e0b;
      transform: rotate(45deg);
      box-shadow: 0 2px 4px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.1);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .gantt-review-diamond:hover .gantt-review-diamond-shape {
      transform: rotate(45deg) scale(1.3);
      box-shadow: 0 3px 6px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.15);
    }
    [data-theme="dark"] .gantt-review-diamond-shape { background: #fbbf24; }

    /* Gantt accordion wrapper — reuses .notes-accordion button styles via shared class */
    .card-gantt-accordion { border-top: 1px solid var(--rv-border-subtle); }
    .card-gantt-accordion > summary { list-style: none; user-select: none; }
    .card-gantt-accordion > summary::-webkit-details-marker { display: none; }
    .card-gantt-accordion[open] > summary .notes-chevron { transform: rotate(90deg); }
    .card-gantt-accordion > .project-gantt { border-top: 1px solid var(--rv-border-subtle); }

    /* Gemini notes accordion — page-level, sits above project cards */
    .gemini-notes-accordion {
      background: var(--rv-bg); border: 1px solid var(--rv-border);
      border-radius: 10px; margin-top: 1.5rem; margin-bottom: 1rem; overflow: hidden;
    }
    .gemini-notes-summary {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.85rem 1.25rem; cursor: pointer; user-select: none;
      font-weight: 600; font-size: 0.95rem; color: var(--rv-text);
      list-style: none;
    }
    .gemini-notes-summary::-webkit-details-marker { display: none; }
    .gemini-notes-accordion[open] > .gemini-notes-summary .notes-chevron { transform: rotate(90deg); }
    .gemini-notes-accordion[open] > .gemini-notes-summary { border-bottom: 1px solid var(--rv-border-subtle); }
    .gemini-notes-body {
      padding: 1rem 1.25rem; color: var(--rv-text-secondary);
      font-size: 0.88rem; line-height: 1.6;
      max-width: 85ch;
    }
    .gemini-notes-body h1, .gemini-notes-body h2, .gemini-notes-body h3 {
      margin: 1rem 0 0.35rem; color: var(--rv-text); font-weight: 600;
    }
    .gemini-notes-body h1 { font-size: 1.05rem; }
    .gemini-notes-body h2 { font-size: 0.98rem; }
    .gemini-notes-body h3 { font-size: 0.92rem; }
    .gemini-notes-body ul { margin: 0.35rem 0; padding-left: 1.25rem; }
    .gemini-notes-body li { margin: 0.15rem 0; }
    .gemini-notes-body p { margin: 0.5rem 0; }
    .gemini-notes-body a { color: var(--rv-accent); text-decoration: none; }
    .gemini-notes-body a:hover { text-decoration: underline; }

    /* Links section */
    .card-links {
      display: flex; flex-wrap: wrap; gap: 0.15rem 0; padding: 0.6rem 1.25rem;
      border-top: 1px solid var(--rv-border-subtle); align-items: center;
    }
    .card-links a {
      display: inline-flex; align-items: center; gap: 0.14rem; font-size: 0.75rem;
      color: #2563eb; text-decoration: underline; text-underline-offset: 2px;
      transition: color 0.15s;
    }
    .card-links a:hover { color: #1d4ed8; }
    [data-theme="dark"] .card-links a { color: #60a5fa; }
    [data-theme="dark"] .card-links a:hover { color: #93c5fd; }
    .card-link-sep { color: var(--rv-text-dim); font-size: 0.6rem; margin: 0 0.4rem; }

    /* Notes accordion */
    .card-notes { border-top: 1px solid var(--rv-border-subtle); }
    .notes-accordion {
      display: flex; align-items: center; gap: 0.4rem; width: 100%;
      padding: 0.6rem 1.25rem; background: none; border: none;
      font-size: 0.75rem; font-weight: 500; color: var(--rv-text-muted);
      cursor: pointer; font-family: inherit; transition: color 0.15s;
    }
    .notes-accordion:hover { color: var(--rv-text); }
    .notes-accordion.has-notes { color: var(--rv-text-secondary); }
    .notes-chevron { transition: transform 0.2s; flex-shrink: 0; }
    .notes-accordion.open .notes-chevron { transform: rotate(90deg); }
    .notes-badge {
      font-size: 0.6rem; font-weight: 500; color: var(--rv-accent);
      background: rgba(37,99,235,0.08); padding: 0.1rem 0.4rem; border-radius: 99px;
      margin-left: 0.25rem;
    }
    [data-theme="dark"] .notes-badge { background: rgba(59,130,246,0.12); }
    .comment-count-badge { background: rgba(34,197,94,0.1); color: #15803d; }
    [data-theme="dark"] .comment-count-badge { background: rgba(34,197,94,0.15); color: #86efac; }
    .notes-panel { padding: 0 1.25rem 0.35rem; }

    /* Two-column layout inside "Open Notes & Feedback".
       Height lives on the row via --nf-height (default 260px) and both
       children stretch to fill. A single .notes-feedback-resizer handle
       below the row adjusts --nf-height so notes + feedback grow together.
       Explicit grid-template-rows: 1fr forces the single row to fill the
       container height — without it the row stays content-sized and the
       columns don't actually grow when the container expands. */
    .notes-feedback-row {
      --nf-height: 260px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-rows: 1fr;
      gap: 1rem;
      align-items: stretch;
      height: var(--nf-height);
      margin-top: 1.25rem;
    }
    .notes-column, .feedback-column {
      min-width: 0; min-height: 0;
      display: flex; flex-direction: column;
      height: 100%;
    }
    /* The feedback column wraps .review-comments — forward the height down */
    .feedback-column > .review-comments { flex: 1 1 auto; min-height: 0; height: auto; }
    /* Shared bottom-bar resize handle */
    .notes-feedback-resizer {
      height: 14px;
      margin-top: 4px;
      cursor: ns-resize;
      display: flex; align-items: center; justify-content: center;
      border-radius: 4px;
      background: transparent;
      transition: background 0.15s;
    }
    .notes-feedback-resizer::after {
      content: ''; display: block; width: 64px; height: 5px;
      border-radius: 3px; background: var(--rv-text-dim);
      opacity: 0.55;
      transition: background 0.15s, opacity 0.15s;
    }
    .notes-feedback-resizer:hover::after { opacity: 0.9; }
    .notes-feedback-resizer:hover { background: var(--rv-bg-subtle); }
    .notes-feedback-resizer.dragging::after { background: var(--rv-accent); opacity: 1; }
    .notes-feedback-resizer.dragging { background: var(--rv-bg-subtle); }
    .notes-column-label {
      font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--rv-text-dim); margin-bottom: 0.5rem;
    }

    /* Comments thread */
    .review-comments {
      display: flex; flex-direction: column; height: 100%;
    }
    .review-comments-label {
      font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--rv-text-dim); margin-bottom: 0.5rem;
    }
    /* .comments-list is the bordered outer container. Inside:
       - .comments-scroll — the actual scrolling area (flex:1)
       - .comment-composer — pinned at the bottom as a visually separate row
       Height fills the shared .notes-feedback-row. */
    .comments-list {
      display: flex; flex-direction: column;
      flex: 1 1 auto; min-height: 0;
      border: 1px solid var(--rv-border);
      border-radius: 8px;
      background: var(--rv-bg-subtle);
      overflow: hidden;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.04),
                  inset 0 -2px 4px rgba(0,0,0,0.04);
    }
    [data-theme="dark"] .comments-list {
      box-shadow: inset 0 2px 6px rgba(0,0,0,0.25),
                  inset 0 -2px 6px rgba(0,0,0,0.25);
    }
    .comments-scroll {
      flex: 1 1 auto; min-height: 0;
      overflow-y: auto;
      display: flex; flex-direction: column; gap: 0.6rem;
      padding: 0.5rem 0.5rem 0.5rem 0.6rem;
    }
    .comments-scroll:empty::before {
      content: 'No comments yet.';
      color: var(--rv-text-dim); font-size: 0.78rem; font-style: italic;
    }
    .comments-scroll::-webkit-scrollbar { width: 10px; }
    .comments-scroll::-webkit-scrollbar-thumb {
      background: var(--rv-border); border-radius: 5px;
      border: 2px solid var(--rv-bg-subtle);
    }
    .comments-scroll::-webkit-scrollbar-thumb:hover { background: var(--rv-text-dim); }
    .comments-scroll::-webkit-scrollbar-track { background: transparent; }
    /* Comments inside the scroll container — lift against the inset bg */
    .comments-scroll .comment { background: var(--rv-bg); }
    .comment {
      background: var(--rv-bg-subtle); border: 1px solid var(--rv-border-subtle);
      border-radius: 8px; padding: 0.55rem 0.75rem;
      animation: comment-fade-in 0.3s ease-out;
    }
    @keyframes comment-fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .comment.own { border-color: rgba(37,99,235,0.3); background: rgba(37,99,235,0.04); }
    [data-theme="dark"] .comment.own { border-color: rgba(59,130,246,0.35); background: rgba(59,130,246,0.08); }
    .comment-head {
      display: flex; align-items: center; gap: 0.5rem;
      font-size: 0.7rem; margin-bottom: 0.25rem;
    }
    .comment-author { font-weight: 600; color: var(--rv-text); }
    .comment-time { color: var(--rv-text-dim); }
    .comment-actions { margin-left: auto; display: flex; gap: 0.35rem; }
    .comment-actions button {
      background: none; border: none; padding: 0.1rem 0.3rem;
      font-size: 0.68rem; color: var(--rv-text-dim); cursor: pointer;
      border-radius: 3px;
    }
    .comment-actions button:hover { background: var(--rv-bg); color: var(--rv-accent); }
    .comment-body {
      font-size: 0.82rem; line-height: 1.5; color: var(--rv-text);
      word-wrap: break-word;
    }
    .comment-body p { margin: 0.25rem 0; }
    .comment-body p:first-child { margin-top: 0; }
    .comment-body p:last-child { margin-bottom: 0; }
    .comment-body a { color: var(--rv-accent); }
    .comment-edit-textarea {
      width: 100%; font-family: inherit; font-size: 0.82rem; line-height: 1.5;
      padding: 0.4rem 0.5rem; border: 1px solid var(--rv-border); border-radius: 6px;
      background: var(--rv-bg); color: var(--rv-text); resize: vertical; min-height: 4rem;
    }
    .comment-edit-actions {
      display: flex; gap: 0.4rem; margin-top: 0.4rem;
      justify-content: flex-end;
    }
    .comment-save-btn, .comment-cancel-btn {
      height: 32px; padding: 0 0.85rem;
      font-size: 0.78rem; font-weight: 500; font-family: inherit;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
    }
    .comment-save-btn {
      background: var(--rv-accent); color: white;
      border: 1px solid var(--rv-accent);
    }
    .comment-save-btn:hover { opacity: 0.9; }
    .comment-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .comment-cancel-btn {
      background: transparent; color: var(--rv-text-secondary);
      border: 1px solid var(--rv-border);
    }
    .comment-cancel-btn:hover {
      background: var(--rv-bg-subtle);
      border-color: var(--rv-text-dim);
      color: var(--rv-text);
    }
    /* Composer — pinned at the bottom of the list container, single pill with input + send */
    .comment-composer {
      flex: 0 0 auto;
      display: flex; align-items: stretch; gap: 0;
      padding: 0.35rem;
      border-top: 1px solid var(--rv-border);
      background: var(--rv-bg);
    }
    .comment-input {
      flex: 1 1 auto; min-width: 0;
      height: 32px; padding: 0 0.65rem;
      font-family: inherit; font-size: 0.82rem; line-height: 32px;
      border: 1px solid var(--rv-border);
      border-right: none;
      border-radius: 6px 0 0 6px;
      background: var(--rv-bg); color: var(--rv-text);
      outline: none;
    }
    .comment-input:focus {
      border-color: var(--rv-accent);
      box-shadow: 0 0 0 2px rgba(37,99,235,0.1);
      z-index: 1;
    }
    .comment-send-btn {
      flex: 0 0 auto;
      height: 32px; padding: 0 0.85rem;
      background: var(--rv-accent); color: white;
      border: 1px solid var(--rv-accent);
      border-radius: 0 6px 6px 0;
      font-size: 0.78rem; font-weight: 500;
      cursor: pointer; white-space: nowrap;
    }
    .comment-send-btn:hover { opacity: 0.9; }
    .comment-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Notes toolbar — matches the shared .rte-toolbar pattern in-app */
    .notes-toolbar {
      display: flex; align-items: center; gap: 0.25rem;
      padding: 0.35rem 0.5rem;
      background: color-mix(in srgb, var(--rv-bg) 92.5%, black);
      border: 1px solid var(--rv-border);
      border-radius: 6px 6px 0 0;
      border-bottom: none;
    }
    [data-theme="dark"] .notes-toolbar {
      background: color-mix(in srgb, var(--rv-bg) 88%, white);
    }
    .notes-toolbar-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border: 1px solid var(--rv-border); border-radius: 4px;
      background: var(--rv-bg); color: var(--rv-text-secondary); cursor: pointer;
      transition: all 0.15s; flex-shrink: 0;
    }
    .notes-toolbar-btn:hover { border-color: var(--rv-accent); color: var(--rv-accent); }
    .notes-link-anchor { position: relative; }
    .notes-link-popover {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 20;
      flex-direction: column; gap: 0.3rem; padding: 0.5rem;
      background: var(--rv-bg-secondary); border: 1px solid var(--rv-border);
      border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); min-width: 220px;
    }
    .notes-link-input {
      padding: 0.35rem 0.5rem; font-size: 0.78rem; font-family: inherit;
      border: 1px solid var(--rv-border); border-radius: 5px;
      background: var(--rv-bg); color: var(--rv-text); width: 100%;
    }
    .notes-link-input:focus { outline: none; border-color: var(--rv-accent); }
    .notes-link-add-btn {
      width: 100%; padding: 0.3rem 0.5rem; font-size: 0.75rem; font-weight: 500;
      border: none; border-radius: 4px; background: var(--rv-accent); color: #fff;
      cursor: pointer; transition: opacity 0.15s;
    }
    .notes-link-add-btn:hover { opacity: 0.85; }

    /* ContentEditable editor — continues from .notes-toolbar (no top border,
       bottom-only rounded corners) to match the in-app .rte-editor pattern.
       Height is driven by the parent .notes-column flex layout so it fills
       the shared row height set by the .notes-feedback-resizer handle. */
    .notes-editor {
      width: 100%; flex: 1 1 auto; min-height: 0;
      padding: 0.5rem 0.6rem; font-size: 0.8rem;
      font-family: inherit; line-height: 1.5;
      background: var(--rv-bg);
      border: 1px solid var(--rv-border);
      border-top: none;
      border-radius: 0 0 6px 6px;
      color: var(--rv-text); outline: none; overflow-y: auto;
      white-space: pre-wrap; word-wrap: break-word; cursor: text;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .notes-editor:focus {
      border-color: var(--rv-accent);
      box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
    }
    .notes-editor.save-error { border-color: var(--rv-danger); }
    .notes-editor.save-ok { border-color: var(--rv-success); }
    .conflict-toast {
      position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
      background: var(--rv-danger); color: #fff;
      padding: 0.6rem 1.2rem; border-radius: 8px;
      font-size: 0.8rem; font-weight: 500;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 9999; max-width: 90vw; text-align: center;
      animation: toast-in 0.25s ease;
    }
    @keyframes toast-in { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
    .notes-editor div + div { margin-top: 1.0em; min-height: 1.5em; }
    .notes-editor:empty::before {
      content: attr(data-placeholder); color: var(--rv-text-dim);
      opacity: 0.6; pointer-events: none; font-style: italic;
    }
    .notes-inline-link {
      color: var(--rv-accent); text-decoration: underline; text-underline-offset: 2px;
      cursor: pointer; font-weight: 500;
    }
    .notes-inline-link:hover { opacity: 0.8; }

    /* Rendered notes (readonly) */
    .notes-rendered {
      font-size: 0.8rem; color: var(--rv-text-secondary); line-height: 1.6;
      padding: 0.25rem 0;
    }
    .notes-rendered p { margin-bottom: 0.3rem; }
    .notes-rendered ul { padding-left: 1.25rem; margin-bottom: 0.3rem; }
    .notes-rendered li { margin-bottom: 0.15rem; }
    .notes-rendered a {
      color: var(--rv-link); text-decoration: underline; text-underline-offset: 2px;
    }
    .notes-rendered a:hover { opacity: 0.8; }

    /* Review item images */
    .review-images {
      margin-top: 0.75rem; padding-top: 0.6rem;
      border-top: 1px solid var(--rv-border-subtle);
    }
    .review-images-label {
      font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--rv-text-dim); margin-bottom: 0.4rem;
    }
    .review-image-drop {
      border: 1.5px dashed var(--rv-border); border-radius: 6px;
      padding: 0.5rem; min-height: 48px; transition: border-color 0.15s, background 0.15s;
      cursor: default; outline: none;
    }
    .review-image-drop:focus-within, .review-image-drop:focus,
    .review-image-drop.dragover {
      border-color: var(--rv-accent); background: rgba(37,99,235,0.04);
    }
    [data-theme="dark"] .review-image-drop:focus-within,
    [data-theme="dark"] .review-image-drop:focus,
    [data-theme="dark"] .review-image-drop.dragover { background: rgba(59,130,246,0.06); }
    .review-image-drop.uploading { opacity: 0.6; pointer-events: none; }
    .review-image-placeholder {
      display: flex; align-items: center; justify-content: center;
      font-size: 0.72rem; color: var(--rv-text-dim); padding: 0.75rem 0;
      font-style: italic; gap: 0.35rem;
    }
    .review-image-drop:focus .review-image-placeholder,
    .review-image-drop:focus-within .review-image-placeholder {
      color: var(--rv-accent);
    }
    .review-image-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 0.5rem;
    }
    .review-image-item { display: flex; flex-direction: column; gap: 0.2rem; }
    .review-image-thumb {
      position: relative; aspect-ratio: 4/3; overflow: hidden;
      border-radius: 4px; background: var(--rv-bg-tertiary);
      border: 1px solid var(--rv-border-subtle);
    }
    .review-image-thumb img {
      width: 100%; height: 100%; object-fit: cover; display: block; cursor: pointer;
    }
    .review-image-delete {
      position: absolute; top: 3px; right: 3px;
      width: 22px; height: 22px; border-radius: 50%;
      background: rgba(0,0,0,0.6); color: #fff; border: none;
      cursor: pointer; padding: 0;
      display: none; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .review-image-delete:hover { background: var(--rv-danger); }
    .review-image-item:hover .review-image-delete { display: flex; }
    .review-image-drag {
      position: absolute; top: 3px; left: 3px;
      width: 22px; height: 22px; border-radius: 4px;
      background: rgba(0,0,0,0.6); color: #fff;
      cursor: grab; padding: 0; z-index: 2;
      display: none; align-items: center; justify-content: center;
      user-select: none;
    }
    .review-image-drag:active { cursor: grabbing; }
    .review-image-item:hover .review-image-drag { display: flex; }
    .review-image-item.review-image-dragging { opacity: 0.4; }
    .review-image-item { cursor: default; }
    .review-image-caption {
      width: 100%; font-size: 0.68rem; font-family: inherit;
      color: var(--rv-text-secondary); background: transparent;
      border: 1px solid transparent; border-radius: 3px;
      padding: 0.15rem 0.3rem; outline: none;
      transition: border-color 0.15s, background 0.15s;
    }
    .review-image-caption::placeholder { color: var(--rv-text-dim); font-style: italic; }
    .review-image-caption:hover { border-color: var(--rv-border); }
    .review-image-caption:focus {
      border-color: var(--rv-accent); background: var(--rv-bg);
    }
    .review-image-caption-ro {
      font-size: 0.68rem; color: var(--rv-text-muted); padding: 0.1rem 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* Always-visible inline image thumbnails */
    .review-inline-images {
      padding: 0.5rem 1.25rem; border-top: 1px solid var(--rv-border-subtle);
    }
    .review-inline-images-label {
      display: block; font-size: 0.65rem; font-weight: 600;
      color: var(--rv-text-muted); text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 0.3rem;
    }
    .review-inline-images-row {
      display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center;
    }
    .review-inline-thumb {
      width: 80px; height: 60px; overflow: hidden; border-radius: 4px;
      background: var(--rv-bg-tertiary); border: 1px solid var(--rv-border-subtle);
      flex-shrink: 0;
    }
    .review-inline-thumb img {
      width: 100%; height: 100%; object-fit: cover; display: block; cursor: pointer;
    }
    .review-inline-thumb:hover { border-color: var(--rv-border-hover); }
    .review-inline-more {
      font-size: 0.7rem; color: var(--rv-text-dim); font-weight: 500;
    }

    /* Lightbox */
    .rv-lightbox-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.85);
      display: flex; align-items: center; justify-content: center;
      animation: rv-lb-in 0.2s ease;
    }
    @keyframes rv-lb-in { from { opacity: 0; } to { opacity: 1; } }
    .rv-lightbox-close {
      position: absolute; top: 1rem; right: 1rem;
      background: rgba(255,255,255,0.1); border: none; color: #fff;
      width: 36px; height: 36px; border-radius: 50%; font-size: 1.25rem;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background 0.15s; z-index: 2;
    }
    .rv-lightbox-close:hover { background: rgba(255,255,255,0.2); }
    .rv-lightbox-content {
      display: flex; flex-direction: column; align-items: center;
      max-width: 90vw; max-height: 90vh;
    }
    .rv-lightbox-content img {
      max-width: 90vw; max-height: 78vh; object-fit: contain;
      border-radius: 4px;
    }
    .rv-lightbox-caption {
      color: #fff; font-size: 0.85rem; margin-top: 0.75rem;
      text-align: center; max-width: 600px; opacity: 0.9;
    }
    .rv-lightbox-counter {
      color: rgba(255,255,255,0.5); font-size: 0.7rem; margin-top: 0.3rem;
    }
    .rv-lightbox-nav {
      position: absolute; top: 50%; transform: translateY(-50%);
      background: rgba(255,255,255,0.1); border: none; color: #fff;
      width: 44px; height: 44px; border-radius: 50%; font-size: 1.5rem;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: background 0.15s; z-index: 2;
    }
    .rv-lightbox-nav:hover { background: rgba(255,255,255,0.2); }
    .rv-lightbox-prev { left: 1rem; }
    .rv-lightbox-next { right: 1rem; }

    /* Empty state */
    .empty-state { text-align: center; color: var(--rv-text-dim); padding: 3rem 1rem; font-size: 0.9rem; }

    /* Mobile */
    @media (max-width: 768px) {
      .layout { flex-direction: column; }
      .sidebar {
        width: 100%; height: auto; position: static; flex-direction: column;
        border-right: none; border-bottom: 1px solid var(--rv-border);
      }
      .sidebar-title { padding: 0.75rem 1rem 0.25rem; }
      .sidebar-nav {
        flex-direction: row; overflow-x: auto; overflow-y: hidden;
        padding: 0 0.75rem 0.5rem; gap: 0.25rem;
      }
      .sidebar-footer { border-top: none; padding: 0.5rem 0.75rem; }
      .main { padding: 1rem; }
      .card-header { padding: 0.75rem 1rem; }
      .project-gantt { padding: 0.75rem 1rem; --gantt-label-col: 100px; }
      .gantt-label { font-size: 0.6rem; }
      .card-links { padding: 0.5rem 1rem; }
      .card-notes { padding: 0; }
      .notes-accordion { padding: 0.6rem 1rem; }
      .notes-panel { padding: 0 1rem 0.35rem; }
      .notes-feedback-row { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
  <script>
    (function(){
      var t = localStorage.getItem('rv-theme');
      if (t === 'dark') document.documentElement.setAttribute('data-theme','dark');
    })();
  </script>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-title">Reviews</div>
      <div class="sidebar-nav">
        ${navItems}
      </div>
      <div class="sidebar-footer">
        <span class="branding">WandiHub</span>
        <button class="theme-toggle" onclick="var d=document.documentElement;var isDark=d.getAttribute('data-theme')==='dark';d.setAttribute('data-theme',isDark?'':'dark');localStorage.setItem('rv-theme',isDark?'light':'dark');this.innerHTML=isDark?'<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot;><path d=&quot;M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z&quot;/></svg>':'<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot;><circle cx=&quot;12&quot; cy=&quot;12&quot; r=&quot;5&quot;/><line x1=&quot;12&quot; y1=&quot;1&quot; x2=&quot;12&quot; y2=&quot;3&quot;/><line x1=&quot;12&quot; y1=&quot;21&quot; x2=&quot;12&quot; y2=&quot;23&quot;/><line x1=&quot;4.22&quot; y1=&quot;4.22&quot; x2=&quot;5.64&quot; y2=&quot;5.64&quot;/><line x1=&quot;18.36&quot; y1=&quot;18.36&quot; x2=&quot;19.78&quot; y2=&quot;19.78&quot;/><line x1=&quot;1&quot; y1=&quot;12&quot; x2=&quot;3&quot; y2=&quot;12&quot;/><line x1=&quot;21&quot; y1=&quot;12&quot; x2=&quot;23&quot; y2=&quot;12&quot;/><line x1=&quot;4.22&quot; y1=&quot;19.78&quot; x2=&quot;5.64&quot; y2=&quot;18.36&quot;/><line x1=&quot;18.36&quot; y1=&quot;5.64&quot; x2=&quot;19.78&quot; y2=&quot;4.22&quot;/></svg>'">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>
    </nav>
    <main class="main">
      ${body}
    </main>
  </div>
  <script>
    document.querySelectorAll('[data-nav-toggle]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var items = btn.nextElementSibling;
        var isOpen = items.style.display !== 'none';
        items.style.display = isOpen ? 'none' : 'block';
        btn.classList.toggle('open', !isOpen);
      });
    });
  </script>
</body>
</html>`
}

// ============ REVIEW SNAPSHOT GENERATION ============

const getISOWeekStr = (d: Date = new Date()) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

const statusLabels: Record<string, string> = { active: 'Active', review: 'In Review', done: 'Done', blocked: 'Blocked', pending: 'Pending', archived: 'Archived' }

const generateReviewSnapshot = async (week: string) => {
  // Get the most recent review
  const latestReview = await get('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 1') as any
  if (!latestReview) {
    console.log('Review snapshot skipped: no reviews exist')
    return null
  }

  // Get review items with project data
  const items = await all(
    `SELECT ri.*, p.name as project_name, p.status, p.designers, p.businessLine,
            p.startDate, p.endDate, p.estimatedHours,
            p.deckName, p.deckLink, p.prdName, p.prdLink, p.briefName, p.briefLink,
            p.figmaLink, p.customLinks
     FROM review_items ri
     LEFT JOIN projects p ON ri.project_id = p.id
     WHERE ri.review_id = ?
     ORDER BY ri.rank ASC`, [latestReview.id]
  )

  // Get all active projects
  const activeProjects = await all(
    `SELECT id, name, status, designers, businessLine, startDate, endDate, estimatedHours,
            deckName, deckLink, prdName, prdLink, briefName, briefLink, figmaLink, customLinks
     FROM projects WHERE status IN ('active', 'blocked')
     ORDER BY name`
  )

  const sizeMap: Record<number, string> = { 35: 'XXS', 70: 'XS', 105: 'S', 175: 'M', 280: 'L', 455: 'XL', 910: 'XXL' }

  const parseDesigners = (d: any) => {
    if (!d) return []
    try { return JSON.parse(d) } catch { return [] }
  }
  const parseBL = (bl: any) => {
    if (!bl) return ['Unassigned']
    try { const p = JSON.parse(bl); return Array.isArray(p) ? p : [bl] } catch { return [bl] }
  }
  const parseLinks = (p: any) => {
    const links: { name: string; url: string }[] = []
    if (p.deckLink) links.push({ name: p.deckName || 'Deck', url: p.deckLink })
    if (p.prdLink) links.push({ name: p.prdName || 'PRD', url: p.prdLink })
    if (p.briefLink) links.push({ name: p.briefName || 'Brief', url: p.briefLink })
    if (p.figmaLink) links.push({ name: 'Figma', url: p.figmaLink })
    try { const cl = JSON.parse(p.customLinks || '[]'); links.push(...cl) } catch { /* ignore */ }
    return links
  }
  const formatDate = (d: string) => {
    if (!d) return null
    const dt = new Date(d + 'T00:00:00')
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // Build review items for snapshot
  const reviewItems = (items as any[]).map(item => {
    const designers = parseDesigners(item.designers).map((d: string) => d.split(' ')[0])
    const bls = parseBL(item.businessLine)
    const links = parseLinks(item)
    const tshirt = sizeMap[item.estimatedHours || 0]
    const sizeLabel = tshirt ? `${tshirt} · ${item.estimatedHours}h` : item.estimatedHours ? `${item.estimatedHours}h` : null
    return {
      project_id: item.project_id,
      project_name: item.project_name || 'Unknown',
      status: item.status,
      designers,
      businessLines: bls,
      estimatedHours: item.estimatedHours,
      sizeLabel,
      endDate: item.endDate,
      links,
      notes: item.notes || null,
    }
  })

  // Build active projects for snapshot
  const activeItems = (activeProjects as any[]).map(p => {
    const designers = parseDesigners(p.designers).map((d: string) => d.split(' ')[0])
    const bls = parseBL(p.businessLine)
    const links = parseLinks(p)
    return {
      project_id: p.id,
      project_name: p.name,
      status: p.status,
      designers,
      businessLines: bls,
      endDate: p.endDate,
      links,
    }
  })

  // Plain text
  const reviewByBL: Record<string, typeof reviewItems> = {}
  for (const item of reviewItems) {
    for (const bl of item.businessLines) {
      if (!reviewByBL[bl]) reviewByBL[bl] = []
      reviewByBL[bl].push(item)
    }
  }

  const activeByBL: Record<string, typeof activeItems> = {}
  for (const item of activeItems) {
    for (const bl of item.businessLines) {
      if (!activeByBL[bl]) activeByBL[bl] = []
      activeByBL[bl].push(item)
    }
  }

  const plainLines = [
    `W&I OPEN CRITIQUES — ${week}`,
    `Projects selected for stakeholder and peer design review`,
    `${reviewItems.length} project${reviewItems.length !== 1 ? 's' : ''} in review`,
    '',
    ...Object.entries(reviewByBL).sort(([a], [b]) => a.localeCompare(b)).flatMap(([bl, projs]) => [
      bl.toUpperCase(),
      ...projs.map(p => {
        const lines = [`  • ${p.project_name}`, `    ${p.designers.join(', ') || 'unassigned'} · ${p.sizeLabel || 'no estimate'} · Due: ${formatDate(p.endDate) || 'no due date'}${p.links.length ? ` · ${p.links.map(l => l.name).join(', ')}` : ''}`]
        if (p.notes) lines.push(`    Notes: ${p.notes.replace(/<[^>]+>/g, '')}`)
        return lines.join('\n')
      }),
      '',
    ]),
    '─'.repeat(40),
    '',
    `ALL ACTIVE PROJECTS — ${activeItems.length} project${activeItems.length !== 1 ? 's' : ''}`,
    '',
    ...Object.entries(activeByBL).sort(([a], [b]) => a.localeCompare(b)).flatMap(([bl, projs]) => [
      bl.toUpperCase(),
      ...projs.map(p => `  • ${p.project_name} — ${statusLabels[p.status] || p.status} · ${p.designers.join(', ') || 'unassigned'} · Due: ${formatDate(p.endDate) || 'no due date'}${p.links.length ? ` · ${p.links.map(l => l.name).join(', ')}` : ''}`),
      '',
    ]),
  ]

  const dataJson = JSON.stringify({
    week,
    reviewId: latestReview.id,
    reviewTitle: latestReview.title,
    reviewItems,
    activeItems,
  })

  await run(
    `INSERT OR REPLACE INTO review_snapshots (id, week, generated_at, plain_text, data_json) VALUES (?, ?, datetime('now'), ?, ?)`,
    [week, week, plainLines.join('\n'), dataJson]
  )

  console.log(`Review snapshot generated for ${week}`)
  return { week, plainText: plainLines.join('\n'), dataJson }
}

// ============ REVIEW SNAPSHOT API ============

router.get('/api/review-snapshots', async (_req, res) => {
  try {
    const snapshots = await all('SELECT id, week, generated_at FROM review_snapshots ORDER BY week DESC')
    res.json(snapshots)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/api/review-snapshots/:week', async (req, res) => {
  try {
    const snapshot = await get('SELECT * FROM review_snapshots WHERE week = ?', [req.params.week])
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' })
    res.json(snapshot)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/api/review-snapshots/generate', async (req, res) => {
  try {
    const week = (req.body.week as string) || getISOWeekStr()
    const result = await generateReviewSnapshot(week)
    if (!result) return res.status(404).json({ error: 'No reviews to snapshot' })
    res.json(result)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ TUESDAY 5PM ET CRON ============

let lastReviewSnapshotCheck = ''

// Post-review rollover: once a review's scheduled date is 36+ hours in the
// past, any project still stuck in 'review' status should fall back to
// 'active'. Runs as part of the review cron ticker.
//
// A review_date of '2026-04-22' is interpreted as the END of that day in
// Eastern Time — i.e. 2026-04-22T23:59:59 America/New_York — since the
// meeting itself happens on that day. 36h after that is the trigger.
export const runReviewRollover = async () => {
  try {
    const rows = await all(
      `SELECT DISTINCT ri.project_id, r.id AS review_id, r.review_date, r.title AS review_title
       FROM review_items ri
       JOIN reviews r ON r.id = ri.review_id
       JOIN projects p ON p.id = ri.project_id
       WHERE p.status = 'review'
         AND r.review_date IS NOT NULL AND r.review_date != ''`
    ) as any[]
    if (!rows || rows.length === 0) return
    const now = Date.now()
    // Group per project so we flip only once even if the project sits on
    // multiple reviews. Flip requires that ALL the project's review_items'
    // reviews have passed the 36h cutoff (otherwise an upcoming re-review
    // would keep it "in review" correctly).
    const byProject = new Map<string, { allPast: boolean; projectId: string }>()
    for (const row of rows) {
      // Parse "YYYY-MM-DD" as end-of-day Eastern. Approximation: ET is UTC-5
      // (standard) or UTC-4 (DST). We use a conservative UTC-4 offset which
      // gives us the *earlier* trigger — matches "36 hours after" intent.
      const [y, m, d] = row.review_date.split('-').map((n: string) => parseInt(n, 10))
      if (!y || !m || !d) continue
      const endOfDayUtcMs = Date.UTC(y, m - 1, d, 23 + 4, 59, 59) // 23:59 ET ≈ 03:59 UTC next day
      const cutoffMs = endOfDayUtcMs + 36 * 60 * 60 * 1000
      const past = now >= cutoffMs
      const existing = byProject.get(row.project_id)
      if (!existing) byProject.set(row.project_id, { allPast: past, projectId: row.project_id })
      else if (!past) existing.allPast = false
    }
    let flipped = 0
    for (const { projectId, allPast } of byProject.values()) {
      if (!allPast) continue
      const proj = await get('SELECT name, status FROM projects WHERE id = ?', [projectId]) as any
      if (!proj || proj.status !== 'review') continue // race / already changed
      await run("UPDATE projects SET status = 'active', updatedAt = datetime('now') WHERE id = ?", [projectId])
      // System-initiated → no initiator to exclude. Fan out to every assigned designer.
      const activityId = await logActivity('project', 'update', proj.name || projectId, null, 'Auto-reverted to active after review')
      const recipients = await recipientsForProject(projectId, null)
      await pinRecipients(activityId, recipients)
      flipped++
    }
    if (flipped > 0) {
      await updateDbVersion()
      console.log(`Post-review rollover: flipped ${flipped} project(s) back to active`)
    }
  } catch (e: any) {
    console.error('Review rollover error:', e.message)
  }
}

export const startReviewCron = () => {
  // Run the rollover once at boot so we catch up anything missed while the
  // server was down.
  runReviewRollover().catch(e => console.error('Initial rollover failed:', e))

  let tick = 0
  setInterval(() => {
    const now = new Date()
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay() // 2 = Tuesday
    const hour = et.getHours()
    const minute = et.getMinutes()
    const checkKey = `${et.getFullYear()}-${et.getMonth()}-${et.getDate()}-${hour}-${minute}`

    if (day === 2 && hour === 17 && minute === 0 && checkKey !== lastReviewSnapshotCheck) {
      lastReviewSnapshotCheck = checkKey
      const week = getISOWeekStr(now)
      generateReviewSnapshot(week).catch(e => console.error('Auto review snapshot failed:', e))
    }

    // Rollover every ~5 minutes (10 ticks × 30s) — often enough that a
    // designer who logs in shortly after the 36h mark sees the flip without
    // having to refresh a second time.
    tick = (tick + 1) % 10
    if (tick === 0) runReviewRollover().catch(e => console.error('Rollover tick failed:', e))
  }, 30_000)
  console.log('Review snapshot cron started (Tuesday 5pm ET); rollover check every 5m')
}

export default router;

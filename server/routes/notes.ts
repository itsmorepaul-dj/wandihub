import express from 'express';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { homedir } from 'os';
import { run, get, all, upsertNote } from '../db.js';
import { updateDbVersion } from '../version.js';
import { getNameVariants } from '../../search.js';

const router = express.Router();

const GEMINI_NOTES_DB = process.env.GEMINI_NOTES_DB || path.join(homedir(), '.openclaw', 'workspace', 'data', 'gemini-notes.db');
const WORK_KB_DB = process.env.WORK_KB_DB || path.join(homedir(), '.openclaw', 'workspace', 'kb', 'work', 'data', 'work-kb.db');

// /notes/sync and /kb/* depend on Paul's local ~/.openclaw workspace (Gemini
// note exports + a Python ingestion script). None of that exists inside the
// Hatch container. Routes are mounted but short-circuit to 404 unless the
// host explicitly opts in via NOTES_SYNC_ENABLED=true.
const localSyncEnabled = (): boolean =>
  process.env.NOTES_SYNC_ENABLED === 'true' || process.env.NOTES_SYNC_ENABLED === '1'
const guardLocalSync: express.RequestHandler = (_req, res, next) => {
  if (!localSyncEnabled()) return res.status(404).json({ error: 'Not available on this host' })
  next()
}

function noteFingerprint(sourceFilename: string, driveUrl: string): string | null {
  const raw = (sourceFilename || '').trim().toLowerCase() || (driveUrl || '').trim().toLowerCase()
  return raw || null
}

// ============ NOTES ============

router.get('/notes/by-project/:projectId', async (req, res) => {
  try {
    const notes = await all(
      `SELECT n.* FROM notes n
       JOIN note_project_links npl ON n.id = npl.note_id
       WHERE npl.project_id = ? AND (n.hidden = 0 OR n.hidden IS NULL)
       ORDER BY n.date DESC`,
      [req.params.projectId]
    )
    res.json(notes)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/notes/by-person/:teamId', async (req, res) => {
  try {
    const notes = await all(
      `SELECT n.* FROM notes n
       JOIN note_people_links npl ON n.id = npl.note_id
       WHERE npl.team_id = ? AND (n.hidden = 0 OR n.hidden IS NULL)
       ORDER BY n.date DESC`,
      [req.params.teamId]
    )
    res.json(notes)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/notes', async (req, res) => {
  try {
    const includeHidden = req.query.includeHidden === 'true'
    const hiddenFilter = includeHidden ? '' : 'WHERE hidden = 0 OR hidden IS NULL'
    const notes = await all(`SELECT * FROM notes ${hiddenFilter} ORDER BY date DESC, created_at DESC`)
    const projectLinks = await all('SELECT * FROM note_project_links')
    const peopleLinks = await all('SELECT * FROM note_people_links')

    const projectMap: Record<string, string[]> = {}
    for (const link of projectLinks as any[]) {
      if (!projectMap[link.note_id]) projectMap[link.note_id] = []
      projectMap[link.note_id].push(link.project_id)
    }

    const peopleMap: Record<string, string[]> = {}
    for (const link of peopleLinks as any[]) {
      if (!peopleMap[link.note_id]) peopleMap[link.note_id] = []
      peopleMap[link.note_id].push(link.team_id)
    }

    res.json((notes as any[]).map(n => {
      const linkedProjectIds = projectMap[n.id]?.length > 0
        ? projectMap[n.id]
        : (n.linkedProjectIds ? JSON.parse(n.linkedProjectIds) : [])
      const linkedTeamIds = peopleMap[n.id]?.length > 0
        ? peopleMap[n.id]
        : (n.linkedTeamIds ? JSON.parse(n.linkedTeamIds) : [])

      return { ...n, linkedProjectIds, linkedTeamIds }
    }))
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/notes/:id', async (req, res) => {
  try {
    const note = await get('SELECT * FROM notes WHERE id = ?', [req.params.id])
    if (!note) return res.status(404).json({ error: 'Note not found' })

    const projectLinks = await all('SELECT project_id FROM note_project_links WHERE note_id = ?', [req.params.id])
    const peopleLinks = await all('SELECT team_id FROM note_people_links WHERE note_id = ?', [req.params.id])

    res.json({
      ...note,
      linkedProjectIds: (projectLinks as any[]).map(l => l.project_id),
      linkedTeamIds: (peopleLinks as any[]).map(l => l.team_id)
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/notes/:id/links', async (req, res) => {
  try {
    const noteId = req.params.id
    const { projectIds = [], personIds = [] } = req.body

    const note = await get('SELECT id FROM notes WHERE id = ?', [noteId])
    if (!note) return res.status(404).json({ error: 'Note not found' })

    for (const projectId of projectIds) {
      await run('INSERT OR IGNORE INTO note_project_links (note_id, project_id) VALUES (?, ?)', [noteId, projectId])
    }
    for (const personId of personIds) {
      await run('INSERT OR IGNORE INTO note_people_links (note_id, team_id) VALUES (?, ?)', [noteId, personId])
    }

    const projectLinks = await all('SELECT project_id FROM note_project_links WHERE note_id = ?', [noteId])
    const peopleLinks = await all('SELECT team_id FROM note_people_links WHERE note_id = ?', [noteId])

    res.json({
      linkedProjectIds: (projectLinks as any[]).map(l => l.project_id),
      linkedTeamIds: (peopleLinks as any[]).map(l => l.team_id)
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/notes/:id/links', async (req, res) => {
  try {
    const noteId = req.params.id
    const { projectIds = [], personIds = [] } = req.body

    for (const projectId of projectIds) {
      await run('DELETE FROM note_project_links WHERE note_id = ? AND project_id = ?', [noteId, projectId])
    }
    for (const personId of personIds) {
      await run('DELETE FROM note_people_links WHERE note_id = ? AND team_id = ?', [noteId, personId])
    }

    const projectLinks = await all('SELECT project_id FROM note_project_links WHERE note_id = ?', [noteId])
    const peopleLinks = await all('SELECT team_id FROM note_people_links WHERE note_id = ?', [noteId])

    res.json({
      linkedProjectIds: (projectLinks as any[]).map(l => l.project_id),
      linkedTeamIds: (peopleLinks as any[]).map(l => l.team_id)
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/notes/:id/hide', async (req, res) => {
  try {
    const { pin } = req.body
    if (pin !== '8432') {
      return res.status(401).json({ error: 'Invalid PIN' })
    }

    const noteId = req.params.id
    const note = await get('SELECT * FROM notes WHERE id = ?', [noteId]) as any
    if (!note) return res.status(404).json({ error: 'Note not found' })

    await run('UPDATE notes SET hidden = 1, hidden_at = datetime("now") WHERE id = ?', [noteId])

    const fp = noteFingerprint(note.source_filename, note.drive_url)
    if (fp) {
      await run(
        'INSERT OR REPLACE INTO hidden_note_fingerprints (fingerprint, original_note_id, hidden_at) VALUES (?, ?, datetime("now"))',
        [fp, noteId]
      )
    }

    const updatedNote = await get('SELECT * FROM notes WHERE id = ?', [noteId])
    res.json(updatedNote)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/notes/:id/restore', async (req, res) => {
  try {
    const noteId = req.params.id
    const note = await get('SELECT * FROM notes WHERE id = ?', [noteId]) as any
    if (!note) return res.status(404).json({ error: 'Note not found' })

    await run('UPDATE notes SET hidden = 0, hidden_at = NULL WHERE id = ?', [noteId])

    const fp = noteFingerprint(note.source_filename, note.drive_url)
    if (fp) {
      await run('DELETE FROM hidden_note_fingerprints WHERE fingerprint = ?', [fp])
    }

    const updatedNote = await get('SELECT * FROM notes WHERE id = ?', [noteId])
    res.json(updatedNote)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.delete('/notes/:id', async (req, res) => {
  try {
    const noteId = req.params.id
    const note = await get('SELECT id FROM notes WHERE id = ?', [noteId])
    if (!note) return res.status(404).json({ error: 'Note not found' })

    await run('DELETE FROM note_project_links WHERE note_id = ?', [noteId])
    await run('DELETE FROM note_people_links WHERE note_id = ?', [noteId])
    await run('DELETE FROM notes WHERE id = ?', [noteId])

    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.post('/notes', async (req, res) => {
  try {
    const { id, source_id, source_filename, title, date, content_preview, projects_raw, people_raw, drive_url, source_created_at, next_steps, details, attachments } = req.body

    if (!id || !title) {
      return res.status(400).json({ error: 'id and title required' })
    }

    const existing = await get('SELECT id FROM notes WHERE id = ?', [id])
    if (existing) {
      return res.status(409).json({ error: 'Note already exists', id })
    }

    await upsertNote({
      id, source_id, source_filename, title, date, content_preview,
      people_raw, projects_raw, drive_url, source_created_at,
      next_steps, details, attachments,
    })

    const newNote = await get('SELECT * FROM notes WHERE id = ?', [id])
    res.status(201).json(newNote)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.put('/notes/:id', async (req, res) => {
  try {
    const noteId = req.params.id
    const { title, date, content_preview, projects_raw, people_raw, linkedProjectIds, linkedTeamIds } = req.body

    const note = await get('SELECT id FROM notes WHERE id = ?', [noteId])
    if (!note) return res.status(404).json({ error: 'Note not found' })

    const updates: string[] = []
    const params: any[] = []

    if (title !== undefined) { updates.push('title = ?'); params.push(title) }
    if (date !== undefined) { updates.push('date = ?'); params.push(date) }
    if (content_preview !== undefined) { updates.push('content_preview = ?'); params.push(content_preview) }
    if (projects_raw !== undefined) { updates.push('projects_raw = ?'); params.push(projects_raw) }
    if (people_raw !== undefined) { updates.push('people_raw = ?'); params.push(people_raw) }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')")
      params.push(noteId)
      await run(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`, params)
    }

    if (linkedProjectIds !== undefined) {
      await run('DELETE FROM note_project_links WHERE note_id = ?', [noteId])
      for (const projectId of linkedProjectIds) {
        await run('INSERT OR IGNORE INTO note_project_links (note_id, project_id) VALUES (?, ?)', [noteId, projectId])
      }
    }

    if (linkedTeamIds !== undefined) {
      await run('DELETE FROM note_people_links WHERE note_id = ?', [noteId])
      for (const personId of linkedTeamIds) {
        await run('INSERT OR IGNORE INTO note_people_links (note_id, team_id) VALUES (?, ?)', [noteId, personId])
      }
    }

    const updatedNote = await get('SELECT * FROM notes WHERE id = ?', [noteId])
    const projectLinks = await all('SELECT project_id FROM note_project_links WHERE note_id = ?', [noteId])
    const peopleLinks = await all('SELECT team_id FROM note_people_links WHERE note_id = ?', [noteId])

    res.json({
      ...updatedNote,
      linkedProjectIds: (projectLinks as any[]).map(l => l.project_id),
      linkedTeamIds: (peopleLinks as any[]).map(l => l.team_id)
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ============ NOTES SYNC ============

router.post('/notes/sync', guardLocalSync, async (req, res) => {
  function cleanContentPreview(raw: string): string {
    if (!raw) return ''
    let text = raw
    text = text.replace(/^\uFEFF/, '').replace(/\u200B/g, '')
    const trimmed = text.trim()
    const hasNoteHeader = /^📝\s*Notes\b/i.test(trimmed)
    const startsWithDate = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i.test(trimmed)
    if (!hasNoteHeader && !startsWithDate) return raw
    const attachIdx = text.search(/^Attachments?\b/im)
    if (attachIdx >= 0) {
      let after = text.substring(attachIdx)
      after = after.replace(/^Attachments?\b[^\n]*\n?/, '')
      after = after.replace(/^(\s*\n)+/, '')
      if (/^[^\n.]{1,100}\n/.test(after)) {
        after = after.replace(/^[^\n]*\n/, '')
      }
      after = after.replace(/^(\s*\n)+/, '').trim()
      if (after.length > 20) return after
    }
    const invitedIdx = text.search(/^Invited\b/im)
    if (invitedIdx >= 0) {
      let after = text.substring(invitedIdx)
      after = after.replace(/^Invited\b[^\n]*\n?/, '')
      while (/^[^\n.]{0,150}\n/.test(after) && !/^(Attachments?|Details?|The |A |In |On |During )/i.test(after.trim())) {
        after = after.replace(/^[^\n]*\n/, '')
      }
      after = after.replace(/^\s*\n/g, '').trim()
      if (after.length > 20) return after
    }
    return raw
  }

  try {
    if (!fs.existsSync(GEMINI_NOTES_DB)) {
      const existingNotes = await all('SELECT COUNT(*) as count FROM notes') as any[]
      return res.json({
        success: true,
        message: 'No external Gemini DB found, notes already in DCC',
        stats: { total: existingNotes[0]?.count || 0, inserted: 0, updated: 0 }
      })
    }

    const geminiDb = new sqlite3.Database(GEMINI_NOTES_DB)
    const geminiAll = (sql: string, params: any[] = []) => new Promise<any[]>((resolve, reject) => {
      geminiDb.all(sql, params, (err, rows) => {
        if (err) reject(err)
        else resolve(rows)
      })
    })

    const geminiNotes = await geminiAll('SELECT * FROM notes ORDER BY id')
    geminiDb.close()

    const dccProjects = await all('SELECT id, name FROM projects') as { id: string; name: string }[]
    const dccTeam = await all('SELECT id, name FROM team') as { id: string; name: string }[]

    let inserted = 0
    let updated = 0
    let projectLinksCreated = 0
    let peopleLinksCreated = 0

    for (const gNote of geminiNotes as any[]) {
      const noteId = `gemini_${gNote.id}`

      let title = gNote.title || ''
      if (!title || /^\w{3}\s\d{1,2},\s\d{4}$/.test(title)) {
        const fnMatch = gNote.filename?.match(/^(.+?)\s*-\s*\d{4}/) || gNote.filename?.match(/^Notes_\s*"(.+?)"/)
        if (fnMatch) {
          title = fnMatch[1].replace(/_/g, ' ').replace(/Notes\s*"/, '').replace(/"$/, '').trim()
        } else if (gNote.filename) {
          title = gNote.filename.replace(/\.pdf$/i, '').replace(/_/g, ' ').trim()
        }
      }

      const existing = await get('SELECT id, hidden FROM notes WHERE id = ?', [noteId]) as any
      if (existing) {
        if (!existing.hidden) {
          await run(
            `UPDATE notes SET title = ?, date = ?, content_preview = ?, people_raw = ?, projects_raw = ?,
             drive_url = ?, source_filename = ?, source_created_at = ?, next_steps = ?, details = ?, attachments = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [title, gNote.date || '', cleanContentPreview(gNote.content_preview || ''), gNote.people || '',
             gNote.projects || '', gNote.drive_url || '', gNote.filename || '',
             gNote.created_at || '', gNote.next_steps || '', gNote.details || '', gNote.attachments || '', noteId]
          )
        }
        updated++
      } else {
        const fp = noteFingerprint(gNote.filename || '', gNote.drive_url || '')
        const isBlocked = fp ? await get('SELECT fingerprint FROM hidden_note_fingerprints WHERE fingerprint = ?', [fp]) : null

        await upsertNote({
          id: noteId, source_id: gNote.id, source_filename: gNote.filename || '', title,
          date: gNote.date || '', content_preview: cleanContentPreview(gNote.content_preview || ''),
          people_raw: gNote.people || '', projects_raw: gNote.projects || '',
          drive_url: gNote.drive_url || '', source_created_at: gNote.created_at || '',
          next_steps: gNote.next_steps || '', details: gNote.details || '', attachments: gNote.attachments || '',
          hidden: isBlocked ? 1 : 0, hidden_at: isBlocked ? new Date().toISOString() : null,
        })
        inserted++
      }

      await run('DELETE FROM note_project_links WHERE note_id = ?', [noteId])
      await run('DELETE FROM note_people_links WHERE note_id = ?', [noteId])

      const noteProjects = (gNote.projects || '').split(',').map((p: string) => p.trim()).filter(Boolean)
      for (const noteProject of noteProjects) {
        const npLower = noteProject.toLowerCase()
        for (const dccProject of dccProjects) {
          const dccLower = dccProject.name.toLowerCase()
          if (dccLower.includes(npLower) || npLower.includes(dccLower) ||
              npLower.split(/\s+/).every(word => dccLower.includes(word))) {
            await run('INSERT OR IGNORE INTO note_project_links (note_id, project_id) VALUES (?, ?)', [noteId, dccProject.id])
            projectLinksCreated++
          }
        }
      }

      const peopleRaw = gNote.people || ''
      const searchText = `${peopleRaw} ${gNote.content_preview || ''} ${gNote.filename || ''}`
      for (const member of dccTeam) {
        const textLower = searchText.toLowerCase()
        const nameVariants = getNameVariants(member.name)
        let matched = false

        for (const variant of nameVariants) {
          const nameParts = variant.split(/\s+/)
          const firstName = nameParts[0]
          const lastName = nameParts[nameParts.length - 1]

          if (textLower.includes(variant) ||
              (firstName && lastName && textLower.includes(firstName) && textLower.includes(lastName))) {
            matched = true
            break
          }
        }

        if (matched) {
          await run('INSERT OR IGNORE INTO note_people_links (note_id, team_id) VALUES (?, ?)', [noteId, member.id])
          peopleLinksCreated++
        }
      }
    }

    await updateDbVersion()
    res.json({
      success: true,
      stats: { total: geminiNotes.length, inserted, updated, projectLinksCreated, peopleLinksCreated }
    })
  } catch (e: any) {
    console.error('Notes sync error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ============ KNOWLEDGE BASE ============

const getKbDb = () => {
  try {
    const kbDb = new sqlite3.Database(WORK_KB_DB);
    const kbAll = (sql: string, params: any[] = []) => new Promise<any[]>((resolve, reject) => {
      kbDb.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    const kbGet = (sql: string, params: any[] = []) => new Promise<any>((resolve, reject) => {
      kbDb.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    return { db: kbDb, all: kbAll, get: kbGet };
  } catch (e) {
    return null;
  }
};

router.get('/notes/:id/full-content', guardLocalSync, async (req, res) => {
  try {
    const kb = getKbDb()
    if (!kb) return res.status(503).json({ error: 'Work KB not available' })
    const source = await kb.get('SELECT content, content_preview FROM sources WHERE source_id = ?', [req.params.id])
    kb.db.close()

    if (!source) return res.status(404).json({ error: 'Full content not found' })
    res.json({ content: (source as any).content || (source as any).content_preview || '' })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

router.get('/kb/search', guardLocalSync, async (req, res) => {
  const { q, project, person, limit: limitStr } = req.query as { q?: string; project?: string; person?: string; limit?: string };
  if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

  const limit = parseInt(limitStr || '10', 10);
  const kb = getKbDb();
  if (!kb) return res.status(503).json({ error: 'Work KB not available' });

  try {
    const ftsQuery = q.replace(/"/g, '""');

    let sourceResults = await kb.all(`
      SELECT s.source_id, s.title, s.date, s.content_preview, s.people,
             s.projects, s.drive_url, s.content_type
      FROM sources_fts fts
      JOIN sources s ON fts.rowid = s.id
      WHERE sources_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, [ftsQuery, limit * 3]);

    if (project) {
      const pLower = project.toLowerCase();
      sourceResults = sourceResults.filter((r: any) => (r.projects || '').toLowerCase().includes(pLower));
    }
    if (person) {
      const personLower = person.toLowerCase();
      sourceResults = sourceResults.filter((r: any) => (r.people || '').toLowerCase().includes(personLower));
    }

    const chunkResults = await kb.all(`
      SELECT c.source_id, c.content as chunk, c.chunk_index,
             s.title, s.date, s.people, s.projects, s.drive_url
      FROM chunks_fts cfts
      JOIN chunks c ON cfts.rowid = c.id
      JOIN sources s ON c.source_id = s.source_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, [ftsQuery, limit]);

    const seen = new Set<string>();
    const results: any[] = [];

    for (const r of sourceResults.slice(0, limit)) {
      results.push({ ...r, match_type: 'source' });
      seen.add(r.source_id);
    }
    for (const r of chunkResults) {
      if (!seen.has(r.source_id)) {
        results.push({ ...r, match_type: 'chunk' });
        seen.add(r.source_id);
      }
    }

    kb.db.close();
    res.json({ query: q, results: results.slice(0, limit), total: results.length });
  } catch (e: any) {
    kb.db.close();
    console.error('KB search error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/kb/stats', guardLocalSync, async (_req, res) => {
  const kb = getKbDb();
  if (!kb) return res.status(503).json({ error: 'Work KB not available' });

  try {
    const sourceCount = await kb.get('SELECT COUNT(*) as count FROM sources');
    const chunkCount = await kb.get('SELECT COUNT(*) as count FROM chunks');
    const dateRange = await kb.get("SELECT MIN(date) as earliest, MAX(date) as latest FROM sources WHERE date IS NOT NULL AND date != ''");
    const projects = await kb.all("SELECT DISTINCT projects FROM sources WHERE projects IS NOT NULL AND projects != ''");

    const uniqueProjects = new Set<string>();
    for (const row of projects) {
      for (const p of (row as any).projects.split(',')) {
        const trimmed = p.trim();
        if (trimmed) uniqueProjects.add(trimmed);
      }
    }

    kb.db.close();
    res.json({
      sources: sourceCount?.count || 0,
      chunks: chunkCount?.count || 0,
      projects: Array.from(uniqueProjects).sort(),
      dateRange: { earliest: dateRange?.earliest, latest: dateRange?.latest }
    });
  } catch (e: any) {
    kb.db.close();
    console.error('KB stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/kb/recent', guardLocalSync, async (req, res) => {
  const { limit: limitStr, project, person } = req.query as { limit?: string; project?: string; person?: string };
  const limit = parseInt(limitStr || '20', 10);
  const kb = getKbDb();
  if (!kb) return res.status(503).json({ error: 'Work KB not available' });

  try {
    let rows = await kb.all(`
      SELECT source_id, title, date, content_preview, people, projects,
             drive_url, content_type, ingested_at
      FROM sources
      ORDER BY date DESC, ingested_at DESC
      LIMIT ?
    `, [limit * 3]);

    if (project) {
      const pLower = project.toLowerCase();
      rows = rows.filter((r: any) => (r.projects || '').toLowerCase().includes(pLower));
    }
    if (person) {
      const personLower = person.toLowerCase();
      rows = rows.filter((r: any) => (r.people || '').toLowerCase().includes(personLower));
    }

    kb.db.close();
    res.json({ results: rows.slice(0, limit) });
  } catch (e: any) {
    kb.db.close();
    console.error('KB recent error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/kb/source/:sourceId', guardLocalSync, async (req, res) => {
  const kb = getKbDb();
  if (!kb) return res.status(503).json({ error: 'Work KB not available' });

  try {
    const source = await kb.get('SELECT * FROM sources WHERE source_id = ?', [req.params.sourceId]);
    if (!source) {
      kb.db.close();
      return res.status(404).json({ error: 'Source not found' });
    }

    const chunks = await kb.all(
      'SELECT chunk_index, content FROM chunks WHERE source_id = ? ORDER BY chunk_index',
      [req.params.sourceId]
    );

    kb.db.close();
    res.json({ ...source, chunks });
  } catch (e: any) {
    kb.db.close();
    console.error('KB source error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/kb/sync', guardLocalSync, async (_req, res) => {
  try {
    const { execSync } = require('child_process');
    const scriptPath = path.join(homedir(), '.openclaw', 'workspace', 'kb', 'work', 'scripts', 'ingest_gemini.py');
    const result = execSync(`python3 "${scriptPath}"`, {
      timeout: 120000,
      encoding: 'utf-8',
      env: { ...process.env, GEMINI_NOTES_DB }
    });

    const lines = result.trim().split('\n');
    const jsonLine = lines[lines.length - 1];
    let stats;
    try { stats = JSON.parse(jsonLine); } catch { stats = { raw_output: result.trim() }; }

    res.json({ success: true, stats });
  } catch (e: any) {
    console.error('KB sync error:', e);
    res.status(500).json({ error: e.message || 'KB sync failed' });
  }
});

export default router;

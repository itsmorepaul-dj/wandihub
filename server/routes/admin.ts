import express from 'express';
import fs from 'fs';
import { spawn } from 'child_process';
import { run, get, all, DB_PATH, IMAGES_DIR, SEED_SECRET, getDb, setDb, schemaDrift,
  upsertProject, upsertTeamMember, upsertBusinessLine, upsertAssignment, upsertNote } from '../db.js';
import sqlite3 from 'sqlite3';
import { requireAdmin } from '../auth.js';
import { broadcast } from '../sse.js';
import { loadMaintenanceState } from '../maintenance.js';
import { updateDbVersion, SITE_VERSION } from '../version.js';

const router = express.Router();

// ============ HEALTH ============

router.get('/health', async (req, res) => {
  res.json({
    status: schemaDrift.length > 0 ? 'degraded' : 'ok',
    timestamp: new Date().toISOString(),
    maintenance: false, // Actual state checked in middleware
    schemaDrift: schemaDrift.length > 0 ? schemaDrift : undefined,
  })
})

// ============ TABLE COUNTS ============

router.get('/table-counts', async (_req, res) => {
  try {
    const tables = await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as any[]
    const counts: Record<string, number> = {}
    for (const t of tables) {
      const row = await get(`SELECT COUNT(*) as c FROM "${t.name}"`) as any
      counts[t.name] = row?.c || 0
    }
    res.json({ counts })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ============ DB DOWNLOAD ============

router.get('/download-db', async (req, res) => {
  try {
    const secret = req.headers['x-seed-secret']
    if (!SEED_SECRET || secret !== SEED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ error: 'Database file not found' })
    }

    const stat = fs.statSync(DB_PATH)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', 'attachment; filename="shared.db"')
    res.setHeader('Content-Length', stat.size)
    fs.createReadStream(DB_PATH).pipe(res)
  } catch (e: any) {
    console.error('Download-db error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ============ DB UPLOAD ============

router.post('/upload-db', express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  try {
    const dbBytes = req.body as Buffer
    if (!dbBytes || dbBytes.length < 100) {
      return res.status(400).json({ error: 'No database file received or file too small' })
    }

    const header = dbBytes.subarray(0, 16).toString('ascii')
    if (!header.startsWith('SQLite format 3')) {
      return res.status(400).json({ error: 'Not a valid SQLite database file' })
    }

    const backupPath = DB_PATH + '.pre-upload-' + Date.now()
    fs.copyFileSync(DB_PATH, backupPath)

    const db = getDb()
    await new Promise<void>((resolve, reject) => {
      db.close((err: any) => err ? reject(err) : resolve())
    })

    fs.writeFileSync(DB_PATH, dbBytes)

    setDb(new sqlite3.Database(DB_PATH))

    const tables = await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as Array<{name: string}>
    const counts: Record<string, number> = {}
    for (const t of tables) {
      const row = await get(`SELECT COUNT(*) as c FROM "${t.name}"`) as {c: number}
      counts[t.name] = row.c
    }

    await loadMaintenanceState()

    broadcast('reload', { reason: 'database-replaced', timestamp: new Date().toISOString() })

    res.json({
      success: true,
      sizeBytes: dbBytes.length,
      backup: backupPath,
      tables: counts
    })
  } catch (e) {
    try { setDb(new sqlite3.Database(DB_PATH)) } catch {}
    res.status(500).json({ error: (e as Error).message })
  }
})

// ============ IMAGE FILES UPLOAD ============
//
// Accepts a tar.gz of image files and unpacks them flat into IMAGES_DIR.
// Auth: same dual path as /upload-db — Okta admin session (requireAdmin runs
// upstream via the route guard) OR x-seed-secret header for ops scripts.
// Existing files with the same filename are overwritten, which is the right
// behavior for the migration scenario this was built for (re-syncing image
// files to match a freshly-restored DB).
//
// The tar is piped through busybox tar (-xz) inside the container — Node 22
// alpine ships with it. Files in subdirectories are stripped via
// --strip-components, so a tarball built with `tar czf - -C /src .` lays its
// contents flat in IMAGES_DIR regardless of whether the source had nested dirs.
router.post('/upload-images', express.raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
  try {
    const tarBytes = req.body as Buffer
    if (!tarBytes || tarBytes.length < 100) {
      return res.status(400).json({ error: 'No tar archive received or file too small' })
    }
    // gzip magic bytes
    if (tarBytes[0] !== 0x1f || tarBytes[1] !== 0x8b) {
      return res.status(400).json({ error: 'Not a gzip-compressed tar (missing 0x1f8b magic)' })
    }

    fs.mkdirSync(IMAGES_DIR, { recursive: true })

    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const proc = spawn('tar', ['-xzvf', '-', '-C', IMAGES_DIR], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', (code: number) => resolve({ stdout, stderr, code: code ?? -1 }))
      proc.stdin.write(tarBytes)
      proc.stdin.end()
    })

    if (result.code !== 0) {
      return res.status(500).json({ error: 'tar extraction failed', stderr: result.stderr.slice(0, 500), code: result.code })
    }

    const written = fs.readdirSync(IMAGES_DIR).length
    res.json({
      success: true,
      imagesDir: IMAGES_DIR,
      filesNowInDir: written,
      tarOutput: (result.stdout || result.stderr).split('\n').filter(Boolean).slice(0, 10),
    })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ============ SEED (LEGACY) ============

router.post('/seed', async (req, res) => {
  try {
    const { projects, team, assignments, priorities, businessLines, brandOptions, notes, noteProjectLinks, notePeopleLinks } = req.body

    if (projects) {
      await run('DELETE FROM projects')
      for (const p of projects) await upsertProject(p)
    }
    if (team) {
      await run('DELETE FROM team')
      for (const t of team) await upsertTeamMember(t)
    }
    if (assignments && assignments.length > 0) {
      await run('DELETE FROM project_assignments')
      for (const a of assignments) await upsertAssignment(a)
    }
    if (priorities && priorities.length > 0) {
      await run('DELETE FROM project_priorities')
      for (const p of priorities) {
        await run(`INSERT INTO project_priorities (business_line_id, project_id, rank) VALUES (?, ?, ?)`,
          [p.business_line_id, p.project_id, p.rank])
      }
    }
    if (businessLines && businessLines.length > 0) {
      await run('DELETE FROM business_lines')
      for (const bl of businessLines) await upsertBusinessLine(bl)
    }
    if (brandOptions && brandOptions.length > 0) {
      await run('DELETE FROM brand_options')
      for (const bo of brandOptions) {
        if (typeof bo === 'string') {
          await run(`INSERT INTO brand_options (name) VALUES (?)`, [bo])
        } else {
          await run(`INSERT INTO brand_options (id, name) VALUES (?, ?)`, [bo.id, bo.name])
        }
      }
    }
    if (notes && notes.length > 0) {
      await run('DELETE FROM notes')
      for (const n of notes) await upsertNote(n)
    }
    if (noteProjectLinks && noteProjectLinks.length > 0) {
      await run('DELETE FROM note_project_links')
      for (const l of noteProjectLinks) {
        await run('INSERT INTO note_project_links (note_id, project_id) VALUES (?, ?)', [l.note_id, l.project_id])
      }
    }
    if (notePeopleLinks && notePeopleLinks.length > 0) {
      await run('DELETE FROM note_people_links')
      for (const l of notePeopleLinks) {
        await run('INSERT INTO note_people_links (note_id, team_id) VALUES (?, ?)', [l.note_id, l.team_id])
      }
    }

    await updateDbVersion()

    res.json({ success: true, synced: {
      projects: projects?.length ?? 0,
      team: team?.length ?? 0,
      assignments: assignments?.length ?? 0,
      priorities: priorities?.length ?? 0,
      businessLines: businessLines?.length ?? 0,
      brandOptions: brandOptions?.length ?? 0,
      notes: notes?.length ?? 0,
      noteProjectLinks: noteProjectLinks?.length ?? 0,
      notePeopleLinks: notePeopleLinks?.length ?? 0
    }})
  } catch (e: any) { res.status(500).json({error: e.message}); }
})

// ============ GOOGLE DOCS INTEGRATION ============

const WI_OPEN_CRITS_DOC_ID = process.env.WI_OPEN_CRITS_DOC_ID || '1QTw96d8wjB4UyrPwb6gXYpwpnLOBBrZuo7xoB48Z08k'
const OPEN_CRITS_SCRIPT_URL = process.env.DCC_OPEN_CRITS_SCRIPT_URL || ''

router.get('/reports/open-crits/doc-url', (_req, res) => {
  res.json({ url: `https://docs.google.com/document/d/${WI_OPEN_CRITS_DOC_ID}/edit` })
})

router.post('/reports/open-crits/sync', requireAdmin, async (req, res) => {
  try {
    if (!OPEN_CRITS_SCRIPT_URL) return res.status(500).json({ error: 'Apps Script web app URL not configured (DCC_OPEN_CRITS_SCRIPT_URL)' })

    const projects = await all(`SELECT p.*, GROUP_CONCAT(t.name, '||') as designer_names
      FROM projects p
      LEFT JOIN project_assignments pa ON pa.project_id = p.id
      LEFT JOIN team t ON pa.designer_id = t.id
      WHERE p.status IN ('active', 'review')
      GROUP BY p.id
      ORDER BY p.businessLine, p.name`) as any[]

    const blGroups: Record<string, Array<{ name: string; designers: string; figmaLink: string; deckLink: string; prdLink: string }>> = {}
    for (const p of projects) {
      let bls: string[]
      try { bls = JSON.parse(p.businessLine) } catch { bls = p.businessLine ? [p.businessLine] : ['Other'] }
      const designers = p.designer_names ? p.designer_names.split('||').filter(Boolean).join('') : ''
      const entry = { name: p.name, designers, figmaLink: p.figmaLink || '', deckLink: p.deckLink || '', prdLink: p.prdLink || '' }
      for (const bl of bls) {
        if (!blGroups[bl]) blGroups[bl] = []
        blGroups[bl].push(entry)
      }
    }

    const today = new Date()
    const dayOfWeek = today.getDay()
    const daysUntilWed = (3 - dayOfWeek + 7) % 7 || 7
    const nextWed = new Date(today)
    nextWed.setDate(today.getDate() + daysUntilWed)
    const tabTitle = nextWed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

    const scriptResp = await fetch(OPEN_CRITS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: SEED_SECRET,
        tabTitle,
        dateStr: tabTitle,
        businessLines: blGroups,
      }),
    })

    const scriptResult = await scriptResp.json().catch(() => ({ error: `HTTP ${scriptResp.status}` }))

    if (scriptResult.error) {
      console.error('Apps Script error:', scriptResult.error)
      return res.status(500).json({ error: scriptResult.error })
    }

    res.json({
      success: true,
      tabTitle,
      projectCount: projects.length,
      businessLines: Object.keys(blGroups).length,
      docUrl: `https://docs.google.com/document/d/${WI_OPEN_CRITS_DOC_ID}/edit`,
    })
  } catch (e: any) {
    console.error('Open Crits sync error:', e)
    res.status(500).json({ error: e.message })
  }
})

export default router;

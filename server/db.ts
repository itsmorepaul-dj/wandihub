import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'shared.db');
export const IMAGES_DIR = path.join(path.dirname(DB_PATH), 'images');

// Ensure images directory exists
try { fs.mkdirSync(IMAGES_DIR, { recursive: true }); } catch { /* ok */ }
export const SEED_SECRET = process.env.DCC_SEED_SECRET || '';

let db: sqlite3.Database;
try {
  db = new sqlite3.Database(DB_PATH);
  console.log('Database connected:', DB_PATH);
} catch (e) {
  console.error('Database connection error:', e);
}

export const getDb = () => db;
export const setDb = (newDb: sqlite3.Database) => { db = newDb; };

export const run = (sql: string, params: any[] = []): Promise<any> => new Promise((resolve, reject) => {
  if (!db) return reject(new Error('Database not connected'));
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

export const all = (sql: string, params: any[] = []): Promise<any[]> => new Promise((resolve, reject) => {
  if (!db) return reject(new Error('Database not connected'));
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

export const get = (sql: string, params: any[] = []): Promise<any> => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

// ============================================
// CENTRALIZED UPSERT FUNCTIONS
// Single source of truth for each table's columns.
// Every INSERT path MUST use these — never inline column lists.
// ============================================

export const upsertProject = async (p: any) => {
  const timelineVal = typeof p.timeline === 'string' ? p.timeline : JSON.stringify(p.timeline || [])
  const customLinksVal = typeof p.customLinks === 'string' ? p.customLinks : JSON.stringify(p.customLinks || [])
  const designersVal = typeof p.designers === 'string' ? p.designers : JSON.stringify(p.designers || [])
  const businessLineVal = typeof p.businessLine === 'string' && p.businessLine.startsWith('[')
    ? p.businessLine
    : typeof p.businessLines === 'string' ? p.businessLines
    : JSON.stringify(p.businessLines || (p.businessLine ? [p.businessLine] : []))
  // Preserve archivedQuarter if not explicitly provided (INSERT OR REPLACE would null it)
  let archivedQuarter = p.archivedQuarter !== undefined ? (p.archivedQuarter || null) : undefined
  if (archivedQuarter === undefined) {
    const existing = await get('SELECT archivedQuarter FROM projects WHERE id = ?', [p.id]) as any
    archivedQuarter = existing?.archivedQuarter || null
  }
  await run(
    `INSERT OR REPLACE INTO projects
     (id, name, status, dueDate, assignee, url, description, businessLine,
      deckName, deckLink, prdName, prdLink, briefName, briefLink, figmaLink,
      customLinks, designers, startDate, endDate, timeline, estimatedHours, archivedQuarter, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [p.id, p.name, p.status || 'active', p.dueDate || null, p.assignee || null,
     p.url || '', p.description || '', businessLineVal,
     p.deckName || '', p.deckLink || '', p.prdName || '', p.prdLink || '',
     p.briefName || '', p.briefLink || '', p.figmaLink || '',
     customLinksVal, designersVal, p.startDate || null, p.endDate || null,
     timelineVal, p.estimatedHours || 0, archivedQuarter]
  )
}

export const upsertTeamMember = async (t: any) => {
  const brandsVal = typeof t.brands === 'string' ? t.brands : JSON.stringify(t.brands || [])
  const timeOffVal = typeof t.timeOff === 'string' ? t.timeOff : JSON.stringify(t.timeOff || [])
  await run(
    `INSERT OR REPLACE INTO team
     (id, name, role, brands, status, slack, email, avatar, timeOff, weekly_hours, excluded, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [t.id, t.name, t.role || '', brandsVal, t.status || 'offline',
     t.slack || '', t.email || '', t.avatar || '', timeOffVal,
     t.weekly_hours ?? 35, t.excluded ? 1 : 0]
  )
}

export const upsertBusinessLine = async (bl: any) => {
  const customLinksVal = typeof bl.customLinks === 'string' ? bl.customLinks : JSON.stringify(bl.customLinks || [])
  await run(
    `INSERT OR REPLACE INTO business_lines
     (id, name, deckName, deckLink, prdName, prdLink, briefName, briefLink, figmaLink, customLinks, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [bl.id, bl.name, bl.deckName || '', bl.deckLink || '', bl.prdName || '', bl.prdLink || '',
     bl.briefName || '', bl.briefLink || '', bl.figmaLink || '', customLinksVal]
  )
}

export const upsertAssignment = async (a: any) => {
  const id = a.id || `${a.project_id}_${a.designer_id}`
  await run(
    `INSERT OR REPLACE INTO project_assignments (id, project_id, designer_id, allocation_percent, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, a.project_id, a.designer_id, a.allocation_percent ?? 0, a.created_at || new Date().toISOString()]
  )
}

export const upsertNote = async (n: any) => {
  await run(
    `INSERT OR REPLACE INTO notes
     (id, source_id, source_filename, title, date, content_preview, people_raw, projects_raw,
      drive_url, source_created_at, next_steps, details, attachments,
      linkedTeamIds, linkedProjectIds, hidden, hidden_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [n.id, n.source_id || null, n.source_filename || '', n.title || '', n.date || '',
     n.content_preview || '', n.people_raw || '', n.projects_raw || '',
     n.drive_url || '', n.source_created_at || '', n.next_steps || '', n.details || '',
     n.attachments || '[]', n.linkedTeamIds ? (typeof n.linkedTeamIds === 'string' ? n.linkedTeamIds : JSON.stringify(n.linkedTeamIds)) : '[]',
     n.linkedProjectIds ? (typeof n.linkedProjectIds === 'string' ? n.linkedProjectIds : JSON.stringify(n.linkedProjectIds)) : '[]',
     n.hidden ? 1 : 0, n.hidden_at || null]
  )
}

// ============================================
// SCHEMA VALIDATION
// ============================================

const UPSERT_COLUMNS: Record<string, string[]> = {
  projects: ['id','name','status','dueDate','assignee','url','description','businessLine',
    'deckName','deckLink','prdName','prdLink','briefName','briefLink','figmaLink',
    'customLinks','designers','startDate','endDate','timeline','estimatedHours','archivedQuarter','updatedAt'],
  team: ['id','name','role','brands','status','slack','email','avatar','timeOff','weekly_hours','excluded','updatedAt'],
  business_lines: ['id','name','deckName','deckLink','prdName','prdLink','briefName','briefLink','figmaLink','customLinks','updatedAt'],
  project_assignments: ['id','project_id','designer_id','allocation_percent','created_at'],
  notes: ['id','source_id','source_filename','title','date','content_preview','people_raw','projects_raw',
    'drive_url','source_created_at','next_steps','details','attachments',
    'linkedTeamIds','linkedProjectIds','hidden','hidden_at'],
}

const AUTO_COLUMNS: Record<string, string[]> = {
  projects: ['createdAt'],
  team: ['createdAt'],
  business_lines: ['createdAt'],
  notes: ['created_at', 'updated_at'],
}

export let schemaDrift: string[] = []

export const validateSchemaOnStartup = async () => {
  const drift: string[] = []
  for (const [table, upsertCols] of Object.entries(UPSERT_COLUMNS)) {
    try {
      const columns = await all(`PRAGMA table_info("${table}")`) as Array<{name: string}>
      const dbCols = columns.map(c => c.name)
      const autoCols = AUTO_COLUMNS[table] || []
      const coveredCols = new Set([...upsertCols, ...autoCols])
      const missing = dbCols.filter(col => !coveredCols.has(col))
      if (missing.length > 0) {
        const msg = `${table}: uncovered columns [${missing.join(', ')}]`
        drift.push(msg)
        console.error(`\n⚠️  SCHEMA DRIFT: table "${table}" has columns NOT covered by upsert function: [${missing.join(', ')}]`)
        console.error(`   These columns will be LOST on INSERT OR REPLACE. Fix upsertFunction immediately!\n`)
      }
    } catch (e) {
      console.error(`Schema validation error for ${table}:`, e)
    }
  }
  schemaDrift = drift
  if (drift.length === 0) {
    console.log('✅ Schema validation passed — all upsert functions cover all DB columns')
  }
}

// ============================================
// SCHEMA INITIALIZATION & MIGRATIONS
// ============================================

export const initSchema = async () => {
  await run("CREATE TABLE IF NOT EXISTS app_versions (key TEXT PRIMARY KEY, db_version TEXT, db_time TEXT, updated_at TEXT)")
  await run("CREATE TABLE IF NOT EXISTS project_priorities (business_line_id TEXT NOT NULL, project_id TEXT NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (business_line_id, project_id))")
  await run("CREATE TABLE IF NOT EXISTS holidays (id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL, createdAt TEXT DEFAULT CURRENT_TIMESTAMP)")

  await run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
    dueDate TEXT, assignee TEXT, url TEXT, description TEXT, businessLine TEXT,
    deckLink TEXT, prdLink TEXT, briefLink TEXT, startDate TEXT, endDate TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP, updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    timeline TEXT, deckName TEXT, prdName TEXT, briefName TEXT, figmaLink TEXT,
    customLinks TEXT, designers TEXT, estimatedHours REAL DEFAULT 0
  )`).catch(e => console.error('projects init error:', e.message))

  await run(`ALTER TABLE projects ADD COLUMN estimatedHours REAL DEFAULT 0`).catch(() => {})
  await run(`ALTER TABLE projects ADD COLUMN archivedQuarter TEXT DEFAULT NULL`).catch(() => {})
  await run(`UPDATE projects SET status = 'archived' WHERE archivedQuarter IS NOT NULL AND status != 'archived'`).catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS team (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, brands TEXT,
    status TEXT DEFAULT 'offline', slack TEXT, email TEXT, avatar TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP, updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    timeOff TEXT, weekly_hours REAL DEFAULT 35, excluded INTEGER DEFAULT 0
  )`).catch(e => console.error('team init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS brand_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL
  )`).catch(e => console.error('brand_options init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS project_assignments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, designer_id TEXT NOT NULL,
    allocation_percent INTEGER DEFAULT 100, created_at TEXT DEFAULT (datetime('now'))
  )`).catch((e) => console.error('project_assignments init error:', e.message))

  await run("ALTER TABLE team ADD COLUMN weekly_hours INTEGER DEFAULT 35").catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS business_lines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    deckName TEXT DEFAULT '', deckLink TEXT DEFAULT '', prdName TEXT DEFAULT '', prdLink TEXT DEFAULT '',
    briefName TEXT DEFAULT '', briefLink TEXT DEFAULT '', figmaLink TEXT DEFAULT '',
    customLinks TEXT DEFAULT '[]',
    createdAt TEXT DEFAULT (datetime('now')), updatedAt TEXT DEFAULT (datetime('now'))
  )`).catch((e) => console.error('business_lines init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, source_id INTEGER, source_filename TEXT,
    title TEXT NOT NULL DEFAULT '', date TEXT, content_preview TEXT,
    people_raw TEXT, projects_raw TEXT, drive_url TEXT, source_created_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    next_steps TEXT DEFAULT '', details TEXT DEFAULT '', attachments TEXT DEFAULT '[]',
    linkedTeamIds TEXT DEFAULT '[]', linkedProjectIds TEXT DEFAULT '[]',
    hidden INTEGER DEFAULT 0, hidden_at TEXT
  )`).catch(e => console.error('notes init error:', e.message))

  await run(`ALTER TABLE notes ADD COLUMN hidden INTEGER DEFAULT 0`).catch(() => {})
  await run(`ALTER TABLE notes ADD COLUMN hidden_at TEXT`).catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS hidden_note_fingerprints (
    fingerprint TEXT PRIMARY KEY, original_note_id TEXT,
    hidden_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('hidden_note_fingerprints init error:', e.message))

  // Backfill fingerprints for any already-hidden notes
  const hiddenNotes = await all(`SELECT id, source_filename, drive_url FROM notes WHERE hidden = 1`).catch(() => [] as any[])
  for (const n of hiddenNotes) {
    const raw = (n.source_filename || '').trim().toLowerCase() || (n.drive_url || '').trim().toLowerCase()
    if (raw) {
      await run('INSERT OR IGNORE INTO hidden_note_fingerprints (fingerprint, original_note_id) VALUES (?, ?)', [raw, n.id]).catch(() => {})
    }
  }

  await run(`ALTER TABLE notes ADD COLUMN next_steps TEXT DEFAULT ''`).catch(() => {})
  await run(`ALTER TABLE notes ADD COLUMN details TEXT DEFAULT ''`).catch(() => {})
  await run(`ALTER TABLE notes ADD COLUMN attachments TEXT DEFAULT '[]'`).catch(() => {})
  await run(`ALTER TABLE notes ADD COLUMN linkedTeamIds TEXT DEFAULT '[]'`).catch(() => {})
  await run(`ALTER TABLE notes ADD COLUMN linkedProjectIds TEXT DEFAULT '[]'`).catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, action TEXT NOT NULL,
    target_name TEXT NOT NULL, user_email TEXT, details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('activity_log init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS note_project_links (
    note_id TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY (note_id, project_id)
  )`).catch(e => console.error('note_project_links init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS note_people_links (
    note_id TEXT NOT NULL, team_id TEXT NOT NULL,
    PRIMARY KEY (note_id, team_id)
  )`).catch(e => console.error('note_people_links init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS weekly_updates (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, designer_id TEXT NOT NULL,
    week TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'highlight',
    description TEXT DEFAULT '', risk_reason TEXT DEFAULT '', resolution TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('weekly_updates init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS weekly_general (
    id TEXT PRIMARY KEY, designer_id TEXT NOT NULL,
    week TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'fyi',
    content TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('weekly_general init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS weekly_snapshots (
    id TEXT PRIMARY KEY, week TEXT NOT NULL UNIQUE,
    generated_at TEXT DEFAULT (datetime('now')),
    plain_text TEXT DEFAULT '',
    data_json TEXT DEFAULT '{}'
  )`).catch(e => console.error('weekly_snapshots init error:', e.message))

  await run(`CREATE TABLE IF NOT EXISTS review_snapshots (
    id TEXT PRIMARY KEY, week TEXT NOT NULL UNIQUE,
    generated_at TEXT DEFAULT (datetime('now')),
    plain_text TEXT DEFAULT '',
    data_json TEXT DEFAULT '{}'
  )`).catch(e => console.error('review_snapshots init error:', e.message))

  // Seed a sample review snapshot if table is empty
  const existingReviewSnap = await get('SELECT id FROM review_snapshots LIMIT 1').catch(() => null)
  if (!existingReviewSnap) {
    const sampleWeek = '2026-W14'
    const sampleData = JSON.stringify({
      week: sampleWeek,
      reviewId: 'sample',
      reviewTitle: 'W&I Open Critique — Week 14',
      reviewItems: [
        { project_id: 's1', project_name: 'MarketWatch Redesign', status: 'review', designers: ['Sarah'], businessLines: ['MarketWatch'], estimatedHours: 280, sizeLabel: 'L · 280h', endDate: '2026-04-18', links: [{ name: 'Figma', url: '#' }, { name: 'PRD', url: '#' }], notes: 'Navigation patterns finalized. Need stakeholder sign-off on mobile breakpoints.' },
        { project_id: 's2', project_name: 'WSJ App Onboarding', status: 'review', designers: ['Mike', 'Priya'], businessLines: ['WSJ'], estimatedHours: 175, sizeLabel: 'M · 175h', endDate: '2026-04-25', links: [{ name: 'Deck', url: '#' }, { name: 'Figma', url: '#' }], notes: 'User testing results in. Iterating on step 3 flow.' },
        { project_id: 's3', project_name: 'Barron\'s Portfolio Dashboard', status: 'review', designers: ['Alex'], businessLines: ['Barron\'s'], estimatedHours: 105, sizeLabel: 'S · 105h', endDate: '2026-05-02', links: [{ name: 'Figma', url: '#' }], notes: null },
      ],
      activeItems: [
        { project_id: 'a1', project_name: 'DJ News Alerts Refresh', status: 'active', designers: ['Jordan'], businessLines: ['Dow Jones'], endDate: '2026-05-09', links: [{ name: 'Brief', url: '#' }] },
        { project_id: 'a2', project_name: 'WSJ Podcast Player', status: 'active', designers: ['Sarah', 'Tim'], businessLines: ['WSJ'], endDate: '2026-04-30', links: [{ name: 'Figma', url: '#' }, { name: 'PRD', url: '#' }] },
        { project_id: 'a3', project_name: 'MarketWatch Charts v2', status: 'blocked', designers: ['Mike'], businessLines: ['MarketWatch'], endDate: '2026-05-16', links: [{ name: 'Figma', url: '#' }] },
        { project_id: 'a4', project_name: 'Barron\'s Subscriber Portal', status: 'active', designers: ['Priya'], businessLines: ['Barron\'s'], endDate: '2026-06-01', links: [{ name: 'Deck', url: '#' }, { name: 'Brief', url: '#' }] },
      ],
    })
    const samplePlain = `W&I OPEN CRITIQUES — 2026-W14\nProjects selected for stakeholder and peer design review\n3 projects in review\n\nBARRON'S\n  • Barron's Portfolio Dashboard\n    Alex · S · 105h · Due: May 2\n\nMARKETWATCH\n  • MarketWatch Redesign\n    Sarah · L · 280h · Due: Apr 18 · Figma, PRD\n    Notes: Navigation patterns finalized. Need stakeholder sign-off on mobile breakpoints.\n\nWSJ\n  • WSJ App Onboarding\n    Mike, Priya · M · 175h · Due: Apr 25 · Deck, Figma\n    Notes: User testing results in. Iterating on step 3 flow.\n\n────────────────────────────────────────\n\nALL ACTIVE PROJECTS — 4 projects\n\nBARRON'S\n  • Barron's Subscriber Portal — Active · Priya · Due: Jun 1 · Deck, Brief\n\nDOW JONES\n  • DJ News Alerts Refresh — Active · Jordan · Due: May 9 · Brief\n\nMARKETWATCH\n  • MarketWatch Charts v2 — Blocked · Mike · Due: May 16 · Figma\n\nWSJ\n  • WSJ Podcast Player — Active · Sarah, Tim · Due: Apr 30 · Figma, PRD`
    await run(
      `INSERT INTO review_snapshots (id, week, generated_at, plain_text, data_json) VALUES (?, ?, '2026-04-01T17:00:00.000Z', ?, ?)`,
      [sampleWeek, sampleWeek, samplePlain, sampleData]
    ).catch(e => console.log('Review snapshot seed:', e.message))
  }

  await run(`CREATE TABLE IF NOT EXISTS project_images (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    filename TEXT NOT NULL, original_name TEXT DEFAULT '',
    mime_type TEXT DEFAULT 'image/png', size_bytes INTEGER DEFAULT 0,
    caption TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('project_images init error:', e.message))
  // Migration: add caption column if missing
  await run(`ALTER TABLE project_images ADD COLUMN caption TEXT DEFAULT ''`).catch(() => {})
  // Migration: add sort_order column if missing, then seed existing rows by created_at
  await run(`ALTER TABLE project_images ADD COLUMN sort_order INTEGER DEFAULT 0`).then(async () => {
    await run(`UPDATE project_images SET sort_order = (
      SELECT COUNT(*) FROM project_images p2
      WHERE p2.project_id = project_images.project_id AND p2.created_at <= project_images.created_at
    ) WHERE sort_order = 0`).catch(() => {})
  }).catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Design Review',
    week TEXT, created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('reviews init error:', e.message))
  // Migration: add description column if missing
  await run(`ALTER TABLE reviews ADD COLUMN description TEXT DEFAULT ''`).catch(() => {})
  // Migration: explicit review_date (ISO YYYY-MM-DD) — independent of created_at
  await run(`ALTER TABLE reviews ADD COLUMN review_date TEXT`).catch(() => {})
  // Backfill: if review_date is null, derive from created_at (date portion)
  await run(`UPDATE reviews SET review_date = substr(created_at, 1, 10) WHERE review_date IS NULL OR review_date = ''`).catch(() => {})
  // Migration: Gemini-generated meeting notes pasted after the review
  await run(`ALTER TABLE reviews ADD COLUMN gemini_notes TEXT DEFAULT ''`).catch(() => {})

  await run(`CREATE TABLE IF NOT EXISTS review_items (
    id TEXT PRIMARY KEY, review_id TEXT NOT NULL, project_id TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT '',
    notes_updated_by TEXT DEFAULT '', notes_updated_at TEXT DEFAULT '',
    description TEXT DEFAULT ''
  )`).catch(e => console.error('review_items init error:', e.message))
  await run(`ALTER TABLE review_items ADD COLUMN description TEXT DEFAULT ''`).catch(() => {})
  // Time allocation: nullable duration (null = auto-split), exempt flag, and total per review
  await run(`ALTER TABLE review_items ADD COLUMN duration_minutes INTEGER DEFAULT NULL`).catch(() => {})
  await run(`ALTER TABLE review_items ADD COLUMN excluded_from_time INTEGER DEFAULT 0`).catch(() => {})
  await run(`ALTER TABLE reviews ADD COLUMN total_minutes INTEGER DEFAULT 45`).catch(() => {})
  // Migration: per-item optional review_date override (null = inherit from parent review)
  await run(`ALTER TABLE review_items ADD COLUMN review_date TEXT`).catch(() => {})

  // Review-scoped images: each review_item has its own gallery, independent of the
  // project's gallery. Files are stored in IMAGES_DIR; each row owns its own filename
  // so duplicate/delete operate independently.
  await run(`CREATE TABLE IF NOT EXISTS review_item_images (
    id TEXT PRIMARY KEY, review_item_id TEXT NOT NULL,
    filename TEXT NOT NULL, original_name TEXT DEFAULT '',
    mime_type TEXT DEFAULT 'image/png', size_bytes INTEGER DEFAULT 0,
    caption TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).catch(e => console.error('review_item_images init error:', e.message))

  // One-time migration: prior versions stored review-scoped uploads in project_images
  // with project_id = review_item.id. Move those rows into review_item_images.
  const legacyReviewImages = await all(
    `SELECT pi.* FROM project_images pi
     WHERE EXISTS (SELECT 1 FROM review_items ri WHERE ri.id = pi.project_id)`
  ).catch(() => [] as any[])
  for (const img of legacyReviewImages) {
    try {
      const existing = await get('SELECT id FROM review_item_images WHERE id = ?', [img.id])
      if (existing) continue
      await run(
        `INSERT INTO review_item_images (id, review_item_id, filename, original_name, mime_type, size_bytes, caption, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [img.id, img.project_id, img.filename, img.original_name || '', img.mime_type || 'image/png',
         img.size_bytes || 0, img.caption || '', img.sort_order || 0, img.created_at || new Date().toISOString()]
      )
      await run('DELETE FROM project_images WHERE id = ?', [img.id])
    } catch (e: any) {
      console.error('review_item_images migration error for', img.id, e.message)
    }
  }
  if (legacyReviewImages.length > 0) {
    console.log(`Migrated ${legacyReviewImages.length} review-scoped images to review_item_images`)
  }

  // Seed default business lines if empty
  const existing = await get('SELECT COUNT(*) as count FROM business_lines')
  if (existing?.count === 0) {
    const defaultLines = [
      "Barron's", "FN London", "IBD", "Mansion Global", "Market Data",
      "MarketWatch", "Messaging", "Mobile Apps", "PEN", "The Wall Street Journal"
    ]
    for (const name of defaultLines) {
      await run('INSERT INTO business_lines (id, name) VALUES (?, ?)', [name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(), name])
    }
    console.log('Seeded default business lines')
  }
}

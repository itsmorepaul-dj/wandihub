import sqlite3 from 'sqlite3';
import path from 'path';

export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'shared.db');
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

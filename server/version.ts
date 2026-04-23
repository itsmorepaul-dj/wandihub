import express from 'express';
import { run, get } from './db.js';
import { broadcast } from './sse.js';

export const SITE_VERSION = '2026.04.23.1900'
export const SITE_TIME = '1900'

const VERSION_KEY = 'dcc_versions'

const generateDbVersionParts = () => {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const getVal = (type: string) => parts.find(p => p.type === type)?.value || '00'
  const year = getVal('year')
  const mm = getVal('month')
  const dd = getVal('day')
  const hh = getVal('hour')
  const min = getVal('minute')

  return {
    versionNumber: `${year}.${mm}.${dd}.${hh}${min}`,
    versionTime: `${hh}${min}`,
  }
}

export const updateDbVersion = async () => {
  const { versionNumber, versionTime } = generateDbVersionParts()
  await run("UPDATE app_versions SET db_version = ?, db_time = ?, updated_at = datetime('now') WHERE key = ?", [versionNumber, versionTime, VERSION_KEY])
  broadcast('data-change', { db_version: versionNumber, timestamp: new Date().toISOString() })
}

export const initVersions = async () => {
  try {
    const existing = await get("SELECT * FROM app_versions WHERE key = ?", [VERSION_KEY])
    if (!existing) {
      const { versionNumber, versionTime } = generateDbVersionParts()
      await run("INSERT INTO app_versions (key, db_version, db_time, updated_at) VALUES (?, ?, ?, datetime('now'))",
        [VERSION_KEY, versionNumber, versionTime])
    }
  } catch (e: any) {
    console.log('Version init:', e.message)
  }
}

export const logActivity = async (
  category: 'project' | 'priority' | 'holiday' | 'capacity' | 'review',
  action: 'create' | 'update' | 'delete' | 'comment',
  targetName: string,
  userEmail: string | null,
  details?: string
): Promise<number | null> => {
  try {
    const r = await run(
      `INSERT INTO activity_log (category, action, target_name, user_email, details, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [category, action, targetName, userEmail || 'anonymous', details || null]
    ) as any
    return r?.lastID ?? null
  } catch (e: any) {
    console.error('Activity log error:', e.message)
    return null
  }
}

// Version routes
export const versionRouter = express.Router();

versionRouter.get('/', async (req, res) => {
  try {
    const existing = await get("SELECT * FROM app_versions WHERE key = ?", [VERSION_KEY])
    res.json({
      site_version: SITE_VERSION,
      site_time: SITE_TIME,
      db_version: existing?.db_version || '',
      db_time: existing?.db_time || ''
    })
  } catch (e: any) { res.status(500).json({error: e.message}); }
})

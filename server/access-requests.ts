// Access requests from outside the Hatch gateway.
//
// Anyone in DJ Slack can run the "Request DesignHub access" workflow, which
// writes a row to a Google Sheet (since they can't reach designhub directly —
// the Hatch oauth2-proxy DENY policy blocks non-allowlisted Okta accounts).
//
// This module:
//   1. Polls the sheet every 60s for status='pending' rows
//   2. Caches the parsed list in memory for the admin UI
//   3. Exposes GET /api/access-requests, POST /:rowId/approve, POST /:rowId/deny
//
// Approve writes the requested role to the local users table (so they're the
// right role the moment they hit designhub) and marks the sheet row approved.
// The admin still has to add the user to the Hatch app allowlist manually
// (no service-account API for that yet) — the response surfaces the email
// for copy/paste.

import express from 'express'
import fs from 'fs'
import path from 'path'
import { google, sheets_v4 } from 'googleapis'
import { run, get } from './db.js'
import { requireAdmin } from './auth.js'
import { broadcast } from './sse.js'

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1gDwADTRdj_EeH1wqplBUC0kHgBr-a2e5nvSc5jPow7c'
const SHEET_TAB = 'designhub-access-requests'
const POLL_INTERVAL_MS = 60_000

// Column layout (1-indexed): A=timestamp, B=email, C=name, D=requested_role,
// E=reason, F=project, G=status, H=handled_by, I=handled_at, J=notes.
const COL = { timestamp: 0, email: 1, name: 2, role: 3, reason: 4, project: 5, status: 6, handled_by: 7, handled_at: 8, notes: 9 } as const

export interface AccessRequest {
  rowId: number          // 1-indexed sheet row (matches Sheets API range)
  timestamp: string      // ISO 8601, parsed from whatever Slack wrote
  rawTimestamp: string   // original sheet value, for debugging
  email: string
  name: string
  requestedRole: 'admin' | 'user' | 'viewer'
  rawRole: string        // original sheet value (e.g. "User (full edit access)")
  reason: string
  project: string
  status: string         // 'pending' for what we expose; backend keeps the literal
}

let cachedPending: AccessRequest[] = []
let lastFetch: { at: string; ok: boolean; error?: string } = { at: '', ok: false }
let sheetsClient: sheets_v4.Sheets | null = null

const loadCredentials = (): { client_email: string; private_key: string } | null => {
  const envKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (envKey) {
    try { return JSON.parse(envKey) } catch (e) {
      console.error('GOOGLE_SERVICE_ACCOUNT_KEY env var is not valid JSON:', e)
      return null
    }
  }
  // Local dev: read from .localsecrets/dh2.json (gitignored)
  const localPath = path.join(process.cwd(), '.localsecrets', 'dh2.json')
  if (fs.existsSync(localPath)) {
    try { return JSON.parse(fs.readFileSync(localPath, 'utf-8')) } catch (e) {
      console.error('Local service account key parse failed:', e)
      return null
    }
  }
  return null
}

const getSheetsClient = (): sheets_v4.Sheets | null => {
  if (sheetsClient) return sheetsClient
  const creds = loadCredentials()
  if (!creds?.client_email || !creds?.private_key) {
    console.warn('Access requests: no Google service account credentials available — feature disabled')
    return null
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  sheetsClient = google.sheets({ version: 'v4', auth })
  return sheetsClient
}

// "User (full edit access)" → "user". Returns null if unrecognized.
const normalizeRole = (raw: string): 'admin' | 'user' | 'viewer' | null => {
  const first = (raw || '').trim().toLowerCase().split(/[\s(]/)[0]
  if (first === 'admin' || first === 'user' || first === 'viewer') return first
  return null
}

// Slack writes timestamps like "May 27, 2026, 10:31:04 AM" — JS parses it fine.
const parseTimestamp = (raw: string): string => {
  const t = new Date(raw)
  if (isNaN(t.getTime())) return ''
  return t.toISOString()
}

const parseRow = (row: string[], rowIndex: number): AccessRequest | null => {
  const email = (row[COL.email] || '').trim().toLowerCase()
  const status = (row[COL.status] || '').trim().toLowerCase()
  if (!email) return null
  if (status !== 'pending') return null
  const role = normalizeRole(row[COL.role] || '')
  if (!role) return null
  return {
    rowId: rowIndex + 1, // sheets are 1-indexed; rowIndex 0 is row 1 (header)
    timestamp: parseTimestamp(row[COL.timestamp] || ''),
    rawTimestamp: row[COL.timestamp] || '',
    email,
    name: (row[COL.name] || '').trim(),
    requestedRole: role,
    rawRole: row[COL.role] || '',
    reason: (row[COL.reason] || '').trim(),
    project: (row[COL.project] || '').trim(),
    status: 'pending',
  }
}

const pollSheet = async (): Promise<void> => {
  const sheets = getSheetsClient()
  if (!sheets) {
    lastFetch = { at: new Date().toISOString(), ok: false, error: 'No credentials' }
    return
  }
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1:J10000`,
    })
    const rows = resp.data.values || []
    const pending: AccessRequest[] = []
    // Skip row 0 (header)
    for (let i = 1; i < rows.length; i++) {
      const parsed = parseRow(rows[i], i)
      if (parsed) pending.push(parsed)
    }
    const prevCount = cachedPending.length
    cachedPending = pending
    lastFetch = { at: new Date().toISOString(), ok: true }
    if (prevCount !== pending.length) {
      broadcast('access-requests', { pending: pending.length })
    }
  } catch (e: any) {
    console.error('Access requests poll failed:', e?.message || e)
    lastFetch = { at: new Date().toISOString(), ok: false, error: e?.message || String(e) }
  }
}

export const startAccessRequestPoller = () => {
  pollSheet().catch(() => {}) // immediate first fetch
  setInterval(() => { pollSheet().catch(() => {}) }, POLL_INTERVAL_MS)
  console.log(`Access request poller started (every ${POLL_INTERVAL_MS / 1000}s)`)
}

// Write status + handled_by + handled_at back to the sheet for one row.
const updateSheetRow = async (rowId: number, status: string, handledBy: string, notes?: string): Promise<void> => {
  const sheets = getSheetsClient()
  if (!sheets) throw new Error('Sheets client unavailable')
  const handledAt = new Date().toISOString()
  // Update G:J in one batch (status, handled_by, handled_at, notes)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!G${rowId}:J${rowId}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[status, handledBy, handledAt, notes || '']],
    },
  })
}

// Insert or promote a local user row so when they hit designhub they're the
// right role from the first request. password_hash is non-null on the schema
// so we use a placeholder (Okta-only users never authenticate by password).
const upsertUserWithRole = async (email: string, name: string, role: 'admin' | 'user' | 'viewer'): Promise<void> => {
  const existing = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
  if (existing) {
    await run(
      'UPDATE users SET role = ?, display_name = COALESCE(NULLIF(display_name, \'\'), ?), access_requested_at = NULL WHERE id = ?',
      [role, name || null, existing.id]
    )
    return
  }
  const placeholder = `okta:approved:${Date.now()}:${Math.random().toString(36).slice(2)}`
  await run(
    'INSERT INTO users (email, password_hash, role, display_name) VALUES (?, ?, ?, ?)',
    [email.toLowerCase(), placeholder, role, name || null]
  )
}

// ============ Express router ============

export const accessRequestsRouter = express.Router()

accessRequestsRouter.get('/access-requests', requireAdmin, (_req, res) => {
  res.json({
    pending: cachedPending,
    last_fetch: lastFetch,
  })
})

accessRequestsRouter.post('/access-requests/refresh', requireAdmin, async (_req, res) => {
  await pollSheet()
  res.json({ pending: cachedPending, last_fetch: lastFetch })
})

accessRequestsRouter.post('/access-requests/:rowId/approve', requireAdmin, async (req, res) => {
  try {
    const rowId = parseInt(req.params.rowId, 10)
    if (!Number.isFinite(rowId) || rowId < 2) return res.status(400).json({ error: 'Invalid rowId' })
    const session = (req as any).session
    const target = cachedPending.find(p => p.rowId === rowId)
    if (!target) return res.status(404).json({ error: 'Request not found or no longer pending' })

    // Optional admin override of the role they actually granted
    const overrideRole = (req.body?.role as string | undefined)?.toLowerCase()
    const role = (overrideRole === 'admin' || overrideRole === 'user' || overrideRole === 'viewer')
      ? overrideRole as 'admin' | 'user' | 'viewer'
      : target.requestedRole

    await upsertUserWithRole(target.email, target.name, role)
    // notes column: always include the granted role, and call out the
    // downgrade explicitly when the granted role differs from the request.
    const grantedNote = role === target.requestedRole
      ? `granted: ${role}`
      : `granted: ${role} (requested: ${target.requestedRole})`
    await updateSheetRow(rowId, 'approved', session.email || 'admin', grantedNote)

    // Refresh cache so the row drops out of pending immediately
    await pollSheet()

    res.json({
      success: true,
      email: target.email,
      role,
      // Hatch gateway carve-out is still manual until they expose a service API.
      hatchAllowlistHint: `mcp__hatch__add_app_user(name="designhub", emails=["${target.email}"])`,
    })
  } catch (e: any) {
    console.error('Approve failed:', e?.message || e)
    res.status(500).json({ error: e?.message || 'Approve failed' })
  }
})

accessRequestsRouter.post('/access-requests/:rowId/deny', requireAdmin, async (req, res) => {
  try {
    const rowId = parseInt(req.params.rowId, 10)
    if (!Number.isFinite(rowId) || rowId < 2) return res.status(400).json({ error: 'Invalid rowId' })
    const session = (req as any).session
    const target = cachedPending.find(p => p.rowId === rowId)
    if (!target) return res.status(404).json({ error: 'Request not found or no longer pending' })

    const notes = (req.body?.notes as string | undefined)?.toString().slice(0, 500) || ''
    await updateSheetRow(rowId, 'denied', session.email || 'admin', notes)
    await pollSheet()

    res.json({ success: true })
  } catch (e: any) {
    console.error('Deny failed:', e?.message || e)
    res.status(500).json({ error: e?.message || 'Deny failed' })
  }
})

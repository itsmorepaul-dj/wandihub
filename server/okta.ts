// Hatch Okta passthrough.
//
// Hatch's oauth2-proxy validates the Okta SSO session and injects two pieces
// of identity on every request reaching the app:
//
//   x-auth-request-email   — verified, lowercased Okta email
//   Authorization: Bearer <JWT>   — the Okta ID token (claims include `name`)
//
// Istio's RequestAuthentication validates the JWT signature upstream of the
// app, so we trust the email header and read the `name` claim without
// re-verifying the signature. We never accept these headers when
// HATCH_OKTA != 'true' so local dev (no Okta gateway) cannot be spoofed by a
// caller setting the header themselves.
//
// On every authenticated request, we make sure a users row exists for the
// caller (default role = 'user'); admins are promoted manually via the
// existing /api/users/:id/role endpoint. We also seed the in-memory sessions
// Map keyed on `okta:<email>` so the rest of the codebase (requireAuth,
// requireAdmin, getUserEmail, comments author resolution, activity recipients)
// keeps working unchanged.

import express from 'express'
import { run, get } from './db.js'
import { sessions, SESSION_COOKIE, setSessionCookie } from './auth.js'

export const oktaEnabled = (): boolean =>
  process.env.HATCH_OKTA === 'true' || process.env.HATCH_OKTA === '1'

const EMAIL_HEADER = 'x-auth-request-email'

const decodeJwtName = (authHeader: string | undefined): string => {
  if (!authHeader) return ''
  const parts = authHeader.replace(/^Bearer\s+/i, '').split('.')
  if (parts.length !== 3) return ''
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    )
    if (typeof payload?.name === 'string' && payload.name.trim()) return payload.name.trim()
    if (typeof payload?.given_name === 'string' && payload?.family_name) {
      return `${payload.given_name} ${payload.family_name}`.trim()
    }
  } catch { /* malformed JWT — fall through */ }
  return ''
}

const ensureUserRow = async (email: string, name: string): Promise<{ id: number; role: string }> => {
  const existing = await get('SELECT id, role, display_name FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
  if (existing) {
    // Backfill display_name lazily — only when the column is empty or the
    // Okta-supplied name has changed (e.g. legal name update). One UPDATE per
    // change, not per request.
    if (name && existing.display_name !== name) {
      await run('UPDATE users SET display_name = ? WHERE id = ?', [name, existing.id]).catch(() => {})
    }
    return { id: existing.id, role: existing.role }
  }
  // Random hash — Okta-only users never authenticate by password, but the
  // column is NOT NULL on the existing schema.
  const placeholder = `okta:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const result = await run(
    'INSERT INTO users (email, password_hash, role, display_name) VALUES (?, ?, ?, ?)',
    [email.toLowerCase(), placeholder, 'viewer', name || null]
  ) as any
  return { id: result.lastID, role: 'viewer' }
}

// Stable per-email session id so we don't churn the sessions Map / sessions
// table on every request. Using a deterministic prefix means the existing
// session-cookie path continues to identify the user across page loads.
const sessionIdFor = (email: string): string => `okta:${email.toLowerCase()}`

// Tracks emails whose display_name has been reconciled this process lifetime,
// so we only run the SELECT+UPDATE once per pod even when sessions were
// hydrated from disk and ensureUserRow doesn't otherwise fire.
const nameSyncedThisProcess = new Set<string>()
const syncDisplayName = async (email: string, name: string) => {
  if (!name || nameSyncedThisProcess.has(email)) return
  nameSyncedThisProcess.add(email)
  const row = await get('SELECT id, display_name FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any
  if (row && row.display_name !== name) {
    await run('UPDATE users SET display_name = ? WHERE id = ?', [name, row.id]).catch(() => {})
  }
}

export const oktaMiddleware: express.RequestHandler = async (req, res, next) => {
  const rawEmail = req.headers[EMAIL_HEADER]
  const email = (typeof rawEmail === 'string' ? rawEmail : '').trim().toLowerCase()
  if (!email) {
    // No identity from oauth2-proxy. Should be impossible behind the gateway,
    // but if it ever happens we don't want to fall through to bcrypt login.
    return res.status(401).json({ error: 'Okta identity missing' })
  }

  try {
    const sid = sessionIdFor(email)
    // Hot path: session already cached (and still trusted — role changes call
    // invalidateUserSessions which clears the cache, forcing a fresh lookup).
    let userId: number
    let role: string
    const name = decodeJwtName(req.headers.authorization as string | undefined)
    const cached = sessions.get(sid)
    if (cached) {
      userId = cached.userId
      role = cached.role
      // Cached sessions skip ensureUserRow, so reconcile name here (once/process).
      syncDisplayName(email, name).catch(() => {})
    } else {
      const ensured = await ensureUserRow(email, name)
      userId = ensured.id
      role = ensured.role
      if (name) nameSyncedThisProcess.add(email)
    }

    sessions.set(sid, { userId, email, role })
    // Populate the cookie on BOTH sides of the request: the response so the
    // browser keeps it, and the in-memory request.cookies so downstream
    // middleware (requireAuth) finds it on this very request — without this
    // the first request after Okta SSO would 401.
    if (!(req as any).cookies) (req as any).cookies = {}
    if (!(req as any).cookies[SESSION_COOKIE]) {
      ;(req as any).cookies[SESSION_COOKIE] = sid
      setSessionCookie(res, sid)
    }
    ;(req as any).session = { userId, email, role, name }
    ;(req as any).oktaName = name
    next()
  } catch (e: any) {
    console.error('Okta middleware error:', e)
    res.status(500).json({ error: 'Okta identity bootstrap failed' })
  }
}

// Small handler the SPA can call to learn its identity in one shot
// (email + role + Okta-supplied display name).
export const oktaWhoamiHandler: express.RequestHandler = (req, res) => {
  const session = (req as any).session
  if (!session) return res.status(401).json({ error: 'Not authenticated' })
  res.json({
    id: session.userId,
    email: session.email,
    role: session.role,
    name: session.name || '',
    okta: true,
  })
}

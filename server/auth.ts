import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { run, get, all } from './db.js';
import { broadcast } from './sse.js';

// Session store: durable in SQLite, cached in memory for synchronous reads.
// Writes go to both stores; expired entries are pruned from both on login
// and via a periodic cleanup interval.
//
// Persisting across container rebuilds (Railway wipes the in-memory state
// every deploy) means cookies keep working, so admins don't get kicked to
// login after every code push. The Map is kept for synchronous .has()/.get()
// in existing middleware and review.ts callbacks.
export const sessions: Map<string, { userId: number; email: string; role: string }> = new Map();

export const SESSION_COOKIE = 'dcc_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const generateSessionId = () => crypto.randomBytes(32).toString('hex');

// Read session id from HttpOnly cookie first, then fall back to x-session-id header
// (the SPA still uses the header; the cookie is authoritative for browser navigation).
export const getSessionIdFromRequest = (req: express.Request): string | null => {
  const fromCookie = (req as any).cookies?.[SESSION_COOKIE]
  if (fromCookie && typeof fromCookie === 'string') return fromCookie
  const fromHeader = req.headers['x-session-id']
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader
  return null
}

export const setSessionCookie = (res: express.Response, sessionId: string) => {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  })
}

export const clearSessionCookie = (res: express.Response) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

export const getUserEmail = (req: express.Request): string | null => {
  const sessionId = getSessionIdFromRequest(req)
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId)!.email
  }
  return null
}

// Auth middleware
export const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  (req as any).session = sessions.get(sessionId);
  next();
};

// Auth middleware - admin only
export const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(sessionId);
  if (session?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin only' });
  }
  (req as any).session = session;
  next();
};

// Auth middleware - blocks viewer-role writes. Viewers can authenticate and
// read everything but cannot mutate state, with the exception of review
// comments which are gated separately at the route layer (see server.ts
// viewerWriteAllowedPaths).
export const requireWrite = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(sessionId);
  if (session?.role === 'viewer') {
    return res.status(403).json({ error: 'Read-only role: writes are not permitted' });
  }
  (req as any).session = session;
  next();
};

// Version guard — reject writes from stale client bundles
export const createVersionGuard = (getSiteVersion: () => string) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const clientVersion = req.headers['x-client-version'] as string
    const SITE_VERSION = getSiteVersion()
    if (!clientVersion || clientVersion !== SITE_VERSION) {
      return res.status(409).json({
        error: 'Version mismatch',
        message: 'A new version has been deployed. Please refresh the page.',
        server_version: SITE_VERSION,
        client_version: clientVersion || 'none',
      })
    }
    next()
  }
}

// Durable session store backing the in-memory Map. Calls to persistSession /
// removePersistedSession are best-effort — a DB write failure shouldn't kill
// the login flow, just means that particular session won't survive a restart.
const persistSession = async (sessionId: string, userId: number, email: string, role: string) => {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  try {
    await run(
      `INSERT OR REPLACE INTO sessions (id, user_id, email, role, created_at, expires_at)
       VALUES (?, ?, ?, ?, datetime('now'), ?)`,
      [sessionId, userId, email, role, expiresAt]
    )
  } catch (err) {
    console.error('Session persist failed:', err)
  }
}

const removePersistedSession = async (sessionId: string) => {
  try { await run('DELETE FROM sessions WHERE id = ?', [sessionId]) } catch (err) { console.error('Session remove failed:', err) }
}

// Wipe every session for a user from both stores. Call this on any change
// that should invalidate existing tokens: delete, role change, password
// change. Always excludes the session passed in `keepSessionId` so an admin
// rotating their own password stays logged in.
export const invalidateUserSessions = async (userId: number, keepSessionId?: string) => {
  try {
    const rows = await all('SELECT id FROM sessions WHERE user_id = ?', [userId]) as any[]
    for (const r of rows) {
      if (keepSessionId && r.id === keepSessionId) continue
      sessions.delete(r.id)
    }
    if (keepSessionId) {
      await run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, keepSessionId])
    } else {
      await run('DELETE FROM sessions WHERE user_id = ?', [userId])
    }
  } catch (err) {
    console.error('invalidateUserSessions failed:', err)
  }
}

const pruneExpiredSessions = async () => {
  try {
    const removed = await run(`DELETE FROM sessions WHERE expires_at < datetime('now')`) as any
    // sqlite3 returns `.changes` on the statement; also drop any expired rows
    // from the in-memory cache so we don't serve stale auth.
    if (removed?.changes > 0) {
      const live = new Set((await all('SELECT id FROM sessions') as any[]).map(r => r.id))
      for (const id of sessions.keys()) if (!live.has(id)) sessions.delete(id)
    }
  } catch (err) {
    console.error('Session prune failed:', err)
  }
}

// Create users + sessions tables, hydrate in-memory cache, seed admin.
export const initUsers = async () => {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user', 'viewer')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`ALTER TABLE users ADD COLUMN display_name TEXT`).catch(() => {})
  await run(`ALTER TABLE users ADD COLUMN access_requested_at TEXT`).catch(() => {})

  // Migration: relax the role CHECK to allow 'viewer'. Older installs were
  // created with CHECK(role IN ('admin','user')) which would reject any
  // UPDATE setting role='viewer'. SQLite can't ALTER a CHECK in place, so
  // rebuild the table when we detect the old constraint.
  try {
    const sqlRow = await get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
    ) as { sql?: string } | undefined
    const hasOldCheck = !!sqlRow?.sql && /CHECK\(\s*role\s+IN\s*\(\s*'admin'\s*,\s*'user'\s*\)\s*\)/i.test(sqlRow.sql)
    if (hasOldCheck) {
      console.log('Migrating users.role CHECK to include viewer...')
      await run('PRAGMA foreign_keys = OFF')
      await run('BEGIN TRANSACTION')
      await run(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user', 'viewer')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        display_name TEXT,
        access_requested_at TEXT
      )`)
      await run('INSERT INTO users_new (id, email, password_hash, role, created_at, display_name) SELECT id, email, password_hash, role, created_at, display_name FROM users')
      await run('DROP TABLE users')
      await run('ALTER TABLE users_new RENAME TO users')
      await run('COMMIT')
      await run('PRAGMA foreign_keys = ON')
      console.log('users.role migration complete')
    }
  } catch (err) {
    console.error('users.role migration failed:', err)
    await run('ROLLBACK').catch(() => {})
    await run('PRAGMA foreign_keys = ON').catch(() => {})
  }

  await run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`)
  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`).catch(() => {})

  // Drop anything already expired before loading; then hydrate the Map so
  // existing cookies keep working across server restarts.
  await run(`DELETE FROM sessions WHERE expires_at < datetime('now')`).catch(() => {})
  try {
    const rows = await all('SELECT id, user_id, email, role FROM sessions') as any[]
    sessions.clear()
    for (const r of rows) sessions.set(r.id, { userId: r.user_id, email: r.email, role: r.role })
    if (rows.length > 0) console.log(`Hydrated ${rows.length} session(s) from disk`)
  } catch (err) {
    console.error('Session hydration failed:', err)
  }

  // Periodic cleanup (hourly). One interval per process; tsx watch restarts
  // create a new one but the old one is GC'd with the module.
  setInterval(() => { pruneExpiredSessions() }, 60 * 60 * 1000)

  try {
    const existingAdmin = await get('SELECT id FROM users WHERE email = ?', ['paul.more@dowjones.com']);
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash('W43verwan08!26', 10);
      await run(
        'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
        ['paul.more@dowjones.com', hashedPassword, 'admin']
      );
      console.log('Admin user seeded: paul.more@dowjones.com');
    }
  } catch (err) {
    console.error('Error seeding admin user:', err);
  }
};

// Auth routes
export const authRouter = express.Router();

authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]) as any;
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const sessionId = generateSessionId();
    sessions.set(sessionId, { userId: user.id, email: user.email, role: user.role });
    // Best-effort persist so the session survives container restarts.
    persistSession(sessionId, user.id, user.email, user.role).catch(() => {})
    setSessionCookie(res, sessionId);

    res.json({
      sessionId,
      user: { id: user.id, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/logout', (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    sessions.delete(sessionId);
    removePersistedSession(sessionId).catch(() => {})
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const session = (req as any).session;
  res.json({
    id: session.userId,
    email: session.email,
    role: session.role,
    // Populated by oktaMiddleware on Hatch; absent on the bcrypt path.
    ...(session.name ? { name: session.name } : {}),
    ...(session.name ? { okta: true } : {}),
  });
});

// User management routes
export const usersRouter = express.Router();

usersRouter.get('/', requireAdmin, async (_req, res) => {
  try {
    const users = await all('SELECT id, email, display_name, role, access_requested_at, created_at FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Pending access requests (admin only). Used by the persistent banner.
usersRouter.get('/access-requests', requireAdmin, async (_req, res) => {
  try {
    const rows = await all(
      `SELECT id, email, display_name, access_requested_at FROM users
       WHERE access_requested_at IS NOT NULL ORDER BY access_requested_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching access requests:', err);
    res.status(500).json({ error: 'Failed to fetch access requests' });
  }
});

// Any authenticated user can flag themselves as requesting full access. The
// /api routes layer (server.ts) carves this out so viewers aren't blocked by
// requireWrite — that's the whole point of this endpoint.
usersRouter.post('/request-access', requireAuth, async (req, res) => {
  try {
    const session = (req as any).session;
    await run(
      `UPDATE users SET access_requested_at = datetime('now') WHERE id = ? AND access_requested_at IS NULL`,
      [session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error recording access request:', err);
    res.status(500).json({ error: 'Failed to record access request' });
  }
});

usersRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { email, password, role = 'user' } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (role !== 'admin' && role !== 'user' && role !== 'viewer') {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await run(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [email, hashedPassword, role]
    );

    res.json({ id: (result as any).lastID, email, role });
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

usersRouter.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const session = (req as any).session;
    if (parseInt(id) === session.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    await run('DELETE FROM users WHERE id = ?', [id]);
    // Invalidate all of that user's active sessions so they can't keep
    // making authenticated requests after being removed.
    await invalidateUserSessions(parseInt(id));
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Admin-only role change. Any existing sessions for the target user are
// invalidated so the new role takes effect immediately (no waiting for the
// 30-day session TTL).
usersRouter.put('/:id/role', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (role !== 'admin' && role !== 'user' && role !== 'viewer') {
      return res.status(400).json({ error: 'Role must be "admin", "user", or "viewer"' });
    }
    const session = (req as any).session;
    if (parseInt(id) === session.userId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    const existing = await get('SELECT id, email FROM users WHERE id = ?', [id]) as any;
    if (!existing) return res.status(404).json({ error: 'User not found' });

    await run('UPDATE users SET role = ?, access_requested_at = NULL WHERE id = ?', [role, id]);
    await invalidateUserSessions(parseInt(id));
    // Tell every connected client to re-check their identity. The target's
    // SPA will see role: changed via /api/auth/me; everyone else's check
    // is a no-op. Cheaper than per-session push channels.
    broadcast('role-change', { userId: parseInt(id), email: existing.email, role });
    res.json({ success: true, id: parseInt(id), role });
  } catch (err) {
    console.error('Error updating user role:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

usersRouter.put('/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const session = (req as any).session;

    const user = await get('SELECT password_hash FROM users WHERE id = ?', [session.userId]) as any;
    const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, session.userId]);

    // Log out every other device on password change. Keep the current
    // session so the user isn't immediately kicked out of the app that just
    // performed the password rotation.
    const currentSessionId = getSessionIdFromRequest(req) || undefined;
    await invalidateUserSessions(session.userId, currentSessionId);

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating password:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

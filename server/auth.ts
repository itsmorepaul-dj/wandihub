import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { run, get, all } from './db.js';

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
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

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
  res.json({ id: session.userId, email: session.email, role: session.role });
});

// User management routes
export const usersRouter = express.Router();

usersRouter.get('/', requireAdmin, async (_req, res) => {
  try {
    const users = await all('SELECT id, email, role, created_at FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

usersRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { email, password, role = 'user' } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
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
    try {
      const rows = await all('SELECT id FROM sessions WHERE user_id = ?', [id]) as any[]
      for (const r of rows) sessions.delete(r.id)
      await run('DELETE FROM sessions WHERE user_id = ?', [id])
    } catch (e) { /* best-effort */ }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
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

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating password:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

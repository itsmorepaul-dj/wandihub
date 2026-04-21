import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { run, get, all } from './db.js';

// In-memory session store
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

// Create users table and seed admin
export const initUsers = async () => {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

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

import express from 'express';
import { run, get, SEED_SECRET } from './db.js';
import { sessions } from './auth.js';
import { broadcast } from './sse.js';

export const maintenanceState = {
  enabled: false,
  bannerMessage: '',
  lockoutMessage: 'Wandi Hub will be back soon.',
  countdownTarget: null as string | null,
}

export function isInLockout(): boolean {
  if (!maintenanceState.enabled) return false
  if (!maintenanceState.countdownTarget) return true
  return new Date() >= new Date(maintenanceState.countdownTarget)
}

export function getMaintenancePayload() {
  return {
    enabled: maintenanceState.enabled,
    bannerMessage: maintenanceState.bannerMessage,
    lockoutMessage: maintenanceState.lockoutMessage,
    countdownTarget: maintenanceState.countdownTarget,
    isLockout: isInLockout(),
  }
}

export async function saveMaintenanceState() {
  await run(
    `INSERT OR REPLACE INTO app_versions (key, db_version, db_time) VALUES ('maintenance', ?, ?)`,
    [JSON.stringify(maintenanceState), new Date().toISOString()]
  )
}

export async function loadMaintenanceState() {
  try {
    const row = await get(`SELECT db_version FROM app_versions WHERE key = 'maintenance'`) as any
    if (row?.db_version) {
      const saved = JSON.parse(row.db_version)
      Object.assign(maintenanceState, saved)
      if (maintenanceState.enabled) {
        console.log(`Maintenance mode restored from DB: ON — countdown: ${maintenanceState.countdownTarget || 'immediate'}`)
      }
    }
  } catch (e) {
    // No saved state, use defaults
  }
}

export const MAINTENANCE_HTML = (message: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wandi Hub - Maintenance</title>
  <meta http-equiv="refresh" content="30">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0e0;
    }
    .card {
      text-align: center;
      padding: 3rem 2.5rem;
      max-width: 480px;
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    .icon { font-size: 3.5rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.75rem; color: #fff; }
    p { font-size: 1rem; line-height: 1.6; color: #b0b8c8; margin-bottom: 1.5rem; }
    .pulse {
      display: inline-block;
      width: 8px; height: 8px;
      background: #53c98d;
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    .status { font-size: 0.85rem; color: #7a8599; }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }
    .admin-link {
      display: inline-block;
      margin-top: 2rem;
      color: rgba(255,255,255,0.1);
      font-size: 0.7rem;
      text-decoration: none;
      cursor: pointer;
      transition: color 0.2s;
    }
    .admin-link:hover { color: rgba(255,255,255,0.4); }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#128736;</div>
    <h1>Scheduled Maintenance</h1>
    <p>${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    <div class="status"><span class="pulse"></span>This page auto-refreshes every 30 seconds</div>
    <a href="/?admin=1" class="admin-link">Admin access</a>
  </div>
</body>
</html>`

// Maintenance mode middleware
export function maintenanceMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!maintenanceState.enabled) return next()
  if (!isInLockout()) return next()
  const isMaintenanceEndpoint = req.path === '/api/maintenance'
  const isHealthEndpoint = req.path === '/api/health' || req.path === '/api/versions' || req.path === '/api/table-counts' || req.path === '/api/events'
  const isAuthEndpoint = req.path.startsWith('/api/auth/')
  const isActivityEndpoint = req.path === '/api/activity'
  const isDbEndpoint = (req.path === '/api/upload-db' || req.path === '/api/download-db') && SEED_SECRET && req.headers['x-seed-secret'] === SEED_SECRET
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
  const sessionId = req.headers['x-session-id'] as string
  const session = sessionId ? sessions.get(sessionId) : null
  const isAdminUser = session?.role === 'admin'
  const isAdminLogin = req.query.admin === '1'
  const isStaticAsset = /\.(js|css|ico|svg|png|jpg|woff2?)$/i.test(req.path)
  const isImageServe = req.method === 'GET' && req.path.startsWith('/api/images/')
  if (isMaintenanceEndpoint || isHealthEndpoint || isAuthEndpoint || isActivityEndpoint || isDbEndpoint || isLocalhost || isAdminUser || isAdminLogin || isStaticAsset || isImageServe) return next()
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'maintenance', message: maintenanceState.lockoutMessage })
  }
  res.status(503).send(MAINTENANCE_HTML(maintenanceState.lockoutMessage))
}

// Maintenance routes
export const maintenanceRouter = express.Router();

maintenanceRouter.get('/', (req, res) => {
  res.json(getMaintenancePayload())
})

maintenanceRouter.post('/', (req, res) => {
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
  const hasSeedToken = SEED_SECRET && req.headers['x-seed-secret'] === SEED_SECRET
  const sessionId = req.headers['x-session-id'] as string
  const session = sessionId ? sessions.get(sessionId) : null
  const isAdmin = session?.role === 'admin'
  if (!isLocalhost && !hasSeedToken && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (req.body.enabled !== undefined) maintenanceState.enabled = !!req.body.enabled
  if (req.body.bannerMessage !== undefined) maintenanceState.bannerMessage = req.body.bannerMessage
  if (req.body.lockoutMessage !== undefined) maintenanceState.lockoutMessage = req.body.lockoutMessage
  if (req.body.countdownTarget !== undefined) maintenanceState.countdownTarget = req.body.countdownTarget || null
  if (req.body.message && !req.body.bannerMessage) maintenanceState.bannerMessage = req.body.message
  saveMaintenanceState()
  console.log(`Maintenance mode: ${maintenanceState.enabled ? 'ON' : 'OFF'}${maintenanceState.enabled ? ' — countdown: ' + (maintenanceState.countdownTarget || 'immediate') : ''}`)
  const payload = getMaintenancePayload()
  broadcast('maintenance', payload)
  res.json(payload)
})

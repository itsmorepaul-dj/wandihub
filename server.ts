import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';

import { initSchema, validateSchemaOnStartup, SEED_SECRET } from './server/db.js';
import { sessions, requireAuth, authRouter, usersRouter, initUsers, createVersionGuard } from './server/auth.js';
import { broadcast, createSSEHandler } from './server/sse.js';
import { maintenanceMiddleware, maintenanceRouter, loadMaintenanceState, getMaintenancePayload } from './server/maintenance.js';
import { SITE_VERSION, initVersions, versionRouter } from './server/version.js';

import projectsRouter from './server/routes/projects.js';
import teamRouter from './server/routes/team.js';
import capacityRouter from './server/routes/capacity.js';
import notesRouter from './server/routes/notes.js';
import dataRouter from './server/routes/data.js';
import adminRouter from './server/routes/admin.js';
import weeklyRouter, { startWeeklyCron } from './server/routes/weekly.js';
import imagesRouter from './server/routes/images.js';
import reviewItemImagesRouter from './server/routes/review-item-images.js';
import reviewRouter, { startReviewCron } from './server/routes/review.js';
import { startReminderCron } from './server/reminders.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.raw({ type: 'image/*', limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// ============ VERSION GUARD ============
// Reject writes from stale client bundles
const versionGuard = createVersionGuard(() => SITE_VERSION)
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
    const skipPaths = ['/api/auth/', '/api/upload-db', '/api/seed', '/api/maintenance', '/api/review-items/', '/api/images', '/api/review-item-images', '/api/review-item-comments']
    if (skipPaths.some(p => req.path.startsWith(p))) return next()
    return versionGuard(req, res, next)
  }
  next()
})

// ============ AUTH ROUTES (before maintenance middleware) ============
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);

// ============ MAINTENANCE MIDDLEWARE ============
app.use('/api/maintenance', maintenanceRouter);
app.use(maintenanceMiddleware);

// ============ SSE ============
app.get('/api/events', createSSEHandler(() => SITE_VERSION, getMaintenancePayload));

// ============ AUTH GUARD FOR WRITES ============
app.use('/api', (req, res, next) => {
  const alwaysSkipPaths = ['/auth/login', '/auth/logout', '/auth/me', '/health', '/versions', '/events']
  const isReadOnly = req.method === 'GET'
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'
  const isSeedEndpoint = req.path === '/seed' || req.path === '/upload-db' || req.path === '/download-db'
  const hasSeedToken = isSeedEndpoint && SEED_SECRET && req.headers['x-seed-secret'] === SEED_SECRET

  const shouldSkip = alwaysSkipPaths.some(p => req.path.startsWith(p)) || isReadOnly || (isSeedEndpoint && isLocalhost) || hasSeedToken

  if (shouldSkip) return next()
  requireAuth(req, res, next)
})

// ============ ROUTE MODULES ============
app.use('/api', projectsRouter);
app.use('/api', teamRouter);
app.use('/api', capacityRouter);
app.use('/api', notesRouter);
app.use('/api', dataRouter);
app.use('/api', adminRouter);
app.use('/api', weeklyRouter);
app.use('/api', imagesRouter);
app.use('/api', reviewItemImagesRouter);
app.use('/api/versions', versionRouter);
app.use(reviewRouter);

// ============ STATIC FILES (production) ============
const DIST_PATH = path.join(process.cwd(), 'dist');
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  try {
    app.use(express.static(DIST_PATH));
    app.get('/', (req, res) => {
      res.sendFile(path.join(DIST_PATH, 'index.html'));
    });
  } catch (e) {
    console.error('Error serving static files:', e);
  }
}

// ============ STARTUP ============
async function startup() {
  try {
    await initSchema();
    await initUsers();
    await initVersions();
    await loadMaintenanceState();
    await validateSchemaOnStartup();
    console.log('Schema initialization complete');
  } catch (e) {
    console.error('Startup error:', e);
  }
}

startup().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log(`Production mode: ${isProduction}`);
    startWeeklyCron();
    startReviewCron();
    startReminderCron();
  });
});

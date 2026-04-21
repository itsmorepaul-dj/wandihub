import express from 'express';
import fs from 'fs';
import path from 'path';
import { run, get, all } from '../db.js';
import { IMAGES_DIR } from '../db.js';

const router = express.Router();

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

// List images for a project (or all if no project_id)
router.get('/images', async (req, res) => {
  try {
    const projectId = req.query.project_id as string;
    if (projectId) {
      const images = await all(
        'SELECT * FROM project_images WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC',
        [projectId]
      );
      return res.json(images);
    }
    // Return all images (for loading counts/thumbnails on project cards)
    const images = await all('SELECT * FROM project_images ORDER BY project_id, sort_order ASC, created_at ASC');
    res.json(images);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Reorder images for a project
router.put('/images/reorder', async (req, res) => {
  try {
    const { project_id, image_ids } = req.body as { project_id?: string; image_ids?: string[] };
    if (!project_id || !Array.isArray(image_ids)) {
      return res.status(400).json({ error: 'project_id and image_ids[] required' });
    }
    for (let i = 0; i < image_ids.length; i++) {
      await run('UPDATE project_images SET sort_order = ? WHERE id = ? AND project_id = ?', [i, image_ids[i], project_id]);
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Serve an image file
router.get('/images/:id', async (req, res) => {
  try {
    const image = await get('SELECT * FROM project_images WHERE id = ?', [req.params.id]);
    if (!image) return res.status(404).json({ error: 'Image not found' });
    const filePath = path.join(IMAGES_DIR, image.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', image.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    fs.createReadStream(filePath).pipe(res);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Upload an image (binary body)
router.post('/images', async (req, res) => {
  try {
    const projectId = req.headers['x-project-id'] as string;
    if (!projectId) return res.status(400).json({ error: 'X-Project-Id header required' });

    const contentType = req.headers['content-type'] || 'image/png';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Only image uploads allowed' });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    console.log(`[image-upload] content-type=${contentType} body-type=${typeof req.body} isBuffer=${Buffer.isBuffer(req.body)} size=${buffer.length}`);

    if (buffer.length === 0) return res.status(400).json({ error: 'Empty file — body was not received as a buffer' });
    if (buffer.length > MAX_SIZE) return res.status(400).json({ error: 'File too large (max 10MB)' });

    const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = `${id}.${ext}`;

    fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);

    const maxRow = await get('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM project_images WHERE project_id = ?', [projectId]);
    const nextOrder = (maxRow?.max_order ?? -1) + 1;

    await run(
      `INSERT INTO project_images (id, project_id, filename, original_name, mime_type, size_bytes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, filename, req.headers['x-original-name'] || filename, contentType, buffer.length, nextOrder]
    );

    const saved = await get('SELECT * FROM project_images WHERE id = ?', [id]);
    res.json(saved);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Update image caption
router.put('/images/:id', async (req, res) => {
  try {
    const { caption } = req.body;
    await run('UPDATE project_images SET caption = ? WHERE id = ?', [caption || '', req.params.id]);
    const saved = await get('SELECT * FROM project_images WHERE id = ?', [req.params.id]);
    if (!saved) return res.status(404).json({ error: 'Image not found' });
    res.json(saved);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Delete an image
router.delete('/images/:id', async (req, res) => {
  try {
    const image = await get('SELECT * FROM project_images WHERE id = ?', [req.params.id]);
    if (!image) return res.status(404).json({ error: 'Image not found' });

    // Delete file
    const filePath = path.join(IMAGES_DIR, image.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await run('DELETE FROM project_images WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

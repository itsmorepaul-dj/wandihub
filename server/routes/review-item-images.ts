import express from 'express';
import fs from 'fs';
import path from 'path';
import { run, get, all } from '../db.js';
import { IMAGES_DIR } from '../db.js';

const router = express.Router();

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

// List images for a review item
router.get('/review-items/:id/images', async (req, res) => {
  try {
    const images = await all(
      'SELECT * FROM review_item_images WHERE review_item_id = ? ORDER BY sort_order ASC, created_at ASC',
      [req.params.id]
    );
    res.json(images);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Reorder images within a review item
router.put('/review-items/:id/images/reorder', async (req, res) => {
  try {
    const { image_ids } = req.body as { image_ids?: string[] };
    if (!Array.isArray(image_ids)) {
      return res.status(400).json({ error: 'image_ids[] required' });
    }
    for (let i = 0; i < image_ids.length; i++) {
      await run(
        'UPDATE review_item_images SET sort_order = ? WHERE id = ? AND review_item_id = ?',
        [i, image_ids[i], req.params.id]
      );
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Upload an image to a review item (binary body)
router.post('/review-items/:id/images', async (req, res) => {
  try {
    const reviewItemId = req.params.id;
    const parent = await get('SELECT id FROM review_items WHERE id = ?', [reviewItemId]);
    if (!parent) return res.status(404).json({ error: 'Review item not found' });

    const contentType = req.headers['content-type'] || 'image/png';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Only image uploads allowed' });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length === 0) return res.status(400).json({ error: 'Empty file — body was not received as a buffer' });
    if (buffer.length > MAX_SIZE) return res.status(400).json({ error: 'File too large (max 10MB)' });

    const id = `rimg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = `${id}.${ext}`;

    fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);

    const maxRow = await get(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM review_item_images WHERE review_item_id = ?',
      [reviewItemId]
    );
    const nextOrder = (maxRow?.max_order ?? -1) + 1;

    // X-Original-Name is sent percent-encoded (HTTP headers are ISO-8859-1,
    // filenames may contain emoji/accents). Decode back to the display string;
    // fall back to the raw value if decoding fails.
    const rawOriginalName = req.headers['x-original-name'];
    let originalName = filename;
    if (typeof rawOriginalName === 'string' && rawOriginalName) {
      try { originalName = decodeURIComponent(rawOriginalName); }
      catch { originalName = rawOriginalName; }
    }

    await run(
      `INSERT INTO review_item_images (id, review_item_id, filename, original_name, mime_type, size_bytes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, reviewItemId, filename, originalName, contentType, buffer.length, nextOrder]
    );

    const saved = await get('SELECT * FROM review_item_images WHERE id = ?', [id]);
    res.json(saved);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Serve a review-item image file
router.get('/review-item-images/:id', async (req, res) => {
  try {
    const image = await get('SELECT * FROM review_item_images WHERE id = ?', [req.params.id]);
    if (!image) return res.status(404).json({ error: 'Image not found' });
    const filePath = path.join(IMAGES_DIR, image.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', image.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    fs.createReadStream(filePath).pipe(res);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Update caption
router.put('/review-item-images/:id', async (req, res) => {
  try {
    const { caption } = req.body;
    await run('UPDATE review_item_images SET caption = ? WHERE id = ?', [caption || '', req.params.id]);
    const saved = await get('SELECT * FROM review_item_images WHERE id = ?', [req.params.id]);
    if (!saved) return res.status(404).json({ error: 'Image not found' });
    res.json(saved);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Delete image (row + file)
router.delete('/review-item-images/:id', async (req, res) => {
  try {
    const image = await get('SELECT * FROM review_item_images WHERE id = ?', [req.params.id]);
    if (!image) return res.status(404).json({ error: 'Image not found' });

    const filePath = path.join(IMAGES_DIR, image.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e: any) { console.error('Image file delete error:', e.message); }
    }
    await run('DELETE FROM review_item_images WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

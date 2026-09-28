const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { upload } = require('../upload');

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// GET all taps (public)
router.get('/', (req, res) => {
  const db = getDb();
  const taps = db.prepare(`
    SELECT * FROM taps WHERE status != 'deleted' ORDER BY tap_number ASC, name ASC
  `).all();
  res.json(taps);
});

// GET single tap (public)
router.get('/:id', (req, res) => {
  const db = getDb();
  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  if (!tap) return res.status(404).json({ error: 'Not found' });
  res.json(tap);
});

// POST create tap (auth required)
router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  const id = uuidv4();
  const {
    tap_number, tap_label, name, style, producer, abv, ibu, description,
    tasting_notes, category, status, keg_level, untappd_url,
    brewfather_id, brewers_friend_id, grainfather_id,
    external_source, external_id, serving_size, serve_method, glassware,
    on_tap_date, price, color, image_url, pipeline_stage
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  db.prepare(`
    INSERT INTO taps (
      id, tap_number, tap_label, name, style, producer, abv, ibu, description,
      tasting_notes, category, status, keg_level, untappd_url,
      brewfather_id, brewers_friend_id, grainfather_id,
      external_source, external_id, serving_size, serve_method, glassware,
      on_tap_date, price, color, image_url, pipeline_stage
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    id, tap_number || null, tap_label || null, name, style || null, producer || null,
    abv || null, ibu || null, description || null, tasting_notes || null,
    category || 'beer', status || 'active', keg_level ?? 100,
    untappd_url || null, brewfather_id || null, brewers_friend_id || null,
    grainfather_id || null, external_source || null, external_id || null,
    serving_size || '16oz', serve_method || null, glassware || null,
    on_tap_date || null, price || null, color || null, image_url || null, pipeline_stage || null
  );

  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(id);
  res.status(201).json(tap);
});

// POST upload a tap image file (auth required) — returns a URL to use as image_url
router.post('/upload-image', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// PUT update tap (auth required)
router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = [
    'tap_number', 'tap_label', 'name', 'style', 'producer', 'abv', 'ibu', 'description',
    'tasting_notes', 'category', 'status', 'keg_level', 'untappd_url',
    'brewfather_id', 'brewers_friend_id', 'grainfather_id',
    'external_source', 'external_id', 'serving_size', 'serve_method', 'glassware',
    'on_tap_date', 'price', 'color', 'image_url', 'pipeline_stage'
  ];

  const updates = [];
  const values = [];

  fields.forEach(field => {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  });

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);

  db.prepare(`UPDATE taps SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  res.json(tap);
});

// PATCH keg level (auth required)
router.patch('/:id/keg-level', requireAuth, (req, res) => {
  const db = getDb();
  const { level } = req.body;
  if (level === undefined || level < 0 || level > 100) {
    return res.status(400).json({ error: 'Level must be 0-100' });
  }
  db.prepare('UPDATE taps SET keg_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(level, req.params.id);
  res.json({ id: req.params.id, keg_level: level });
});

// DELETE tap (auth required - soft delete)
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE taps SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);
  res.json({ success: true });
});

module.exports = router;

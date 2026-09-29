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

// Keeps the beers library current with the latest details for a beer.
// Matches on case-insensitive (name, producer) — brewfather_id is NOT used
// for matching because it's different for every batch of the same recipe.
// Never throws: a failure here must not block a tap save.
function upsertBeerFromTap(db, tap) {
  if (!tap.name || !tap.name.trim()) return;
  try {
    const producer = tap.producer || null;
    const existing = producer
      ? db.prepare('SELECT id FROM beers WHERE LOWER(name) = LOWER(?) AND LOWER(producer) = LOWER(?)').get(tap.name, producer)
      : db.prepare('SELECT id FROM beers WHERE LOWER(name) = LOWER(?) AND producer IS NULL').get(tap.name);

    const fields = {
      name: tap.name, producer: tap.producer || null, style: tap.style || null,
      abv: tap.abv || null, ibu: tap.ibu || null, description: tap.description || null,
      tasting_notes: tap.tasting_notes || null, category: tap.category || null,
      untappd_url: tap.untappd_url || null, serving_size: tap.serving_size || null,
      color: tap.color || null, image_url: tap.image_url || null,
      brewfather_id: tap.brewfather_id || null, brewers_friend_id: tap.brewers_friend_id || null,
      grainfather_id: tap.grainfather_id || null, external_source: tap.external_source || null,
      external_id: tap.external_id || null
    };

    if (existing) {
      db.prepare(`
        UPDATE beers SET
          name=?, producer=?, style=?, abv=?, ibu=?, description=?, tasting_notes=?,
          category=?, untappd_url=?, serving_size=?, color=?, image_url=?,
          brewfather_id=?, brewers_friend_id=?, grainfather_id=?, external_source=?, external_id=?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        fields.name, fields.producer, fields.style, fields.abv, fields.ibu, fields.description,
        fields.tasting_notes, fields.category, fields.untappd_url, fields.serving_size, fields.color,
        fields.image_url, fields.brewfather_id, fields.brewers_friend_id, fields.grainfather_id,
        fields.external_source, fields.external_id, existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO beers (
          id, name, producer, style, abv, ibu, description, tasting_notes, category,
          untappd_url, serving_size, color, image_url, brewfather_id, brewers_friend_id,
          grainfather_id, external_source, external_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), fields.name, fields.producer, fields.style, fields.abv, fields.ibu,
        fields.description, fields.tasting_notes, fields.category, fields.untappd_url,
        fields.serving_size, fields.color, fields.image_url, fields.brewfather_id,
        fields.brewers_friend_id, fields.grainfather_id, fields.external_source, fields.external_id
      );
    }
  } catch (e) {
    console.warn('Beer upsert warning:', e.message);
  }
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
  upsertBeerFromTap(db, tap);
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
  upsertBeerFromTap(db, tap);
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

// POST promote a coming-soon tap onto an available tap number (auth required)
router.post('/:id/promote', requireAuth, (req, res) => {
  const db = getDb();
  const tapNumber = parseInt(req.body.tap_number, 10);
  if (!Number.isInteger(tapNumber) || tapNumber < 1) {
    return res.status(400).json({ error: 'tap_number must be a positive integer' });
  }

  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  if (!tap) return res.status(404).json({ error: 'Not found' });
  if (tap.status !== 'coming-soon') {
    return res.status(400).json({ error: 'Only a coming-soon tap can be promoted' });
  }

  const activeOccupant = db.prepare(
    "SELECT id FROM taps WHERE tap_number = ? AND status = 'active' AND id != ?"
  ).get(tapNumber, tap.id);
  if (activeOccupant) {
    return res.status(409).json({ error: `Tap ${tapNumber} is already active` });
  }

  // Clear out any kicked/hidden row currently sitting on that number — but never
  // touch another coming-soon beer that happens to share the number (e.g. one
  // pre-assigned for planning purposes); just free it from that tap instead.
  db.prepare(
    "UPDATE taps SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE tap_number = ? AND status IN ('kicked', 'hidden') AND id != ?"
  ).run(tapNumber, tap.id);
  db.prepare(
    "UPDATE taps SET tap_number = NULL, updated_at = CURRENT_TIMESTAMP WHERE tap_number = ? AND status = 'coming-soon' AND id != ?"
  ).run(tapNumber, tap.id);

  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    UPDATE taps SET
      tap_number = ?, status = 'active', pipeline_stage = NULL,
      keg_level = 100, on_tap_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(tapNumber, today, tap.id);

  const updated = db.prepare('SELECT * FROM taps WHERE id = ?').get(tap.id);
  res.json(updated);
});

// DELETE tap (auth required - soft delete)
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE taps SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);
  res.json({ success: true });
});

module.exports = router;

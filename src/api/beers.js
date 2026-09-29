const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

const FIELDS = [
  'name', 'producer', 'style', 'abv', 'ibu', 'description', 'tasting_notes',
  'category', 'untappd_url', 'serving_size', 'color', 'image_url',
  'brewfather_id', 'brewers_friend_id', 'grainfather_id', 'external_source', 'external_id'
];

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const beers = db.prepare('SELECT * FROM beers ORDER BY name ASC').all();
  res.json(beers);
});

router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const beer = db.prepare('SELECT * FROM beers WHERE id = ?').get(req.params.id);
  if (!beer) return res.status(404).json({ error: 'Not found' });
  res.json(beer);
});

router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM beers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const values = [];
  FIELDS.forEach(field => {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(req.params.id);

  db.prepare(`UPDATE beers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const beer = db.prepare('SELECT * FROM beers WHERE id = ?').get(req.params.id);
  res.json(beer);
});

router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM beers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;

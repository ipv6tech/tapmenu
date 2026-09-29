const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { upload } = require('../upload');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Login
router.post('/login', (req, res) => {
  const db = getDb();
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check auth status
router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
  }
});

// Setup first admin (only works if no users exist)
router.post('/setup', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existing.count > 0) {
    return res.status(403).json({ error: 'Setup already complete' });
  }

  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 chars) required' });
  }

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, hash);
  req.session.userId = id;
  req.session.username = username;
  res.json({ success: true });
});

// Change password
router.post('/change-password', requireAuth, (req, res) => {
  const db = getDb();
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);
  res.json({ success: true });
});

// POST logo upload (auth required)
router.post('/upload-logo', requireAuth, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  // Save to settings
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('logo_url', url);
  res.json({ url });
});

// GET settings (public)
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// PUT settings (auth required)
router.put('/settings', requireAuth, (req, res) => {
  const db = getDb();
  const allowed = [
    'taproom_name', 'brewery_name', 'establishment_name',
    'tagline', 'display_theme', 'show_abv', 'show_ibu', 'show_price',
    'show_keg_level', 'show_style', 'show_producer', 'show_category',
    'show_serve_method', 'show_glassware', 'show_tasting_notes', 'show_on_tap_date',
    'show_description', 'show_serving_size',
    'pipeline_enabled', 'pipeline_title', 'pipeline_refresh_mins',
    'pipeline_packaged_label', 'tap_count', 'hidden_tap_numbers',
    'show_qr_codes', 'menu_page_enabled',
    'custom_css',
    'accent_color', 'logo_url', 'display_layout', 'use_logo_as_brand', 'logo_size',
    'brewfather_api_user_id', 'brewfather_api_key'
  ];
  try {
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Settings save error:', err);
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

module.exports = router;

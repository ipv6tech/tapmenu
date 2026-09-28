const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getDb } = require('../db');

// Generate a QR code that sends the drinker to the beer's Untappd page,
// for rating or checking in. Only exists when the tap has an Untappd URL set.
router.get('/:id', async (req, res) => {
  const db = getDb();

  const qrSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('show_qr_codes');
  if (qrSetting && qrSetting.value === '0') return res.status(404).json({ error: 'Not found' });

  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  if (!tap) return res.status(404).json({ error: 'Not found' });
  if (!tap.untappd_url) return res.status(404).json({ error: 'Not found' });

  const url = tap.untappd_url;

  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getDb } = require('../db');

// Generate QR code for a tap's detail page
router.get('/:id', async (req, res) => {
  const db = getDb();
  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  if (!tap) return res.status(404).json({ error: 'Not found' });

  const baseUrl = req.query.base_url || `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/tap/${tap.id}`;

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

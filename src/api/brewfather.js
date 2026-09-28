const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function getBrewfatherCreds() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').all(
    'brewfather_api_user_id', 'brewfather_api_key'
  );
  const creds = {};
  rows.forEach(r => { creds[r.key] = r.value; });
  return {
    userId: creds['brewfather_api_user_id'] || '',
    apiKey: creds['brewfather_api_key'] || ''
  };
}

function makeAuthHeader(userId, apiKey) {
  const encoded = Buffer.from(`${userId}:${apiKey}`).toString('base64');
  return `Basic ${encoded}`;
}

// GET /api/brewfather/batches - list batches from Brewfather
router.get('/batches', requireAuth, async (req, res) => {
  const { userId, apiKey } = getBrewfatherCreds();
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'Brewfather API credentials not configured. Add them in Settings > Integrations.' });
  }

  try {
    const statusParam = req.query.status || 'Fermenting,Conditioning,Completed';
    // Brewfather's /batches status filter only accepts a single status value per
    // request (no comma-separated list), so fetch each requested status separately
    // and merge the results.
    const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean);
    const include = 'recipe.style,recipe.ibu,recipe.abv,recipe.color,recipe.tasteNotes,measuredAbv';

    const batchLists = await Promise.all(statuses.map(async (status) => {
      const url = `https://api.brewfather.app/v2/batches?include=${encodeURIComponent(include)}&status=${encodeURIComponent(status)}&limit=50`;
      const response = await fetch(url, {
        headers: {
          'Authorization': makeAuthHeader(userId, apiKey),
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401) {
          throw Object.assign(new Error('Invalid Brewfather credentials. Check your User ID and API Key.'), { status: 401 });
        }
        throw Object.assign(new Error(`Brewfather API error: ${response.status} ${errText}`), { status: response.status });
      }

      return response.json();
    }));

    // De-duplicate in case a batch is ever returned under more than one status
    const seen = new Set();
    const batches = [];
    for (const list of batchLists) {
      for (const b of list) {
        if (!seen.has(b._id)) { seen.add(b._id); batches.push(b); }
      }
    }

    // Map Brewfather batch fields to our tap format
    const mapped = batches.map(b => mapBatchToTap(b));
    res.json(mapped);

  } catch (err) {
    console.error('Brewfather fetch error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to reach Brewfather API: ' + err.message });
  }
});

// GET /api/brewfather/batches/:id - get single batch detail
router.get('/batches/:id', requireAuth, async (req, res) => {
  const { userId, apiKey } = getBrewfatherCreds();
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'Brewfather credentials not configured.' });
  }

  try {
    const url = `https://api.brewfather.app/v2/batches/${req.params.id}`;
    const response = await fetch(url, {
      headers: { 'Authorization': makeAuthHeader(userId, apiKey) }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Batch not found in Brewfather' });
    }

    const batch = await response.json();
    res.json(mapBatchToTap(batch));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/brewfather/import/:id - import a batch as a new tap
router.post('/import/:id', requireAuth, async (req, res) => {
  const { userId, apiKey } = getBrewfatherCreds();
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'Brewfather credentials not configured.' });
  }

  const db = getDb();
  const { v4: uuidv4 } = require('uuid');

  try {
    const url = `https://api.brewfather.app/v2/batches/${req.params.id}`;
    const response = await fetch(url, {
      headers: { 'Authorization': makeAuthHeader(userId, apiKey) }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Batch not found in Brewfather' });
    }

    const batch = await response.json();
    const tap = mapBatchToTap(batch);
    const id = uuidv4();

    // Check if this brewfather batch is already imported
    const existing = db.prepare("SELECT id FROM taps WHERE brewfather_id = ? AND status != 'deleted'").get(batch._id);
    if (existing) {
      return res.status(409).json({ error: 'This batch is already on your tap list.', existing_id: existing.id });
    }

    // Map Brewfather batch status → tap status
    const tapStatus = brewfatherStatusToTapStatus(batch.status);
    const pipelineStage = brewfatherStatusToPipelineStage(batch.status);

    db.prepare(`
      INSERT INTO taps (
        id, tap_number, name, style, producer, abv, ibu, description,
        tasting_notes, category, status, pipeline_stage, keg_level, brewfather_id, brewfather_batch_no,
        external_source, external_id, serving_size, color, image_url, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      id,
      req.body.tap_number || null,
      tap.name,
      tap.style || null,
      tap.producer || null,
      tap.abv || null,
      tap.ibu || null,
      tap.description || null,
      tap.tasting_notes || null,
      tap.category || 'beer',
      tapStatus,
      pipelineStage,
      100,
      batch._id,
      batch.batchNo || null,
      'brewfather',
      batch._id,
      '16oz',
      tap.color || null,
      tap.image_url || null
    );

    const created = db.prepare('SELECT * FROM taps WHERE id = ?').get(id);
    res.status(201).json(created);

  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/brewfather/import-bulk - import multiple batches at once
router.post('/import-bulk', requireAuth, async (req, res) => {
  const { userId, apiKey } = getBrewfatherCreds();
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'Brewfather credentials not configured.' });
  }

  const { batches: batchAssignments } = req.body;
  // batchAssignments: [{ brewfather_id, tap_number (optional) }, ...]
  if (!Array.isArray(batchAssignments) || !batchAssignments.length) {
    return res.status(400).json({ error: 'No batches provided.' });
  }

  const db = getDb();
  const { v4: uuidv4 } = require('uuid');
  const results = { imported: [], skipped: [], errors: [] };

  for (const assignment of batchAssignments) {
    const { brewfather_id, tap_number } = assignment;
    try {
      // Check already imported
      const existing = db.prepare("SELECT id FROM taps WHERE brewfather_id = ? AND status != 'deleted'").get(brewfather_id);
      if (existing) {
        results.skipped.push({ brewfather_id, reason: 'Already on tap list' });
        continue;
      }

      const url = `https://api.brewfather.app/v2/batches/${brewfather_id}`;
      const response = await fetch(url, {
        headers: { 'Authorization': makeAuthHeader(userId, apiKey) }
      });
      if (!response.ok) {
        results.errors.push({ brewfather_id, reason: `Brewfather error: ${response.status}` });
        continue;
      }

      const batch = await response.json();
      const tap = mapBatchToTap(batch);
      const id = uuidv4();
      const tapStatus = brewfatherStatusToTapStatus(batch.status);
      const pipelineStage = brewfatherStatusToPipelineStage(batch.status);

      db.prepare(`
        INSERT INTO taps (
          id, tap_number, name, style, producer, abv, ibu, description,
          tasting_notes, category, status, pipeline_stage, keg_level, brewfather_id, brewfather_batch_no,
          external_source, external_id, serving_size, color, image_url, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        id, tap_number || null, tap.name, tap.style || null, tap.producer || null,
        tap.abv || null, tap.ibu || null, tap.description || null, tap.tasting_notes || null,
        tap.category || 'beer', tapStatus, pipelineStage, 100,
        batch._id, batch.batchNo || null,
        'brewfather', batch._id, '16oz', tap.color || null, tap.image_url || null
      );

      const created = db.prepare('SELECT * FROM taps WHERE id = ?').get(id);
      results.imported.push(created);

    } catch (err) {
      results.errors.push({ brewfather_id, reason: err.message });
    }
  }

  res.json(results);
});

// POST /api/brewfather/sync/:tap_id - refresh a tap from its linked Brewfather batch
router.post('/sync/:tap_id', requireAuth, async (req, res) => {
  const { userId, apiKey } = getBrewfatherCreds();
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'Brewfather credentials not configured.' });
  }

  const db = getDb();
  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.tap_id);
  if (!tap) return res.status(404).json({ error: 'Tap not found' });
  if (!tap.brewfather_id) return res.status(400).json({ error: 'This tap is not linked to a Brewfather batch' });

  try {
    const url = `https://api.brewfather.app/v2/batches/${tap.brewfather_id}`;
    const response = await fetch(url, {
      headers: { 'Authorization': makeAuthHeader(userId, apiKey) }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Could not fetch batch from Brewfather' });
    }

    const batch = await response.json();
    const updated = mapBatchToTap(batch);
    const mappedStatus = brewfatherStatusToTapStatus(batch.status);
    // A promoted (active) tap must never be pulled back to coming-soon by a
    // sync just because Brewfather hasn't caught up to Completed/Archived yet.
    const tapStatus = (tap.status === 'active' && mappedStatus === 'coming-soon') ? 'active' : mappedStatus;
    const pipelineStage = tapStatus === 'coming-soon' ? brewfatherStatusToPipelineStage(batch.status) : null;

    db.prepare(`
      UPDATE taps SET
        name = ?, style = ?, producer = ?, abv = ?, ibu = ?, description = ?,
        tasting_notes = ?, color = ?, image_url = ?, brewfather_batch_no = ?,
        status = ?, pipeline_stage = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      updated.name,
      updated.style || tap.style,
      updated.producer || tap.producer,
      updated.abv || tap.abv,
      updated.ibu || tap.ibu,
      updated.description || tap.description,
      updated.tasting_notes || tap.tasting_notes,
      updated.color || tap.color,
      updated.image_url || tap.image_url,
      batch.batchNo || tap.brewfather_batch_no || null,
      tapStatus,
      pipelineStage,
      tap.id
    );

    const result = db.prepare('SELECT * FROM taps WHERE id = ?').get(tap.id);
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/brewfather/sync-all - sync all taps linked to Brewfather
router.post('/sync-all', requireAuth, async (req, res) => {
  const { userId, apiKey } = getBrewfatherCreds();
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'Brewfather credentials not configured.' });
  }

  const db = getDb();
  const linkedTaps = db.prepare("SELECT * FROM taps WHERE brewfather_id IS NOT NULL AND status != 'deleted'").all();
  if (!linkedTaps.length) {
    return res.json({ synced: [], errors: [] });
  }

  const results = { synced: [], errors: [] };

  for (const tap of linkedTaps) {
    try {
      const url = `https://api.brewfather.app/v2/batches/${tap.brewfather_id}`;
      const response = await fetch(url, {
        headers: { 'Authorization': makeAuthHeader(userId, apiKey) }
      });
      if (!response.ok) {
        results.errors.push({ id: tap.id, name: tap.name, reason: `Brewfather error: ${response.status}` });
        continue;
      }

      const batch = await response.json();
      const updated = mapBatchToTap(batch);
      const mappedStatus = brewfatherStatusToTapStatus(batch.status);
      // A promoted (active) tap must never be pulled back to coming-soon by a
      // sync just because Brewfather hasn't caught up to Completed/Archived yet.
      const tapStatus = (tap.status === 'active' && mappedStatus === 'coming-soon') ? 'active' : mappedStatus;
      const pipelineStage = tapStatus === 'coming-soon' ? brewfatherStatusToPipelineStage(batch.status) : null;

      db.prepare(`
        UPDATE taps SET
          name = ?, style = ?, producer = ?, abv = ?, ibu = ?, description = ?,
          tasting_notes = ?, color = ?, image_url = ?, brewfather_batch_no = ?,
          status = ?, pipeline_stage = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        updated.name, updated.style || tap.style,
        updated.producer || tap.producer,
        updated.abv || tap.abv, updated.ibu || tap.ibu,
        updated.description || tap.description,
        updated.tasting_notes || tap.tasting_notes,
        updated.color || tap.color, updated.image_url || tap.image_url,
        batch.batchNo || tap.brewfather_batch_no || null,
        tapStatus, pipelineStage, tap.id
      );

      results.synced.push({ id: tap.id, name: updated.name });
    } catch (err) {
      results.errors.push({ id: tap.id, name: tap.name, reason: err.message });
    }
  }

  res.json(results);
});

// Map Brewfather batch status → Tap Menu tap status
function brewfatherStatusToTapStatus(bfStatus) {
  switch (bfStatus) {
    case 'Planning':
    case 'Brewing':
    case 'Fermenting':
    case 'Conditioning':
      return 'coming-soon';
    case 'Completed':
      return 'active';
    case 'Archived':
      return 'kicked';
    default:
      return 'active';
  }
}

// Map Brewfather batch status → pipeline stage (only meaningful while the
// tap status is 'coming-soon'; NULL once it becomes active/kicked)
function brewfatherStatusToPipelineStage(bfStatus) {
  switch (bfStatus) {
    case 'Planning':
      return 'planned';
    case 'Brewing':
      return 'brewing';
    case 'Fermenting':
      return 'fermenting';
    case 'Conditioning':
      return 'packaged';
    default:
      return null;
  }
}

// Helper: map a Brewfather batch object to our tap schema
function mapBatchToTap(batch) {
  const recipe = batch.recipe || {};
  const style = recipe.style || {};

  // Use measured ABV if available, fall back to recipe ABV
  const abv = batch.measuredAbv || recipe.abv || null;

  // IBU from recipe
  const ibu = recipe.ibu ? Math.round(recipe.ibu) : null;

  // Guess category from style type
  const category = guessCategoryFromStyle(style, recipe);

  // SRM color → hex approximation
  const srmColor = recipe.color ? srmToHex(recipe.color) : null;

  // Tasting notes from batch
  const tastingNotes = batch.tasteNotes || (batch.tasteLogs && batch.tasteLogs.length > 0
    ? batch.tasteLogs[batch.tasteLogs.length - 1].tasteNotes
    : null);

  // Description from batch notes or recipe notes
  const description = batch.batchNotes || recipe.notes || null;

  return {
    name: recipe.name || batch.name || 'Unnamed Batch',
    style: style.name || recipe.style?.category || null,
    producer: batch.brewer || recipe.author || null,
    abv: abv ? parseFloat(abv.toFixed(1)) : null,
    ibu,
    category,
    description: description ? description.slice(0, 500) : null,
    tasting_notes: tastingNotes ? tastingNotes.slice(0, 300) : null,
    color: srmColor,
    image_url: batch.img_url || recipe.img_url || null,
    brewfather_id: batch._id,
    // Extra metadata for display
    _batch_status: batch.status,
    _batch_no: batch.batchNo,
    _brew_date: batch.brewDate,
    _og: batch.measuredOg || recipe.og,
    _fg: batch.measuredFg || recipe.fg,
  };
}

function guessCategoryFromStyle(style, recipe) {
  const name = ((style.name || '') + ' ' + (style.category || '') + ' ' + (recipe.name || '')).toLowerCase();
  if (name.includes('mead')) return 'mead';
  if (name.includes('cider')) return 'cider';
  if (name.includes('seltzer') || name.includes('hard seltzer')) return 'seltzer';
  if (name.includes('ipa') || name.includes('india pale')) return 'ipa';
  if (name.includes('stout') || name.includes('porter')) return 'stout';
  if (name.includes('sour') || name.includes('lambic') || name.includes('gose') || name.includes('berliner')) return 'sour';
  if (name.includes('wheat') || name.includes('hefeweizen') || name.includes('witbier')) return 'wheat';
  if (name.includes('lager') || name.includes('pilsner') || name.includes('märzen') || name.includes('bock')) return 'lager';
  if (style.type === 'Lager') return 'lager';
  return 'craft-beer';
}

// Approximate SRM value to a hex color for display
function srmToHex(srm) {
  const srmColors = [
    [1, '#FFE699'], [2, '#FFD878'], [3, '#FFCA5A'], [4, '#FFBF42'],
    [5, '#FBB123'], [6, '#F8A600'], [7, '#F39C00'], [8, '#EA8F00'],
    [9, '#E58500'], [10, '#DE7C00'], [12, '#D77200'], [14, '#CF6900'],
    [16, '#CB6200'], [18, '#C35D00'], [20, '#BB5100'], [24, '#B54C00'],
    [28, '#B04500'], [32, '#A63E00'], [36, '#A13700'], [40, '#9B3200'],
  ];
  const clamp = Math.max(1, Math.min(srm, 40));
  for (let i = srmColors.length - 1; i >= 0; i--) {
    if (clamp >= srmColors[i][0]) return srmColors[i][1];
  }
  return '#FFE699';
}

module.exports = router;

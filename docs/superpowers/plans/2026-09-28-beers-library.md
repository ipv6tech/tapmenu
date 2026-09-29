# Beers Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `beers` catalog, decoupled from `taps`, so a beer that's been on tap before can be re-tapped by picking it from a list instead of retyping its details.

**Architecture:** A new `beers` table stores descriptive fields only (no tap-instance fields like status/keg_level/on_tap_date). Every tap create/update auto-upserts a matching beer row (case-insensitive match on name+producer). A new admin-only `/api/beers` REST API backs a "Beers" admin panel (list/edit/delete) and a picker in the Add Tap drawer that prefills the form from a chosen beer.

**Tech Stack:** Node/Express, sql.js-backed `src/db.js` wrapper (see `getDb().prepare(...).run/get/all`, no native better-sqlite3 despite what older docs say), vanilla JS frontend in `public/index.html`, no test framework — manual curl/DB verification per this repo's convention.

**Spec:** `docs/superpowers/specs/2026-09-28-beers-library-design.md`

## Global Constraints

- No FK from `taps` to `beers` — a tap created from a beer is fully independent afterward (spec: Schema).
- Beer matching key is case-insensitive `(name, producer)` only — never `brewfather_id` (spec: Data flow §1; Scott: brewfather_id differs per batch of the same recipe).
- Beer upsert failures must never fail the tap create/update request — log and continue (spec: Data flow §1, Error handling).
- `/api/beers` routes are all `requireAuth` — no public route (spec: API).
- Deleting a beer must never modify or delete any `taps` row (spec: Data flow §3, Error handling).
- Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, matching this repo's existing `runMigrations()` pattern in `src/db.js`).

## Review Focus

- Two taps with the same name but different producers (e.g. a house IPA vs. a guest IPA of the same name) must NOT be treated as the same beer — match is `(name, producer)` together, not name alone.
- A tap with an empty/whitespace-only `name` must not create a garbage beer row — the spec's upsert trigger is "non-empty `name`"; empty producer (`null`/`''`) must still match consistently across taps (e.g. two taps both with no producer and the same name should still dedupe to one beer).
- Updating a tap's name to a *new* value must not silently rewrite the *old* beer row's name out from under other taps still referencing that name — the upsert only touches the beer matching the tap's *current* post-update `(name, producer)`, so this is a re-match, not an in-place rename of a stale row. Confirmed by Task 3's test cases 2 and 4.
- The Add Tap drawer's beer picker must not be requestable/visible from the public (unauthenticated) side — it only appears inside the auth-gated admin drawer, and its data (`GET /api/beers`) is itself `requireAuth`, so an unauthenticated user gets a 401, not an empty list that looks intentional.
- Deleting a beer that shares a name with an *active* tap must leave that tap's display page rendering completely unaffected (no FK, no cascading field nulling) — exercised by Task 2's delete test.

---

## Task 1: `beers` table migration

**Files:**
- Modify: `src/db.js` (add table to `initSchema()`'s `CREATE TABLE` block, alongside the existing `taps`/`settings`/`users` tables)

**Interfaces:**
- Produces: a `beers` table with columns `id, name, producer, style, abv, ibu, description, tasting_notes, category, untappd_url, serving_size, color, image_url, brewfather_id, brewers_friend_id, grainfather_id, external_source, external_id, created_at, updated_at` — consumed by Tasks 2 and 3.

- [ ] **Step 1: Add the `CREATE TABLE IF NOT EXISTS beers` statement**

In `src/db.js`, inside `initSchema()`, add this table definition to the same template string that already creates `taps`, `settings`, and `users` (insert it right after the `taps` table definition, before `settings`):

```sql
    CREATE TABLE IF NOT EXISTS beers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      producer TEXT,
      style TEXT,
      abv REAL,
      ibu INTEGER,
      description TEXT,
      tasting_notes TEXT,
      category TEXT,
      untappd_url TEXT,
      serving_size TEXT,
      color TEXT,
      image_url TEXT,
      brewfather_id TEXT,
      brewers_friend_id TEXT,
      grainfather_id TEXT,
      external_source TEXT,
      external_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 2: Verify the table is created on a fresh DB**

Run:
```bash
rm -f /tmp/beers-plan-test.db
DB_PATH=/tmp/beers-plan-test.db node -e "
const { initDb, getDb } = require('./src/db');
initDb().then(() => {
  const row = getDb().prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='beers'\").get();
  console.log(row ? 'PASS: beers table exists' : 'FAIL: beers table missing');
});
"
```
Expected: `PASS: beers table exists`

- [ ] **Step 3: Verify running `initDb()` twice against the same file is safe (idempotent migration)**

Run the exact same command from Step 2 again against the same `/tmp/beers-plan-test.db` (don't delete it first).
Expected: same `PASS: beers table exists` output, no thrown error.

- [ ] **Step 4: Commit**

```bash
git add src/db.js
git commit -m "Add beers table for the beers library (#7)"
```

---

## Task 2: Beers CRUD API

**Files:**
- Create: `src/api/beers.js`
- Modify: `server.js` (mount the new router)

**Interfaces:**
- Consumes: `getDb()` from `src/db.js` (Task 1's `beers` table); the `requireAuth` middleware pattern already used in `src/api/taps.js` (reimplemented locally the same way `taps.js` does — there's no shared middleware module in this codebase).
- Produces: `GET /api/beers` (list, ordered by `name ASC`), `GET /api/beers/:id`, `PUT /api/beers/:id`, `DELETE /api/beers/:id` — consumed by Task 4 (frontend Beers panel) and Task 5 (Add Tap picker, `GET` only).

- [ ] **Step 1: Write `src/api/beers.js`**

```javascript
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
```

- [ ] **Step 2: Mount the router in `server.js`**

Add near the other router requires (after the `brewfatherRouter` require at line 11):
```javascript
const beersRouter = require('./src/api/beers');
```
Add near the other `app.use('/api/...')` mounts (after `app.use('/api/brewfather', brewfatherRouter);` at line 36):
```javascript
  app.use('/api/beers', beersRouter);
```

- [ ] **Step 3: Manual verification — auth is enforced and CRUD works**

Start the server against a scratch DB:
```bash
rm -f /tmp/beers-plan-test.db
DB_PATH=/tmp/beers-plan-test.db node server.js
```
(background/separate terminal; note the port it logs)

```bash
# No session -> 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/beers
# Expected: 401

# Create admin + log in, keeping cookies
curl -s -c /tmp/beers-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'
curl -s -b /tmp/beers-cookies.txt -c /tmp/beers-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'

# List (should be empty array)
curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers
# Expected: []

# Manually insert a beer row to test GET/PUT/DELETE (no POST route exists per spec — beers are created only via tap upsert, Task 3)
DB_PATH=/tmp/beers-plan-test.db node -e "
const { initDb, getDb } = require('./src/db');
const { v4: uuidv4 } = require('uuid');
initDb().then(() => {
  const id = uuidv4();
  getDb().prepare('INSERT INTO beers (id, name, producer) VALUES (?, ?, ?)').run(id, 'Test IPA', 'Test Brewery');
  console.log(id);
});
" > /tmp/beer-id.txt
BEER_ID=$(cat /tmp/beer-id.txt | tail -1)

curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers/$BEER_ID
# Expected: JSON with name "Test IPA"

curl -s -b /tmp/beers-cookies.txt -X PUT http://localhost:3000/api/beers/$BEER_ID \
  -H 'Content-Type: application/json' -d '{"style":"West Coast IPA"}'
# Expected: JSON with style "West Coast IPA"

curl -s -b /tmp/beers-cookies.txt -X DELETE http://localhost:3000/api/beers/$BEER_ID
curl -s -o /dev/null -w "%{http_code}\n" -b /tmp/beers-cookies.txt http://localhost:3000/api/beers/$BEER_ID
# Expected: 404 (deleted)
```
Stop the server, and delete `/tmp/beers-plan-test.db`, `/tmp/beers-cookies.txt`, `/tmp/beer-id.txt` afterward.

- [ ] **Step 4: Commit**

```bash
git add src/api/beers.js server.js
git commit -m "Add beers CRUD API (admin-only)"
```

---

## Task 3: Auto-upsert beers from tap create/update

**Files:**
- Modify: `src/api/taps.js` (the `POST /` handler and `PUT /:id` handler)

**Interfaces:**
- Consumes: `beers` table (Task 1).
- Produces: an `upsertBeerFromTap(db, tapFields)` helper function in `src/api/taps.js`, called from both the create and update handlers — no other task depends on this function's name since it's internal to `taps.js`.

- [ ] **Step 1: Add the `upsertBeerFromTap` helper to `src/api/taps.js`**

Add this function near the top of the file, after the `requireAuth` definition:

```javascript
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
      const { v4: uuidv4 } = require('uuid');
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

module.exports.upsertBeerFromTap = upsertBeerFromTap; // exported for direct testing in Step 2
```

Note: the `uuidv4` require is already imported at the top of `taps.js` (`const { v4: uuidv4 } = require('uuid');`) — use that existing import instead of re-requiring inline; remove the inline `require('uuid')` line from the snippet above when applying this edit.

- [ ] **Step 2: Wire the helper into the `POST /` handler**

In the existing `POST /` handler in `taps.js`, right after the `const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(id);` line and before `res.status(201).json(tap);`, add:
```javascript
  upsertBeerFromTap(db, tap);
```

- [ ] **Step 3: Wire the helper into the `PUT /:id` handler**

In the existing `PUT /:id` handler, right after `const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);` (the one that runs after the `UPDATE`) and before `res.json(tap);`, add:
```javascript
  upsertBeerFromTap(db, tap);
```

- [ ] **Step 4: Manual verification — dedupe and non-dedupe cases**

```bash
rm -f /tmp/beers-plan-test.db
DB_PATH=/tmp/beers-plan-test.db node server.js
```
(separate terminal)

```bash
curl -s -c /tmp/beers-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'
curl -s -b /tmp/beers-cookies.txt -c /tmp/beers-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'

# Case 1: create a tap -> a matching beer is auto-created
curl -s -b /tmp/beers-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sunset IPA","producer":"Home Brewed","abv":6.2,"tap_number":1,"status":"active"}'
curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers
# Expected: one beer, name "Sunset IPA", abv 6.2

# Case 2: edit that tap's ABV -> beer updates, not duplicated
TAP_ID=$(curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/taps | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[0].id))")
curl -s -b /tmp/beers-cookies.txt -X PUT http://localhost:3000/api/taps/$TAP_ID \
  -H 'Content-Type: application/json' -d '{"abv":6.5}'
curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers
# Expected: still exactly ONE beer, abv now 6.5

# Case 3: create a second tap, same name+producer different case/spacing -> updates same beer, still one row
curl -s -b /tmp/beers-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"SUNSET ipa","producer":"home brewed","tap_number":2,"status":"active"}'
curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers
# Expected: still exactly ONE beer row

# Case 4: create a tap with a different name -> a distinct second beer row
curl -s -b /tmp/beers-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Different Stout","tap_number":3,"status":"active"}'
curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers
# Expected: exactly TWO beer rows now

# Case 5: two taps with same name, no producer on either -> should dedupe to one beer
curl -s -b /tmp/beers-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"No Producer Beer","tap_number":4,"status":"active"}'
curl -s -b /tmp/beers-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"No Producer Beer","tap_number":5,"status":"active"}'
curl -s -b /tmp/beers-cookies.txt http://localhost:3000/api/beers
# Expected: exactly THREE beer rows total (Sunset IPA, Different Stout, No Producer Beer) — not four
```
Stop the server, delete the scratch DB and cookie file afterward.

- [ ] **Step 5: Commit**

```bash
git add src/api/taps.js
git commit -m "Auto-upsert beers library from tap create/update"
```

---

## Task 4: Beers admin panel (list, edit, delete)

**Files:**
- Modify: `public/index.html` (sidebar nav, new admin panel markup, new beer-edit modal/form, JS render/save/delete functions)

**Interfaces:**
- Consumes: `GET /api/beers`, `PUT /api/beers/:id`, `DELETE /api/beers/:id` (Task 2); the existing `api()` helper, `esc()` helper, `toast()` helper, `showPanel(name)` function, `state` object — all already defined in `public/index.html`.
- Produces: `state.beers` (array, loaded alongside `state.taps`), `loadBeers()`, `renderBeersPanel()`, `openBeerEditModal(id)`, `saveBeerEdit()`, `deleteBeer(id)` — `openBeerEditModal` is also consumed by Task 5 indirectly is NOT required; Task 5 only consumes `state.beers` and `GET /api/beers` data already loaded by `loadBeers()`.

- [ ] **Step 1: Add the sidebar nav button**

In the sidebar (around line 393, right after the `sb-coming-soon` button), add:
```html
        <button class="sidebar-btn" id="sb-beers" onclick="showPanel('beers')"><span class="icon">📖</span> Beers Library</button>
```

- [ ] **Step 2: Add the Beers admin panel markup**

Right after the closing `</div>` of the "Coming Soon Panel" block (the panel whose id is `panel-coming-soon`), add a new panel:
```html
        <!-- Beers Library Panel -->
        <div class="admin-panel" id="panel-beers">
          <div class="admin-panel-header">
            <div class="panel-title">Beers Library</div>
          </div>
          <div class="taps-table-wrap">
            <table>
              <thead><tr>
                <th>Name</th><th>Producer</th><th>Style</th><th>ABV</th><th>Last Updated</th><th style="text-align:right">Actions</th>
              </tr></thead>
              <tbody id="admin-beers-tbody"></tbody>
            </table>
          </div>
        </div>
```

- [ ] **Step 3: Add a small edit modal for a beer**

Right after the closing `</div>` of the `<!-- ════ ADD/EDIT DRAWER ════ -->` drawer block, add a lightweight modal reusing the same `.modal`-style classes already used by the tap detail modal (`modal-overlay`/`modal` classes — check their definitions are already used elsewhere in the file for the tap view modal around line ~650-666; reuse those same class names so no new CSS is needed):
Follow the existing tap-modal nesting exactly (`.modal-overlay` is the only element `display:none`-by-default/toggled via `.open`; `.modal` is its child and has no visibility state of its own — making it a sibling would render it inline before it's opened):

```html
<!-- ════ BEER EDIT MODAL ════ -->
<div class="modal-overlay" id="beer-modal-overlay" onclick="closeBeerModalBg(event)">
  <div class="modal">
    <div class="modal-header">
      <div class="modal-tap-name">Edit Beer</div>
      <button class="modal-close" onclick="closeBeerEditModal()">✕</button>
    </div>
    <div class="modal-body">
      <input type="hidden" id="beer-f-id">
      <div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="beer-f-name" type="text"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Producer</label><input class="form-input" id="beer-f-producer" type="text"></div>
        <div class="form-group"><label class="form-label">Style</label><input class="form-input" id="beer-f-style" type="text"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">ABV %</label><input class="form-input" id="beer-f-abv" type="number" step="0.1" min="0"></div>
        <div class="form-group"><label class="form-label">IBU</label><input class="form-input" id="beer-f-ibu" type="number" min="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="beer-f-desc"></textarea></div>
      <div class="form-group"><label class="form-label">Tasting Notes</label><textarea class="form-textarea" id="beer-f-notes"></textarea></div>
      <div class="form-group"><label class="form-label">Untappd URL</label><input class="form-input" id="beer-f-untappd" type="url"></div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-danger btn-sm" style="margin-right:auto" onclick="deleteBeerFromModal()">Delete</button>
        <button class="btn btn-secondary" onclick="closeBeerEditModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveBeerEdit()">Save</button>
      </div>
    </div>
  </div>
</div>
```

Note there is no separate `drawer-footer` element here (that class belongs to the Add/Edit Tap drawer, a different component) — the action buttons are just the last block inside `.modal-body`.

- [ ] **Step 4: Add `state.beers` and `loadBeers()`, call it from `init()`**

In the `state` object definition (around line 893-898), add `beers: [],`:
```javascript
let state = {
  taps: [], settings: {}, beers: [],
  menuFilter: 'all',
  currentLayout: 'grid',
  authenticated: false, editingId: null,
};
```

Add a `loadBeers()` function right after `loadTaps()`'s closing brace:
```javascript
async function loadBeers() {
  try { state.beers = await api('GET', '/beers'); } catch(e) { state.beers = []; }
}
```

In `init()`, add a call to `loadBeers()` after `await loadTaps();`:
```javascript
  await loadBeers();
```

- [ ] **Step 5: Add `renderBeersPanel()` and wire it into `showPanel()`**

In `showPanel(name)`, add a branch alongside the existing `coming-soon`/`integrations` branches:
```javascript
  if (name === 'beers') renderBeersPanel();
```

Add the render function (place it near `renderComingSoonPanel()`):
```javascript
async function renderBeersPanel() {
  await loadBeers();
  const tbody = document.getElementById('admin-beers-tbody');
  if (!state.beers.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:2rem">No beers saved yet. Beers are added automatically when you create or edit a tap.</td></tr>';
    return;
  }
  tbody.innerHTML = state.beers.map(b => `<tr>
    <td style="font-weight:600">${esc(b.name)}</td>
    <td>${b.producer ? esc(b.producer) : '—'}</td>
    <td>${b.style ? esc(b.style) : '—'}</td>
    <td style="font-family:var(--font-mono);font-size:0.78rem">${b.abv ? b.abv+'%' : '—'}</td>
    <td style="font:400 0.72rem var(--font-mono);color:var(--text-muted)">${b.updated_at ? timeAgo(b.updated_at) : '—'}</td>
    <td style="text-align:right"><div style="display:flex;justify-content:flex-end;gap:0.3rem">
      <button class="btn btn-secondary btn-sm btn-icon" onclick="openBeerEditModal('${b.id}')" title="Edit">✏️</button>
      <button class="btn btn-secondary btn-sm btn-icon" onclick="deleteBeer('${b.id}')" title="Delete">🗑</button>
    </div></td>
  </tr>`).join('');
}
```

- [ ] **Step 6: Add `openBeerEditModal`, `closeBeerEditModal`, `saveBeerEdit`, `deleteBeer`, `deleteBeerFromModal`**

Place these near `openDrawer`/`closeDrawer`/`deleteTap`:
```javascript
function closeBeerModalBg(e) { if (e.target === document.getElementById('beer-modal-overlay')) closeBeerEditModal(); }
function openBeerEditModal(id) {
  const b = state.beers.find(x => x.id === id);
  if (!b) return;
  document.getElementById('beer-f-id').value = b.id;
  document.getElementById('beer-f-name').value = b.name || '';
  document.getElementById('beer-f-producer').value = b.producer || '';
  document.getElementById('beer-f-style').value = b.style || '';
  document.getElementById('beer-f-abv').value = b.abv || '';
  document.getElementById('beer-f-ibu').value = b.ibu || '';
  document.getElementById('beer-f-desc').value = b.description || '';
  document.getElementById('beer-f-notes').value = b.tasting_notes || '';
  document.getElementById('beer-f-untappd').value = b.untappd_url || '';
  document.getElementById('beer-modal-overlay').classList.add('open');
}
function closeBeerEditModal() {
  document.getElementById('beer-modal-overlay').classList.remove('open');
}
async function saveBeerEdit() {
  const id = document.getElementById('beer-f-id').value;
  const name = document.getElementById('beer-f-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  const body = {
    name,
    producer: document.getElementById('beer-f-producer').value || null,
    style: document.getElementById('beer-f-style').value || null,
    abv: document.getElementById('beer-f-abv').value || null,
    ibu: document.getElementById('beer-f-ibu').value || null,
    description: document.getElementById('beer-f-desc').value || null,
    tasting_notes: document.getElementById('beer-f-notes').value || null,
    untappd_url: document.getElementById('beer-f-untappd').value || null,
  };
  try {
    await api('PUT', '/beers/' + id, body);
    toast('Beer updated!', 'success');
    closeBeerEditModal();
    await renderBeersPanel();
  } catch(e) { toast(e.message, 'error'); }
}
async function deleteBeer(id) {
  if (!confirm('Delete this beer from the library? Existing taps are not affected.')) return;
  try {
    await api('DELETE', '/beers/' + id);
    toast('Beer deleted', 'success');
    await renderBeersPanel();
  } catch(e) { toast(e.message, 'error'); }
}
async function deleteBeerFromModal() {
  const id = document.getElementById('beer-f-id').value;
  closeBeerEditModal();
  await deleteBeer(id);
}
```

- [ ] **Step 7: Manual browser verification**

Start the app against a scratch DB (`DB_PATH=/tmp/beers-plan-test.db node server.js`), log into `/admin`, create a tap so a beer auto-populates, click "Beers Library" in the sidebar, confirm the row appears, edit it (change style), confirm it saves and re-renders, then delete it and confirm the row disappears and the original tap (check "All Taps" panel) is untouched. Delete the scratch DB afterward.

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "Add Beers Library admin panel (list/edit/delete)"
```

---

## Task 5: Beer picker in the Add Tap drawer

**Files:**
- Modify: `public/index.html` (drawer markup, `openDrawer()`, new picker function)

**Interfaces:**
- Consumes: `state.beers` (populated by Task 4's `loadBeers()`, already loaded on `init()` before the drawer can be opened); existing drawer field ids (`f-name`, `f-producer`, `f-style`, `f-abv`, `f-ibu`, `f-desc`, `f-notes`, `f-category`, `f-serve-method`, `f-glassware`, `f-serving`, `f-color`, `f-image`, `f-untappd`, `f-brewfather`, `f-brewersfriend`, `f-grainfather`) as defined in the existing drawer markup and `openDrawer()`.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add the picker control to the drawer, only shown for new taps**

Right after the `<!-- TAP IDENTITY -->` div's opening content and before its closing `</div>` — i.e., insert this as the first thing inside the "Tap Identity" section, right after the section label div (before the `Tap #`/`Tap Label` form-row) — add:
```html
      <div class="form-group" id="beer-picker-group" style="display:none">
        <label class="form-label">Load from Beers Library</label>
        <select class="form-select" id="f-beer-picker" onchange="applyBeerPick(this.value)">
          <option value="">— Start from scratch —</option>
        </select>
      </div>
```

- [ ] **Step 2: Populate and show/hide the picker in `openDrawer()`**

In `openDrawer(id, defaultStatus)`, the picker should only be offered when adding a *new* tap (not editing), and only when there are beers to pick from. In the `else` branch (the "new tap" branch, right before `document.getElementById('f-status').value = defaultStatus || 'active';`), add:
```javascript
    const pickerGroup = document.getElementById('beer-picker-group');
    const picker = document.getElementById('f-beer-picker');
    if (state.beers.length) {
      picker.innerHTML = '<option value="">— Start from scratch —</option>' +
        state.beers.map(b => `<option value="${b.id}">${esc(b.name)}${b.producer ? ' — ' + esc(b.producer) : ''}</option>`).join('');
      picker.value = '';
      pickerGroup.style.display = '';
    } else {
      pickerGroup.style.display = 'none';
    }
```
And in the `if (id)` branch (editing an existing tap), hide it — add right after `document.getElementById('drawer-delete-btn').style.display = id ? 'inline-flex' : 'none';`:
```javascript
  document.getElementById('beer-picker-group').style.display = 'none';
```

- [ ] **Step 3: Add `applyBeerPick(beerId)`**

Place this near `openDrawer`:
```javascript
function applyBeerPick(beerId) {
  if (!beerId) return;
  const b = state.beers.find(x => x.id === beerId);
  if (!b) return;
  document.getElementById('f-name').value = b.name || '';
  document.getElementById('f-producer').value = b.producer || '';
  document.getElementById('f-category').value = b.category || 'beer';
  document.getElementById('f-style').value = b.style || '';
  document.getElementById('f-abv').value = b.abv || '';
  document.getElementById('f-ibu').value = b.ibu || '';
  document.getElementById('f-desc').value = b.description || '';
  document.getElementById('f-notes').value = b.tasting_notes || '';
  document.getElementById('f-serving').value = b.serving_size || '';
  document.getElementById('f-color').value = b.color || '';
  document.getElementById('f-image').value = b.image_url || '';
  document.getElementById('f-untappd').value = b.untappd_url || '';
  document.getElementById('f-brewfather').value = b.brewfather_id || '';
  document.getElementById('f-brewersfriend').value = b.brewers_friend_id || '';
  document.getElementById('f-grainfather').value = b.grainfather_id || '';
  const imgCurrentWrap = document.getElementById('image-current-wrap');
  if (b.image_url) { document.getElementById('image-current-img').src = b.image_url; imgCurrentWrap.style.display = 'flex'; }
  else { imgCurrentWrap.style.display = 'none'; }
}
```

Note deliberately not prefilled: `tap_number`, `tap_label`, `status`, `on_tap_date`, `price`, `keg_level`, `pipeline_stage`, `serve_method`, `glassware` — these are tap-instance fields the admin still sets themselves per the spec (spec: Data flow §2).

- [ ] **Step 4: Manual browser verification**

Against a scratch DB with at least one beer already saved (create+kick a tap first so a beer exists), open the admin, click "+ Add Tap": confirm the picker appears with the beer listed. Select it: confirm name/style/ABV/description/etc. prefill, while tap #/status/date remain whatever their defaults were. Save the tap, then reopen it for editing: confirm the picker is hidden in edit mode. Delete the scratch DB afterward.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Add beer picker to Add Tap drawer for fast re-tapping"
```

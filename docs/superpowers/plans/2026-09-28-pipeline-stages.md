# Pipeline Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `coming-soon` taps a granular pipeline stage (Planned/Brewing/Fermenting/Packaged) driven by Brewfather status or manual admin choice, surface it correctly in the public pipeline section, add a dedicated admin "Coming Soon" view, and let an admin promote a coming-soon beer directly onto a declared, available physical tap.

**Architecture:** One new nullable column (`taps.pipeline_stage`) and two new settings (`pipeline_packaged_label`, `tap_count`) extend the existing tap/settings model — no new tables. Brewfather status mapping gains a companion function alongside the existing tap-status mapping. A new `POST /api/taps/:id/promote` endpoint handles the tap-number handoff (soft-delete old occupant, reassign the coming-soon tap). Frontend changes are all in `public/index.html`'s existing single-file SPA, following its established patterns (settings-card markup, `showPanel`/`sidebar-btn` navigation, `openDrawer`/`saveTap` flow).

**Tech Stack:** Node/Express, sql.js (SQLite via WASM, wrapped in `src/db.js`), vanilla JS/HTML in `public/index.html`. No build step, no test framework — verification is via curl/node scripts and Playwright, matching this project's established practice.

**Spec:** `docs/superpowers/specs/2026-09-28-pipeline-stages-design.md`

## Global Constraints

- All migrations must be idempotent (`ALTER TABLE ... ADD COLUMN`, caught duplicate-column errors) — see `runMigrations()` in `src/db.js`.
- Every new setting must be added to the `allowed` allowlist in `PUT /api/auth/settings` (`src/api/auth.js`) or it silently won't save.
- `pipeline_stage` is only meaningful when `status = 'coming-soon'`; it must be `NULL` for every other status.
- Only the final stage's label is configurable (`pipeline_packaged_label`); Planned/Brewing/Fermenting stay fixed text.
- No test framework exists in this repo — verify with the dev server (`DB_PATH=/tmp/<scratch>.db node server.js`) plus curl/Playwright, and always kill the dev server and delete the scratch DB when a task's verification is done.

## Review Focus

- **Stale/legacy `coming-soon` rows with `pipeline_stage = NULL`**: the pipeline section and the new admin panel must both fall back to a generic "Coming Soon" grouping/label, not crash or silently drop the tap.
- **Promoting onto a tap number with more than one non-deleted occupant row** (e.g. a `kicked` row and a `hidden` row both sitting on tap 4): the promote endpoint must soft-delete *all* of them, not just the first match.
- **Race on the promote endpoint**: a stale client-side picker sending a `tap_number` that's actually `active` by the time the request lands must get a 409, never silently overwrite an active tap.
- **`tap_count` shrinking below tap numbers currently in use**: an `active` tap on number 15 with `tap_count` set to 12 must keep working (existing taps are never forcibly hidden/deleted by a lowered count) — the count only bounds what's offered as *available*, it doesn't retroactively invalidate existing assignments.
- **Non-numeric or empty `f-num`/promote picker input**: `tap_number` is optional elsewhere in this app (`tap_number || null`) — the promote flow must reject a missing/non-numeric `tap_number` with 400 rather than writing `NaN` or `undefined` into the row.

---

### Task 1: Data model — schema, migration, and settings

**Files:**
- Modify: `src/db.js:134-165` (settings seed), `src/db.js:170-194` (`runMigrations`)
- Modify: `src/api/auth.js:100-111` (settings allowlist)

**Interfaces:**
- Produces: `taps.pipeline_stage` column (TEXT, nullable); settings `pipeline_packaged_label` (default `'Packaged'`) and `tap_count` (default `'12'`), both readable via `GET /api/auth/settings` and writable via `PUT /api/auth/settings`.

- [ ] **Step 1: Write a verification script that checks today's (failing) state**

Create `/tmp/verify-task1.js`:

```js
const path = require('path');
const dbPath = '/tmp/verify-task1.db';
require('fs').rmSync(dbPath, { force: true });
process.env.DB_PATH = dbPath;
const { initDb, getDb } = require(path.join(process.cwd(), 'src/db'));

(async () => {
  await initDb();
  const db = getDb();

  const cols = db.prepare("PRAGMA table_info(taps)").all().map(c => c.name);
  console.log('has pipeline_stage column:', cols.includes('pipeline_stage'));

  const settings = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
    .all('pipeline_packaged_label', 'tap_count');
  console.log('settings found:', settings);

  require('fs').rmSync(dbPath, { force: true });
})();
```

Run: `cd /Users/staylor/git-repos/taplist/tapmenu && node /tmp/verify-task1.js`
Expected (before implementation): `has pipeline_stage column: false` and `settings found: []`

- [ ] **Step 2: Add the migration to `src/db.js`**

In `src/db.js`, add `pipeline_stage` to the `migrations` array in `runMigrations()` (around line 173-178):

```js
  const migrations = [
    `ALTER TABLE taps ADD COLUMN tap_label TEXT`,
    `ALTER TABLE taps ADD COLUMN serve_method TEXT`,
    `ALTER TABLE taps ADD COLUMN glassware TEXT`,
    `ALTER TABLE taps ADD COLUMN on_tap_date TEXT`,
    `ALTER TABLE taps ADD COLUMN brewfather_batch_no INTEGER`,
    `ALTER TABLE taps ADD COLUMN last_synced_at DATETIME`,
    `ALTER TABLE taps ADD COLUMN pipeline_stage TEXT`,
  ];
```

- [ ] **Step 3: Seed the two new settings**

In `src/db.js`, add to the `INSERT OR IGNORE INTO settings` list (around line 156-157, right after `menu_page_enabled`):

```sql
      ('show_qr_codes', '1'),
      ('menu_page_enabled', '1'),
      ('pipeline_packaged_label', 'Packaged'),
      ('tap_count', '12'),
      ('custom_css', ''),
```

- [ ] **Step 4: Add both settings to the PUT allowlist**

In `src/api/auth.js`, extend the `allowed` array (around line 106-107):

```js
    'pipeline_enabled', 'pipeline_title', 'pipeline_refresh_mins',
    'pipeline_packaged_label', 'tap_count',
    'show_qr_codes', 'menu_page_enabled',
```

- [ ] **Step 5: Re-run the verification script and confirm it now passes**

Run: `node /tmp/verify-task1.js`
Expected: `has pipeline_stage column: true` and `settings found:` a 2-element array containing `{key: 'pipeline_packaged_label', value: 'Packaged'}` and `{key: 'tap_count', value: '12'}`.

- [ ] **Step 6: Confirm the migration is idempotent (run twice, no crash)**

Run: `rm -f /tmp/verify-task1.db && node /tmp/verify-task1.js && node /tmp/verify-task1.js`

Wait — the script deletes its own DB file at the end, so this only tests a single fresh init each time. Instead run this idempotency check directly:

```bash
cd /Users/staylor/git-repos/taplist/tapmenu && node -e "
process.env.DB_PATH = '/tmp/verify-task1-idempotent.db';
const { initDb } = require('./src/db');
(async () => {
  await initDb(); // first init: creates + migrates
  await initDb(); // second init on the SAME file: migration must no-op, not throw
  console.log('ran initDb twice with no error');
})();
"
rm -f /tmp/verify-task1-idempotent.db
```

Expected: prints `ran initDb twice with no error` with no thrown exception or "Migration warning" logged for `pipeline_stage`.

- [ ] **Step 7: Clean up and commit**

```bash
rm -f /tmp/verify-task1.js /tmp/verify-task1.db /tmp/verify-task1-idempotent.db
cd /Users/staylor/git-repos/taplist/tapmenu
git add src/db.js src/api/auth.js
git commit -m "Add pipeline_stage column and pipeline/tap-count settings"
```

---

### Task 2: Backend — Brewfather stage mapping and tap field wiring

**Files:**
- Modify: `src/api/brewfather.js:354-369` (add `brewfatherStatusToPipelineStage`, wire into all 4 call sites)
- Modify: `src/api/taps.js:34-62` (POST create), `src/api/taps.js:80-96` (PUT update)

**Interfaces:**
- Consumes: `taps.pipeline_stage` column from Task 1.
- Produces: `brewfatherStatusToPipelineStage(bfStatus)` — pure function, same shape as the existing `brewfatherStatusToTapStatus(bfStatus)` in the same file, returns one of `'planned' | 'brewing' | 'fermenting' | 'packaged' | null`. `POST /api/taps` and `PUT /api/taps/:id` both accept and persist a `pipeline_stage` field.

- [ ] **Step 1: Write a standalone test for the mapping function (fails — function doesn't exist yet)**

Create `/tmp/verify-task2-mapping.js`:

```js
const path = require('path');
const brewfatherRouterModule = require(path.join(process.cwd(), 'src/api/brewfather.js'));
// The mapping functions aren't exported yet — this require alone proves the
// module loads; the real check is that brewfatherStatusToPipelineStage
// doesn't exist as an export.
console.log('module exports keys:', Object.keys(brewfatherRouterModule));
```

Run: `cd /Users/staylor/git-repos/taplist/tapmenu && node /tmp/verify-task2-mapping.js`
Expected (before implementation): the module only exports the Express router (a function), not `brewfatherStatusToPipelineStage` — confirming the mapping function isn't accessible yet for direct testing. (Since the plan wires it in inline rather than exporting it, the real verification is via the API — see Step 4.)

- [ ] **Step 2: Add the mapping function**

In `src/api/brewfather.js`, right after `brewfatherStatusToTapStatus` (around line 354-369), add:

```js
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
```

- [ ] **Step 3: Wire it into all 4 Brewfather call sites**

In `src/api/brewfather.js`, at each of the 4 places that call `brewfatherStatusToTapStatus(batch.status)` (`POST /import/:id`, `POST /import-bulk`, `POST /sync/:tap_id`, `POST /sync-all`), add the companion call right after and thread it into the SQL:

For `POST /import/:id` (around line 138):
```js
    const tapStatus = brewfatherStatusToTapStatus(batch.status);
    const pipelineStage = brewfatherStatusToPipelineStage(batch.status);
```
Then add `pipeline_stage` to that INSERT's column list and VALUES placeholders, passing `pipelineStage` as the corresponding bound value (same pattern as the other columns in that statement).

For `POST /import-bulk` (around line 216): identical two-line addition, plus `pipeline_stage` added to its INSERT.

For `POST /sync/:tap_id` (around line 267) and `POST /sync-all` (around line 326): identical two-line addition, plus `pipeline_stage = ?` added to the `UPDATE ... SET` list with `pipelineStage` bound alongside `tapStatus`.

- [ ] **Step 4: Add `pipeline_stage` to the manual create/update field lists**

In `src/api/taps.js`, add `'pipeline_stage'` to the destructured fields and column list in `POST /` (around line 34-62):

```js
  const {
    tap_number, tap_label, name, style, producer, abv, ibu, description,
    tasting_notes, category, status, keg_level, untappd_url,
    brewfather_id, brewers_friend_id, grainfather_id,
    external_source, external_id, serving_size, serve_method, glassware,
    on_tap_date, price, color, image_url, pipeline_stage
  } = req.body;
```
Add `pipeline_stage` to the `INSERT INTO taps (...)` column list and its matching `?` placeholder and bound value (`pipeline_stage || null`).

In `src/api/taps.js`, add `'pipeline_stage'` to the `fields` array in `PUT /:id` (around line 80-86):
```js
  const fields = [
    'tap_number', 'tap_label', 'name', 'style', 'producer', 'abv', 'ibu', 'description',
    'tasting_notes', 'category', 'status', 'keg_level', 'untappd_url',
    'brewfather_id', 'brewers_friend_id', 'grainfather_id',
    'external_source', 'external_id', 'serving_size', 'serve_method', 'glassware',
    'on_tap_date', 'price', 'color', 'image_url', 'pipeline_stage'
  ];
```

- [ ] **Step 5: Verify end-to-end via the running dev server**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
rm -f /tmp/verify-task2.db
DB_PATH=/tmp/verify-task2.db nohup node server.js > /tmp/verify-task2-server.log 2>&1 &
sleep 2
curl -s -c /tmp/verify-task2-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}'
echo
curl -s -b /tmp/verify-task2-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"tap_number":1,"name":"Planned Beer","status":"coming-soon","pipeline_stage":"planned"}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log('saved pipeline_stage:', d.pipeline_stage)"
```

Expected: `saved pipeline_stage: planned`

- [ ] **Step 6: Clean up and commit**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task2*.* /tmp/verify-task2-cookies.txt
cd /Users/staylor/git-repos/taplist/tapmenu
git add src/api/brewfather.js src/api/taps.js
git commit -m "Map Brewfather status to a pipeline stage; accept pipeline_stage on tap create/update"
```

---

### Task 3: Backend — promote-to-tap endpoint

**Files:**
- Modify: `src/api/taps.js` (add new route, after the existing `PATCH /:id/keg-level` route around line 117)

**Interfaces:**
- Consumes: `taps.pipeline_stage` (Task 1), `tap_count` setting (Task 1).
- Produces: `POST /api/taps/:id/promote` — body `{ tap_number: number }`, requires auth. Returns the updated tap (200) or `{error}` with 400/404/409.

- [ ] **Step 1: Write the verification script (fails — route doesn't exist yet)**

Create `/tmp/verify-task3.sh`:

```bash
#!/bin/bash
set -e
cd /Users/staylor/git-repos/taplist/tapmenu
rm -f /tmp/verify-task3.db
DB_PATH=/tmp/verify-task3.db nohup node server.js > /tmp/verify-task3-server.log 2>&1 &
SERVER_PID=$!
sleep 2

curl -s -c /tmp/verify-task3-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}' >/dev/null

# A coming-soon beer we want to promote
COMING_SOON_ID=$(curl -s -b /tmp/verify-task3-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ready IPA","status":"coming-soon","pipeline_stage":"packaged"}' \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).id)")

# A kicked tap sitting on tap number 4 (should be soft-deleted by the promote)
curl -s -b /tmp/verify-task3-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"tap_number":4,"name":"Old Stout","status":"kicked"}' >/dev/null

echo "--- promote onto tap 4 (should succeed once implemented) ---"
curl -s -o /tmp/verify-task3-promote.json -w "HTTP %{http_code}\n" \
  -b /tmp/verify-task3-cookies.txt -X POST "http://localhost:3000/api/taps/$COMING_SOON_ID/promote" \
  -H 'Content-Type: application/json' -d '{"tap_number":4}'
cat /tmp/verify-task3-promote.json; echo

kill $SERVER_PID
rm -f /tmp/verify-task3*.* /tmp/verify-task3-cookies.txt
```

Run: `chmod +x /tmp/verify-task3.sh && /tmp/verify-task3.sh`
Expected (before implementation): `HTTP 404` (no such route).

- [ ] **Step 2: Implement the promote route**

In `src/api/taps.js`, add after the `PATCH /:id/keg-level` route (around line 117), before the `DELETE /:id` route:

```js
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

  // Clear out any non-deleted row (kicked/hidden) currently sitting on that number
  db.prepare(
    "UPDATE taps SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE tap_number = ? AND status != 'deleted' AND id != ?"
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
```

- [ ] **Step 3: Re-run the verification script**

Run: `/tmp/verify-task3.sh`
Expected: `HTTP 200` and the JSON body shows `"tap_number":4`, `"status":"active"`, `"pipeline_stage":null`, `"keg_level":100`.

- [ ] **Step 4: Verify the old occupant was soft-deleted and the 409 conflict path**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
rm -f /tmp/verify-task3b.db
DB_PATH=/tmp/verify-task3b.db nohup node server.js > /tmp/verify-task3b-server.log 2>&1 &
sleep 2
curl -s -c /tmp/verify-task3b-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}' >/dev/null

OLD_ID=$(curl -s -b /tmp/verify-task3b-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"tap_number":5,"name":"Old Kicked","status":"kicked"}' \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).id)")
# A second, independent row also sitting on tap 5 (e.g. an admin manually hid
# a second stale entry for the same number) — both must be cleared by promote
OLD_ID_2=$(curl -s -b /tmp/verify-task3b-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"tap_number":5,"name":"Old Hidden Duplicate","status":"hidden"}' \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).id)")
ACTIVE_ID=$(curl -s -b /tmp/verify-task3b-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"tap_number":6,"name":"Currently Active","status":"active"}' \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).id)")
COMING_ID=$(curl -s -b /tmp/verify-task3b-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"New Beer","status":"coming-soon"}' \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).id)")

echo "--- promote onto tap 5 (two old occupants -> both should soft-delete) ---"
curl -s -b /tmp/verify-task3b-cookies.txt -X POST "http://localhost:3000/api/taps/$COMING_ID/promote" \
  -H 'Content-Type: application/json' -d '{"tap_number":5}' >/dev/null
curl -s "http://localhost:3000/api/taps/$OLD_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log('old kicked row status:', d.status)"
curl -s "http://localhost:3000/api/taps/$OLD_ID_2" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log('old hidden row status:', d.status)"

echo "--- promote a fresh coming-soon tap onto tap 6 (currently active -> expect 409) ---"
COMING_ID_2=$(curl -s -b /tmp/verify-task3b-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Another Beer","status":"coming-soon"}' \
  | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).id)")
curl -s -o /dev/null -w "HTTP %{http_code}\n" -b /tmp/verify-task3b-cookies.txt \
  -X POST "http://localhost:3000/api/taps/$COMING_ID_2/promote" \
  -H 'Content-Type: application/json' -d '{"tap_number":6}'

echo "--- promote with a missing tap_number -> expect 400 ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -b /tmp/verify-task3b-cookies.txt \
  -X POST "http://localhost:3000/api/taps/$COMING_ID_2/promote" \
  -H 'Content-Type: application/json' -d '{}'

echo "--- promote with a non-numeric tap_number -> expect 400 ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -b /tmp/verify-task3b-cookies.txt \
  -X POST "http://localhost:3000/api/taps/$COMING_ID_2/promote" \
  -H 'Content-Type: application/json' -d '{"tap_number":"not-a-number"}'

lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task3b*.* /tmp/verify-task3b-cookies.txt
```

Expected: `old kicked row status: deleted`, `old hidden row status: deleted`, `HTTP 409` for the active-tap promote attempt, and `HTTP 400` for both the missing and non-numeric `tap_number` attempts.

- [ ] **Step 5: Clean up and commit**

```bash
rm -f /tmp/verify-task3.sh
cd /Users/staylor/git-repos/taplist/tapmenu
git add src/api/taps.js
git commit -m "Add POST /api/taps/:id/promote to move a coming-soon beer onto a tap"
```

---

### Task 4: Frontend — pipeline stage field in the tap edit drawer

**Files:**
- Modify: `public/index.html:668-682` (drawer form markup), `public/index.html:1486-1539` (`openDrawer`), `public/index.html:1542-1588` (`saveTap`)

**Interfaces:**
- Consumes: `pipeline_stage` field on tap objects (Task 2), `pipeline_packaged_label` setting (Task 1, surfaced via `state.settings`).
- Produces: `<select id="f-stage">` and `toggleStageField()`, following the same show/hide convention as the existing `toggleLogoSizeRow()` (`public/index.html:1661-1663`).

- [ ] **Step 1: Add the stage field to the drawer markup**

In `public/index.html`, replace the Status form-row (lines 668-682) with a version that adds the stage select and an `onchange` hook on Status:

```html
      <div class="form-row">
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Status</label>
          <select class="form-select" id="f-status" onchange="toggleStageField()">
            <option value="active">On Tap</option>
            <option value="coming-soon">Coming Soon</option>
            <option value="kicked">Kicked / Empty</option>
            <option value="hidden">Hidden</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label">Date Tapped</label>
          <input class="form-input" id="f-on-tap-date" type="date">
        </div>
      </div>
      <div class="form-group" id="f-stage-group" style="display:none">
        <label class="form-label">Pipeline Stage</label>
        <select class="form-select" id="f-stage">
          <option value="planned">Planned</option>
          <option value="brewing">Brewing</option>
          <option value="fermenting">Fermenting</option>
          <option value="packaged" id="f-stage-packaged-option">Packaged</option>
        </select>
      </div>
```

- [ ] **Step 2: Add `toggleStageField()`, using the same pattern as `toggleLogoSizeRow()`**

In `public/index.html`, right after `toggleLogoSizeRow()` (around line 1661-1663), add:

```js
function toggleStageField() {
  const isComingSoon = document.getElementById('f-status').value === 'coming-soon';
  document.getElementById('f-stage-group').style.display = isComingSoon ? 'block' : 'none';
  document.getElementById('f-stage-packaged-option').textContent = state.settings.pipeline_packaged_label || 'Packaged';
}
```

- [ ] **Step 3: Populate the field when opening the drawer**

In `openDrawer(id)` (`public/index.html:1486-1539`), in the `if (id)` branch right after the `f-status` line (around line 1496):

```js
    document.getElementById('f-status').value = t.status || 'active';
    document.getElementById('f-stage').value = t.pipeline_stage || 'planned';
```

In the `else` branch (new-tap defaults, around line 1524):

```js
    document.getElementById('f-status').value = 'active';
    document.getElementById('f-stage').value = 'planned';
```

At the end of `openDrawer`, right before `document.getElementById('drawer-overlay').classList.add('open');` (around line 1537), add:

```js
  toggleStageField();
```

- [ ] **Step 4: Include it in the save payload**

In `saveTap()` (`public/index.html:1542-1588`), add to the `body` object (around line 1562, next to `status`):

```js
    name, status: document.getElementById('f-status').value,
    pipeline_stage: document.getElementById('f-status').value === 'coming-soon'
      ? document.getElementById('f-stage').value
      : null,
```

- [ ] **Step 5: Verify with Playwright**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill 2>/dev/null
rm -f /tmp/verify-task4.db
DB_PATH=/tmp/verify-task4.db nohup node server.js > /tmp/verify-task4-server.log 2>&1 &
sleep 2
curl -s -X POST http://localhost:3000/api/auth/setup -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"testpass123"}' >/dev/null
```

Create `/tmp/verify-task4.js` (adjust the `SCRATCH`/`node_modules` path to match whatever Playwright install this session already has — see prior Playwright scripts in this conversation for the exact `NODE_PATH` used):

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/admin');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'testpass123');
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(600);

  await page.click('button:has-text("+ Add Tap")');
  await page.waitForTimeout(200);
  const hiddenByDefault = await page.isHidden('#f-stage-group');

  await page.selectOption('#f-status', 'coming-soon');
  const visibleAfterComingSoon = await page.isVisible('#f-stage-group');
  await page.selectOption('#f-stage', 'brewing');
  await page.fill('#f-name', 'Test Brewing Beer');
  await page.click('button:has-text("Save Tap")');
  await page.waitForTimeout(500);

  const saved = await page.evaluate(() => fetch('/api/taps').then(r => r.json()));
  const tap = saved.find(t => t.name === 'Test Brewing Beer');

  console.log(JSON.stringify({ hiddenByDefault, visibleAfterComingSoon, pipeline_stage: tap?.pipeline_stage }, null, 2));
  await browser.close();
})();
```

Run it with the same `NODE_PATH`-pointed Playwright install used earlier in this project's sessions.
Expected: `hiddenByDefault: true`, `visibleAfterComingSoon: true`, `pipeline_stage: "brewing"`.

(Check the drawer's actual save-button text/selector against the live markup before running — if it isn't literally "Save Tap", use whatever `saveTap()`'s trigger button says.)

- [ ] **Step 6: Clean up and commit**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task4.js /tmp/verify-task4.db /tmp/verify-task4-server.log
cd /Users/staylor/git-repos/taplist/tapmenu
git add public/index.html
git commit -m "Add Pipeline Stage field to the tap edit drawer"
```

---

### Task 5: Frontend — real stage label in the public pipeline section (resolves #2)

**Files:**
- Modify: `public/index.html` (`renderPipeline()`, the `statusLabel` computation — find via `grep -n "brewfather_id ? 'Fermenting'"`)

**Interfaces:**
- Consumes: `t.pipeline_stage` (Task 2/4), `state.settings.pipeline_packaged_label` (Task 1).

- [ ] **Step 1: Locate and replace the hardcoded label**

Find the line in `renderPipeline()`:

```js
    const statusLabel = t.brewfather_id ? 'Fermenting' : 'Coming Soon';
```

Replace with:

```js
    const STAGE_LABELS = { planned: 'Planned', brewing: 'Brewing', fermenting: 'Fermenting' };
    const statusLabel = t.pipeline_stage === 'packaged'
      ? (state.settings.pipeline_packaged_label || 'Packaged')
      : (STAGE_LABELS[t.pipeline_stage] || 'Coming Soon');
```

- [ ] **Step 2: Verify with curl + a Playwright screenshot check**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill 2>/dev/null
rm -f /tmp/verify-task5.db
DB_PATH=/tmp/verify-task5.db nohup node server.js > /tmp/verify-task5-server.log 2>&1 &
sleep 2
curl -s -c /tmp/verify-task5-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}' >/dev/null
curl -s -b /tmp/verify-task5-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Planning Stage Beer","status":"coming-soon","pipeline_stage":"planned","brewfather_id":"fake-bf-id"}' >/dev/null
# A legacy/manually-added coming-soon tap with no pipeline_stage set at all —
# must fall back to a generic label, not crash or show "undefined"/"null"
curl -s -b /tmp/verify-task5-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Legacy Unassigned Beer","status":"coming-soon"}' >/dev/null
```

Create `/tmp/verify-task5.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:3000/');
  await page.waitForTimeout(500);
  const pipelineText = await page.evaluate(() => document.getElementById('pipeline-row').textContent);
  console.log(JSON.stringify({
    showsPlanned: pipelineText.includes('Planned') && !pipelineText.includes('Fermenting'),
    legacyFallsBackToComingSoon: pipelineText.includes('Coming Soon'),
    noPageErrors: errors.length === 0,
  }, null, 2));
  await browser.close();
})();
```

Run with the project's Playwright install.
Expected: `showsPlanned: true` (proves issue #2 — a Brewfather-linked tap no longer always shows "Fermenting"), `legacyFallsBackToComingSoon: true` (a tap with no `pipeline_stage` set degrades gracefully), `noPageErrors: true`.

- [ ] **Step 3: Clean up and commit**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task5.js /tmp/verify-task5.db /tmp/verify-task5-server.log /tmp/verify-task5-cookies.txt
cd /Users/staylor/git-repos/taplist/tapmenu
git add public/index.html
git commit -m "Show the real pipeline stage in the public pipeline section (fixes #2)"
```

---

### Task 6: Frontend — Settings UI for packaged-stage label and tap count

**Files:**
- Modify: `public/index.html:522-535` (Pipeline Section settings-card), `public/index.html:1597-1653` (`loadSettingsForm`), `public/index.html:1731-1775` (`saveSettings`)

**Interfaces:**
- Produces: `#s-pipeline-packaged-label`, `#s-tap-count` form fields, wired to `pipeline_packaged_label`/`tap_count` settings from Task 1.

- [ ] **Step 1: Add the packaged-label field to the Pipeline Section card**

In `public/index.html`, inside the Pipeline Section `settings-card` (around line 525-534), add a second form-row after the existing Section Title / Auto-refresh one:

```html
            <div class="form-row" style="margin-top:0.875rem">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label">Packaged Stage Label <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">(e.g. "On Deck", "Up Next")</span></label>
                <input class="form-input" id="s-pipeline-packaged-label" type="text" placeholder="Packaged">
              </div>
            </div>
```

- [ ] **Step 2: Add a new "Taps" settings-card for the tap count**

In `public/index.html`, right after the "Pages" settings-card (around line 536-540), add:

```html
          <div class="settings-card">
            <h3>Taps</h3>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">Total Taps <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">(used to compute which tap numbers are available)</span></label>
              <input class="form-input" id="s-tap-count" type="number" min="1" style="max-width:120px" placeholder="12">
            </div>
          </div>
```

- [ ] **Step 3: Wire both into `loadSettingsForm()`**

In `loadSettingsForm()` (`public/index.html:1597-1653`), add after the existing `s-pipeline-refresh` line (around line 1648):

```js
  document.getElementById('s-pipeline-packaged-label').value = s.pipeline_packaged_label || 'Packaged';
  document.getElementById('s-tap-count').value = s.tap_count || '12';
```

- [ ] **Step 4: Wire both into `saveSettings()`**

In `saveSettings()` (`public/index.html:1731-1775`), add after the existing `pipeline_refresh_mins` line (around line 1772):

```js
      pipeline_packaged_label: document.getElementById('s-pipeline-packaged-label').value || 'Packaged',
      tap_count: document.getElementById('s-tap-count').value || '12',
```

- [ ] **Step 5: Verify with Playwright**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill 2>/dev/null
rm -f /tmp/verify-task6.db
DB_PATH=/tmp/verify-task6.db nohup node server.js > /tmp/verify-task6-server.log 2>&1 &
sleep 2
curl -s -X POST http://localhost:3000/api/auth/setup -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"testpass123"}' >/dev/null
```

Create `/tmp/verify-task6.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/admin');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'testpass123');
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(600);
  await page.evaluate(() => showPanel('settings'));
  await page.waitForTimeout(300);

  await page.fill('#s-pipeline-packaged-label', 'On Deck');
  await page.fill('#s-tap-count', '8');
  await page.click('button:has-text("Save Settings")');
  await page.waitForTimeout(600);

  const settings = await page.evaluate(() => fetch('/api/auth/settings').then(r => r.json()));
  console.log(JSON.stringify({
    pipeline_packaged_label: settings.pipeline_packaged_label,
    tap_count: settings.tap_count
  }, null, 2));
  await browser.close();
})();
```

Run with the project's Playwright install.
Expected: `pipeline_packaged_label: "On Deck"`, `tap_count: "8"`.

- [ ] **Step 6: Clean up and commit**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task6.js /tmp/verify-task6.db /tmp/verify-task6-server.log
cd /Users/staylor/git-repos/taplist/tapmenu
git add public/index.html
git commit -m "Add Packaged Stage Label and Total Taps settings fields"
```

---

### Task 7: Frontend — new "Coming Soon" admin panel (read-only list + available-taps indicator)

**Files:**
- Modify: `public/index.html:390-397` (sidebar), after `public/index.html:418` (new panel markup, before the Settings panel), `public/index.html:972-979` (`loadTaps`)

**Interfaces:**
- Consumes: `state.taps` (already loaded), `state.settings.tap_count`, `state.settings.pipeline_packaged_label`, `t.pipeline_stage`.
- Produces: `renderComingSoonPanel()`, called from `loadTaps()` alongside the existing `renderAdminTable()` call, and from `showPanel('coming-soon')` navigation.

- [ ] **Step 1: Add the sidebar entry**

In `public/index.html`, in the sidebar (around line 392-393), add a new button right after "All Taps":

```html
        <button class="sidebar-btn active" id="sb-taps" onclick="showPanel('taps')"><span class="icon">🍺</span> All Taps</button>
        <button class="sidebar-btn" id="sb-coming-soon" onclick="showPanel('coming-soon')"><span class="icon">🚧</span> Coming Soon</button>
        <button class="sidebar-btn" id="sb-add" onclick="openDrawer()"><span class="icon">➕</span> Add Tap</button>
```

- [ ] **Step 2: Add the panel markup**

In `public/index.html`, right after the closing `</div>` of `panel-taps` (right before the `<!-- Settings Panel -->` comment, around line 418-420), add:

```html
        <!-- Coming Soon Panel -->
        <div class="admin-panel" id="panel-coming-soon">
          <div class="admin-panel-header">
            <div class="panel-title">Coming Soon</div>
          </div>
          <div id="available-taps-indicator" style="margin-bottom:1rem;font-size:0.85rem;color:var(--text-muted)"></div>
          <div id="coming-soon-groups"></div>
        </div>
```

- [ ] **Step 3: Implement the availability calculation and render function**

In `public/index.html`, add near `renderAdminTable()` (right after it, around line 1483):

```js
// A tap number is occupied if any non-deleted row with status='active' has it.
// Everything else in [1..tap_count] is available (never used, or currently kicked/hidden).
function computeAvailableTapNumbers() {
  const tapCount = parseInt(state.settings.tap_count, 10) || 12;
  const occupied = new Set(
    state.taps.filter(t => t.status === 'active' && t.tap_number).map(t => t.tap_number)
  );
  const available = [];
  for (let n = 1; n <= tapCount; n++) {
    if (!occupied.has(n)) available.push(n);
  }
  return available;
}

const PIPELINE_STAGE_ORDER = ['planned', 'brewing', 'fermenting', 'packaged'];
function pipelineStageGroupLabel(stage) {
  if (stage === 'packaged') return state.settings.pipeline_packaged_label || 'Packaged';
  if (stage === 'planned') return 'Planned';
  if (stage === 'brewing') return 'Brewing';
  if (stage === 'fermenting') return 'Fermenting';
  return 'Unassigned';
}

function renderComingSoonPanel() {
  const available = computeAvailableTapNumbers();
  document.getElementById('available-taps-indicator').textContent =
    available.length ? `Available taps: ${available.join(', ')}` : 'No taps available';

  const comingSoon = state.taps.filter(t => t.status === 'coming-soon');
  const groups = {};
  for (const stage of [...PIPELINE_STAGE_ORDER, null]) {
    groups[stage ?? 'unassigned'] = comingSoon.filter(t => (t.pipeline_stage || null) === stage);
  }

  const container = document.getElementById('coming-soon-groups');
  const sections = [...PIPELINE_STAGE_ORDER, 'unassigned'].map(key => {
    const stageKey = key === 'unassigned' ? null : key;
    const taps = groups[key];
    if (!taps.length) return '';
    const rows = taps.map(t => `
      <div onclick="openDrawer('${t.id}')" style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.875rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;cursor:pointer">
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span style="font-weight:600">${esc(t.name)}</span>
          ${t.brewfather_id ? '<span class="integration-badge">🍺 Brewfather</span>' : ''}
        </div>
      </div>
    `).join('');
    return `
      <div style="margin-bottom:1.25rem">
        <div style="font:600 0.72rem var(--font-mono);color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.5rem">${esc(pipelineStageGroupLabel(stageKey))}</div>
        ${rows}
      </div>
    `;
  }).join('');

  container.innerHTML = sections || '<div class="empty-state">Nothing in the pipeline right now.</div>';
}
```

- [ ] **Step 4: Call it from `loadTaps()`**

In `loadTaps()` (`public/index.html:972-979`), add alongside the existing `renderAdminTable()` call:

```js
async function loadTaps() {
  try {
    state.taps = await api('GET', '/taps');
    renderDisplay();
    renderMobileMenu();
    if (state.authenticated) { renderAdminTable(); renderComingSoonPanel(); }
  } catch(e) {}
}
```

- [ ] **Step 5: Verify with Playwright**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill 2>/dev/null
rm -f /tmp/verify-task7.db
DB_PATH=/tmp/verify-task7.db nohup node server.js > /tmp/verify-task7-server.log 2>&1 &
sleep 2
curl -s -c /tmp/verify-task7-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}' >/dev/null
curl -s -b /tmp/verify-task7-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Brewing Beer","status":"coming-soon","pipeline_stage":"brewing"}' >/dev/null
# An active tap on a number ABOVE the declared tap_count (simulates a venue
# that later lowers its declared count below a number already in use)
curl -s -b /tmp/verify-task7-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"tap_number":15,"name":"Existing Active Beer","status":"active"}' >/dev/null
curl -s -b /tmp/verify-task7-cookies.txt -X PUT http://localhost:3000/api/auth/settings \
  -H 'Content-Type: application/json' -d '{"tap_count":"3"}' >/dev/null
```

Create `/tmp/verify-task7.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/admin');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'testpass123');
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(600);
  await page.evaluate(() => showPanel('coming-soon'));
  await page.waitForTimeout(300);

  const indicatorText = await page.evaluate(() => document.getElementById('available-taps-indicator').textContent);
  const groupsText = await page.evaluate(() => document.getElementById('coming-soon-groups').textContent);

  // Confirm the tap_count=3 setting didn't touch the pre-existing active tap 15
  const taps = await page.evaluate(() => fetch('/api/taps').then(r => r.json()));
  const existingTap15 = taps.find(t => t.tap_number === 15);

  console.log(JSON.stringify({
    indicatorText, // should list only 1..3 minus any occupied among those, never 15
    hasBrewingGroup: groupsText.includes('BREWING'),
    hasBeer: groupsText.includes('Brewing Beer'),
    tap15StillActive: existingTap15?.status === 'active',
  }, null, 2));
  await browser.close();
})();
```

Run with the project's Playwright install.
Expected: `indicatorText: "Available taps: 1, 2, 3"` (numbers 1-3 are all free; tap 15 is out of the declared 1..3 range so it never appears here even though it's occupied), `hasBrewingGroup: true`, `hasBeer: true`, `tap15StillActive: true` (lowering `tap_count` never touches a tap that's already in use above that range).

- [ ] **Step 6: Clean up and commit**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task7.js /tmp/verify-task7.db /tmp/verify-task7-server.log /tmp/verify-task7-cookies.txt
cd /Users/staylor/git-repos/taplist/tapmenu
git add public/index.html
git commit -m "Add Coming Soon admin panel with available-taps indicator"
```

---

### Task 8: Frontend — promote action in the Coming Soon panel

**Files:**
- Modify: `public/index.html` (`renderComingSoonPanel()` from Task 7 — add a promote button per row and a picker)

**Interfaces:**
- Consumes: `POST /api/taps/:id/promote` (Task 3), `computeAvailableTapNumbers()` (Task 7).
- Produces: `promoteTap(tapId)` — prompts for an available tap number and calls the endpoint.

- [ ] **Step 1: Add the promote button to each Coming Soon row**

In `renderComingSoonPanel()` (Task 7), change the row template to add a button and stop its click from also opening the drawer:

```js
    const rows = taps.map(t => `
      <div onclick="openDrawer('${t.id}')" style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.875rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;cursor:pointer">
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span style="font-weight:600">${esc(t.name)}</span>
          ${t.brewfather_id ? '<span class="integration-badge">🍺 Brewfather</span>' : ''}
        </div>
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();promoteTap('${t.id}')" ${available.length ? '' : 'disabled title="No taps available"'}>→ Put on Tap</button>
      </div>
    `).join('');
```

- [ ] **Step 2: Implement `promoteTap()`**

In `public/index.html`, right after `renderComingSoonPanel()`, add:

```js
async function promoteTap(tapId) {
  const available = computeAvailableTapNumbers();
  if (!available.length) { toast('No taps available', 'error'); return; }

  const choice = prompt(`Which tap number? Available: ${available.join(', ')}`, String(available[0]));
  if (choice === null) return;
  const tapNumber = parseInt(choice, 10);
  if (!available.includes(tapNumber)) {
    toast(`Tap ${choice} is not available`, 'error');
    return;
  }

  try {
    await api('POST', `/taps/${tapId}/promote`, { tap_number: tapNumber });
    toast('Beer moved onto tap!', 'success');
    await loadTaps();
  } catch(e) {
    toast(e.message, 'error');
  }
}
```

- [ ] **Step 3: Verify with Playwright**

```bash
cd /Users/staylor/git-repos/taplist/tapmenu
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill 2>/dev/null
rm -f /tmp/verify-task8.db
DB_PATH=/tmp/verify-task8.db nohup node server.js > /tmp/verify-task8-server.log 2>&1 &
sleep 2
curl -s -c /tmp/verify-task8-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}' >/dev/null
curl -s -b /tmp/verify-task8-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ready Beer","status":"coming-soon","pipeline_stage":"packaged"}' >/dev/null
curl -s -b /tmp/verify-task8-cookies.txt -X PUT http://localhost:3000/api/auth/settings \
  -H 'Content-Type: application/json' -d '{"tap_count":"2"}' >/dev/null
```

Create `/tmp/verify-task8.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', async dialog => { await dialog.accept('1'); }); // answer the prompt() with tap "1"

  await page.goto('http://localhost:3000/admin');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', 'testpass123');
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(600);
  await page.evaluate(() => showPanel('coming-soon'));
  await page.waitForTimeout(300);

  await page.click('button:has-text("Put on Tap")');
  await page.waitForTimeout(600);

  const taps = await page.evaluate(() => fetch('/api/taps').then(r => r.json()));
  const promoted = taps.find(t => t.name === 'Ready Beer');
  console.log(JSON.stringify({ status: promoted.status, tap_number: promoted.tap_number, pipeline_stage: promoted.pipeline_stage }, null, 2));
  await browser.close();
})();
```

Run with the project's Playwright install.
Expected: `status: "active"`, `tap_number: 1`, `pipeline_stage: null`.

- [ ] **Step 4: Clean up and commit**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f /tmp/verify-task8.js /tmp/verify-task8.db /tmp/verify-task8-server.log /tmp/verify-task8-cookies.txt
cd /Users/staylor/git-repos/taplist/tapmenu
git add public/index.html
git commit -m "Add promote-to-tap action in the Coming Soon admin panel"
```

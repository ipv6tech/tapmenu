# Available Tap Slots & Coming-Soon Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every declared tap slot (`1..tap_count`) on the public display — including empty ones as "Available" placeholders, hideable per-number — and let a coming-soon beer be pinned onto a specific slot so it previews there as "Coming Soon".

**Architecture:** No new tap columns — `tap_number` on a `coming-soon` row becomes a meaningful "pinned slot" value, extending plumbing `promote()` already partially has. One new setting (`hidden_tap_numbers`, CSV). One new endpoint (`POST /api/taps/:id/pin`, closely mirroring the existing `promote()` handler). The public grid switches from mapping over qualifying tap rows to iterating every slot number and picking the highest-priority row for it (active → kicked → pinned coming-soon → empty placeholder).

**Tech Stack:** Node/Express, sql.js-backed `src/db.js` wrapper, vanilla JS frontend in `public/index.html`, no test framework — manual curl/DB verification per this repo's convention, Playwright for UI/grid checks.

**Spec:** `docs/superpowers/specs/2026-09-29-available-tap-slots-design.md`

## Global Constraints

- Pinning never blocks/reserves a number for promotion purposes — the same number can still be promoted into by anything, or re-pinned by the same tap; only a *different* coming-soon tap targeting the same number is rejected (spec: API §pin, step 3).
- Pinning a coming-soon tap onto a number never changes that tap's `status` or `pipeline_stage` (spec: API §pin, step 5).
- The pipeline section (`renderPipeline()`) is untouched — a pinned beer still appears there regardless of pin state (spec: Non-goals).
- `hidden_tap_numbers` values outside `1..tap_count` are harmless no-ops — the slot loop only ever iterates that range (spec: Error handling).

## Review Focus

- A `tap_count` change that shrinks the range (e.g. from 12 to 5) must not leave a stale `hidden_tap_numbers` entry (e.g. `"9"`) silently breaking anything — since the slot loop only iterates `1..tap_count`, a stale hidden entry outside range must have zero effect, not throw or produce a blank/malformed slot.
- Two coming-soon taps racing to pin the same available number — the second request must get the 409 "already pinned" response, never silently overwrite the first pin or corrupt the row (this is the finding a naive `UPDATE ... WHERE id = ?` with no re-check between read and write could produce — the plan's pin endpoint step order matters).
- A `kicked` tap sitting on tap #5 whose keg display is currently visible on the public grid must disappear the moment a coming-soon beer is pinned onto #5 (per spec priority: pinned coming-soon beats a lingering kicked row) — not show both, not show neither.
- An admin who unpins a beer (`tap_number: null`) expects that slot to immediately show "Available" again on the public display, and the beer to keep appearing wherever it already did in the pipeline section — not disappear from the pipeline section, and not leave the old number showing stale "Coming Soon" content.
- `hidden_tap_numbers` must not accidentally hide a slot that's actually `active`-occupied — hiding is meant for physically-nonexistent taps, but nothing in the design stops an admin from mistakenly hiding a number that has a real active beer on it; the plan's tests should at least confirm this "works as configured" (hides it) so a future bug report about "my active beer vanished" is traceable to the setting, not silent unrelated code.

---

## Task 1: `hidden_tap_numbers` setting (backend)

**Files:**
- Modify: `src/db.js` (add to the `INSERT OR IGNORE INTO settings` seed list in `initSchema()`)
- Modify: `src/api/auth.js` (add to the `allowed` array in `PUT /settings`)

**Interfaces:**
- Produces: a `hidden_tap_numbers` setting (default `''`), readable via the existing public `GET /api/auth/settings` and writable via the existing `PUT /api/auth/settings` — consumed by Task 3 (grid rendering) and Task 4 (Settings UI).

- [ ] **Step 1: Add the seed row**

In `src/db.js`, inside `initSchema()`'s `INSERT OR IGNORE INTO settings` list, add a line right after `('tap_count', '12'),`:
```sql
      ('hidden_tap_numbers', ''),
```

- [ ] **Step 2: Add it to the settings write allowlist**

In `src/api/auth.js`, inside the `PUT /settings` handler's `allowed` array, add `'hidden_tap_numbers'` right after `'tap_count'`:
```javascript
    'pipeline_packaged_label', 'tap_count', 'hidden_tap_numbers',
```

- [ ] **Step 3: Verify the setting is seeded on a fresh DB and writable**

```bash
rm -f /tmp/tapslots-plan-test.db
DB_PATH=/tmp/tapslots-plan-test.db node server.js > /tmp/tapslots-plan-server.log 2>&1 &
```
(use the Bash tool's `run_in_background: true` for the above — a plain trailing `&` in one call reliably dies in this environment)

```bash
sleep 1.5
curl -s http://localhost:3000/api/auth/settings | node -e "process.stdin.on('data', d => console.log('seeded value:', JSON.stringify(JSON.parse(d).hidden_tap_numbers)))"
# Expected: seeded value: ""

curl -s -c /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'
curl -s -b /tmp/tapslots-cookies.txt -c /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'

curl -s -b /tmp/tapslots-cookies.txt -X PUT http://localhost:3000/api/auth/settings \
  -H 'Content-Type: application/json' -d '{"hidden_tap_numbers":"9,10"}'
curl -s http://localhost:3000/api/auth/settings | node -e "process.stdin.on('data', d => console.log('after write:', JSON.stringify(JSON.parse(d).hidden_tap_numbers)))"
# Expected: after write: "9,10"
```
Stop the server (`kill` the PID or matching `lsof -ti:3000`), delete `/tmp/tapslots-plan-test.db`, `/tmp/tapslots-cookies.txt`, `/tmp/tapslots-plan-server.log` afterward.

- [ ] **Step 4: Commit**

```bash
git add src/db.js src/api/auth.js
git commit -m "Add hidden_tap_numbers setting"
```

---

## Task 2: `POST /api/taps/:id/pin` endpoint

**Files:**
- Modify: `src/api/taps.js` (new route, placed right after the existing `POST /:id/promote` handler)

**Interfaces:**
- Consumes: nothing new (uses `getDb()` already imported in this file).
- Produces: `POST /api/taps/:id/pin` `{ tap_number }` → updated tap JSON, or 400/404/409 — consumed by Task 5 (Coming Soon panel's pin button).

- [ ] **Step 1: Add the pin route**

Add this immediately after the existing `router.post('/:id/promote', ...)` handler in `src/api/taps.js` (before the `DELETE` route):

```javascript
// POST pin a coming-soon tap onto a specific tap number, without promoting it
// (auth required) — the number stays visually "reserved" but is NOT blocked
// from being promoted into or re-pinned by something else; only a different
// coming-soon tap targeting the same number is rejected.
router.post('/:id/pin', requireAuth, (req, res) => {
  const db = getDb();
  const tapNumber = parseInt(req.body.tap_number, 10);
  if (!Number.isInteger(tapNumber) || tapNumber < 1) {
    return res.status(400).json({ error: 'tap_number must be a positive integer' });
  }

  const tap = db.prepare('SELECT * FROM taps WHERE id = ?').get(req.params.id);
  if (!tap) return res.status(404).json({ error: 'Not found' });
  if (tap.status !== 'coming-soon') {
    return res.status(400).json({ error: 'Only a coming-soon tap can be pinned' });
  }

  const activeOccupant = db.prepare(
    "SELECT id FROM taps WHERE tap_number = ? AND status = 'active' AND id != ?"
  ).get(tapNumber, tap.id);
  if (activeOccupant) {
    return res.status(409).json({ error: `Tap ${tapNumber} is already active` });
  }

  const pinnedOccupant = db.prepare(
    "SELECT id, name FROM taps WHERE tap_number = ? AND status = 'coming-soon' AND id != ?"
  ).get(tapNumber, tap.id);
  if (pinnedOccupant) {
    return res.status(409).json({ error: `Tap ${tapNumber} is already pinned to "${pinnedOccupant.name}"` });
  }

  // Clear out any kicked/hidden row currently sitting on that number, same as promote().
  db.prepare(
    "UPDATE taps SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE tap_number = ? AND status IN ('kicked', 'hidden') AND id != ?"
  ).run(tapNumber, tap.id);

  db.prepare(
    'UPDATE taps SET tap_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(tapNumber, tap.id);

  const updated = db.prepare('SELECT * FROM taps WHERE id = ?').get(tap.id);
  res.json(updated);
});
```

- [ ] **Step 2: Manual verification**

```bash
rm -f /tmp/tapslots-plan-test.db /tmp/tapslots-cookies.txt
DB_PATH=/tmp/tapslots-plan-test.db node server.js > /tmp/tapslots-plan-server.log 2>&1 &
```
(background)

```bash
sleep 1.5
curl -s -c /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'
curl -s -b /tmp/tapslots-cookies.txt -c /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'

# Case 1: pin a coming-soon tap onto an empty number -> succeeds
CS_ID=$(curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Next Up IPA","status":"coming-soon"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps/$CS_ID/pin \
  -H 'Content-Type: application/json' -d '{"tap_number":5}'
# Expected: 200, JSON with tap_number:5, status still "coming-soon"

# Case 2: a second coming-soon tap pinning the SAME number -> 409
CS_ID2=$(curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Also Coming","status":"coming-soon"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -o /dev/null -w "case 2 status (expect 409): %{http_code}\n" -b /tmp/tapslots-cookies.txt \
  -X POST http://localhost:3000/api/taps/$CS_ID2/pin -H 'Content-Type: application/json' -d '{"tap_number":5}'

# Case 3: pinning onto an active-occupied number -> 409
ACTIVE_ID=$(curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"On Tap Now","status":"active","tap_number":7}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -o /dev/null -w "case 3 status (expect 409): %{http_code}\n" -b /tmp/tapslots-cookies.txt \
  -X POST http://localhost:3000/api/taps/$CS_ID2/pin -H 'Content-Type: application/json' -d '{"tap_number":7}'

# Case 4: pinning onto a number held by a kicked row -> kicked row soft-deleted, pin succeeds
KICKED_ID=$(curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Dead Keg","status":"kicked","tap_number":3}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps/$CS_ID2/pin \
  -H 'Content-Type: application/json' -d '{"tap_number":3}'
# Expected: 200, tap_number:3
curl -s -b /tmp/tapslots-cookies.txt http://localhost:3000/api/taps/$KICKED_ID | node -e "process.stdin.on('data',d=>console.log('kicked row status (expect deleted):', JSON.parse(d).status))"

# Case 5: unpin via existing PUT -> succeeds, tap_number becomes null
curl -s -b /tmp/tapslots-cookies.txt -X PUT http://localhost:3000/api/taps/$CS_ID \
  -H 'Content-Type: application/json' -d '{"tap_number":null}'
# Expected: 200, tap_number:null

# Case 6: pinning a non-coming-soon tap -> 400
curl -s -o /dev/null -w "case 6 status (expect 400): %{http_code}\n" -b /tmp/tapslots-cookies.txt \
  -X POST http://localhost:3000/api/taps/$ACTIVE_ID/pin -H 'Content-Type: application/json' -d '{"tap_number":8}'
```
Stop the server, delete the scratch DB/cookie/log files afterward.

- [ ] **Step 3: Commit**

```bash
git add src/api/taps.js
git commit -m "Add pin endpoint for previewing a coming-soon beer on a specific tap"
```

---

## Task 3: Slot-based public grid rendering

**Files:**
- Modify: `public/index.html` (`renderDisplay()`, new `buildTapSlots()` and `emptyCardHTML()` functions)

**Interfaces:**
- Consumes: `state.settings.tap_count`, `state.settings.hidden_tap_numbers` (Task 1), `state.taps` (already loaded).
- Produces: `buildTapSlots()` (array of `{ number, tap }`, `tap` is `null` for an empty slot) and `emptyCardHTML(number)` — not consumed by any other task, both are internal to `renderDisplay()`.

- [ ] **Step 1: Add `buildTapSlots()` and `emptyCardHTML()`**

Add these right before `function renderDisplay()`:

```javascript
// Every declared tap number (1..tap_count) becomes a "slot". Each slot shows
// the highest-priority tap row currently on that number — active beats a
// lingering kicked row beats a coming-soon beer pinned there for preview —
// or an empty "Available" placeholder if nothing qualifies. A number in
// hidden_tap_numbers is skipped entirely (no card, empty or otherwise).
function buildTapSlots() {
  const tapCount = parseInt(state.settings.tap_count, 10) || 12;
  const hidden = new Set(
    (state.settings.hidden_tap_numbers || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n))
  );
  const slots = [];
  for (let n = 1; n <= tapCount; n++) {
    if (hidden.has(n)) continue;
    const active = state.taps.find(t => t.tap_number === n && t.status === 'active');
    const kicked = !active && state.taps.find(t => t.tap_number === n && t.status === 'kicked');
    const pinned = !active && !kicked && state.taps.find(t => t.tap_number === n && t.status === 'coming-soon');
    slots.push({ number: n, tap: active || kicked || pinned || null });
  }
  return slots;
}

function emptyCardHTML(number) {
  return `<div class="tap-card" style="--c:var(--border)">
    <div class="list-color-strip" style="background:var(--border)"></div>
    <div class="list-body" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80px;padding:1.5rem">
      <div class="tap-number-lg" style="font-size:1.8rem;opacity:0.4">${number}</div>
      <div style="font:600 0.72rem var(--font-mono);text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);margin-top:0.3rem">Available</div>
    </div>
    <div class="list-right"></div>
  </div>`;
}
```

- [ ] **Step 2: Replace the grid-building logic in `renderDisplay()`**

Replace the existing body:
```javascript
function renderDisplay() {
  const s = state.settings;
  // Active + kicked taps on the grid — coming-soon goes to the pipeline, hidden is fully excluded
  const activeTaps = state.taps.filter(t => t.status !== 'coming-soon' && t.status !== 'hidden');
  const grid = document.getElementById('display-grid');
  grid.className = `tap-grid layout-${state.currentLayout}`;
  if (!activeTaps.length) {
    grid.innerHTML = '<div class="empty-state">No taps to show.</div>';
  } else {
    grid.innerHTML = activeTaps.map(t =>
      state.currentLayout === 'large' ? largeCardHTML(t, s) :
      state.currentLayout === 'list'  ? listCardHTML(t, s) :
      gridCardHTML(t, s)
    ).join('');
  }
  renderPipeline();
}
```
with:
```javascript
function renderDisplay() {
  const s = state.settings;
  const slots = buildTapSlots();
  const grid = document.getElementById('display-grid');
  grid.className = `tap-grid layout-${state.currentLayout}`;
  if (!slots.length) {
    grid.innerHTML = '<div class="empty-state">No taps to show.</div>';
  } else {
    grid.innerHTML = slots.map(slot => {
      if (!slot.tap) return emptyCardHTML(slot.number);
      return state.currentLayout === 'large' ? largeCardHTML(slot.tap, s) :
             state.currentLayout === 'list'  ? listCardHTML(slot.tap, s) :
             gridCardHTML(slot.tap, s);
    }).join('');
  }
  renderPipeline();
}
```

Note: a `coming-soon` tap with no `tap_number` set (the common case — most coming-soon beers are never pinned) is simply never selected by `buildTapSlots()`'s `.find()` calls, so it's invisible on the grid exactly as today, and still shows in the pipeline section via `renderPipeline()` (unchanged). A `hidden`-status tap is likewise never selected (not in the active/kicked/coming-soon-pinned checks), so its slot correctly falls through to "Available" — matching today's behavior where a hidden tap's number counts as available.

- [ ] **Step 3: Manual browser verification**

```bash
rm -f /tmp/tapslots-plan-test.db /tmp/tapslots-cookies.txt
DB_PATH=/tmp/tapslots-plan-test.db node server.js > /tmp/tapslots-plan-server.log 2>&1 &
```
(background)

```bash
sleep 1.5
curl -s -c /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/auth/setup \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'
curl -s -b /tmp/tapslots-cookies.txt -c /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"password123"}'
# hidden_tap_numbers includes 99 (outside 1..5) to confirm an out-of-range entry is a no-op
curl -s -b /tmp/tapslots-cookies.txt -X PUT http://localhost:3000/api/auth/settings \
  -H 'Content-Type: application/json' -d '{"tap_count":"5","hidden_tap_numbers":"4,99"}'
curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Active Beer","status":"active","tap_number":1}' > /dev/null
KICKED_ID=$(curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Dead Keg","status":"kicked","tap_number":2}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
CS_ID=$(curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps \
  -H 'Content-Type: application/json' -d '{"name":"Pinned Preview IPA","style":"IPA","abv":6.1,"status":"coming-soon"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -b /tmp/tapslots-cookies.txt -X POST http://localhost:3000/api/taps/$CS_ID/pin \
  -H 'Content-Type: application/json' -d '{"tap_number":2}' > /dev/null
```

Use Playwright (reuse the install from a prior session's scratchpad `pw-test/node_modules` via `NODE_PATH`, per this project's convention) to load `http://localhost:3000/`, then check `#display-grid .tap-card` count and content:
- Expect exactly 4 cards (tap_count=5 minus 1 hidden number — the `99` entry is out of range and has no effect).
- Tap 1's card shows "Active Beer" with the normal "On Tap" badge.
- Tap 2's card shows "Pinned Preview IPA" with a "Soon"/"Coming Soon" badge — confirming the pin visually replaced the kicked row that was on #2 before pinning (the kicked row's own soft-delete was already verified server-side in Task 2's Case 4; this confirms the *display* reflects it).
- Taps 3 and 5 show "Available" placeholders (tap 4 is hidden — no card for it at all).

Then, as a defensive check on `hidden_tap_numbers` interacting with an active tap: `curl -X PUT /api/auth/settings -d '{"hidden_tap_numbers":"1,4,99"}'` (adding `1`, which is `Active Beer`'s number) and reload — confirm tap #1's card is now also gone (hiding is unconditional, even for an active tap; this is "works as configured," not a bug, per the spec).

Delete the scratch DB/cookie/log files and stop the server afterward.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Render every tap slot on the public grid, with Available placeholders and pinned coming-soon previews"
```

---

## Task 4: Settings UI — hidden taps checkboxes

**Files:**
- Modify: `public/index.html` (Settings "Taps" card markup, `loadSettingsForm()`, `saveSettings()`)

**Interfaces:**
- Consumes: `hidden_tap_numbers` setting (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the checkbox container to the Settings "Taps" card**

Right after the existing `Total Taps` form-group inside the "Taps" settings card, add:
```html
            <div class="form-group" style="margin-top:0.875rem;margin-bottom:0">
              <label class="form-label">Hidden Taps <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">(excluded from the public display entirely)</span></label>
              <div id="s-hidden-taps-grid" style="display:flex;flex-wrap:wrap;gap:0.5rem"></div>
            </div>
```

- [ ] **Step 2: Add `renderHiddenTapsCheckboxes()` and wire it up**

Add this function near `loadSettingsForm()`:
```javascript
function renderHiddenTapsCheckboxes() {
  const tapCount = parseInt(document.getElementById('s-tap-count').value, 10) || 12;
  const hidden = new Set(
    (state.settings.hidden_tap_numbers || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n))
  );
  const container = document.getElementById('s-hidden-taps-grid');
  container.innerHTML = '';
  for (let n = 1; n <= tapCount; n++) {
    const label = document.createElement('label');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:0.3rem;font-size:0.8rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:0.3rem 0.6rem;cursor:pointer';
    label.innerHTML = `<input type="checkbox" class="hidden-tap-cb" value="${n}" ${hidden.has(n) ? 'checked' : ''}> ${n}`;
    container.appendChild(label);
  }
}
```

In `loadSettingsForm()`, right after the existing `document.getElementById('s-tap-count').value = s.tap_count || '12';` line, add:
```javascript
  renderHiddenTapsCheckboxes();
```

On the `s-tap-count` input itself, add a regenerate-on-change hook — change its markup from:
```html
<input class="form-input" id="s-tap-count" type="number" min="1" style="max-width:120px" placeholder="12">
```
to:
```html
<input class="form-input" id="s-tap-count" type="number" min="1" style="max-width:120px" placeholder="12" onchange="renderHiddenTapsCheckboxes()">
```

- [ ] **Step 3: Include the checked values in `saveSettings()`**

In `saveSettings()`, right after the existing `tap_count: document.getElementById('s-tap-count').value || '12',` line, add:
```javascript
      hidden_tap_numbers: Array.from(document.querySelectorAll('.hidden-tap-cb:checked')).map(cb => cb.value).join(','),
```

- [ ] **Step 4: Manual browser verification**

Start the app against a scratch DB, log in, go to Settings, confirm the "Hidden Taps" checkbox row shows 1..12 (default tap_count). Change "Total Taps" to 5 and confirm the row regenerates to show only 1..5. Check boxes 2 and 4, click "Save Settings", reload the page, return to Settings, and confirm boxes 2 and 4 are still checked and the row still only shows 1..5. Delete the scratch DB afterward.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Add Hidden Taps checkboxes to Settings"
```

---

## Task 5: Pin / Unpin actions in the Coming Soon admin panel

**Files:**
- Modify: `public/index.html` (`renderComingSoonPanel()`, new `pinTap()`/`unpinTap()` functions)

**Interfaces:**
- Consumes: `POST /api/taps/:id/pin` (Task 2), existing `PUT /api/taps/:id` (for unpin), `computeAvailableTapNumbers()` (existing).
- Produces: nothing consumed by later tasks (last task).

- [ ] **Step 1: Add pin/unpin action markup to each Coming Soon row**

In `renderComingSoonPanel()`, the row template currently is:
```javascript
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
Replace it with:
```javascript
    const rows = taps.map(t => `
      <div onclick="openDrawer('${t.id}')" style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.875rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;cursor:pointer">
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span style="font-weight:600">${esc(t.name)}</span>
          ${t.brewfather_id ? '<span class="integration-badge">🍺 Brewfather</span>' : ''}
          ${t.tap_number ? `<span class="integration-badge">📌 Pinned to Tap ${t.tap_number}</span>` : ''}
        </div>
        <div style="display:flex;gap:0.4rem">
          ${t.tap_number
            ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();unpinTap('${t.id}')">Unpin</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();pinTap('${t.id}')" ${available.length ? '' : 'disabled title="No taps available"'}>📌 Pin to Tap</button>`
          }
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();promoteTap('${t.id}')" ${available.length ? '' : 'disabled title="No taps available"'}>→ Put on Tap</button>
        </div>
      </div>
    `).join('');
```

- [ ] **Step 2: Add `pinTap()` and `unpinTap()`**

Place these right after `promoteTap()`:
```javascript
async function pinTap(tapId) {
  const available = computeAvailableTapNumbers();
  if (!available.length) { toast('No taps available', 'error'); return; }

  const choice = prompt(`Pin to which tap number? Available: ${available.join(', ')}`, String(available[0]));
  if (choice === null) return;
  const tapNumber = parseInt(choice, 10);
  if (!available.includes(tapNumber)) {
    toast(`Tap ${choice} is not available`, 'error');
    return;
  }

  try {
    await api('POST', `/taps/${tapId}/pin`, { tap_number: tapNumber });
    toast('Beer pinned to tap!', 'success');
    await loadTaps();
  } catch(e) {
    toast(e.message, 'error');
  }
}

async function unpinTap(tapId) {
  try {
    await api('PUT', `/taps/${tapId}`, { tap_number: null });
    toast('Beer unpinned', 'success');
    await loadTaps();
  } catch(e) {
    toast(e.message, 'error');
  }
}
```

- [ ] **Step 3: Manual browser verification**

Start the app against a scratch DB, log in, add a coming-soon beer via the Coming Soon panel, click "📌 Pin to Tap", enter an available number in the prompt, confirm the row now shows "📌 Pinned to Tap N" and an "Unpin" button in place of "Pin to Tap" (with "→ Put on Tap" still present). Switch to the public display tab and confirm that tap's card shows the beer with a "Coming Soon" badge, and confirm it *also* still appears in the bottom pipeline section (unaffected by pinning). Return to admin, click "Unpin", confirm the row reverts to showing "📌 Pin to Tap" again, the public display slot reverts to "Available", and the beer is still present in the pipeline section (unpinning doesn't remove it from the pipeline, only from the tap card). Delete the scratch DB afterward.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Add pin/unpin actions to the Coming Soon admin panel"
```

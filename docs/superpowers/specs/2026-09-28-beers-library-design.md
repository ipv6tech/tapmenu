# Beers Library — Design Spec

Resolves [issue #7](https://github.com/ipv6tech/tapmenu/issues/7): restoring a beer that's been on tap before shouldn't require retyping all its details.

## Intent

Scott wants to **re-tap a beer he's brewed before quickly**, without retyping name/style/ABV/description/etc. History/analytics ("this IPA has been on tap 5 times") is explicitly *not* a goal — the beers library exists purely to make re-tapping fast. This decision supersedes the original issue's simpler "browse soft-deleted taps and restore" proposal: a separate `beers` catalog, decoupled from `taps`, was chosen instead.

Success looks like: kicking a familiar beer today, then a few weeks later adding it back to a tap by picking it from a list and adjusting only the tap-specific fields (tap number, on-tap date, price, keg level), instead of retyping everything.

## Non-goals

- No tap-run history view (dates on tap, run counts) — beers library is a catalog only, not a history log.
- No live-linking between a beer's library entry and any tap that was created from it — each tap is an independent, editable snapshot.
- No public-facing API for the beers library — admin/catalog only.
- Does not change existing soft-delete behavior (`status = 'deleted'` rows are untouched, still no browsing UI for them).

## Schema

New `beers` table, added via `runMigrations()` pattern (idempotent, checked at startup):

```sql
CREATE TABLE IF NOT EXISTS beers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  producer          TEXT,
  style             TEXT,
  abv               REAL,
  ibu               INTEGER,
  description       TEXT,
  tasting_notes     TEXT,
  category          TEXT,
  untappd_url       TEXT,
  serving_size      TEXT,
  color             TEXT,
  image_url         TEXT,
  brewfather_id     TEXT,
  brewers_friend_id TEXT,
  grainfather_id    TEXT,
  external_source   TEXT,
  external_id       TEXT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Deliberately excludes anything tap-instance-specific: `tap_number`, `status`, `keg_level`, `on_tap_date`, `price`, `pipeline_stage`, `last_synced_at`. No foreign key from `taps` to `beers` — a tap created from a beer is a fully independent row from that point on.

## Data flow

### 1. Auto-upsert on tap create/update

Whenever a tap is created (`POST /api/taps`) or updated (`PUT /api/taps/:id`) with a non-empty `name`, upsert a matching row in `beers`:

- **Match key:** case-insensitive `(name, producer)`. Brewfather's `brewfather_id` is *not* used for matching — it's different for every batch of the same beer, so it would never dedupe repeat brews of the same recipe. (`brewfather_id` is still stored on the beer row, informationally, as "last known".)
- **Match found:** update that beer row's fields from the tap's current values.
- **No match:** insert a new beer row.
- Runs inside the same transaction as the tap write. If the upsert fails, log a warning and let the tap save succeed anyway — this is a convenience cache, not critical data, and must never block a tap save.

### 2. Create tap from a library beer ("fast re-tap")

The Add Tap form gains a beer picker (autocomplete over `GET /api/beers`). Selecting a beer prefills the new-tap form with its fields as an ordinary editable snapshot — identical to typing them in by hand. The admin still sets tap-instance fields (tap number, status, on_tap_date, price, keg_level) themselves. No association is recorded between the new tap and the source beer row.

### 3. Beers admin page

A new admin section listing all beers (name, producer, style, ABV, updated_at), with inline edit and delete. This exists because auto-save alone will accumulate near-duplicates (e.g. inconsistent capitalization or spacing in `name`/`producer` that the case-insensitive match doesn't catch) — manual cleanup is the release valve for that.

- Delete removes only the `beers` row. It never touches `taps`; existing/past tap rows created from that beer are unaffected.

## API

New `src/api/beers.js`, mounted at `/api/beers`, all routes `requireAuth` (admin-only, no public route needed):

- `GET /api/beers` — list all, ordered by `name ASC`
- `GET /api/beers/:id` — single beer
- `PUT /api/beers/:id` — update fields
- `DELETE /api/beers/:id` — hard delete (no soft-delete needed; this is a curated catalog, not user-facing history)

`src/api/taps.js`: the existing `POST /` and `PUT /:id` handlers gain the upsert-into-beers call described above, wrapped so a failure there doesn't fail the tap request.

## Frontend (`public/index.html`)

- Add Tap form: a "Load from Beers Library" control (search/autocomplete input or a small modal list) above the manual fields. Picking a beer fills the same form fields already used for manual entry — no new form, just a prefill.
- New "Beers" admin nav section: table of library beers with edit (opens the same field set as a tap's descriptive fields, minus tap-instance fields) and delete actions.

## Error handling

- Beer upsert errors are caught and logged, never surfaced to the tap-save caller as a failure.
- Beers admin CRUD follows the same auth/error conventions as the existing taps admin API (401 on missing session, 404 on missing id).

## Testing

No test framework in this repo — verified manually per project convention, using a scratch DB (`DB_PATH=/tmp/<scratch>.db`) and curl:

1. Create a tap with a name → confirm a matching beer row is auto-created.
2. Edit that tap's ABV/description → confirm the matching beer row is updated, not duplicated.
3. Create a second tap with the same name+producer (different case/spacing variations to confirm the match) → confirm it updates the same beer row.
4. Create a tap with a different name → confirm a distinct new beer row.
5. Use the beer picker to create a new tap from an existing beer → confirm prefill is correct and the new tap is independent (editing it afterward doesn't touch the beer row).
6. Delete a beer via the admin page → confirm existing/past tap rows are untouched.
7. Beers admin CRUD: list, edit, delete — confirm auth is enforced (401 without session).

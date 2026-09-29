# Available Tap Slots & Coming-Soon Pinning — Design Spec

Resolves [issue #13](https://github.com/ipv6tech/tapmenu/issues/13): show all `tap_count` tap slots on the public display, even empty ones (reserving their space unless explicitly hidden), and allow a coming-soon beer to be pinned onto a specific tap card so it shows there as "Coming Soon" instead of only in the pipeline section.

## Intent

Today the public tap grid only renders a card for each existing tap row — a physical tap with nothing currently assigned to it (never used, or its history fully soft-deleted) shows no card at all, so the grid visually shrinks instead of showing the taproom's actual physical layout. Scott wants every declared tap slot (`1..tap_count`, from the existing PR #9 setting) to always occupy its space on the display, so the grid always reflects "this taproom has N taps" — with an explicit way to hide specific numbers that aren't in public use. Separately, he wants a lightweight way to preview an upcoming beer directly on the tap card it's destined for, without fully activating it.

Success looks like: setting `tap_count` to 12, having 8 in active use, and seeing all 12 slots reserved on the display — 8 with real beers, and the other 4 either showing "Available" or, for one of them, a "Coming Soon" preview of tomorrow's release — with slots 9-10 (say, taps that don't physically exist yet) hidden via a new setting.

## Non-goals

- No change to `promote()`'s behavior or the existing admin promote flow (issue #9's spec) beyond what's noted below (stale-pin cleanup, which its existing conflict-clearing logic already provides for free).
- Pinning does not reserve/occupy the tap number for availability purposes — the same number can still be promoted into or re-pinned regardless of an existing pin (per Scott's explicit choice), except pinning itself rejects targeting a number another coming-soon tap is already pinned to.
- No change to the pipeline section (bottom-of-page "Coming Soon" chips) — a pinned beer continues to appear there unchanged; pinning is additive, not a replacement location.
- No visual redesign of the existing card types (`gridCardHTML`/`largeCardHTML`/`listCardHTML`) beyond adding an "Available" placeholder variant and a pinned-coming-soon variant.

## Data model

No new tap columns. `tap_number` on a `status = 'coming-soon'` row is now a first-class, meaningful value ("pinned to this slot") — the existing `promote()` endpoint already writes `tap_number = NULL` on *other* coming-soon rows holding the target number when a promotion happens onto it (see `src/api/taps.js`'s existing conflict-clearing `UPDATE`), so this data usage is an extension of already-present plumbing, not a new concept.

One new setting (seeded in `initSchema()`, added to the settings allowlist in `src/api/auth.js`):

| Key | Default | Notes |
|-----|---------|-------|
| `hidden_tap_numbers` | `''` | Comma-separated tap numbers (e.g. `"9,10"`) excluded from the public grid entirely — no card rendered for them, whether empty, pinned, or otherwise. |

## API

### `POST /api/taps/:id/pin` — pin a coming-soon tap onto a specific number

Body: `{ tap_number }`. Auth required.

1. Load tap `:id`; 404 if missing, 400 if `status !== 'coming-soon'`.
2. 409 if `tap_number` is currently occupied by an `active` row (same availability check `promote()` already uses).
3. 409 if a *different* `coming-soon` row already has this `tap_number` ("already pinned by another beer" — reject per Scott's choice, don't auto-displace).
4. Soft-delete (`status = 'deleted'`) any `kicked`/`hidden` row currently holding that `tap_number` (mirrors `promote()` step 3 — a pin should clear stale dead-keg cards the same way a promotion does).
5. `UPDATE taps SET tap_number = ? WHERE id = ?` — nothing else changes (`status`, `pipeline_stage`, everything else stays as-is; it's still coming-soon).
6. Return the updated tap.

### Unpin

No new endpoint — the existing `PUT /api/taps/:id` already supports `{ tap_number: null }`, which is exactly "unpin."

## Grid rendering (`public/index.html`)

`renderDisplay()` currently maps only over `state.taps` rows that qualify (`status !== 'coming-soon' && status !== 'hidden'`). Replace the grid-building logic with a slot-based iteration:

1. Parse `hidden_tap_numbers` into a `Set<number>`.
2. For `n` in `1..tap_count`:
   - If `n` is in the hidden set → render nothing for this slot.
   - Else pick the highest-priority tap row with `tap_number === n`, in order: `status === 'active'` → `status === 'kicked'` → (`status === 'coming-soon'` AND this is its pinned number) → none found.
   - Render: the matching row's normal card (active/kicked use the existing card renderers unchanged) — for the coming-soon-pinned case, a card showing the beer's name/style/etc. exactly like a normal card, but with a "Coming Soon" status badge in place of keg level/serve-method/on-tap-date (those fields don't apply pre-tap); for "none found", a new lightweight "Available" placeholder card (tap number only, no beer content).
3. Taps whose `tap_number` is `null` (unassigned coming-soon, or historical rows) are simply never chosen by this loop — no separate handling needed.

This replaces the flat `activeTaps.map(...)` in `renderDisplay()`; `renderPipeline()` is untouched (still filters `status === 'coming-soon'` regardless of pin state).

Applies to all three layouts (`gridCardHTML`, `largeCardHTML`, `listCardHTML`) — each needs an "Available" placeholder variant and to handle the pinned-coming-soon case (reusing their existing markup with the info fields it doesn't have simply omitted, same pattern already used for `coming-soon`/`kicked` hiding `serve_method`/`glassware` per the existing "Serve Method / Glassware Visibility" business rule).

## Settings UI

Below the existing `tap_count` field in Settings, a "Hidden Taps" control: a row of checkboxes labeled `1..tap_count` (re-rendered whenever `tap_count` changes), checked ones written into `hidden_tap_numbers` as CSV on save. Matches the existing Settings save/load pattern (`loadSettingsForm()`/`saveSettings()`).

## Admin Coming Soon panel

Each coming-soon row gets a new "📌 Pin to Tap" action next to the existing "→ Put on Tap" button, opening the same available-numbers picker (reusing `computeAvailableTapNumbers()` — unaffected by pins, per the occupancy decision) and calling the new pin endpoint on confirm. A row that already has a `tap_number` set shows "📌 Pinned to Tap N" with an "Unpin" button (calls the existing `PUT` with `tap_number: null`) instead of the "Pin to Tap" button. The "→ Put on Tap" button remains available regardless of pin state — promoting a pinned coming-soon tap onto its own pinned number (or a different one) works exactly as `promote()` already does today.

## Error handling

- Pin endpoint's 409s carry a clear message (`"Tap 5 is already active"` / `"Tap 5 is already pinned to <other beer name>"`) so the admin UI can toast it, matching `promote()`'s existing error-message pattern.
- Malformed/out-of-range `hidden_tap_numbers` values (e.g. a number greater than `tap_count`) are harmless no-ops — the slot loop only ever iterates `1..tap_count`, so a stale hidden entry for a number outside that range simply has no effect.

## Testing

No test framework in this repo — verified manually via curl against a scratch DB and Playwright for the display grid, per this project's established convention:

1. Set `tap_count` to a small number (e.g. 5), leave some slots with no tap row at all — confirm the public grid shows exactly 5 cards, with unused ones as "Available" placeholders.
2. Hide one number via the new setting — confirm its slot renders nothing (grid has one fewer card, others unaffected).
3. Pin a coming-soon tap to an empty number — confirm its card shows name/style + "Coming Soon" badge, and it still also appears in the pipeline section unchanged.
4. Attempt to pin a second coming-soon tap to the same already-pinned number — confirm 409 and no change.
5. Attempt to pin onto a number currently active-occupied — confirm 409.
6. Pin onto a number currently held by a `kicked` row — confirm the kicked row is soft-deleted and the pinned card replaces it.
7. Promote a *different* coming-soon tap onto a pinned number — confirm the existing conflict-clearing logic frees the stale pin (its `tap_number` becomes `null`) and the promoted tap's card takes over that slot.
8. Unpin (`PUT tap_number: null`) — confirm the slot reverts to "Available" and the beer still shows in the pipeline section.
9. Confirm all three layouts (grid/large/list) render the "Available" placeholder and pinned-coming-soon cards without errors.

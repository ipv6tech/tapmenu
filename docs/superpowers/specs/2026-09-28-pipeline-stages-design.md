# Pipeline Stages for Coming Soon Taps

Resolves: [#3 — Split out Coming Soon from Tap status](https://github.com/ipv6tech/tapmenu/issues/3), [#2 — Investigate Brewfather Batches that are in "Planning mode"](https://github.com/ipv6tech/tapmenu/issues/2)

## Problem

Today, `coming-soon` is a single flat tap status. Any Brewfather-linked tap in
`coming-soon` status is hardcoded to display "Fermenting" in the public
pipeline section, regardless of whether the batch is actually Planning,
Brewing, Fermenting, or Conditioning in Brewfather (#2). There's also no
admin-side view dedicated to upcoming beers — they're mixed into the single
"All Taps" table — so newly imported or added upcoming beers aren't easy to
track as a group (#3).

## Goals

- Give `coming-soon` taps a granular pipeline stage: Planned, Brewing,
  Fermenting, Packaged.
- Auto-populate that stage from Brewfather batch status on import and sync.
- Let admins set/change the stage manually for taps not linked to Brewfather.
- Show the real stage (not a hardcoded guess) in the public pipeline section.
- Add a dedicated "Coming Soon" admin view, grouped by stage, that Brewfather
  imports/syncs and manually-added upcoming beers land in automatically.
- Let admins rename the label of the final stage (default "Packaged") to
  whatever fits their taproom's voice (e.g. "On Deck", "Up Next").

## Non-goals

- No change to the `active` / `kicked` / `hidden` statuses or their existing
  visibility rules.
- No "promote to active" workflow beyond what already exists (editing a tap's
  status/tap_number in the edit drawer).
- No beer/recipe archive (tracked separately as
  [#7](https://github.com/ipv6tech/tapmenu/issues/7)).

## Data model

Add one nullable column to `taps`:

```sql
ALTER TABLE taps ADD COLUMN pipeline_stage TEXT
```

Valid values: `planned`, `brewing`, `fermenting`, `packaged`. Only meaningful
when `status = 'coming-soon'`; `NULL` for all other statuses, and also `NULL`
for legacy `coming-soon` rows until an admin sets a stage or a Brewfather sync
populates one (in which case the pipeline section falls back to a generic
"Coming Soon" label).

Add one new setting (seeded in `initSchema()`, added to the `PUT /settings`
allowlist in `src/api/auth.js`):

| Key | Default | Notes |
|-----|---------|-------|
| `pipeline_packaged_label` | `'Packaged'` | Display label for the final pipeline stage. Only this stage's label is configurable — Planned/Brewing/Fermenting stay fixed, matching Brewfather's own terms. |

Migration (idempotent, added to `runMigrations()` in `src/db.js` alongside the
existing `ALTER TABLE` calls, using the existing duplicate-column catch
pattern).

## Brewfather status mapping

Extend `src/api/brewfather.js`. Today `brewfatherStatusToTapStatus(bfStatus)`
maps Brewfather status to a tap `status`. Add a companion function
`brewfatherStatusToPipelineStage(bfStatus)`:

| Brewfather status | Tap status (unchanged) | Pipeline stage (new) |
|---|---|---|
| Planning | coming-soon | planned |
| Brewing | coming-soon | brewing |
| Fermenting | coming-soon | fermenting |
| Conditioning | coming-soon | packaged |
| Completed | active | `NULL` |
| Archived | kicked | `NULL` |
| (anything else) | active | `NULL` |

Call this alongside `brewfatherStatusToTapStatus` in all three places that
currently call it: `POST /import/:id`, `POST /import-bulk`, `POST
/sync/:tap_id`, and `POST /sync-all` — each of those INSERT/UPDATE statements
gains a `pipeline_stage` column and bound value.

## Manual editing (tap edit drawer)

In the drawer (`public/index.html`, the `f-status` select and its surrounding
form), add a "Pipeline Stage" `<select id="f-stage">` with options Planned /
Brewing / Fermenting / *(configurable label)*. It's shown only when `f-status`
is set to `coming-soon`, hidden otherwise (plain JS show/hide on the status
select's `onchange`, mirroring how other conditional fields in this drawer
already behave). Included in the tap create/update payload as
`pipeline_stage`, sent as `null` when status isn't `coming-soon`.

## Public pipeline section

`renderPipeline()` in `public/index.html` currently computes:

```js
const statusLabel = t.brewfather_id ? 'Fermenting' : 'Coming Soon';
```

Replace with a lookup keyed by `t.pipeline_stage`:

```js
const STAGE_LABELS = { planned: 'Planned', brewing: 'Brewing', fermenting: 'Fermenting' };
const statusLabel = t.pipeline_stage === 'packaged'
  ? (state.settings.pipeline_packaged_label || 'Packaged')
  : (STAGE_LABELS[t.pipeline_stage] || 'Coming Soon');
```

This directly resolves #2: the label now reflects the tap's actual stage
instead of a hardcoded guess.

## New admin "Coming Soon" section

New sidebar entry (`sb-coming-soon` / `showPanel('coming-soon')`) next to "All
Taps", following the existing `sidebar-btn` / `admin-panel` pattern. Panel
lists only `status = 'coming-soon'` taps grouped under four headings (Planned
/ Brewing / Fermenting / *(configurable label)*), each row showing name and a
Brewfather link badge (if linked). Clicking a row opens the same edit drawer
used by "All Taps" (`openDrawer(tap.id)`), where the stage dropdown added
above lets the admin change it — no new inline-editing widget, just a
filtered/grouped read of the same tap list. No separate backend endpoint
needed — it filters the same `state.taps` array already loaded by
`loadTaps()`.

Brewfather imports/syncs and manually-added upcoming beers all land here
automatically since they're just taps with `status = 'coming-soon'` — no
additional tracking/queueing mechanism required.

## Testing

No test suite in this project (confirmed in prior work this session). Verify
manually with the dev server + Playwright, matching the pattern used
throughout this session:
- Create taps in each of the 4 stages (2 manual, 2 via a mocked/real
  Brewfather import) and confirm correct labels in the public pipeline
  section and correct grouping in the new admin Coming Soon view.
- Change the `pipeline_packaged_label` setting and confirm it updates both
  the admin section heading and the public pipeline chip label.
- Confirm a tap edited to a non-coming-soon status hides the stage dropdown
  and clears `pipeline_stage` server-side.
- Confirm existing `active`/`kicked`/`hidden` taps are unaffected (regression
  check against the status-display work from the previous branch).

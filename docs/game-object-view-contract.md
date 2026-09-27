# Game object view: bounded VESPERIX pilot

User correction: a project task collector is not sufficient. Build the first useful
game-development flow around `zone_forest_shrine_outer`, while retaining the separate
Canvas and existing records entry points.

## Delivered slice to implement

- Explicitly connect a local VESPERIX repository to a project. Directory aliases remain
  discovery metadata, not filesystem permission. Store this connection locally; do not
  restore read permission from portable project imports.
- Read the real Zone/SubLocation/Content/associated encounter JSON files. Never write
  those files from the browser. Restrict reads to the connected repository's known
  DungeonExploration config subtree, regular JSON files and bounded sizes/counts.
- Show Zone entry, locations and declared routes. Show configuration candidates and
  their encounter data separately from runtime-selected content, which is unknown here.
- Select a location to inspect names, descriptions, first-entry content, weighted
  candidates, shop/gate links and exact source JSON/hash. Missing/duplicate/broken
  references stay visible as diagnostics, rather than being silently filled in.
- Prepare an object-scoped modify/verify request with source versions and a user note.
  User explicitly selects and sends to one existing bound task. Reuse durable delivery
  receipts; no automatic outbound task is sent during implementation or smoke tests.
- Create the associated work record as part of that action, preserving planned versus
  actual execution. Retried actions keep one record and one feedback request. Display
  associated records/results back on the object; a record status is not runtime proof.
- Refresh detects changed sources. A new action from a stale view must refresh before
  submission. Already accepted action retries retain their original context.

## Loading and freshness

- The workspace reads its Zone list and selected Zone in one authenticated
  `game/view?zone_id=...` request. Both come from the same repository snapshot.
- A bounded, process-local index reuses unchanged parsed JSON. Each normal read
  inventories paths, file sizes, creation times and modification times; additions,
  deletions, parse errors and excluded reparse paths remain visible.
- Explicit Refresh uses `refresh=true` and re-reads every source. This also handles
  external tools that preserve file size and timestamps while changing contents.
  Window focus and Zone navigation use the incremental read.
- New modify/verify actions always read and hash fresh source bytes before comparing
  the requested revision. The browsing cache cannot authorize a stale new action.
- Neither the cache nor its contents confer project access. Connection checks still run
  on every request. The original source endpoints and Canvas entry remain available.

## Verification boundary

Isolated repository/database fixtures exercise parsing, path containment, malformed and
missing references, source changes, action retry and task-target changes. Browser fixtures
exercise object selection/source inspection/request preparation and responsive layout.
Live VESPERIX acceptance reads configuration and connects the project only: no game file
modification, no PlayMode control, no real task submission and no completion claim.

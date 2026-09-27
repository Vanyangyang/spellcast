# Game planning workspace: R0–R2

User-approved direction: systems provide shared rules, states and parameters; content
references them, with explicit local parameter overrides. Player flows connect systems
and content. Scope is the current R0/R1/R2 planning effort, not the legacy config library.

## First usable slice

- Game development opens planning by default. Existing Canvas, records, project access
  and export/import remain available. User feedback 261 explicitly excludes old game
  configuration from this workspace: no configuration tab, automatic scans, projections
  or historical values in the new planning views. Existing adapter data stays on disk.
- Extend the canonical development object with optional `planning`. No duplicate content
  store and no automatic conversion of legacy objects or import of game configurations.
- Planning kinds: `system`, `rule`, `hook`, `parameter`, `content`, `flow`.
- Shared fields: R0/R1/R2 scope membership, draft/confirmed design state, body, source
  references and typed links (`belongs_to`, `uses`, `depends_on`, `follows`).
- Rules record trigger, conditions and effects. Hooks record player cue, action, payoff
  and continued motivation. Parameters record value, unit, bounds, formula text and named
  candidate values. Formulas are not executable code or runtime simulations.
- Links reference canonical object IDs in the same project. A parameter `uses` link may
  carry a numeric local value plus rationale; changing one consumer cannot mutate the
  shared parameter. Show direct/indirect references and inherited versus local values.
- Use optional structured fields; creating a draft requires only a name and scope.
  Unknown values remain unset. Do not invent approved R0–R2 gameplay content.
- Editing occupies the available work area. Preserve drafts, selection and view filters;
  conflict handling must retain local edits. Sources and records are secondary details.
- The primary view is a spatial system graph. Systems and player flows form the stable
  base. R0/R1/R2 filter the overlaid rules, numbers, content and experience hooks in the
  same positions; independent layer switches and Skeleton only never rearrange the base.
- Explicit `belongs_to` locates an overlay; otherwise actual `uses` references can locate
  it through rules/parameters. A canonical object can be projected at several hosts without
  being copied. Unattached objects remain visible with a clear marker. Cycles terminate.
- Solid base connections reflect saved links. Dashed cross-system overlay connections
  expose the exact source, target and relationship in their label/inspector. They are not
  invented system flow. `follows` arrows run predecessor to successor. Local numeric
  values and inherited shared values are labelled independently.
- Node positions, camera, layer visibility and inspection selection are local view state,
  persisted separately from game design. Dragging and zooming never unlock or edit content.
  Plain mouse wheel uses Canvas's bounded step zoom at the pointer; Ctrl/Meta also work.
  Blank-space drag pans. Detail/editor scrolling remains local to those content areas.
  Wheel events are coalesced per animation frame; zoom bounds preserve the mouse anchor.
  Contextual creation preselects type/scope and optional system/flow host; graph editing
  opens the wide canonical editor. The directory is an auxiliary lookup view.
- A project without active planning objects displays an explicitly labelled, in-memory
  interactive example. It cannot be edited into the project or sent as saved facts. Creating
  a real object starts the real graph. No example or legacy configuration is imported.
- Saved objects open read-only. Explicit Edit / Unlock & edit resumes the local draft.
  Save & lock and Cancel edits & lock restore protection. Navigation preserves unfinished
  drafts separately; an explicitly unlocked object stays unlocked until locked or saved.

## Persistence and compatibility

- Project schema migration v2→v3 adds a nullable planning JSON field to development objects.
- Writes, immutable object history and request receipts remain one transaction with
  expected_revision checks. Legacy object writes omitting planning preserve it.
- Object history can be restored as a new revision after current relationship validation.
- Optional `planning.locked` is independent of design confirmation. False is omitted for
  legacy canonical-history compatibility. Locked current objects reject `put_object`
  (including archive or clearing the flag) and `restore_object` for every writer.
  Only explicit `set_object_lock {id,expected_revision,locked}` changes protection;
  it uses the same transaction, OCC, receipt and version-history rules.
  Restoration restores the historical lock flag. Export/import and restart retain it.
- Export bundles with planning data use version 2; old version 1 bundles still import.
  Preserve canonical IDs, relationships, local overrides, history and external references.
- Validate same-project targets, kinds, finite numeric values, bounds and containment
  cycles. Keep actual duplicate definitions visible. Archive retains references and history.
- Existing Agent access and local-owner attribution remain in force. No automatic task
  dispatch, VESPERIX source changes or Unity operation is needed for this implementation.

## Acceptance

- Fixtures: shared parameter referenced by two content items, one with an override;
  update shared value, inspect impact/effective values, preserve source and object identity.
- Retry, stale revision, invalid links/overrides, old-client writes, history restore,
  v2 migration, restart and export/import must preserve the planning graph.
- Browser: create/edit rules, hooks and numbers; switch R0/R1/R2; inspect incoming
  links; use a candidate value; retain drafts and conflicts; verify wide/narrow layouts.
- Graph: independent layers, unchanged base positions across scope changes, drag/zoom
  persistence after reload, correct shared/local values, canonical reference identity and
  link provenance, visible unattached cycles and zero example writes.
- Correct the existing config adapter's foreign-key misclassification (SubLocation.ZoneId
  must not define a Zone) and the optional map's node/edge coordinate mismatch.
- Build/install locally with a closed-database backup; verify prior Canvas and project
  records remain. Test content stays in isolated fixtures.

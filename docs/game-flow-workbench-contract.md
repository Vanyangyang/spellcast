# Game flow workbench implementation scope

This slice follows the user's request for an indie game-development workbench and the
reference review. It turns player flows into editable steps, branches and explicit state
changes, with a walkthrough and a result that can seed an existing work record.

## Data

`PlanningFields.flow` is optional and only valid on `kind=flow`. It contains an entry
step, typed variables and steps. Variables have stable IDs, names, number/flag/text type,
initial text, unit, and an optional canonical parameter ID through an explicit `uses`
link. The walkthrough takes its starting value from that parameter/local override.

Steps contain player goal, action and feedback text. Outgoing choices target stable step
IDs and carry AND conditions plus explicit set/add/subtract effects. An operand is a
literal or another variable. Cycles are allowed; each advance is a user action and a
session has a bounded length. A step can require a manual result before continuing or be
an explicit ending. No arbitrary expression evaluation or engine execution is introduced.

Incomplete initial values can be saved as undecided, but block starting a walkthrough
until supplied. Missing IDs, invalid types/operators and dangling transition targets
are rejected. Empty flows are valid unfinished designs. Existing planning JSON and
history keep their prior canonical form when `flow` is absent; no DB migration is needed.

## Work area

- Flow editor: select/create a player step, edit choices and conditions/effects, inspect
  the step graph, and edit typed variables/parameter bindings in a table.
- Walkthrough: pick initial inputs, see available/blocked choices and explanations,
  advance one choice, inspect before/after changes and chart numeric values by step.
- Manual-result steps require an explicit acknowledgement/input; those inputs are
  recorded as manual. A walkthrough is not a real game verification result.
- Session state includes source versions and a frozen definition/input snapshot. Reopen
  resumes the same session; changed sources require a fresh run, preserving the old trace.
- Saving a result seeds a reviewable work-record draft, including scope, inputs, route,
  outcome and preview boundary. It never sends an external task or overwrites another draft.

## Reuse and boundaries

Use existing X6 for the step graph, Tabulator for variables, ECharts for traces, loaded
when the feature is opened. Common components read canonical data; preview values remain
separate. The independent Canvas and existing system map remain available.

Do not import old VESPERIX configuration or invent its new R0–R2 design. An in-memory
example can teach the interaction, with no real-object save or task-send path.

## Acceptance

Validate persistence/portability/locks for the optional flow payload; reference and type
checks; deterministic conditions/effects including atomic failure; shared/local parameter
initialization; manual-result gate; loop bound; source freshness; resume/rewind; step and
value editing; map/curve mounting and disposal; and reviewed work-record handoff. Build
and update locally with a closed backup and existing-data comparison.

## Follow-up: linked trials (2026-09-26)

`docs/game-workbench-linked-trials-contract.md` extends this slice. Saved walkthroughs are now
immutable project trials that travel with export/import (bundle version 3); the browser keeps
only the active checkpoint. Source freshness distinguishes execution changes (flow definition,
bound values, units, archiving) from editing metadata such as lock state, while keeping the full
snapshot. The record summary cites the saved trial instead of a local copy.

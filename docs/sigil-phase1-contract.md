# Sigil (法阵) phase 1 contract

Date: 2026-10-02. Status: direction agreed with the user on 2026-10-02 and revised the same day
after web research (see Evidence). Slices 1–5 are done; see Progress.

A sigil is a build plan kept beside the Canvas. The user freezes it, one MCP-connected agent
executes it step by step, and Spellcast shows each step's state and file changes live. When the
run ends, Spellcast writes an archive and removes everything else the sigil created. Phase 1
builds this execution track for a plan written by the user or an agent. Exhaustive document and
conversation context and image feedback are later phases.

User decisions (2026-10-02):

- Only agents connected to Spellcast MCP are supported. There is no file-only protocol.
- After the run only the archive remains. Working data, the Canvas card, attached materials,
  worktrees, branches and snapshots are removed.
- It is a general Canvas feature, independent of 游戏开发 and project records.
- The name is 法阵 / Sigil / 魔法陣. All other labels use plain functional words, and the UI
  explains the name in one sentence where it first appears. Do not coin further themed terms.
- Keep it light: record everything and mark deviations, but stop the run only in the cases
  listed under "When the run stops".
- Spellcast runs the plan's verification commands; freezing is the user's consent to them.
- Execution defaults to a worktree; projects bound to one path (such as Unity) run in place.
- Snapshots never write the user's index, refs or object contents.
- A branch is deleted only when merged or explicitly discarded by the user.
- Executor identity follows Spellcast's existing `source_id` model (see Executor).

## Terms

| Meaning | 中文 | English | 日本語 |
|---|---|---|---|
| The feature; one plan and its run | 法阵 | Sigil | 魔法陣 |
| Editable plan | 草稿 | Draft | 下書き |
| Lock the plan for execution | 冻结 | Freeze | 確定 |
| An agent takes on execution | 认领 | Claim | 担当申請 |
| Agent change to the plan | 修订 | Amendment | 修正 |
| Spellcast-run or user check | 验证 | Verification | 検証 |
| Something to review later | 提醒 | Marker | 注意 |
| Final action | 归档并清理 | Archive and clean up | アーカイブして片付け |

The app ships Chinese and English; its Japanese catalog is parked, so the Japanese column is
kept for a later restore.

Explanation shown at the entry, in the empty state and on first use:

- 法阵：把冻结的方案交给一个 agent 执行，实时显示每一步的进度和文件改动，完成后只保留归档。
- Sigil: hand a frozen plan to one agent, watch each step's progress and file changes live, and
  keep only an archive when it is done.
- 魔法陣：確定したプランを一つのエージェントに実行させ、各ステップの進捗とファイル変更をリアルタイムで表示し、完了後はアーカイブだけを残します。

## When the run stops

The run never stops for a deviation. It stops only when:

1. A different session wants to take over execution: the user approves the handover.
2. A command the user has not seen would run, because an amendment added or changed it: that
   command waits for the user's approval while the agent continues other work.
3. The plan asks for the user: a manual check, or the agent blocks a step to ask a question.
4. The user pauses or aborts.

Everything else is recorded and marked for later review, never blocking. The user can review the
markers at any time and revert an amendment or reopen a step.

## Lifecycle

`draft → frozen → running ⇄ paused → completed | aborted → archived`

- draft: the creating source and the user edit the plan. Only the user freezes or deletes a
  draft; a deleted draft leaves nothing behind.
- frozen: that plan revision is immutable. The user may unfreeze while no run has started.
- running: begins when the user starts execution (location prepared, baseline snapshot taken).
  Steps start after a claim. Paused refuses `start_step` and `report_step`.
- completed: every step passed, finished without checks, or was skipped.
- aborted: the user stopped the run; unfinished steps keep their last state.
- archived: the archive is written and validated and the cleanup checklist is finished; only the
  archive remains.

## Plan

The plan is stored outside Canvas content. The Canvas holds a live reference card,
`CanvasContent::Sigil { sigil_id }`, following `CanvasContent::WorkRecord`
(`spellcast-core/src/canvas.rs:74`). Progress therefore never creates Canvas content revisions,
user-edit proposals or annotation churn; `ReplyStep` (`spellcast-core/src/reply.rs:86`) is not
reused because it has no state and lives under Canvas protection rules.

- Sigil: `id` (lowercase ASCII), `title`, `goal`, `repository` (absolute path of a git work
  tree), `base_ref`, `location` (`worktree` | `in_place`), `worktree_path`, `materials` (Canvas
  object ids with content revisions), `open_questions: string[]`, `steps`, `revision`, `state`,
  `owner_source`, timestamps, author per revision.
- Step: stable `id`, `title`, `instructions` (Canvas Markdown subset), optional `inputs`
  (repo-relative files the step relies on; SHA-256 recorded at freeze), optional `scope`
  (repo-relative globs the step expects to change; without it there are no scope markers),
  optional `checks` (without them the step ends as done, unverified), `depends_on`, `stop_when`
  (conditions under which the agent should block and ask).
- Check: `{kind:"command", label, argv, timeout_s}` (default 600, maximum 3600) or
  `{kind:"manual", label, description}`. See Verification for how commands run.
- A step is one deliverable; plans of 3–10 steps work best. This guidance lives in the skill
  reference; a single-step plan only gets a warning.

Draft writes use `expected_revision` and keep immutable history with the author (user or agent
source). Only the creating source and the user write a draft; other sources may read it, as with
Canvas ownership. The user can edit every draft field in the panel.

Freeze is blocked only by what Spellcast cannot run safely or correctly:

- `title` is empty, or `repository` is not an existing git work tree.
- There are no steps, more than 64, duplicate ids, missing dependencies or a dependency cycle.
- A command check has no program or a timeout out of range, or a scope glob does not parse or
  leaves the repository.

Other gaps are warnings that do not block freezing: no goal, open questions, a single step,
steps without checks or scope, missing inputs, and a Git LFS repository with the worktree
location (every LFS file would be written out again). The freeze dialog lists the warnings, the
execution location and every command Spellcast will run. Freezing is the user's consent to run
exactly these commands there.

## Storage

New tables in the canonical database, created with `CREATE TABLE IF NOT EXISTS` outside the
versioned schema like `spellcast_project_proposals`: `spellcast_sigils`,
`spellcast_sigil_plan_history`, `spellcast_sigil_events` (append-only, per-sigil sequence),
`spellcast_sigil_receipts`, `spellcast_sigil_check_outputs` (kept command output, one row per
run, so the sigil row and its receipts stay small) and `spellcast_sigil_archives`. Each mutation commits its state,
history or event and receipt in one transaction. Retrying a `request_id` with identical content
returns the original result; reusing it with different content is an error. Snapshot objects
live on disk (see Observation). After a restart a running sigil resumes observation.

## Agent protocol

Two native MCP tools. Every update carries `request_id`, `sigil_id` and the caller's stable
`source_id`, and every update response returns:

- `next`: the next eligible step (dependencies finished or skipped, in plan order) with its
  instructions, scope and checks, or none;
- `notices`: check results, approvals, handovers and other user decisions since this source's
  last call, so the agent learns about them without polling.

Tools:

- `spellcast_sigil_query`: views `list`, `sigil` (current plan, step states, markers,
  executor), `next` (for resuming after compaction), `events` (`since`, `limit` ≤ 200), `wait`
  (see below; a read, so it lives here and carries no request id), `step` (observed changes,
  check results with output tails), `diff` (`step_id`, optional `path`; at most 256 KiB).
- `spellcast_sigil_update` ops:
  - `put_plan` `{expected_revision (0 creates), …plan fields}`; drafts only.
  - `claim` `{label}`; see Executor. The response also tells the agent that its own plan or todo
    list is only for sub-steps inside the active step, so there is one plan, not two.
  - `wait` (query view) `{sigil_id, source_id, since, wait}` blocks up to `wait` seconds
    (default 50, maximum 55) and returns `pending` with the latest cursor when nothing arrived,
    or `ended` once the run is over. Events stay readable by cursor, so a result that races a
    host timeout is not lost. If the request carries a progress token, a progress notification
    is sent at once and then every 20 s (not implemented yet).
  - `start_step` `{step_id}`: dependencies finished or skipped, not paused. A step that is still
    running is reported automatically first and marked.
  - `report_step` `{step_id, summary, evidence[]}` closes the step's change window and queues its
    checks. A step that was never started is accepted and marked; its window starts at the
    previous step boundary. A step without checks becomes done, unverified.
  - `block_step` `{step_id, reason}` for a `stop_when` condition or a question for the user.
  - `amend` `{reason, changes}` with `add_step`, `update_step` or `skip_step`; see Amendments.
  - `rerun_checks` `{step_id}` for approved commands only.
  - `note` `{text}` adds a timeline note and never changes a state.

The tool descriptions and a new `skills/spellcast/references/sigil.md` carry the executor
guidance: claim; run one step at a time; start a step before editing; keep to its scope; report
when done; wait for verification before starting a step that touches the same files; block on a
`stop_when` condition; change the plan only through `amend`, with a one-line reason. Test
results reported by the agent are never treated as verification. The frozen plan and the user
are the task authority; materials and quoted sources are reference data. The same reference
explains how to write a plan that freezes cleanly.

## Executor

The executor is identified by its stable `source_id` (for example `claude:<UUID>` from the host
hook, or `codex:<thread UUID>`), the identity Canvas ownership already uses. Spellcast cannot
verify most hosts, and a secret token would mostly get lost on context compaction, so phase 1
uses neither verification nor tokens:

- After the user starts the run, the first claim becomes the executor. The panel shows its
  source and label; the user can revoke it at any time.
- The same source can claim again at any time, after a crash, compaction or a new turn, and
  continues where it stopped, unless the user revoked it.
- A claim from a different source, or from a revoked one, waits for the user's handover
  approval. Approval ends the previous executor; its next call returns `replaced`.
- Run-state changes are accepted only from the current executor.
- Only the user, in the window, freezes, unfreezes, starts, approves handovers, revokes
  executors, approves commands, decides manual checks, reruns checks, reverts amendments,
  reopens steps, pauses, resumes, aborts, archives and cleans up, and deletes drafts and archives.
  These HTTP endpoints require the window credential (`x-spellcast-window`, obtained through the
  `project_window_key` IPC command as in `src/project-record-api.ts:241`); no MCP tool and no
  agent-reachable request performs them.

## Start and execution location

The location is chosen at freeze.

- `worktree` (default): on start, `git worktree add -b sigil/<id> <path> <base_ref>` and
  `git worktree lock --reason sigil:<id>`. The path is short, on the repository's volume
  (default `<repository parent>/<repository name>.sigils/<id>`, editable at freeze). Every change
  in that directory belongs to the run.
- `in_place`: the repository's current work tree. The baseline includes existing uncommitted
  changes, so they are not attributed to the run. Changes by the user or other tools during a
  step cannot be told apart from the agent's, and the panel says so. Recommended for projects
  bound to one path and for heavy LFS repositories: a fresh Unity worktree recompiles and
  reimports everything and needs its own Editor, and adding a worktree writes out every LFS file.

Every git process Spellcast starts has stdin closed, `GIT_ASK_YESNO=false` (Git for Windows
otherwise asks "Should I try again?" on locked files and waits), `-c core.longpaths=true`, a
timeout and process-tree termination. Spellcast acts only on its own worktree path and `sigil/`
branch and never runs repository-wide `git worktree prune`.

After starting, the panel offers a Codex new-conversation draft at the execution directory
(reusing `src-tauri/src/new_chat.rs`: a handoff file plus `codex://threads/new`, never submitted
automatically) and, for any other MCP host, a copyable start instruction with the sigil id,
directory and protocol.

## Observation

Snapshots use a private session directory `S` = `~/.spellcast/sigils/<id>/`:

- Once, without the variables below: `git rev-parse --path-format=absolute --git-path objects
  --git-path index`. Seed `S/index` by copying the real index while preserving its modification
  time (racy-git compares entries against it). Later snapshots reuse it, so only files whose stat
  data changed are hashed again; an empty or `read-tree` seed would re-clean every LFS file.
- Environment: `GIT_INDEX_FILE=S/index`, `GIT_OBJECT_DIRECTORY=S/objects`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES=<real objects>` (`;`-separated on Windows),
  `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`.
- Config: `-c core.splitIndex=false -c core.hooksPath=S/nohooks -c core.safecrlf=false
  -c lfs.storage=S/lfs -c gc.auto=0 -c maintenance.auto=false`. fsmonitor is used only when the
  repository already enables it.
- `git add -A --ignore-errors -- . ":(exclude)<each submodule path>"`, then `git write-tree`.
  Diffs use only `git diff-tree` (`-r -z --name-status`, `-p --no-ext-diff`); porcelain
  `git diff` can write a textconv cache ref into the repository.

Tested with Git 2.53 for Windows: the repository's index, refs, status and object count stay
unchanged. Git still refreshes the modification time of object files that already exist
("freshening"); their content never changes, and the panel says so.

- New untracked files over 1 MiB are listed by path and size but not stored, as jj does. `S` is
  capped at 2 GiB; beyond that snapshots pause with a notice. Files locked by other programs make
  a snapshot partial, and it is marked.
- Snapshots are taken at start and at every `start_step` and `report_step`. While a step runs,
  Spellcast snapshots at most every 2 s (10 s otherwise during a run). A changed tree appends
  `changes_observed` with numstat against the step's start snapshot. Snapshots never overlap; if
  one takes longer than the interval, the panel shows the actual delay.
- Markers: paths outside the running step's declared scope; edits while no step runs (listed on
  the timeline); a step with a declared scope reported without any observed change; inputs whose
  SHA-256 changed since freeze for a reason other than an earlier step within its scope.
- Files ignored by `.gitignore` and files outside the repository are not observed.

As implemented in slice 3:

- The pathspecs (`.`, submodule and large-file excludes as `:(exclude,literal)…`) go through
  `--pathspec-from-file` with NUL separators, so their number is not limited by the command line.
  Private commands run with `LC_ALL=C`, so `error: unable to index file '…'` names the files
  that make a snapshot partial.
- The open window belongs to the active step, else to the most recently started blocked step.
  Edits with no open window are listed outside any step, one entry per gap between steps. A step
  reported without a start takes the edits listed since the previous boundary.
- A scope pattern that names a directory covers everything in it; matching is case-insensitive
  on Windows. A step without scope gets no scope markers.
- Observation, not the run, stops when the baseline cannot be taken (`unavailable`) or the
  private directory passes 2 GiB (`size_cap`). Other snapshot failures are recorded once and
  retried at the next interval; a failed step-boundary snapshot falls back to the latest
  observed tree. An interval that finds nothing changed writes nothing; the timing of the latest
  snapshot is kept in memory and shown as `observation_live`.
- Each change refreshes only the sigil's cards through the `spellcast-sigil` window event.

## Verification

Running commands:

- `argv[0]` is resolved with `PATHEXT` against the child's `PATH` and the execution directory
  (`which::which_in`), accepting `exe`, `com`, `bat` and `cmd`, and run by absolute path. Rust
  appends only `.exe` to a bare name, so `npm` (`npm.cmd`) would not be found otherwise. Rust's
  batch-file argument escaping (since 1.77.2) applies; arguments it refuses, such as line breaks,
  are reported to the user. No raw arguments.
- The process starts suspended with `CREATE_NO_WINDOW`, joins a kill-on-close Job Object and
  then resumes, with stdin null. Timeout, abort and normal exit all terminate the job, so no
  descendant keeps running or holds the output pipe.
- stdout and stderr share one pipe (`std::io::pipe`, Rust 1.87+; the toolchain is 1.88) to keep
  their order. A reader keeps draining and retains the last 64 KiB. Lines decode as UTF-8, else
  the OEM code page (GBK on Chinese Windows), else lossily.
- Implementation may extend the job runner in `src-tauri/src/complete_setup.rs`, which today
  keeps the first 256 KiB, stops reading at the cap, waits for readers before closing the job and
  decodes lossily; all four change. `process-wrap` 10 (tokio, job object) is the alternative.

Results:

- `report_step` queues the step's approved command checks in declared order. One check runs at a
  time; exit code 0 passes; a timeout fails.
- The agent may keep working while checks run. If files change during a check, its result is
  marked, and the agent or the user can rerun it.
- Manual checks wait for the user's pass or fail, with an optional note.
- The agent's summary and evidence are shown but never make a step pass.
- After a failure the agent may start the step again as a new attempt; earlier attempts stay in
  the timeline. A step passes when every check of its latest attempt passes.

As implemented in slice 4:

- The runner is `spellcast-bridge/src/sigil_process.rs` rather than the `src-tauri` job runner,
  because the bridge serves both the desktop app and `spellcast-server`. A name with a path
  separator resolves against the execution directory; a bare name is looked up on `PATH` only,
  never in the execution directory. `PATHEXT` is filtered to com, exe, bat and cmd. Inherited
  git repository variables are removed, as for snapshots. Every ending terminates the job; the
  output reader then gets at most 5 s to drain. On macOS and Linux the command leads its own
  process group, which is killed; descendants that leave the group are not reached.
- Output keeps the last 64 KiB. Each line decodes as UTF-8, else in the OEM code page, else
  lossily; terminal colour codes are dropped and a carriage return keeps only the text after it.
  A failed command keeps its last 20 lines (at most 2 KiB) in the step; the full kept output is
  in `spellcast_sigil_check_outputs` and returned by the `step` view.
- A report, including an automatic one, replaces the step's check results with the new
  attempt's: commands in the frozen list are queued, other commands wait for approval, manual
  checks wait for the user. One task per sigil runs queued commands one at a time, earliest
  reported step first. A snapshot right before and after each command records the tree it
  verified and whether files changed meanwhile (the result lists them and the step gets a
  `check_disturbed` marker; the command's own writes count too, and the card says so).
- Pausing lets the running command finish and keeps the queue until the user resumes. Aborting,
  a new attempt of the step, or reporting it again stops its queued and running commands; a
  running process is ended at once. Commands recorded as running when Spellcast restarts run
  again (`check_interrupted`).
- A failure outranks a check waiting for the user, which outranks one still verifying. A step
  whose check failed comes back as `next`, with `check_results`, before any ready step. The
  user can change a manual decision until the run ends. The executor receives `check_finished`
  (with the output tail for failures), `check_decided` and `step_verified` as notices.
  Completion is checked after every result and when the user resumes.
- Interfaces: the agent's `rerun_checks`; window routes `POST /api/sigils/:id/checks/decide` and
  `POST /api/sigils/:id/checks/rerun` (window credential) and the read-only
  `GET /api/sigils/:id/step`; `check_live` in the `sigil` view (the running command, its start
  time and newest 2 KiB of output), refreshed on the card at most every 2 s while output grows.

## Amendments

- An amendment applies immediately as a new plan revision with the agent's reason, and the
  affected steps get a marker. History is append-only.
- Steps that already passed are not edited; the agent adds a new step instead.
- New or changed commands do not run until the user approves them. Until then the step's
  verification needs the user; other steps continue.
- A skipped step counts as satisfied for its dependents.
- The user can revert an amendment from the timeline, restoring the earlier plan fields without
  touching files, or reopen a skipped step.

As implemented in slice 5:

- `amend {reason, changes}` takes a one-line reason (at most 500 characters) and 1–16 changes:
  `add_step {step, after}` (after the named step, else at the end), `update_step {step_id, …}`
  (only the given fields change; a change that changes nothing is refused) and
  `skip_step {step_id}`. A finished step (passed, done unverified or skipped) cannot be updated
  or skipped. The amended plan must pass the write bounds and the step checks that block
  freezing (duplicates, missing dependencies, cycles, empty commands, timeouts, scope globs);
  otherwise nothing changes.
- An amendment is a new plan revision with an `amend` history row and an `amended` event, and
  each step it touched gets an `amended` marker with the revision and reason. A reported step
  whose checks changed starts its verification over from the new definition; a skipped step's
  queued and running commands stop.
- Commands that are neither frozen nor approved appear as `pending_commands` in the `sigil` view
  and `commands_waiting_approval` in agent responses; their results wait as `needs_approval`
  and the runner never starts them. Approving
  (`POST /api/sigils/:id/commands/approve`, window credential) adds the command to the run's
  approved list and queues its waiting results; the agent hears `command_approved`. There is no
  decline: the user leaves the command waiting, reverts the amendment or writes to the agent.
- Reverting (`POST /api/sigils/:id/amendments/revert`) restores the touched steps' earlier
  definitions, removes steps the amendment added together with their progress (their events
  stay), and reopens steps it skipped; a step reported before the skip keeps its report. It is
  refused while a later, unreverted amendment changes the same steps or another step depends on
  a step it added. A revert is a new revision (`revert_amendment`), marks the steps and reaches
  the agent as `amendment_reverted`.
- Reopening (`POST /api/sigils/:id/steps/reopen`) turns a skipped step back to pending, with a
  `reopened` marker and the `step_reopened` notice.
- Inputs first declared by an amendment are hashed when it applies, and later input checks
  measure them from then rather than from the freeze.
- An amendment that skips the last unfinished step completes the run; that history row records
  the completion.

## Step states

Two dimensions derive from the event log: progress, owned by the agent's reports (pending,
active, reported, blocked, skipped), and verification, owned by Spellcast and the user (none,
running, passed, failed, needs the user). The light combines them; each state shows a color, an
icon and its label, and color is never the only signal.

| 中文 | English | Light | Meaning |
|---|---|---|---|
| 未开始 | Pending | grey | Dependencies are not finished |
| 可开始 | Ready | grey outline | Dependencies finished or skipped |
| 进行中 | Running | blue, pulsing on changes | Started, not reported |
| 待验证 | Verifying | yellow | Reported; checks queued or running |
| 已通过 | Passed | green | Every check of the latest attempt passed |
| 已完成（未验证） | Done, unverified | green outline | Reported; the step has no checks |
| 未通过 | Failed | red | A check failed or timed out |
| 待你处理 | Needs you | orange | Manual check, blocked step or command awaiting approval |
| 已跳过 | Skipped | grey, struck through | Skipped by the agent or the user |

Markers are purple badges on a step, never a state and never a stop: out-of-scope edits, plan
changes by the agent, steps reported automatically or without being started, reported without
changes, inputs changed by someone else, checks disturbed by later edits, partial snapshots.
Edits outside any step appear on the timeline with the same badge.

## Interface

- Canvas card: title, state, a count per step state, the marker count and the item that needs
  the user. Opening it opens the sigil panel. Removing the card does not delete the sigil.
- Panel: the dependency graph with step states; the selected step's instructions, scope, checks
  with output, live change list and diff; the event timeline; and a marker list the user can go
  through during or after the run. Each decision sits beside the item it decides. A dedicated
  window event (like `spellcast-board` in `src/shell.ts:45`) carries the sigil id and latest
  sequence; the panel fetches events since its last sequence, never the whole board, and never
  replaces an open diff or a note being typed.
- Entry: 法阵 in the Canvas top bar lists active sigils and archives. 新建法阵 from a selection
  makes the selected objects its materials.
- Agent and user text renders literally. Existing Canvas protections stay in force.

## Archive and clean up

Available for completed and aborted sigils.

1. Build the bundle: every plan revision with authors and reasons, executors and handovers, the
   full event log with markers, per-step numstat and text patches (16 MiB total; binary files by
   path and hash), check outputs, material snapshots (the `new_chat_context` snapshot format,
   8 MiB), the final state and, for worktrees, the branch tip, whether it is merged into
   `base_ref`, and the names and sizes of ignored files (`git status --porcelain --ignored`),
   because removing a worktree deletes them silently.
2. Write it as one immutable row, read it back and validate counts and hashes. On failure
   nothing is deleted.
3. Show the cleanup checklist, then run it item by item:
   - Worktree, in this order: stop Spellcast's own checks; remove junctions and symbolic links
     inside the worktree without following them (`git worktree remove --force` on Git for
     Windows has emptied junction targets); `git worktree unlock`; `git worktree remove`, with
     `--force` only after the archive is validated; if that fails, read
     `git worktree list --porcelain` and delete leftovers without following links. "Permission
     denied" is retried with backoff and then shown, asking the user to close programs still
     using the folder (editors, Unity, terminals).
   - Branch, checked against the current tip of `base_ref` and its remote-tracking branch:
     `git merge-base --is-ancestor` (0 merged, 1 continue, anything else keeps the branch);
     otherwise merged when every `git cherry` line starts with `-` (rebased or cherry-picked);
     otherwise a squash check (a temporary squashed commit written to the private object
     directory, compared with `git cherry`); otherwise kept unless the user discards it. A branch
     without commits counts as merged. Deletion uses `git branch -D` after the worktree is gone,
     because `-d` checks the upstream or HEAD rather than `base_ref`.
   - Snapshot directory and handoff files.
   - Canvas card and materials, through existing Canvas deletion. Delete-locked or user-edited
     items are listed for the user to unlock and remove, or keep.
   - Working rows. Only the archive row remains.
   A failed item stays on the list for retry.
4. Archives can be listed, opened read-only, exported as JSON and deleted by the user.

## Limits shown to the user

- Executor identities are declared by the agents, not verified.
- Observation sees file changes, not intent. Beyond observed diffs and check results, it cannot
  prove the agent followed the instructions.
- Ignored files and paths outside the repository are not observed. Snapshots refresh the
  modification time of existing object files. Snapshot speed on very large repositories (for
  example a 100,000-file Unity project) has not been measured.
- The `wait` bound is based on Claude Code and Codex documentation and source; limits in Cursor
  and Grok Build are unknown.
- Phase 1 acceptance covers Windows only.

## Not in phase 1

Exhaustive document and conversation ledgers, image feedback, parallel steps or several
executors, automatic merge, desktop notifications, folders without git, reusable worktree slots
for path-bound projects, MCP Tasks (not supported by Claude Code or Codex yet).

## Implementation order

Each slice lands with its tests before the next starts.

1. Types, store, receipts, freeze checks and warnings, `put_plan`, queries, Canvas card.
2. Executor claims and handover, start (worktree and in place), step protocol with `next` and
   `notices`, `wait`, event log, states from the agent's reports.
3. Snapshots with the private object directory, change feed, markers, input changes.
4. Command and manual checks, reruns, disturbed-check markers.
5. Amendments, command approval, revert and reopen.
6. Archive, validation, cleanup checklist, archive list and export.
7. Panel polish, Chinese and English strings, skill reference.

## Progress

Slice 1, 2026-10-02:

- Done: `CanvasContent::Sigil` in core with every match site; `spellcast-bridge/src/sigils.rs`
  (types, write bounds, glob syntax, freeze review, freeze record), `sigil_store.rs` (tables,
  history, events, receipts), `sigil_workspace.rs` (agent drafts, user create/edit/freeze/
  unfreeze/delete, card pinning and removal, `list`/`sigil`/`events` queries), `sigil_api.rs`
  (window-credential routes) and the two MCP tools. `cargo test -p spellcast-core -p
  spellcast-bridge`: core 64, bridge 226 passed, including 10 sigil tests (authorship, replay,
  freeze blocks and warnings, restart, deletion with cards, MCP transport, window credential).
- Written but not yet mounted: `src/sigil-card.ts`, `src/sigil-card.css`, `src/sigil-api.ts`,
  `src/i18n/sigil.ts`; `tsc --noEmit` passes.
- Mounted after the other task finished (user confirmed): `{ type: "sigil" }` in `src/types.ts`,
  the card in `src/canvas.ts` (opening a sigil works inside the card; there is no reader view),
  labels in `src/main.ts` and `src/canvas-annotations.ts`.

Slice 2, 2026-10-02 (backend done, card written, same mounting wait):

- `spellcast-bridge/src/sigil_run.rs`: start (worktree created with `git worktree add -b
  sigil/<id>` and locked `sigil:<id>`, or in place; rollback if recording fails; a retried start
  replays without git), claims and handover, revoke, pause/resume/abort, user notes, the agent's
  `start_step`/`report_step`/`block_step`/`note`, `next`/`notices`/`cursor` in every response,
  per-executor notice cursors stored with the run, `next` and `wait` views, completion.
  Step reports append events without moving the revision; lifecycle changes do.
- `sigil_store.rs` now applies changes through one receipt-checked transaction
  (`sigil_apply`); the draft operations use it as well.
- Tests: 16 sigil tests (6 new with real temporary git repositories: worktree start and lock,
  branch clash rollback, in-place start, claims/handover/revoke, dependencies with checks
  holding dependents, automatic reports, block and resume, completion, notices once, `wait`
  woken by a pause, abort ending waits; MCP transport for `claim`/`start_step`/`report_step`;
  window credential on start and pause). `cargo test -p spellcast-core -p spellcast-bridge`:
  core 64, bridge 232 passed. Test fixtures now release the database before removing it.
- Card: executor, handover approve/decline, lights per step computed by the server (`lights`,
  `next` in the `sigil` view), markers, blocked reasons, start/pause/resume/abort/revoke/note,
  copyable start instruction. Reading a sigil needs no window credential, so the card also loads
  in the browser preview; every action still does.
- Browser check `scripts/check-sigil-card-preview.mjs` (built assets, every API request answered
  by an in-memory fixture): four cards on the real Canvas, states and explanation, a light and
  text label per step, markers, blocked reason, executor and handover request, freeze disabled
  by errors, freeze and start dialogs (commands, consent, location; cancel and Escape send
  nothing), dark and light at 1600/1320/880 without overflow and with text contrast at least
  4.5:1. The first screenshots showed invisible text: the Canvas view swaps the palette (there
  `--paper` is the card surface), so the card now uses the `--studio-*` variables and the dialog
  reuses `.board-dialog`. `check-canvas-cleanup-preview.mjs` and `check-i18n.mjs` still pass.
- Not yet: progress notifications during `wait`, the Codex new-conversation draft (needs
  `src-tauri`), a native-app check, and any action exercised with the real window credential
  outside Rust tests. (The dedicated window event listed here before landed in slice 3.)

Slice 3, 2026-10-03:

- `spellcast-bridge/src/sigil_snapshot.rs`: the private session (index seeded from the
  repository's with its modification time, objects through the alternate, hooks, split index,
  CRLF refusals, maintenance and lazy fetches off, LFS store in the session), snapshots with
  large-file and submodule excludes and partial results, `diff-tree` change lists with line counts,
  patches capped at 256 KiB, private size. The shared `git` runner also clears inherited
  repository variables.
- `spellcast-bridge/src/sigil_observe.rs`: the baseline at start, snapshots at every
  `start_step` and `report_step` under the run's snapshot lock, the interval loop (2 s with an open
  step, else 10 s; restarted runs resume), attribution to the open step or outside any step,
  markers (`out_of_scope`, `partial_snapshot`, `input_changed`, `reported_without_changes`), input
  writers, the size cap and the `diff` view. Queries `step` and `diff` over MCP, `GET
  /api/sigils/:id/diff` for the window (read-only; other origins are refused by the local request
  guard). Agent responses carry `changed_files` and `outside_scope`.
- `Surface::sigil_changed` (default: repaint the board) and the desktop's `spellcast-sigil`
  event, so progress refreshes only the sigil's cards.
- Tests: 9 new. On temporary repositories with split index, sparse checkout, a
  `post-index-change` hook, textconv, a submodule and Git LFS, snapshots leave the index bytes,
  shared index files, refs, `git count-objects` and LFS objects unchanged, run no hook, write no
  textconv ref and put LFS objects in the session; large new files are listed and not stored,
  ignored files skipped, patches capped; a file held by another program gives a partial
  snapshot and a marker; changes go to the open step with every marker; a step reported without a
  start takes the edits made since; observation continues after a restart in a worktree (whose
  baseline equals its base tree); the size cap stops observation and not the run; the interval
  loop records edits on its own. The HTTP test covers the diff route and the `step` and `diff`
  views. `cargo test -p spellcast-core -p spellcast-bridge`: core 64, bridge 241 passed;
  `src-tauri` and `spellcast-server` build.
- Card: per step the changed file count and line counts with the marker count; expanded, the
  marker explanations and the file list (status, lines, out of scope, large files not stored);
  edits outside any step by gap; observation notes (interval and slow checks, unreadable files,
  inputs that differed at start, why observation stopped); a diff dialog rendering the patch as
  text. Open lists, keyboard focus and an open diff survive live refreshes.
- Browser check: now measures every visible text in the card and the diff dialog against its
  composited background. That found warning text at 3.4:1 in the light theme, which the earlier
  selector list never measured; accent colors used as text are now mixed toward the ink. The
  check also drives a live refresh through the browser form of the `spellcast-sigil` event and
  confirms markup in a patch stays text.
- Not yet: measured snapshot speed on a large repository, the panel's events-since-sequence
  fetch (the card refetches the sigil on each event), and the items still open from slice 2.
  (Check results in the `step` view, listed here before, landed in slice 4.)

Slice 4, 2026-10-03:

- `spellcast-bridge/src/sigil_process.rs`: program resolution with `PATHEXT`, a suspended start
  with `CREATE_NO_WINDOW` inside a kill-on-close job (a process group on macOS and Linux), one
  pipe for stdout and stderr keeping the last 64 KiB, timeouts, cancellation, and per-line
  decoding. `windows-sys` and `libc`, both already in the lock files, are now direct
  dependencies of the bridge.
- `spellcast-bridge/src/sigil_verify.rs`: queueing on report, the per-sigil runner with
  snapshots before and after each command, the `check_disturbed` marker, stopping on abort or a
  new attempt, restart recovery, reruns, manual decisions, `step_verified`, and the live output
  view. Lights, `next`, completion and notices use the verification results
  (`spellcast-bridge/src/sigils.rs`, `sigil_run.rs`). The observation loop also starts check
  runners.
- Tests: 15 new, all with real processes. Process tests: pass and fail with stdout and stderr in
  order; a timeout and a normal exit both end a background descendant that holds the pipe,
  without waiting for it; cancellation; the 64 KiB tail with colour codes and progress lines;
  arguments reach a batch file literally and a line break is refused; `PATHEXT` finds `.cmd`
  files and `npm`; GBK and UTF-8 lines in one output; and a probe started as a check sees no
  console window and runs inside a job. Verification tests: lights through a manual decision,
  notices, a failed step returning as `next`, a new attempt passing, completion, a file written
  during a command marking the result, reruns by the user and the agent, pause and resume, abort
  ending a hanging command, restart recovery, and approval matching. The HTTP test now runs
  `git --version` through the router's own loop until the run completes, reads the output route,
  and checks that rerun and decide need the window credential. `cargo test -p spellcast-core -p
  spellcast-bridge`: core 64, bridge 256 passed; `src-tauri` and `spellcast-server` build.
- Card: each step shows how many of its checks passed. Expanded, each check shows its status,
  time, exit code or timeout, command, live output while running, the last lines of a failure,
  the files that changed while it ran, and a manual check's description and note. Buttons show
  output (a dialog with the kept output as text), pass or fail a manual check (with an optional
  note; a decided check offers only the other decision), and rerun finished commands. A paused
  run says what happens to its checks. Elapsed time counts up between refreshes.
- Browser check: covers all of the above, including markup in live output, failure tails and the
  output dialog staying text, and a decision dialog that sends nothing when cancelled. Contrast
  of every visible text is at least 4.5:1 in both themes at all widths. The orange status chip
  first measured 4.49:1 in the light theme; its tint is now lighter.
- Not yet: approving commands that wait for approval (slice 5, with amendments; until then only
  a changed plan could produce one), and the items still open from slices 2 and 3.

Native check and deploy, 2026-10-03:

- `scripts/check-sigil-native.mjs`, run through `scripts/run-native-check.mjs` (CDP 9356, port
  47218) against the `com.spellcast.board.verify` debug build with its own data, drives one
  sigil end to end on a temporary repository: an agent's MCP draft pins a card on the Canvas;
  freeze and start from the card (the real window credential) create a locked worktree; an edit
  during a step reaches the card through interval snapshots and the `spellcast-sigil` desktop
  event; the reported step's command runs and its light turns green; an amendment's new command
  is approved on the card and runs after the step's report; an amendment is reverted from the
  card; the user's manual decision completes the run and the agent's `wait` reports it.
- With the user's go-ahead the installed app was replaced with a build of slices 1–4 (and the
  finished Canvas cleanup work in the same tree): graceful close, exe and database backup in
  `backups/202610021737-sigil`, relaunch through Explorer, board unchanged.

Slice 5, 2026-10-03:

- `spellcast-bridge/src/sigil_amend.rs`: `amend` with add, update and skip; approval of commands;
  revert; reopen; hashes for inputs that amendments declare. The run keeps `amendments`,
  `approved_commands` and `amended_inputs`. The freeze review's step checks are shared with
  amendments (`step_errors`). Window routes for approve, revert and reopen, all needing the
  window credential.
- Tests: 4 new: amendments apply as a new revision with history, events and markers, and are
  refused for finished steps, duplicates, cycles, multi-line reasons, changes that change
  nothing and other sources; a new command waits, is never run, is approved once and then runs
  to completion; reverts restore fields, remove added steps, reopen skips, refuse while a later
  amendment touches the same step and reach the agent once each; reopening; inputs declared by
  an amendment are measured from it. The HTTP test checks the three routes need the window
  credential. `cargo test -p spellcast-core -p spellcast-bridge`: core 64, bridge 260 passed.
- Card: a box of commands waiting for approval above the steps (approval dialog with the
  command, directory, timeout and consent), the amendment list with reason and changes, newest
  first, with revert for amendments not yet reverted, and reopen on skipped steps.
- Browser check: 8 checks, 18 screenshots. The first skipped step in the fixture measured 3.63:1
  in the light theme: skipped titles used the muted color since slice 2 and had never been
  measured; they now use the soft text color.
- Not yet: the installed app still has slices 1–4; deploying slice 5 restarts it again. The
  items still open from slices 2 and 3.

## Acceptance

- Rust: transactions and restart; `request_id` replay; revision conflicts; freeze blocks
  (cycle, malformed command, bad glob, path outside the repository) while warnings do not; the
  first claim after start becomes executor; the same source continues after a new claim; a
  different or revoked source waits for handover; non-executor updates are refused; `next` and
  `notices` in every response; starting a step reports the running one; reporting an unstarted
  step is accepted and marked; refusals while paused; event order; amendments apply at once, and
  new commands never run before approval; revert restores the earlier fields; `wait` returns
  `pending` at its bound and a later call with the same cursor gets the missed event.
- Git, on temporary repositories created by the tests, including LFS, split index, submodule,
  sparse checkout, hook and textconv setups: snapshots leave the repository's index, refs, status
  and `git count-objects` unchanged and put LFS objects in `S/lfs`; per-step diffs; markers never
  block; ignored and oversized untracked files excluded; a locked file gives a marked partial
  snapshot; worktree creation, locking and removal; a junction inside a worktree leaves its
  target intact; an unmerged branch is kept without confirmation; rebased and squash-merged
  branches are recognized.
- Checks: pass, fail, timeout, output cap, `npm.cmd` resolution, a grandchild process killed on
  timeout, GBK output decoded, no console window, argv never interpreted by a shell.
- Archive: the bundle is complete and validated before any deletion; a failure leaves everything
  in place; cleanup items can be retried.
- Browser fixture: every step state and marker in both themes at 1600/1320/880; live updates
  that keep an open diff and a typed note; handover and command approvals; literal rendering of
  agent text.
- Isolated native app (own data directory, port and WebView profile): one end-to-end sigil on a
  temporary repository driven by a scripted MCP client. No test touches the user's repositories,
  Canvas database or real agent sessions.

## Evidence (web research, 2026-10-02)

- Timeouts: Claude Code drops an HTTP tool call without a first byte after 60 s by default and
  moves calls over 120 s to the background (https://code.claude.com/docs/en/mcp,
  https://code.claude.com/docs/en/env-vars). Spellcast's MCP server answers with JSON responses
  (`spellcast-bridge/src/mcp.rs:653`), which send nothing before the result. Codex defaults to
  300 s in source since rust-v0.141.0 (docs still say 60 s), and Spellcast configures 300 s
  (https://developers.openai.com/codex/mcp, https://github.com/openai/codex/pull/28234).
- Prior art: agents keep their own task status unreliably in Taskmaster and Kiro
  (https://github.com/eyaltoledano/claude-task-master/issues/1247,
  https://github.com/kirodotdev/Kiro/issues/11625, /issues/8859, /issues/6826); Spec Kit's
  converge step is the agent's own judgement
  (https://github.com/github/spec-kit/blob/main/templates/commands/converge.md); a second planning
  tool competes with Codex's own (https://github.com/openai/codex/issues/33890); Cline keeps
  checkpoints in a shadow repository (https://docs.cline.bot/features/checkpoints).
- Snapshots: Git environment variables and quarantine (https://git-scm.com/docs/git,
  https://git-scm.com/docs/git-receive-pack); Codex removed ghost-commit undo
  (https://github.com/openai/codex/discussions/9618) and its turn-diff refs broke other Git tools
  (https://github.com/openai/codex/issues/29388); jj skips new files over 1 MiB
  (https://docs.jj-vcs.dev/latest/config/). Measured locally on Git 2.53.0.windows.1 with
  git-lfs 3.7.1 in throwaway repositories.
- Worktrees: https://git-scm.com/docs/git-worktree; junction targets emptied by forced removal
  (https://github.com/anthropics/claude-code/issues/84162,
  https://github.com/openai/codex/issues/49995); Unity reimport without Library
  (https://docs.unity3d.com/6000.6/Documentation/Manual/default-directories.html).
- Processes: https://doc.rust-lang.org/std/process/struct.Command.html,
  https://blog.rust-lang.org/2024/04/09/cve-2024-24576/,
  https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs,
  https://docs.rs/process-wrap.
- Measured on 2026-10-03 with Git 2.53.0.windows.1 and git-lfs 3.7.1 in throwaway repositories
  before slice 3: `git add --ignore-errors` exits 1 and prints `error: unable to index file '…'`
  for a file opened without sharing, and the tree still writes; `diff-tree -z --raw --numstat`
  prints all raw records, then all numstat records; `:(exclude,literal)` works in a
  `--pathspec-from-file` list; a sparse checkout's skipped entries stay in the private tree; the
  LFS clean filter writes to `lfs.storage` only.
- Measured on 2026-10-03 on Windows 11 with Rust 1.88, during slice 4: a check started suspended
  with `CREATE_NO_WINDOW` and resumed after `AssignProcessToJobObject` sees `GetConsoleWindow()`
  return null and `IsProcessInJob` true. A descendant started with `start /b` keeps the merged
  pipe open; terminating the job ends it and the reader sees the end of the output at once.
  Rust refuses a batch-file argument containing a line break (`InvalidInput`) and passes `&` and
  `%PATH%` literally. cmd's `echo` re-encodes a batch file's bytes through the console code page,
  while `type` copies a file's bytes, so GBK and UTF-8 lines can share one output.
- Side finding, not verified: `spellcast_listen` accepts waits up to 120 s
  (`spellcast-bridge/src/lib.rs:952`), which may exceed Claude Code's 60 s first-byte limit.
  Tracked separately; not part of this contract.

## Independent sigil workspace (2026-10-03)

The fixed **Sigil / 法阵** button in the main header opens a dedicated list and detail view
from either desktop mode or the Canvas. It does not create, freeze or start a run. The list
reads the existing `GET /api/sigils` summaries; the selected detail mounts the same
`mountSigilCard` used by the Canvas, so there is one canonical plan, run and permission model.

- Filters group all sigils, drafts (draft/frozen), active runs (running/paused), and finished
  runs (completed/aborted/archived). A visible selection survives a refresh; when it disappears,
  the first remaining visible sigil is selected. Empty lists and empty filters have distinct
  explanations.
- Refresh and live sigil events update the list. A failed read keeps the previously displayed
  data and offers retry with an inline error. Refresh never implies a successful mutation.
- Returning to the Canvas preserves its cards and layout. Leaving the workspace destroys its
  detail and removes its own event and locale subscriptions; late list requests are aborted.
- The workspace hides the Canvas composer and idea-layout shortcuts. Chinese/English labels,
  keyboard focus, light/dark themes and scrolling at the desktop minimum size remain usable.
- `npm run build` followed by `node scripts/check-sigil-card-preview.mjs` checks the entry and
  workspace with isolated HTTP fixtures. It never freezes, starts or otherwise mutates the
  user's real sigils; mock browser evidence is not native execution verification.

## Handover to the original session (2026-10-03)

The window can start a frozen sigil and hand its execution instruction to the session that wrote
the plan, instead of only offering a copyable instruction. The user keeps every decision: there is
no MCP freeze or start, and a handover never claims, executes or verifies anything by itself.

- `POST /api/sigils/:id/dispatch` with `{request_id, started_at_ms, retry?}` requires the window
  credential and a trusted origin, like the other window actions. The window first starts the
  run, then dispatches with the `run.started_at_ms` that start returned, so a request can never
  target another run.
- Eligible only while running, for the run named by `started_at_ms`, with a freeze record, an
  owner that is a Codex source with a verified exact binding (thread UUID, absolute session
  directory, protocol agent), not revoked or replaced, and no other executor. Claude and unknown
  sources keep the copy-only fallback. The session directory may differ from the plan's
  repository; the execution directory always comes from the user's freeze.
- One delivery per run. The first request persists `run.delivery` (target, instruction and the
  request id `sigil-dispatch:<id>:<started_at_ms>`) before it enters the existing Canvas
  feedback/desktop delivery, and later requests reuse that reservation and its receipt. `retry`
  only resets a definitely failed local receipt or reconciles an unknown/unanswered one; accepted
  or uncertain requests are never sent again. Just before the desktop write the transport
  re-checks the reservation, run, binding, thread, directory and exact text, so an ordinary
  request cannot impersonate a handover.
- The `sigil` view carries `delivery`: target label, thread, session directory, `phase`
  (projected from the receipt; `reserved`, or `unknown` when a reserved receipt is gone), `error`,
  `handover_unavailable`, `can_dispatch`, `can_retry`, the fallback instruction and the receipt.
  `error` describes only a recorded delivery: its receipt error, a missing receipt, or a binding
  that changed under the reservation. Lifecycle is not an error; the stage line explains it.
  `handover_unavailable` is a stable code (`no_owner`, `claude_owner`, `revoked`,
  `other_executor`, `binding_missing`, `binding_invalid`, `binding_changed`) that the window
  localizes beside the copy-only fallback.
- Delivery is not a claim and not verification. The card keeps showing "waiting for a claim"
  until the original session claims through `spellcast_sigil_update`, and checks still decide
  each step. A claimed run offers no further dispatch, even with a stale retry flag.
- Window: a frozen plan whose original session can take it offers the primary
  **Start and hand to original session…** action; its confirmation names the session label,
  source, task, session directory and execution directory. A failed handover after a successful
  start keeps the run running, says so, and offers handover again. Delivery details show only for
  frozen, running and paused plans; one persistent alert node carries a delivery problem, so live
  refreshes do not announce it again.
- Sigil dialogs attach to `<body>`. Outside the Canvas view (for example in the sigil workspace)
  they map the Canvas variables they use to the app palette, and in the light theme keep
  secondary buttons on the light surface; before this, the dark workspace's freeze consent
  showed its directory, command and consent text at 1.0–2.6:1 and the light one an unreadable
  Cancel button. Other shared board dialogs outside the Canvas view may still have that Cancel
  button problem in the light theme; only sigil dialogs were changed and checked.
- Evidence: `cargo test -p spellcast-bridge --lib sigil` (including the delivery module and the
  lifecycle/ownership reason test) and `node scripts/check-sigil-card-preview.mjs`, whose
  mutation flows mount the real card module in an isolated page with a fake desktop shell (window
  key, fixture port and sigil event channel only) and in-memory HTTP fixtures. Not verified: a
  real desktop delivery into a Codex task, a real claim by that task, and a native WebView run of
  the handover.

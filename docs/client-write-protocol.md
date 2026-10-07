# Native application write delegation, protocol 1

Stage 1 implements the Spellcast side only. There is no active grant by default,
no credential exchange and no HTTP/MCP registration. CCGUI must implement the
native client described here before a user can authorize it. Implementing or
building this code is not native user approval.

## Transport and mutual identity

Windows local pipe: `\\.\pipe\Spellcast.ClientWrite.v1.<current-user-SID>`.
The server sets an explicit user-only DACL, rejects remote clients, uses
FIRST_PIPE_INSTANCE for initial creation and keeps the name owned between
connections. Failure disables delegation; it never falls back to HTTP, another
pipe, a copied key or an environment credential. At most eight operations are
admitted; frames and replies are bounded. One connection carries one request.

Each frame is a four-byte unsigned little-endian byte count followed by UTF-8
JSON. Requests are limited to 1 MiB, replies to 2 MiB. Zero/oversized/truncated
frames fail closed. The async connection budget is 10 seconds. A dispatched
blocking save owns its pipe and admission slot until its transaction ends, even
if its waiting task times out. Timeout is not cancellation or permission to retry.

Both programs MUST get the other endpoint's PID from GetNamedPipeClientProcessId
or GetNamedPipeServerProcessId, open and retain the process handle, check its
creation FILETIME and kernel process live signal (not exit code 259 alone), and obtain its token SID and executable path
from the OS. Executable inspection uses a retained read handle without write or
delete sharing, canonical path, volume/file ID and SHA-256. Reparse images,
network paths, unknown identity, changed identity, dead processes and reused
PIDs are rejected. The server requires the same OS user and `ccgui-next.exe`.

The CCGUI native adapter MUST pin the expected Spellcast installation identity
through a visible native user confirmation and use the kernel server PID to
verify it BEFORE sending any request. `src-tauri/src/client_identity.rs` includes
the reference `verify_server` function: it compares path, hash, file ID and SID
and requires `spellcast.exe`. A server's JSON identity or a process name alone
is not sufficient evidence. Native application updates that replace an image
require identity review again. This is an owner-user boundary, not protection
against administrator compromise or injection into an already trusted process.

## Messages

Unknown operations and fields, including nested record/plan/check fields, are
rejected. No URL, arbitrary IPC, executable proxy, claimed identity, Origin,
window key, bearer, task token, actor or scope override is accepted.

```json
{"op":"status","protocol":1}
```

An OS-verified status request only registers a transient candidate for the
native UI. It does not create or approve a grant. Reply data contains
`server_epoch`, `process_stamp`, `identity`, `grant` (null when absent), and
`granted`. The public correlation values are not credentials. The installation
identity is path/SID; its approved image identity additionally binds SHA-256 and
file ID. `process_stamp` also binds PID and exact creation FILETIME.

```json
{
  "op":"save", "protocol":1,
  "session":{"server_epoch":"from-status","process_stamp":"from-status",
             "grant_id":"from-approved-grant","generation":1},
  "request_id":"stable-unique-operation-id",
  "change":{"op":"put_record","project_id":"project-uuid","id":"record-id",
            "expected_revision":0,"fields":{"title":"Draft","status":"planned"}}
}
```

Save changes:

| Change | Permission and boundary |
| --- | --- |
| `put_record` | `scopes.records`; create with expected revision 0 and absent ID, or update with the current revision. Existing archive state is preserved. object_id must exist in that project. References are saved text, not file reads or object writes. |
| `sigil_create` with `plan` | `scopes.sigil_drafts`; global draft, new server ID, no executor ownership. Includes exactly one fixed `sigil-<id>` Canvas reference card in the same commit. |
| `sigil_put_plan` with `id`, `expected_revision`, `plan` | Same scope; existing draft only, current revision required. Retains its original owner_source. No implicit unfreeze, archive, delete or lifecycle transition. |
| `sigil_claim` with `id`, optional `label` | `scopes.sigil_claims`; claim or request handover on an already started Sigil. Source id is `ccgui:<grant_id>`. |
| `sigil_start_step` with `id`, `step_id` | `scopes.sigil_run`; begin a step after a successful claim. |
| `sigil_report_step` with `id`, `step_id`, optional `summary`/`evidence` | Same scope; report the active step. Observation snapshots may follow on the next observe loop. |
| `sigil_execute` with `id`, `expected_revision` | `scopes.sigil_run`; freeze and autonomously start a draft this grant saved (`updated_by.kind` is `client`, author source `client:<grant_id>`). Does not claim. Does not accept argv, shell, amend, or command approval. The window `POST /api/sigils/:id/execute` path is unchanged. |

CCGUI remote browsers never open the named pipe. A paired, approved web device calls workbench mutate on the desktop process; the desktop ClientWrite client performs the pipe exchange. Pin confirmation remains desktop-only.

Plans use existing SigilPlan fields. Materials are Canvas object ID/content
revision references; current existence, visibility and revision are checked
while holding the Canvas state lock. Paths and command argv in a draft are inert
data. Saving does not review/read the repository, hash inputs, create a worktree,
start a process, notify an executor, run a model or invoke Observer. It only
invalidates the UI after commit.

Automatic native card refresh is also a pure preview for a client-authored draft:
it reports `native_review_required`, without repository preflight, and disables
the UI freeze control. The native user can explicitly click “Review in Spellcast”:
`POST /api/sigils/:id/review` requires the unchanged window credential + Origin
guard and current draft revision. It performs review only on that explicit action
and opens the existing freeze confirmation if review passes. This operation is
absent from the delegated pipe. The original native window freeze authority/checks
are unchanged. `sigil_execute` is the pipe's freeze-and-start for a draft this grant authored. It still does not run arbitrary commands, select models, or use Observer. Agent MCP execute continues to refuse client-authored drafts. Missing `sigil_run` returns `scope_denied` and leaves the draft unstarted.

```json
{
  "op":"receipt","protocol":1,
  "session":{"server_epoch":"fresh-status","process_stamp":"fresh-status",
             "grant_id":"approved-grant","generation":1},
  "request_id":"the-original-operation-id"
}
```

Receipt replies identify `committed` with the exact saved `result`, or
`not_found`. Authentication and the current operation scope are checked first.
Receipts are isolated by grant/request ID. A newly confirmed generation for the
same installation can recover its earlier committed receipts, subject to the
current scope; revoked or changed-image callers cannot do so without fresh
native approval. `not_found` after a lost in-flight reply does NOT prove a save
cannot still commit. CCGUI must retain unknown/pending and never automatically
resend, switch request IDs, retry another transport or discard reservations.

All replies are `{protocol:1,ok:true,data:...}` or
`{protocol:1,ok:false,error:{code,outcome_unknown}}`. Stable codes include
invalid_request, identity_unknown, identity_changed, grant_required, revoked,
stale_session, scope_denied, conflict, not_draft, idempotency_conflict, not_found,
storage_unavailable and outcome_unknown. Raw OS/SQLite errors are not returned.

## Native approval, storage and ordering

Settings → Connection → Application delegation lists OS-observed candidates
and grants. Record, global-draft, claim and run permissions start unchecked. The visible
confirmation identifies canonical image path, SHA-256 and SID, all current and
future projects, all global drafts, the fixed new-draft card, and current/future
approved CCGUI web devices until revocation. The excluded execution, command,
model and Observer permissions are explicit. Only visible, focused `main`
window IPC can approve/replace scopes or revoke. Machine / server-AI hosts may set
`SPELLCAST_MACHINE_CLIENT_APPROVE=1` to skip the focused-window gate on that IPC, and
may run `spellcast --machine-client-approve [ccgui-next.exe|absolute-path]` while a
matching CCGUI process is live to grant all four scopes (records, sigil_drafts,
sigil_claims, sigil_run) without the native confirmation dialog. `sigil_run` is
what authorizes `sigil_execute` as well as step start/report, so that machine
grant can freeze and start a draft without the Spellcast window. Discovery still
requires a live OS-verified process; the env flag is never a network grant. Listing is read-only; approval
rechecks the candidate's live process/image, then uses policy revision CAS.
Candidates expire after five minutes. Their displayed birth time uses safe
Unix milliseconds; authentication never rounds the original FILETIME through JS.

Grant, generation, scope checks, CAS writes, fixed card, exact receipt and
successful audit share the same Store lock/SQLite transaction. Canvas saves use
the existing state → Store lock order. Revoke uses that Store lock/transaction;
save-before-revoke stays committed, revoke-before-save rejects. A replay is
authorized before its receipt is read and cannot write a second revision/card.
Card/history/audit/receipt failures roll back the entire new draft. Existing
record, Sigil, Canvas and task-access receipts are not modified.

Grant/audit/receipt tables live in the canonical Store. Windows delegation is
disabled unless the existing parent directory is OS-owner/admin/System-only;
it never rewrites a shared parent ACL. Existing owner-only protection is reused
on the explicit DB/journal/WAL/SHM files. Reparse/hard-linked storage is rejected.
No new cross-app secret is generated or stored. No old settings, paired device,
task permission, source ID or directory alias can create a grant.

Approval or scope/identity replacement increments both revision and generation;
revocation does too. Restart creates a new public server epoch and closes old
connections. The approved installation policy persists, but every new request
still requires fresh matching OS identity/status. Database migration/import
revokes all application grants and preserves committed data/receipts; it never
restores a prior native approval. Existing Agent/task permissions are separate.

Audit stores time, grant/generation, policy revision, scope snapshot, identity
fingerprint, fixed operation/result codes and a request-ID hash. It contains no
body, environment, raw paths, credential or secret. The authorized result
receipt contains the saved content by design and is not an audit log.

## Required CCGUI stage 2

Keep the existing approved-device/connection gates and durable pending ledger.
Bind browser identity and allowed WS Origin to the server-owned request context;
never accept those claims from request JSON. Replace the three window-key save
paths with the native bounded protocol, including mutual server identity check.
Derive write availability from an active matching grant and its scopes. Expose
grant-required/changed/revoked states and receipt-only recovery; keep native
approval outside Web command dispatch. CCGUI device revocation blocks queued
requests and result release. It does not roll back a save already sent; Spellcast
application grant revocation has the transaction ordering described above.

Stage 1 does not install, restart, authorize, connect a real device or modify
CCGUI. Mock tests are not a successful real cross-application authorization.

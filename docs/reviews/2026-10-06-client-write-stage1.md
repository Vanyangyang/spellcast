# Spellcast client write delegation: stage 1 acceptance

Stage 1 changes Spellcast only. The CCGUI application repository was not edited,
built or installed by this task. No real Spellcast process was started/restarted,
no real project/assistant content or application credential was read, and no
actual grant/device connection was created. No checkpoint, aside, MCP memory
write, model or real Observer was invoked. CLI remained xhigh / priority (Fast).

Shared wire contract and stage-2 obligations: [client-write-protocol.md](../client-write-protocol.md).

## Security comparison

| Requirement | Implementation and acceptance evidence |
| --- | --- |
| Default no authority; native consent only | New grant table has no default rows; status only creates expiring in-memory candidates. Approve/revoke IPC requires visible focused `main`; UI starts both scopes unchecked and requires a confirmation showing image identity, global range and fixed card side effect. Legacy task grants do not authorize application writes. |
| Actual OS client; mutual server identity | Kernel pipe endpoint PID, process creation time/live state, token SID, canonical executable path, retained image handle, file ID and SHA-256. Server requires same user and ccgui-next.exe. Reference client verifier requires the native-pinned Spellcast identity; claimed JSON identity is never authentication. Unknown/path/hash/file-ID/PID reuse mismatches deny. |
| Private local IPC; no anonymous alternative | Owner SID DACL, remote-client rejection, initial FIRST_PIPE_INSTANCE, reserved name between connections, one bounded frame/request, eight admitted operations. Only status/save/receipt; no TCP/URL/IPC/command proxy and no fallback transport or key. Native probe verifies both actual kernel endpoint PIDs and name-squatting rejection in a unique TEST pipe. |
| Only record put and draft saves | Typed record create/update CAS; pure draft create/update CAS and material existence/content-revision checks. Preserves record archive state and existing draft authorship. No project/object management, archive/restore, freeze/start/run/command/model/Observer operation is in the delegated protocol. |
| Reliable revoke/save/receipt ordering | State → Store lock order; grant/generation checks, save, fixed card, exact receipt and successful audit share one transaction. Revoke serializes on the Store lock. Replays check current authority before reading receipts. Fault and concurrent order tests verify rollback or a committed save-before-revoke. |
| No save-triggered repository inspection | Delegated save skips sigil_answer/review/executor hooks. Automatic client-draft card reads return pure native_review_required preview. Only a later explicit native review click uses the original window credential/Origin guard; it is absent from the pipe. Tests check mount/refresh performs no review/write and failed explicit review never freezes/executes. |
| Restarts/updates/imports | Fresh public server epoch on restart; exact process stamp requires fresh status. Scope/image replacement and revoke increment generation. Import/migration revokes client grants while keeping committed data/receipts and unrelated Agent permissions. |
| Protected persistence, no new secrets | Canonical Store; delegation refuses non-private/reparse parent directories. Reuses owner-only protection only on explicit DB/sidecars, rejects hard links and a different file owner, and does not rewrite shared directory ACLs or take ownership. No bearer, window key copy, crypto scheme or new secret store. |
| Auditable without content/secrets | Audit keeps time, grant/generation, policy revision, scope snapshot, identity fingerprint, fixed operation/result and request-ID hash. Private body/environment/path sentinels and raw database errors do not appear. Full saved content belongs only to authenticated result receipts. |
| Existing protections and data | No general network listener, trusted-Origin list, window-key delivery/check, existing task-access policy or existing receipt was changed. Original record history/receipt/portability and Agent draft ownership regressions pass. |

## Final source validation

Logs are retained under `artifacts/client-write-stage1/`; each command log records
its explicit EXIT_CODE. These final runs cover the current source after the
Origin/null-Origin, import-revocation, scope/identity audit and automatic-card
preflight fixes. Earlier successful runs are not counted as current acceptance.

| Command | Exit | Passed cases | Log |
| --- | --- | --- | --- |
| cargo test --offline -p spellcast-bridge client_access -- --test-threads=1 | 0 | 25 | core-final.log |
| cargo test --offline -p spellcast-bridge project_record_store -- --test-threads=1 | 0 | 19 | record-compat.log |
| cargo test --offline -p spellcast-bridge agent_drafts_pin_one_card_replay_exactly_and_respect_authorship -- --test-threads=1 | 0 | 1 | draft-compat.log |
| cargo test --offline --manifest-path src-tauri/Cargo.toml --lib client_ -- --test-threads=1 | 0 | 12 | native-final.log |
| cargo test --offline --manifest-path src-tauri/Cargo.toml --lib state_path::tests -- --test-threads=1 | 0 | 10 | migration-compat.log |
| node scripts/check-client-access-ui.mjs | 0 | 17 | ui-final.log |
| node scripts/check-client-draft-card.mjs | 0 | 3 | card-final.log |
| npm run build | 0 | TypeScript + Vite production build; latest source also built by the standard beforeBuildCommand | frontend-final.log; candidate-build.log |
| npm run tauri -- build --no-bundle | 0 | Standard release candidate; not run/installed | candidate-build.log |

The native filter contains nine new client/delegation/migration cases (including
one inert child-fixture entry) and three
existing synthetic completion metadata/sound-policy cases. Migration validation
overlaps it; counts must not be added into a unique-test total. The new native
checks actually queried the Windows kernel for the test executable and both
ends of a unique temporary pipe, exercised temporary DACL/hard-link checks, and
proved that a synthetic test-harness child exiting with code 259 is terminated
using the kernel process signal. It is not confused with STILL_ACTIVE. This
child runs no application/model/service logic and creates no grant or user data.
They deliberately reject the test executable as CCGUI/installed Spellcast. They
did not authenticate a real CCGUI installation, open the production pipe, create
a real grant or prove the native consent click worked in a running application.

All database writes and grants in tests used temporary synthetic databases and
mock OS identities. Native controls/OS verification and business policy are
tested separately; mocks are never reported as real authorization success.
The original live Spellcast process was PID 55400, created at
2026-10-06 16:24:29.775657 +08:00, and remained unchanged during these checks.

Two earlier card-contract runs exited 1: an esbuild CSS-output configuration
error, then a missing preview-only UI restriction. Both were corrected; the
final three card cases exited 0. No assertion was weakened or skipped.
Final UI review additionally corrected the changed-image display so a historical
approved grant is not presented as current image authorization; its reapproval
uses the prior policy CAS. Final OS review additionally uses the process signal
to reject terminated processes even when their exit code is 259. Candidate builds
were repeated after these source changes, rather than reusing stale binaries.
Existing dead-code/unused-import warnings and Vite bundle-size/import warnings
remain outside this change; no new authorization failure is hidden by them.

## Candidate and real activation boundary

Candidate command is the standard `npm run tauri -- build --no-bundle` with
CARGO_NET_OFFLINE=true. Its beforeBuildCommand prepares repository-owned plugin
resources, runs their isolated mock guard/SDK checks, and builds the frontend;
it does not install a plugin, connect a real device or start a real Observer.
The release executable is not run. Terminal result, candidate SHA-256/size,
source-file hashes and local implementation commit are recorded in
`artifacts/client-write-stage1/acceptance.json` after the build completes.

Residual acceptance boundaries:

- CCGUI stage 2 must implement kernel server-identity verification against a
  native-pinned installation, replace the three window-key save paths, retain
  approved-device/connection checks, bind WS Origin to server-owned context,
  and recover pending/unknown by receipt without automatic resend. Its current
  Canvas compatibility diagnostic is independent of this stage.
- A real two-application grant/save/revoke/disconnect/upgrade exercise, actual
  focused-main confirmation, another-user/remote pipe rejection and storage
  behavior on the user's real directory were not exercised. They require a
  later user-approved native validation session; no actual consent is implied
  by these tests, compilation, prior all-project approval or CLI bypass mode.
- Owner/admin/System trust is the boundary. This does not claim resistance to
  administrator compromise, same-account database tampering or injection into
  an already trusted application process. Non-Windows and unusual/unsafe ACL
  layouts are rejected; they receive no weaker alternative.
- Once CCGUI stage 2 and the reviewed Spellcast candidate are installed in a
  later authorized session, the user selects the expected Spellcast identity
  in CCGUI's native confirmation, then opens Spellcast Settings → Connection →
  Application delegation, verifies the observed CCGUI image/path/hash/SID,
  selects the two desired scopes and clicks the visible approval. Same page
  offers revision-checked revocation. Saving never substitutes for that consent.

This task authorizes only the local source commit and candidate artifact. It
does not authorize installation, restart, real grants/data writes or a push.

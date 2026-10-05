# Claude host identity for Spellcast

The native hook helper supports `--host claude`. It accepts the hook stdin's exact `session_id` only when it is a hyphenated UUID (`8-4-4-4-12` hexadecimal digits), canonicalizes it to lowercase, and appends a JSON-escaped identity to an enabled observer bootstrap:

```text
SPELLCAST_SOURCE_ID="claude:123e4567-e89b-12d3-a456-426614174000"
```

Use that stable value as `source_id` for checkpoint, Canvas, and other Spellcast MCP calls that take a source. It is the Claude host conversation's identity. The observer's judging provider is independent: selecting `codex` or `claude` must never replace the `claude:<UUID>` origin. Missing, malformed, padded, braced, or non-UUID IDs fail closed with empty stdout and exit code zero. The helper does not infer identity from cwd, model, latest sessions, prompts, or transcript history.

## Native hook registration

[The Claude manifest](../hooks/claude-hooks.json) registers only `SessionStart` (`startup|resume|clear|compact`) and `UserPromptSubmit`. It uses Claude's native `command` plus `args` exec form and `${CLAUDE_PLUGIN_ROOT}`. Claude substitutes paths as literal arguments without a shell, including paths with spaces, apostrophes, dollar signs, or backticks. The checked-in manifest targets the Windows package's `bin/spellcast-hook.exe`; a POSIX package must use its platform-built `bin/spellcast-hook` command path. The host must support the documented exec form. See the official [hooks reference](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form).

Keep the [Codex manifest](../hooks/hooks.json) separate and use the same [shared bootstrap](../hooks/observer-bootstrap.txt) for both hosts. Claude automatically merges a plugin's default `hooks/hooks.json` even when a custom hooks file is declared. A separate Claude plugin package must therefore place the Claude manifest at its own `hooks/hooks.json` and omit the Codex manifest from that package. Do not load the repository root as a Claude plugin with both manifests. An SDK integration can instead register exactly the two events from the Claude manifest, invoke the helper with `--host claude`, and pass the native hook payload unchanged. See the official [plugin hooks reference](https://code.claude.com/docs/en/plugins-reference#hooks).

## Connect the original GUI conversation

The [thin CC GUI plugin](../extensions/ccgui-spellcast/README.md) uses the public session/chat SDK to register the already open Claude conversation and route Canvas requests back to its exact native UUID. The hook-derived `claude:<UUID>` and the plugin's registered native UUID must describe that same conversation. The GUI session ID remains a separate navigation handle; it is not a replacement for the native UUID. Neither selecting an observer provider nor changing Canvas focus changes the origin.

The host also needs Spellcast's native MCP connection at `http://127.0.0.1:47194/mcp`, as defined in [.mcp.json](../.mcp.json). The hook's status endpoint is `http://127.0.0.1:47194/api/observer/status`; both must point to the same running Spellcast instance. A hook's `additionalContext` output only supplies context: it is not a checkpoint receipt. The model must call native `spellcast_checkpoint` for a checkpoint to exist. If native MCP is unavailable, report that capability gap; do not submit checkpoints by an HTTP fallback or start a hidden replacement session. Plugin pairing credentials, MCP authentication, and host permissions remain under their existing setup.

## Gating and local state

Identity is appended only when the existing observer policy chooses bootstrap. Disabled, paused, disallowed, unavailable, repeat, stop, and child-event decisions retain the existing behavior. Native/compat child markers are skipped before the status request. Resume, clear, and compact use the existing refresh policy. The helper's default remains Codex, with the original stdout, cache key, status timeout, and child handling.

Claude cache keys use the canonical `claude:<UUID>` namespace; Codex cache keys continue using their existing native session ID. Thus matching UUIDs cannot suppress another host's bootstrap, and different UUID letter casing does not create another Claude source. Cache filenames and diagnostic session identities are hashed. Diagnostics contain bounded outcome fields, not raw UUIDs, cwd, prompts, transcript paths, credentials, or tokens. The helper reads only the status endpoint; it does not perform model, permission, authentication, or proxy configuration calls.

The helper never injects `CLAUDE_OBSERVER_RUNNER_PATH`, reads a runner path from plugin roots, or adds Claude-host courier instructions. Both plugin packages continue to distribute `hooks/claude-observer-runner.mjs` for App use.

With App provider `claude`, `spellcast_checkpoint` returns `status=scheduled` without exposing a brief to the host. The App runs its fixed fresh Claude Code Opus 5.5 xhigh runner and completes the ticket directly; the host starts neither a runner nor a courier child. Only `status=ready` with `brief.provider=codex` authorizes an actual isolated Codex judging child that calls native `spellcast_observer_complete`. If that capability is unavailable, report the real gap once and remain silent. Every non-ready status, including `scheduled`, `disabled`, `suppressed`, `cooldown`, `duplicate`, `capacity`, and `unavailable`, forbids spawn and immediate retry. If an older App returns `ready` with `brief.provider=claude`, report the App version or capability mismatch once and remain silent without a courier or provider fallback. Never label a Claude judgment as Codex, change the App's provider selection, or create a hidden main conversation to fill the gap. The host source remains `claude:<UUID>` in either case.

The App switch remains authoritative. Source cancellation through `spellcast_checkpoint(snapshot=null)` stops the corresponding App runner process; disabling asides invalidates pending tickets and stops their runners. Finishing a normal main reply does not require cancelling an aside that remains valid for the active task. Locale and non-blocking aside style remain part of the shared protocol.

The current managed Claude runtime supports Windows. Desktop startup locates an absolute Node executable and verifies the packaged runner against the same plugin's SHA-256 integrity manifest. A missing runtime produces `unavailable`, never a fallback host child. The original runner still verifies the Claude subscription and managed proxy, fixes its model and effort, and forbids tools. Its program and arguments cannot be selected by a checkpoint.

Application workers serialize execution per source. A replacement first cancels the previous ticket, including during cooldown, and cannot start a second process until the old tree is reaped. Pause, provider or locale changes, expiry, explicit cancellation, and shutdown also cancel work. Windows creates the runner suspended and assigns it to a kill-on-close Job before it runs; normal exits and failures both end its descendants. Shutdown crosses the short process-creation/assignment critical section before exiting, so an unassigned suspended child cannot be left behind. No observer completion is sent back into the host's task queue.

## Verification

Run `cargo test -p spellcast-hook` for the helper's unit and subprocess checks, including exact origin, malformed and hostile IDs, independent judging provider metadata, host cache isolation, child skips, policy gating, and diagnostic privacy. The tests also parse the Claude manifest and check its native event/command contract. Packaging, actual hook loading, native MCP availability, and a real CC GUI checkpoint/Canvas round trip need separate host acceptance; helper tests do not establish those outcomes.

On Windows, `node scripts/package-claude-plugin.mjs` builds the current release helper and regenerates `src-tauri/resources/claude-plugin` plus `src-tauri/resources/ccgui-spellcast`. The native package is named `spellcast`, version `0.1.1`, with only Claude hooks at its default hook path. Both outputs include SHA-256 integrity manifests and package metadata. Packaging validates the helper against an isolated ephemeral loopback mock and validates the thin GUI plugin before copying; it does not install either plugin or call the real observer or a model.

Run `cargo test -p spellcast-bridge observer` for ticket/dispatch, real process cancellation, expiry, descendant cleanup, successive replacements, and captured-origin regressions. Run `cargo test --manifest-path src-tauri/Cargo.toml observer_runtime::trusted::tests --lib` for resource and executable discovery checks.

For native acceptance, build a debug `com.spellcast.board.verify` app with `tauri/devtools`, then run `node scripts/check-observer-native.mjs --hold-ms 120000`. The check stages its own integrity-checked synthetic runner, database, ports, WebView profile and executable. It verifies a short-lived MCP client exits while the observer stays in the native app, a late result reaches a real bubble, and cancellation, switch-off and main-window close reap the process trees. It does not call a Claude model or use a real host conversation; those are separate acceptance boundaries. Evidence is written to `artifacts/native-checks/check-observer-native/report.json`.

# Spellcast implementation handoff

Current release: **0.2.1**. Start with [README](README.md), [release evidence](docs/releases/0.2.1.md), and the canonical [Spellcast Skill](skills/spellcast/SKILL.md).

Spellcast has two connected surfaces: sparse OS bubbles, and an Everything board where the existing host agent can compose complete replies. Adopting a bubble saves it onto the board. An explicit request to develop it leads to a structured board reply. User feedback stays attached to its source task and content block. Spellcast does not run a model or automatically wake an idle host.

Bubble content comes from the Agent's task; bubble placement follows the user's foreground display. Never use the board window's monitor as the active display. Keep the selected presentation mode (`surface`) separate from the board's actual keyboard focus (`board_focused`): background board mode does not suppress desktop bubbles. Explicit pause does.

| Path | Responsibility |
| --- | --- |
| `spellcast-core/` | Board state, bubbles, structured reply validation and revision rules |
| `spellcast-bridge/` | Shared service, MCP, loopback HTTP, durable state and feedback |
| `spellcast-server/` | Browser-preview service |
| `src-tauri/` | OS windows, client configuration writers, Skill installer |
| `src/` | Board and bubble UI; `replies.ts` renders structured blocks |
| `skills/spellcast/` | Agent behavior shipped in the application |
| `extensions/spellcast/` | Optional editor launcher and local status display |

Run `npm run desktop` for the actual desktop app, or `npm start` for the browser preview. The desktop app owns its bridge; do not launch a second server on the same port.

Validate changes with `npm run build`, `cargo test --workspace`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib`. Build the Windows installer with `npm run tauri -- build --bundles nsis`.

Keep evidence precise: a browser test proves browser behavior; an HTTP MCP round trip proves that adapter; host tool registration and host wakeups need their own evidence. The 0.2.1 notes record what was actually checked.

# Spellcast

![Spellcast: a wand casting desktop aside bubbles](docs/media/spellcast-hero-story.gif)

Spellcast is a local desktop app for coding agents. While the agent works on your task, it can drop a short aside on the display you are using: a roast, a reminder, or an idea you were not expecting. The bubble sits above your work. It does not bring the agent window forward.

Keep a thought on the Canvas and keep working it as text, images, comparisons, relationship graphs, steps, or interactive pieces. Codex and Grok Build can also show a completion notice. Sending a request back to the original task still goes through Codex Desktop.

> Spellcast is early. This is a preview you can try, not a finished product.

[English](README.md) · [简体中文](README.zh-CN.md) · [Download the preview (Windows only tested)](https://github.com/Vanyangyang/spellcast/releases/latest)

[![Spellcast - Desktop stage for coding agents: bubbles & Canvas | Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1254388&theme=light&t=1789729302078)](https://www.producthunt.com/products/spellcast?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spellcast)

## How it looks

**Codex on Windows is the supported, tested path.** macOS is untested.

**Bubbles and asides are passive.** There is no "spawn bubble" button. With **Show asides** on, asides come only from a host **subagent**, using a small slice of the main task. A desktop bubble appears when something is worth saying. No bubble is a normal result. Hooks do not fire one on every turn.

1. **Turn asides on for Codex**

   ![Desktop settings: Show asides On, Codex selected. Bubbles appear only when progress is worth saying.](docs/media/02-desktop-asides-codex.png)

   Desktop settings with **Show asides** On and **Codex** selected. Off leaves the main chat and Canvas only.

2. **A result on the Canvas**

   ![Canvas with an idea card under Needs sorting](docs/media/01-canvas-idea.png)

   An idea under **Needs sorting**. The agent put it there because the thought was worth keeping. You did not press a spawn button. Canvas is still changing; suggestions are welcome. Ideas already have several forms. A later Canvas focus mode may spend whatever it takes to speed up creative work.

3. **Claim, note, and tell the agent**

   ![Canvas Claim and Note card with the Tell the agent bar](docs/media/03-canvas-claim-note.png)

   A **Claim** or **Note** on the Canvas, plus **Tell the agent**. That bar sends a follow-up into the session. It does not create bubbles.

4. **A floating desktop bubble**

   ![A TAKE/aside bubble animating in over a Grok Build TUI session](docs/media/02-desktop-asides-bubble.gif)

   A **Grok Build** TUI session with a **TAKE**/aside bubble coming in. The running session produced it. Star it and it stays at the top. Leave it and it fades. You can drag the bubble.

5. **A completion notice**

   ![Completion notice card: Task complete, footer Grok Build · Double-click to dismiss](docs/media/04-completion-notice.png)

   A completion card with an optional spoken alert. The footer shows **Grok Build**. Double-click dismisses it.

## Where the preview stands

- **Published build:** [0.4.8](https://github.com/Vanyangyang/spellcast/releases/tag/v0.4.8) Windows x64 installer. See [0.4.8 notes](docs/releases/0.4.8.md).
- **This preview:** editable Canvas ideas, workspace/task organization, send-back to the original Codex Desktop task, one-step **Codex** setup (MCP + Hooks + Skill). **Grok Build setup comes later** (the Settings button is visible but disabled). See [runtime acceptance](docs/reviews/2026-09-14-workbench-runtime-acceptance.md), [replies](docs/reviews/2026-09-15-replies-inbox.md), and [Codex-only setup](docs/reviews/2026-09-15-codex-only-entry.md).
- **Still rough.** Layout, copy, and the Skill are changing. Feedback and issues are welcome. See [the next improvement brief](docs/next-improvement-prompt.md).

## From bubble to Canvas

1. **It shows up on the display you are using.** The agent's current task is the context. Your foreground window picks the display. Bubbles stay sparse. One might be an objection, a reminder, or a detour. Ignore it, drag it, or open it.
2. **Keep it.** The star saves the words onto the Canvas and attaches the originating task when that is known.
3. **Work it.** Combine components into an Idea with a title and a purpose. The Canvas is the reply surface. The layout follows the idea.
4. **Edit, then send.** Pick a direction, edit components, or add a constraint. Those edits stay on the Canvas until you click **Send to Codex**. The request then goes to the original task. Sending it elsewhere needs confirmation.

| Expression | What you can do |
| --- | --- |
| Text | Read complete explanations, edit them, and ask about a specific block |
| Images and shapes | Arrange reference images, rectangles, ellipses, and annotations |
| Comparison | Inspect alternatives against the same criteria and choose one |
| Relationship graph | Follow labeled connections, inspect nodes, drag, pan, and zoom |
| Storyboard | Explore ordered steps, their actions and feedback, and reorder them |
| Interactive works | Use locally stored Web tools supplied by the agent, with declared inputs and outputs |

Ideas can mix these forms. Switch away and desktop bubbles resume. An explicit pause stays paused.

## How it connects

Spellcast is a local desktop app, connected through MCP. It does not run a model and does not need a model API key. Your agent keeps using its existing host and model.

An explicit Canvas send goes to the matching task in running **Codex Desktop**, including an idle task. Failed delivery is not shown as success. Grok Build setup is not in this preview.

**Completion notices** are a small always-on-top card. Spoken alerts are optional and follow the UI language. Double-click a Codex card to jump back into that task. Double-click a Grok Build card to dismiss it.

**Independent asides** follow the Spellcast switch. They run as a host subagent and use only a small slice of the main task. See [Codex hooks and verification boundaries](docs/codex-observer-hooks.md).

Kept ideas and replies survive restart. Durable memory is separate: save only what you choose, inspect it in **Memory**, search it, and forget individual entries. Starring a bubble does not create a memory on its own.

## Get started

![Spellcast desktop settings: asides switch, MCP address, and one-step Codex setup](docs/media/spellcast-desktop-settings.png)

1. Build the current source (below) for the workflow described here, or install the [published Windows preview](https://github.com/Vanyangyang/spellcast/releases/latest).
2. For **Codex**, open **Settings**, keep Codex selected, and install or update the Spellcast integration. That writes MCP, Hooks, and the behavior Skill together, with backups and conflict checks. Reload Codex and follow any Hooks trust instructions in the integration status.
3. **Grok Build will be added in a later version.** The Settings button stays visible but cannot install.
4. Turn independent asides on with the Spellcast switch when you want them. Codex Hooks are what can start them.

Integration details: [docs/codex-observer-hooks.md](docs/codex-observer-hooks.md) and the packaged [hooks/INSTALL.md](hooks/INSTALL.md).

The Spellcast app has to be running. Local MCP is `http://127.0.0.1:47194/mcp`. **Setup currently supports Codex.** Other hosts in Settings are visible but disabled. macOS and Linux CI packages are untested.

## Develop locally

```sh
git clone https://github.com/Vanyangyang/spellcast.git
cd spellcast
npm ci
npm run prepare:codex-plugin
npm run desktop
```

Use Node.js 22+, the repository's Rust toolchain, and the platform's Tauri prerequisites. Windows builds require Visual Studio C++ build tools, Windows SDK, and WebView2. Linux builds need WebKitGTK 4.1 and the other packages from the [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

`npm start` is a browser Canvas preview. Desktop bubbles need `npm run desktop` or the installed app. `npm run desktop` hot-reloads against Vite at `http://127.0.0.1:47193`. A local debug exe: `npx tauri build --debug --no-bundle`.

```sh
npm run build
cargo test --workspace
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri -- build --bundles nsis
# Linux: npm run tauri -- build --bundles appimage,deb
```

## Built with Astra

Spellcast was built with GPT-6 Astra. Astra pushed back on the product assumptions, wrote the Rust core and the Tauri shell, wired the bubble → Canvas → feedback loop, and used computer use to test the desktop interactions and make the demos. The graph canvas uses [AntV X6](https://github.com/antvis/X6). The desktop shell uses [Tauri](https://github.com/tauri-apps/tauri).

## Friends

- [LINUX DO](https://linux.do)

[Agent behavior](skills/spellcast/SKILL.md) · [Release notes and verification](docs/releases/) · [AGPL-3.0 license](LICENSE)

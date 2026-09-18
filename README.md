# Spellcast

![Spellcast: a wand casting desktop aside bubbles](docs/media/spellcast-hero-story.gif)

**A stage of its own.** Desktop asides, a Canvas for ideas you can develop, and completion notices for Codex and Grok Build. Sending a request back to the original task still uses Codex Desktop.

> **Spellcast is in early development.** Early demo · Experimental preview.
> What you see here is a preview build for trying the idea, not a finished product. Stay tuned for the full release.

Want Astra to roast your project? Remember what you meant to come back to? Give you an idea you were not expecting?

Your agent keeps working on your task. Its asides appear as bubbles on the display you are currently using, above your work without bringing the agent window forward. Keep a thought, bring it onto the Canvas, and develop it with text, images, comparisons, relationships, steps, and interactive works.

[English](README.md) · [简体中文](README.zh-CN.md) · [Download the preview (Windows only tested)](https://github.com/Vanyangyang/spellcast/releases/latest)

[![Spellcast - Desktop stage for coding agents: bubbles & Canvas | Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1254388&theme=light&t=1789729302078)](https://www.producthunt.com/products/spellcast?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spellcast)

## How it looks

**Codex on Windows is the supported, tested path.** macOS is untested.

**Bubbles and asides are passive.** There is no “spawn bubble” button. With **Show asides** on, asides are thrown only via a host **subagent**, using a small slice of the main task. A desktop bubble appears when something is worth saying — a roast, a reminder, or a spark. Silence is a valid outcome. Hooks do not guarantee a bubble on every turn.

1. **Turn asides on for Codex**

   ![Desktop settings: Show asides On, Codex selected. Bubbles appear only when progress is worth saying.](docs/media/02-desktop-asides-codex.png)

   Desktop settings with **Show asides** On and **Codex** selected. Off keeps the main chat and Canvas only.

2. **A result on the Canvas**

   ![Canvas with an idea card under Needs sorting](docs/media/01-canvas-idea.png)

   An idea under **Needs sorting**. The agent placed this on the Canvas when the thought was worth keeping — not because you pressed a spawn button. Canvas is still in active development; suggestions are welcome. Ideas can already take several forms. A later Canvas focus mode may spend whatever it takes to accelerate creative work.

3. **Claim, note, and tell the agent**

   ![Canvas Claim and Note card with the Tell the agent bar](docs/media/03-canvas-claim-note.png)

   A **Claim** or **Note** on the Canvas, plus **Tell the agent**. That bar sends a follow-up into the session. It does not create bubbles.

4. **A floating desktop bubble**

   ![A TAKE/aside bubble animating in over a Grok Build TUI session](docs/media/02-desktop-asides-bubble.gif)

   A **Grok Build** TUI session with a **TAKE**/aside bubble animating in. There is still no spawn button; the running session produced the bubble. Star it and it stays at the top; leave it and it fades on its own. You can drag the bubble.

5. **A completion notice**

   ![Completion notice card: Task complete, footer Grok Build · Double-click to dismiss](docs/media/04-completion-notice.png)

   A completion card with an optional spoken alert. The footer shows **Grok Build**; double-click dismisses the card.

## Where the preview stands

- **Published build:** [0.4.5](https://github.com/Vanyangyang/spellcast/releases/tag/v0.4.5) — Windows x64 installer. See [0.4.5 notes](docs/releases/0.4.5.md).
- **This preview:** editable Canvas ideas, workspace/task organization, send-back to the original Codex Desktop task, one-step **Codex** setup (MCP + Hooks + Skill). **Grok Build setup comes later** (the Settings button is visible but disabled). See [runtime acceptance](docs/reviews/2026-09-14-workbench-runtime-acceptance.md), [replies](docs/reviews/2026-09-15-replies-inbox.md), and [Codex-only setup](docs/reviews/2026-09-15-codex-only-entry.md).
- **Still rough.** Layout, copy, and the Skill are changing. Feedback and issues are welcome. See [the next improvement brief](docs/next-improvement-prompt.md).

## From a spark to something you can work with

1. **A thought meets you where you work.** Your agent's task supplies the context; your foreground window determines the display. A sparse bubble carries an objection, a reminder, or a creative detour. Leave it alone, drag it, or open it.
2. **Keep the idea.** The star saves its words onto your Canvas, with the originating task attached when known.
3. **Give it room.** Combine components into an Idea with a title and purpose. The Canvas becomes the reply surface, with a composition that fits the idea.
4. **Make it yours.** Choose a direction, edit components, or add a constraint. These changes stay on the Canvas until you explicitly click **Send to Codex**; the request then goes to its original task. Redirecting it requires confirmation.

| Expression | What you can do |
| --- | --- |
| Text | Read complete explanations, edit them, and ask about a specific block |
| Images and shapes | Arrange reference images, rectangles, ellipses, and annotations |
| Comparison | Inspect alternatives against the same criteria and choose one |
| Relationship graph | Follow labeled connections, inspect nodes, drag, pan, and zoom |
| Storyboard | Explore ordered steps, their actions and feedback, and reorder them |
| Interactive works | Use locally stored Web tools supplied by the agent, with declared inputs and outputs |

Ideas can combine these forms. Switch away and desktop bubbles resume; an explicit pause stays paused.

## Your agent stays where it already works

Spellcast is a local desktop app, connected through MCP. It does not run a model or require a model API key. Your agent continues to use its existing host and model.

An explicit Canvas submission goes to the matching task in running **Codex Desktop**, including an idle task. Failed delivery is not shown as success. Grok Build setup is not in this preview.

**Completion notices** are a small always-on-top card, with an optional spoken alert in the UI language. A Codex card double-clicks back into that task; a Grok Build card double-clicks to dismiss.

**Independent asides** follow the Spellcast switch. They run as a host subagent, using only a small slice of the main task. See [Codex hooks and verification boundaries](docs/codex-observer-hooks.md).

Kept ideas and replies survive restart. Durable memory is separate: save only what you choose, inspect it in **Memory**, search it, and forget individual entries. Keeping a bubble does not automatically create a memory.

## Get started

![Spellcast desktop settings: asides switch, MCP address, and one-step Codex setup](docs/media/spellcast-desktop-settings.png)

1. Build the current source (below) for the workflow described here, or install the [published Windows preview](https://github.com/Vanyangyang/spellcast/releases/latest).
2. For **Codex**, open **Settings**, keep Codex selected, and install or update the Spellcast integration. This writes MCP, Hooks, and the behavior Skill together, with backups and conflict checks. Reload Codex and follow any Hooks trust instructions shown by the integration status.
3. **Grok Build will be added in a future version.** The Settings button remains visible but cannot install.
4. Enable independent asides using the Spellcast switch when desired (Codex Hooks are what can start them).

Integration details: [docs/codex-observer-hooks.md](docs/codex-observer-hooks.md) and the packaged [hooks/INSTALL.md](hooks/INSTALL.md).

The Spellcast app must be running. Local MCP is `http://127.0.0.1:47194/mcp`. **Setup currently supports Codex.** Other hosts in Settings are visible but disabled. macOS and Linux CI packages are untested.

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

Spellcast was built with GPT-6 Astra. Astra challenged the product assumptions, wrote the Rust core and the Tauri shell, integrated the bubble → Canvas → feedback loop, and used computer use to test the desktop interactions end-to-end and produce the demos. The graph canvas uses [AntV X6](https://github.com/antvis/X6); the desktop shell uses [Tauri](https://github.com/tauri-apps/tauri).

## Friends

- [LINUX DO](https://linux.do) — A new kind of ideal community.

[Agent behavior](skills/spellcast/SKILL.md) · [Release notes and verification](docs/releases/) · [AGPL-3.0 license](LICENSE)

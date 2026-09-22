# Spellcast

![Spellcast: a wand casting desktop aside bubbles](docs/media/spellcast-hero-story.gif)

Spellcast is a local desktop app for coding agents. The agent keeps working on your task. When something is worth saying, a short aside can land on the display you are using, usually a roast or a leftover reminder, and once in a while an idea you weren't expecting. The bubble sits on top of your work. It leaves the agent window where it is.

Keep a thought on the Canvas if you want to keep editing it: text, images, comparisons, relationship graphs, steps, interactive pieces. Codex and Grok Build can also show a completion notice when a task finishes. Sending a request back to the original task still goes through Codex Desktop.

> Early preview. I would not call it done.

[English](README.md) · [简体中文](README.zh-CN.md) · [Download the preview (Windows only tested)](https://github.com/Vanyangyang/spellcast/releases/latest)

[![Spellcast - Desktop stage for coding agents: bubbles & Canvas | Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1254388&theme=light&t=1789729302078)](https://www.producthunt.com/products/spellcast?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spellcast)

## How it looks

I've only tested Codex on Windows. That is the path this preview supports. macOS is untested.

Bubbles and asides are passive. There is no "spawn bubble" button; I left it out on purpose. With **Show asides** on, asides come only from a host subagent, using a small slice of the main task. A desktop bubble shows up when something is worth saying. Hooks do not fire one on every turn.

1. **Turn asides on for Codex**

   ![Desktop settings: Show asides On, Codex selected. Bubbles appear only when progress is worth saying.](docs/media/02-desktop-asides-codex.png)

   Desktop settings with **Show asides** On and Codex selected. Off leaves the main chat and Canvas only.

2. **A result on the Canvas**

   ![Canvas with an idea card under Needs sorting](docs/media/01-canvas-idea.png)

   An idea under **Needs sorting**. The agent put it there because the thought was worth keeping. Canvas is still changing, so if something feels off, open an issue. Ideas already have several forms. A later Canvas focus mode may spend whatever it takes to speed up creative work.

3. **Claim, note, and tell the agent**

   ![Canvas Claim and Note card with the Tell the agent bar](docs/media/03-canvas-claim-note.png)

   A **Claim** or **Note** on the Canvas, plus **Tell the agent**. That bar sends a follow-up into the session. It does not create bubbles.

4. **A floating desktop bubble**

   ![A TAKE/aside bubble animating in over a Grok Build TUI session](docs/media/02-desktop-asides-bubble.gif)

   A Grok Build TUI session with a **TAKE**/aside bubble coming in. The running session produced it. Star it and it stays at the top; leave it and it fades. You can drag it.

5. **A completion notice**

   ![Completion notice card: Task complete, footer Grok Build · Double-click to dismiss](docs/media/04-completion-notice.png)

   A completion card with an optional spoken alert. The footer shows Grok Build. Double-click dismisses it.

## Where the preview stands

- Published build is [0.4.12](https://github.com/Vanyangyang/spellcast/releases/tag/v0.4.12), with desktop packages built by GitHub Actions. See [0.4.12 notes](docs/releases/0.4.12.md).
- This preview has editable Canvas ideas, workspace/task organization, send-back to the original Codex Desktop task, and one-step Codex setup (MCP + Hooks + Skill). Grok Build setup comes later. The Settings button is visible but disabled. See [runtime acceptance](docs/reviews/2026-09-14-workbench-runtime-acceptance.md), [replies](docs/reviews/2026-09-15-replies-inbox.md), and [Codex-only setup](docs/reviews/2026-09-15-codex-only-entry.md).
- Layout, copy, and the Skill are still moving around. Open an issue if you hit something. See [the next improvement brief](docs/next-improvement-prompt.md).

## From bubble to Canvas

1. **It follows the display you are using.** Context comes from the agent's current task. The foreground window picks the monitor. Bubbles stay sparse: mostly an objection or a reminder, sometimes a detour. Ignore it or drag it. You can also open it.
2. **Keep it.** The star saves the words onto the Canvas and attaches the originating task when that is known.
3. **Work it.** Combine components into an Idea with a title and a purpose. The Canvas is the reply surface; the layout follows the idea.
4. **Edit, then send.** Pick a direction or add a constraint, then edit the components. Those edits stay on the Canvas until you click **Send to Codex**. The request then goes to the original task. Sending it elsewhere needs confirmation.

| Expression | What you can do |
| --- | --- |
| Text | Read complete explanations, edit them, and ask about a specific block |
| Images and shapes | Arrange reference images, rectangles, ellipses, and annotations |
| Comparison | Inspect alternatives against the same criteria and choose one |
| Relationship graph | Follow labeled connections, inspect nodes, drag, pan, and zoom |
| Storyboard | Explore ordered steps, their actions and feedback, and reorder them |
| Interactive works | Use locally stored Web tools supplied by the agent, with declared inputs and outputs |

Ideas can mix these forms. Switch away and desktop bubbles resume. If you pause asides yourself, they stay off.

## MCP, send-back, memory

Spellcast is a local desktop app. It talks to your agent through MCP. It does not run a model, and you do not paste a model API key. The agent keeps using its existing host and model.

An explicit Canvas send goes to the matching task in running Codex Desktop, including an idle task. Failed delivery is not shown as success. Grok Build setup is not in this preview.

Completion notices are a small always-on-top card. Spoken alerts are optional and follow the UI language. Double-click a Codex card to jump back into that task. Double-click a Grok Build card to dismiss it.

Independent asides follow the Spellcast switch. They run as a host subagent and use only a small slice of the main task. See [Codex hooks and verification boundaries](docs/codex-observer-hooks.md).

Kept ideas and replies survive restart. Durable memory is a separate action: save only what you choose, inspect it in **Memory**, search it, and forget individual entries. Starring a bubble does not create a memory on its own.

## Get started

![Spellcast desktop settings: asides switch, MCP address, and one-step Codex setup](docs/media/spellcast-desktop-settings.png)

1. Build the current source (below) for the workflow described here, or install the [published Windows preview](https://github.com/Vanyangyang/spellcast/releases/latest).
2. For Codex, open **Settings**, keep Codex selected, and install or update the Spellcast integration. That writes MCP, Hooks, and the behavior Skill together, with backups and conflict checks. Reload Codex and follow any Hooks trust instructions in the integration status.
3. Grok Build will be added in a later version. The Settings button stays visible but cannot install.
4. Turn independent asides on with the Spellcast switch when you want them. Codex Hooks are what can start them.

Integration details: [docs/codex-observer-hooks.md](docs/codex-observer-hooks.md) and the packaged [hooks/INSTALL.md](hooks/INSTALL.md).

The Spellcast app has to be running. Local MCP is `http://127.0.0.1:47194/mcp`. Setup currently supports Codex. Other hosts in Settings are visible but disabled. macOS and Linux CI packages are untested.

## Develop locally

Windows Canvas data lives in `%USERPROFILE%\.spellcast\spellcast.sqlite3`, shared across launch methods. See [storage and old-data migration](docs/state-storage.md).

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

Spellcast was built with GPT-6 Astra. Astra pushed back on the product assumptions, then wrote the Rust core and the Tauri shell and wired the bubble to Canvas to feedback loop. Computer use is how the desktop interactions got tested and how the demos were made. The graph canvas uses [AntV X6](https://github.com/antvis/X6). The desktop shell uses [Tauri](https://github.com/tauri-apps/tauri).

## Friends

- [LINUX DO](https://linux.do)

[Agent behavior](skills/spellcast/SKILL.md) · [Release notes and verification](docs/releases/) · [AGPL-3.0 license](LICENSE)

# Spellcast Codex plugin (0.3.0)

This folder is a self-contained Codex plugin. Installing it is **not** the same as trusting its hooks. Do not use `--dangerously-bypass-hook-trust`.

Running a **prebuilt** plugin package does not require Node or Python. Building the package from source still needs Rust and Node.

## What this package is

- Native helper `bin/spellcast-hook` (Windows: `spellcast-hook.exe`) talks only to loopback HTTP.
- MCP `.mcp.json` points at the same Spellcast instance as the hook `--endpoint`.
- Canonical Skill: `skills/spellcast/SKILL.md`.
- Hooks: `hooks/hooks.json` for `SessionStart` and `UserPromptSubmit` only.

Hook stdout is native context output only. It is not a `spellcast_checkpoint` receipt, not observer complete, and not proof the model read the text.

Official manual-install notes: https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually

## Manual install (do not overwrite an existing marketplace)

1. Copy this **entire plugin directory** to a personal plugins folder. Recommended:

   `%USERPROFILE%\plugins\spellcast`
   (Linux/macOS: `~/plugins/spellcast`)

2. Edit `%USERPROFILE%\.agents\plugins\marketplace.json`.
   - If the file **already exists**, keep its top-level `name` and **every existing plugin entry**. Only **add** the Spellcast object below.
   - `source.path` is relative to the **marketplace root** (for a personal marketplace that is usually your home directory), **not** relative to `.agents/plugins`.

   Entry to add:

   ```json
   {
     "name": "spellcast",
     "source": { "source": "local", "path": "./plugins/spellcast" },
     "policy": {
       "installation": "AVAILABLE",
       "authentication": "ON_INSTALL"
     },
     "category": "Productivity"
   }
   ```

   If the file **does not exist**, create this **minimal** file (change `"name"` only if you already use another marketplace name):

   ```json
   {
     "name": "personal",
     "plugins": [
       {
         "name": "spellcast",
         "source": { "source": "local", "path": "./plugins/spellcast" },
         "policy": {
           "installation": "AVAILABLE",
           "authentication": "ON_INSTALL"
         },
         "category": "Productivity"
       }
     ]
   }
   ```

3. If the marketplace top-level `name` is `personal`, install with:

   ```
   codex plugin add spellcast@personal
   ```

   If you kept a different marketplace name, use `spellcast@<that-name>` instead.

4. In Codex, run `/hooks` and trust **only** this plugin's SessionStart and UserPromptSubmit commands.

5. Start the Spellcast desktop app, open **Settings**, and turn **Asides / 旁念** on if you want them. Then start a **new ordinary task** to accept the native path. An existing long-running task may not pick up hooks until it is reloaded.

This document does not write `~/.agents` or `~/.codex` for you.

## Same-instance rule

Hook `--endpoint` and MCP `url` must name one Spellcast. Default is `http://127.0.0.1:47194`.

## Windows

`commandWindows` is a `powershell.exe` launcher. Codex runs that string through the user shell (`powershell -NoProfile -Command` or `cmd /c`); a quoted exe path is not valid PowerShell. The launcher reads `PLUGIN_ROOT` from the process environment (so names with spaces or apostrophes work) and does not expand `${PLUGIN_ROOT}` in the outer command. POSIX `command` is unchanged. Timeout remains 2 seconds. The helper uses the Windows GUI subsystem so a trusted hook should not flash a console; redirected stdin/stdout still carry JSON. Packaging was verified on Windows; other OS builds are not claimed as tested. Installing a new `commandWindows` string changes the hook trust hash — trust it in Codex (`/hooks`); do not use `--dangerously-bypass-hook-trust`.

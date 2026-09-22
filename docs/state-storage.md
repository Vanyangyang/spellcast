# Canvas storage on Windows

The desktop app uses `%USERPROFILE%\.spellcast\spellcast.sqlite3`. This location is outside AppData, so launching Spellcast from a packaged host such as Codex or from Explorer reaches the same database. MSIX can redirect AppData reads and writes into a host package's LocalCache; even the same apparent Roaming path can refer to different files ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)).

Once the canonical database exists, startup only opens that file. A lock, unsupported schema, or corruption is an error, never a reason to fall back to another board. SQLite still enforces one owner for the database. macOS and Linux retain their existing application data directory.

## First migration

Only when the canonical file is absent, startup checks the previous application data location and this app's old `LocalCache/Roaming/com.spellcast.board/spellcast.sqlite3` files beneath Windows package directories. One unambiguous source is copied using SQLite's backup API, including committed WAL records and stored artifact files. Multiple sources stop startup with their paths; modification times and card counts are never used to guess the intended board.

A packaged launch cannot reliably inspect the physical Roaming file hidden by its redirected view. When it sees legacy data, automatic migration stops: launch once from the Windows Start menu for an unvirtualized scan, or explicitly select a database with the command below. This restriction applies only before the canonical store exists.

For an explicit selection, close the old Spellcast instance, unset `SPELLCAST_STATE_FILE`, and run the installed executable with:

```powershell
& 'C:\path\to\spellcast.exe' --migrate-state-from 'C:\full\path\to\chosen\spellcast.sqlite3'
```

The command copies the chosen database to the fixed location and exits. It refuses to overwrite an existing canonical database. Restart Spellcast normally afterward. Old databases remain untouched as recovery sources; they are no longer runtime alternatives. Back up the chosen database before migration when recovering from conflicting histories.

`SPELLCAST_STATE_FILE` remains an explicit development/test override and must be an absolute path. The browser preview's separate fixture database is not the desktop store. Neither an override nor the working directory silently changes the desktop default.

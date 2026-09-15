# vendor/wry 0.55.1

Copied from the local crates.io cache, then patched with one upstream hunk.

## Original crate

- Name/version: `wry` 0.55.1
- crates.io index checksum (Cargo.lock + `.crate` SHA-256): `186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514`
- Copied from: `C:\Users\Administrator\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\wry-0.55.1`
- `.crate` file: `C:\Users\Administrator\.cargo\registry\cache\index.crates.io-1949cf8c6b5b557f\wry-0.55.1.crate`
- Licenses kept: `LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE.spdx`
- `.cargo-ok` was not copied forward as package verification

## Upstream fix

- Commit: https://github.com/tauri-apps/wry/commit/3fbf592feab29ffb269778a6f5573746a2f25a4a
- PR: https://github.com/tauri-apps/wry/pull/1795 (2026-08-10)
- Applied only the `WM_DESTROY` / `PARENT_DESTROY_MESSAGE` functional hunk:
  1. `RemoveWindowSubclass(hwnd, Some(Self::parent_subclass_proc), PARENT_SUBCLASS_ID)`
  2. `drop(Box::from_raw(controller))`
  3. Delete the old drop-then-`SetWindowSubclass(..., null)` path that left the callback installed
- Not applied: unrelated match-arm restyles (`WM_SIZE` / `WM_MOVE`) from that commit

## Workspace patch

`src-tauri` (independent workspace) has:

```toml
[patch.crates-io]
wry = { path = "../vendor/wry" }
```

Do not edit the global Cargo registry. Do not bump Tauri to 3 alpha.

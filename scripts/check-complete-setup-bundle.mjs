import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(process.argv[2] ?? join(root, "src-tauri/resources/codex-plugin"));
const helper = process.platform === "win32" ? "spellcast-hook.exe" : "spellcast-hook";
const managed = [
  ".codex-plugin/plugin.json",
  "hooks/hooks.json",
  "hooks/observer-bootstrap.txt",
  "hooks/observer-stop.txt",
  "skills/spellcast/SKILL.md",
  "skills/spellcast/references/asides.md",
  "skills/spellcast/references/canvas.md",
  "skills/spellcast/references/works.md",
  "skills/spellcast/references/feedback.md",
  ".mcp.json",
  "LICENSE",
  `bin/${helper}`,
  "integrity.json",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

assert(existsSync(dest), `missing bundle ${dest}`);
for (const rel of managed) {
  const path = join(dest, rel);
  assert(existsSync(path) && statSync(path).isFile(), `missing ${rel}`);
  assert(!statSync(path).isSymbolicLink?.(), `symlink ${rel}`);
}
const integrity = JSON.parse(readFileSync(join(dest, "integrity.json"), "utf8"));
assert.equal(integrity.algorithm, "sha256");
for (const rel of Object.keys(integrity.files)) {
  assert.equal(integrity.files[rel], sha256(join(dest, rel)), `hash mismatch ${rel}`);
}
const mcp = JSON.parse(readFileSync(join(dest, ".mcp.json"), "utf8"));
assert.equal(mcp.mcpServers.spellcast.url, "http://127.0.0.1:47194/mcp");
const hooks = JSON.parse(readFileSync(join(dest, "hooks/hooks.json"), "utf8"));
assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
assert.equal(hooks.hooks.SessionStart[0].hooks[0].timeout, 2);
assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].timeout, 2);
const blob = readFileSync(join(dest, "hooks/hooks.json"), "utf8") + readFileSync(join(dest, ".mcp.json"), "utf8");
assert(!blob.includes("G:\\\\VibeProj"), "packaged files must not embed repo paths");
assert(!existsSync(join(dest, "package-meta.json")), "package-meta.json must not ship");
console.log(JSON.stringify({ dest, files: managed.length, helper: sha256(join(dest, "bin", helper)) }, null, 2));

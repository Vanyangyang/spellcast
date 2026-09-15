import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packScript = join(root, "scripts/package-codex-plugin.mjs");

const MANAGED = [
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
];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function helperName() {
  return process.platform === "win32" ? "spellcast-hook.exe" : "spellcast-hook";
}

function isRegularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) return null;
  return args[index + 1];
}

const dest = resolve(flag("--dest") ?? join(root, "src-tauri/resources/codex-plugin"));
const packOut = resolve(
  flag("--pack-out") ?? join(root, "artifacts/spellcast-complete-setup-20260913", `plugin-pack-${Date.now()}-${randomBytes(3).toString("hex")}`),
);

const pack = spawnSync(process.execPath, [packScript, "--out", packOut, "--port", "47194"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
});
if (pack.status !== 0) {
  process.stderr.write(pack.stderr || pack.stdout || "package-codex-plugin failed\n");
  process.exit(pack.status ?? 1);
}

const packed = join(packOut, "spellcast");
if (!existsSync(packed)) {
  console.error("package did not write spellcast/");
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(packed, dest, { recursive: true });
const meta = join(dest, "package-meta.json");
if (existsSync(meta)) rmSync(meta);

const helperRel = `bin/${helperName()}`;
const files = {};
for (const rel of [...MANAGED, helperRel]) {
  const path = join(dest, rel);
  if (!isRegularFile(path)) {
    console.error(`missing packed file ${rel}`);
    process.exit(1);
  }
  files[rel] = sha256File(path);
}
writeFileSync(join(dest, "integrity.json"), JSON.stringify({ algorithm: "sha256", files }, null, 2) + "\n");

const text = JSON.stringify({ dest, packOut, helper: helperRel, files: Object.keys(files) }, null, 2);
process.stdout.write(text + "\n");

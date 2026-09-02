/**
 * Regression: Spellcast must never overwrite Codex ~/.codex/config.toml
 * with Cursor-format mcpServers JSON.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SAMPLE_CODEX_CONFIG_TOML,
  INCIDENT_CURSOR_MCP_JSON,
  MCP_REGISTRATION_ENABLED,
  autoRegisterSpellcastMcp,
  detectConfigFormat,
  mergeCursorMcpServer,
  pathIsUnderCodex,
  registerSpellcastMcp,
} from "./lib/tool-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function assert(cond, message) {
  if (!cond) failures.push(message);
}

function scratch() {
  return mkdtempSync(join(tmpdir(), "spellcast-cfg-"));
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function codeOf(err) {
  return err && err.code ? err.code : String(err);
}

{
  assert(MCP_REGISTRATION_ENABLED === false, "MCP registration must stay disabled");
  try {
    registerSpellcastMcp();
    failures.push("registerSpellcastMcp must throw");
  } catch (err) {
    assert(codeOf(err) === "RegistrationDisabled", `registerSpellcastMcp: ${codeOf(err)}`);
  }
}

{
  const home = scratch();
  const codex = join(home, ".codex", "config.toml");
  const cursor = join(home, ".cursor", "mcp.json");
  write(codex, SAMPLE_CODEX_CONFIG_TOML);
  write(cursor, `{ "mcpServers": { "keep": { "command": "echo" } } }`);
  const beforeCodex = readFileSync(codex);
  const beforeCursor = readFileSync(cursor);
  try {
    autoRegisterSpellcastMcp(home);
    failures.push("autoRegisterSpellcastMcp must refuse");
  } catch (err) {
    assert(codeOf(err) === "RegistrationDisabled", `autoRegister: ${codeOf(err)}`);
  }
  assert(readFileSync(codex).equals(beforeCodex), "auto-register must not touch Codex TOML");
  assert(readFileSync(cursor).equals(beforeCursor), "auto-register must not touch Cursor JSON");
  assert(detectConfigFormat(readFileSync(codex)) === "toml", "Codex fixture must remain TOML");
  rmSync(home, { recursive: true, force: true });
}

{
  const home = scratch();
  const windowsShape = join(home, "Users", "Administrator", ".codex", "config.toml");
  write(windowsShape, SAMPLE_CODEX_CONFIG_TOML);
  const before = readFileSync(windowsShape);
  assert(pathIsUnderCodex(windowsShape), "Windows .codex path must be detected");
  assert(
    pathIsUnderCodex("C:\\\\Users\\\\Administrator\\\\.codex\\\\config.toml"),
    "literal Windows Codex path must be forbidden",
  );
  try {
    mergeCursorMcpServer(windowsShape, "spellcast", { url: "http://127.0.0.1:47194/mcp" });
    failures.push("write helper must refuse .codex/config.toml");
  } catch (err) {
    assert(codeOf(err) === "CodexPathForbidden", `codex write: ${codeOf(err)}`);
  }
  assert(readFileSync(windowsShape).equals(before), "Codex TOML must be byte-identical after refused write");
  assert(!readFileSync(windowsShape, "utf8").includes("mcpServers"), "must not dump mcpServers into TOML");
  rmSync(home, { recursive: true, force: true });
}

{
  const home = scratch();
  const toml = join(home, "misc", "config.toml");
  write(toml, SAMPLE_CODEX_CONFIG_TOML);
  const before = readFileSync(toml);
  try {
    mergeCursorMcpServer(toml, "spellcast", { url: "http://127.0.0.1:47194/mcp" });
    failures.push("write helper must refuse any .toml target");
  } catch (err) {
    assert(codeOf(err) === "TomlTarget", `toml write: ${codeOf(err)}`);
  }
  assert(readFileSync(toml).equals(before), "non-Codex TOML must stay untouched");
  rmSync(home, { recursive: true, force: true });
}

{
  const home = scratch();
  const mcp = join(home, ".cursor", "mcp.json");
  write(mcp, SAMPLE_CODEX_CONFIG_TOML);
  const before = readFileSync(mcp);
  try {
    mergeCursorMcpServer(mcp, "spellcast", { url: "http://127.0.0.1:47194/mcp" });
    failures.push("write helper must refuse TOML bytes at a .json path");
  } catch (err) {
    assert(codeOf(err) === "TomlTarget", `json-path toml: ${codeOf(err)}`);
  }
  assert(readFileSync(mcp).equals(before), "misnamed TOML must stay untouched");
  rmSync(home, { recursive: true, force: true });
}

{
  const home = scratch();
  const mcp = join(home, ".cursor", "mcp.json");
  write(
    mcp,
    `{
  "mcpServers": {
    "keep-me": { "command": "echo", "args": ["ok"] }
  },
  "other": { "stay": true }
}
`,
  );
  mergeCursorMcpServer(mcp, "spellcast", { url: "http://127.0.0.1:47194/mcp" });
  const parsed = JSON.parse(readFileSync(mcp, "utf8"));
  assert(parsed.other?.stay === true, "merge must keep sibling keys");
  assert(parsed.mcpServers?.["keep-me"]?.command === "echo", "merge must keep existing servers");
  assert(parsed.mcpServers?.spellcast?.url === "http://127.0.0.1:47194/mcp", "merge must add the key");
  rmSync(home, { recursive: true, force: true });
}

{
  assert(detectConfigFormat(Buffer.from(INCIDENT_CURSOR_MCP_JSON)) === "json", "incident payload is JSON");
  assert(detectConfigFormat(Buffer.from(SAMPLE_CODEX_CONFIG_TOML)) === "toml", "Codex fixture is TOML");
}

const skipDirs = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  ".cursor",
]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

const allowedMention = [
  join(root, "orbit-core", "src", "config_safety.rs"),
  join(root, "scripts", "lib", "tool-config.mjs"),
  join(root, "scripts", "check-config-safety.mjs"),
  join(root, "README.md"),
  join(root, "HANDOFF.md"),
  join(root, "extensions", "orbit", "README.md"),
  join(root, "extensions", "orbit", "AGENTS.md"),
];

const writeRe =
  /\b(writeFileSync|writeFile|fs::write|File::create|std::fs::write)\b[\s\S]{0,200}(mcpServers|config\.toml|\.codex)/m;
const dumpTomlRe = /mcpServers[\s\S]{0,120}\.toml|\.toml[\s\S]{0,120}mcpServers/;

for (const file of walk(root)) {
  if (!/\.(rs|mjs|js|ts|sh|md)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  if (file.includes(`${sep}orbit-server${sep}`) && /["']\/mcp["']/.test(text)) {
    failures.push(`${file}: orbit-server must not expose /mcp`);
  }
  if (writeRe.test(text) && !allowedMention.includes(file)) {
    failures.push(`${file}: looks like a write of MCP JSON or Codex config`);
  }
  if (dumpTomlRe.test(text) && !allowedMention.includes(file) && !file.endsWith("config_safety.rs")) {
    failures.push(`${file}: looks like dumping mcpServers into a .toml path`);
  }
}

// sanity: fixture file used by tests exists in-repo as documentation
const fixture = join(root, "orbit-core", "tests", "fixtures", "codex-config.toml");
if (existsSync(fixture)) {
  assert(detectConfigFormat(readFileSync(fixture)) === "toml", "in-repo Codex fixture must be TOML");
}

if (failures.length) {
  console.error("config-safety FAILED:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("config-safety OK: Codex TOML is never overwritten; MCP registration stays off.");

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const resources = join(root, "src-tauri", "resources");
const claudeDest = join(resources, "claude-plugin");
const ccguiDest = join(resources, "ccgui-spellcast");
const version = "0.1.1";
// The CC GUI plugin is versioned on its own: it changes (and must be re-installed in CC GUI) without a new Claude plugin.
const guiVersion = "0.1.2";
const statusEndpoint = "http://127.0.0.1:47194/api/observer/status";
const mcpEndpoint = "http://127.0.0.1:47194/mcp";
const guiPermissions = [
  "host:chat", "host:session", "events", "storage", "ui:settings-section",
  "network:127.0.0.1:47194",
];
const requiredSkillFiles = [
  "skills/spellcast/SKILL.md",
  "skills/spellcast/references/asides.md",
  "skills/spellcast/references/canvas.md",
  "skills/spellcast/references/works.md",
  "skills/spellcast/references/feedback.md",
  "skills/spellcast/references/project-records.md",
  "skills/spellcast/references/sigil.md",
  "skills/spellcast/scripts/project-api.mjs",
];

function normalized(path) {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function isWithin(base, path) {
  const rel = relative(normalized(base), normalized(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// A generated root or its validation directory is the only recursive removal target.
function removeGenerated(path, owner) {
  assert([claudeDest, ccguiDest].some(dest => normalized(dest) === normalized(owner)));
  assert(isWithin(owner, path), "removal escaped its exact generated root");
  assert.equal(normalized(realpathSync(resources)), normalized(resources), "resource parent is redirected");
  if (!existsSync(path)) return;
  assert(!lstatSync(owner).isSymbolicLink(), "generated root must not be a symlink");
  assert.equal(normalized(realpathSync(owner)), normalized(owner), "generated root is redirected");
  assert(isWithin(owner, realpathSync(path)), "canonical removal target escaped generated root");
  rmSync(path, { recursive: true, force: true });
}

function walkFiles(base, path = base) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(path, entry.name);
    assert(!entry.isSymbolicLink(), "package sources must not contain symlinks");
    if (entry.isDirectory()) files.push(...walkFiles(base, full));
    else {
      assert(entry.isFile(), "package sources must be regular files");
      files.push(relative(base, full).split(sep).join("/"));
    }
  }
  return files;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonFile(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function copySnapshot(snapshot, dest) {
  for (const [rel, bytes] of snapshot) {
    const path = join(dest, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

function snapshotFiles(relatives) {
  return new Map(relatives.map(rel => {
    const path = join(root, rel);
    assert(lstatSync(path).isFile(), `not a regular package input: ${rel}`);
    return [rel, readFileSync(path)];
  }));
}

function assertSnapshotStillCurrent(snapshot) {
  for (const [rel, bytes] of snapshot) {
    assert(readFileSync(join(root, rel)).equals(bytes), `source changed during packaging: ${rel}; rerun`);
  }
}

function checkNodeSyntax(source, label) {
  const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(checked.status, 0, `${label} syntax failed: ${checked.stderr || checked.error || ""}`);
}

function validateNativeHooks(hooks) {
  assert.deepEqual(Object.keys(hooks).sort(), ["hooks"]);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    assert.equal(hooks.hooks[event].length, 1);
    const group = hooks.hooks[event][0];
    if (event === "SessionStart") assert.equal(group.matcher, "startup|resume|clear|compact");
    else assert(!Object.hasOwn(group, "matcher"));
    assert.equal(group.hooks.length, 1);
    assert.deepEqual(group.hooks[0], {
      type: "command",
      command: "${CLAUDE_PLUGIN_ROOT}/bin/spellcast-hook.exe",
      args: ["--host", "claude", "--endpoint", statusEndpoint],
      timeout: 2,
    });
  }
}

function validateGuiSnapshot(snapshot) {
  const manifest = JSON.parse(snapshot.get("extensions/ccgui-spellcast/manifest.json"));
  assert.equal(manifest.id, "spellcast-canvas-bridge");
  assert.equal(manifest.version, guiVersion);
  assert.equal(manifest.tier, "js");
  // CC GUI protected builds report versions like "1.1.1+protected.3"; older plugin SDKs throw while
  // comparing that against minAppVersion and silently never activate the plugin. The host:chat
  // permission already limits the plugin to CC GUI builds that carry the chat bridge.
  assert.equal(manifest.minAppVersion, undefined, "CC GUI plugin must not declare minAppVersion");
  assert.deepEqual([...manifest.permissions].sort(), [...guiPermissions].sort());
  const source = snapshot.get("extensions/ccgui-spellcast/main.js").toString("utf8");
  assert(/^export default function activate\(ctx\)/.test(source));
  assert(!/^\s*import\b/m.test(source) && !/\bimport\s*\(/.test(source), "CC GUI plugin must stay a single import-free file");
  checkNodeSyntax(source, "CC GUI plugin");
  return manifest;
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false, windowsHide: true, ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeout ?? 180_000);
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} failed (${code ?? signal}): ${stderr || stdout}`));
      else resolveResult({ stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function validatePackagedHelper(hooks) {
  let enabled = true, revision = 1, hits = 0;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/api/observer/status") {
      res.writeHead(404); res.end(); return;
    }
    hits += 1;
    const body = JSON.stringify({ enabled, paused: false, allowed: enabled, reason: enabled ? "ok" : "disabled", policy_revision: revision });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
    res.end(body);
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  const state = join(claudeDest, ".pack-validation");
  try {
    assert.notEqual(port, 47194, "validation must never use the actual observer port");
    mkdirSync(state);
    const handler = hooks.hooks.SessionStart[0].hooks[0];
    const executable = handler.command.replace("${CLAUDE_PLUGIN_ROOT}", claudeDest);
    const args = [...handler.args];
    args[args.indexOf("--endpoint") + 1] = `http://127.0.0.1:${port}/api/observer/status`;
    args.push("--state-dir", state, "--timeout-ms", "500");
    const env = { ...process.env };
    for (const key of ["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_DATA", "SPELLCAST_HOOK_ENDPOINT", "SPELLCAST_HOOK_STATE_DIR", "SPELLCAST_HOOK_DIAG_STALL_MS"]) delete env[key];
    env.CLAUDE_PLUGIN_ROOT = claudeDest;
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const source = `claude:${uuid}`;
    const startup = { hook_event_name: "SessionStart", session_id: uuid, source: "startup" };
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: uuid };
    async function hook(input) {
      const output = await runProcess(executable, args, { input: JSON.stringify(input), env, timeout: 5_000 });
      assert.equal(output.stderr, "");
      return output.stdout;
    }
    function checkBootstrap(output) {
      const context = JSON.parse(output).hookSpecificOutput.additionalContext;
      assert(context.startsWith(readFileSync(join(claudeDest, "hooks/observer-bootstrap.txt"), "utf8").trim()));
      const id = context.split("\n").find(line => line.startsWith("SPELLCAST_SOURCE_ID="));
      assert.equal(JSON.parse(id.slice("SPELLCAST_SOURCE_ID=".length)), source);
      assert(!context.includes("CLAUDE_OBSERVER_RUNNER_PATH"));
      assert(!context.includes("Claude 宿主的 provider 边界"));
      assert(context.includes('只有 status="ready" 且 brief.provider=codex'));
      assert(context.includes('spellcast_checkpoint 返回 status="scheduled"，不向宿主暴露 brief'));
    }
    checkBootstrap(await hook(startup));
    assert.equal(await hook(prompt), "");
    checkBootstrap(await hook({ ...startup, source: "resume", provider: "codex" }));
    const beforeSkip = hits;
    assert.equal(await hook({ ...startup, session_id: "\"\nPRIVATE-INVALID-ID" }), "");
    assert.equal(await hook({ ...startup, agent_id: "PRIVATE-CHILD-ID" }), "");
    assert.equal(hits, beforeSkip);
    enabled = false; revision = 2;
    const stopped = JSON.parse(await hook(prompt)).hookSpecificOutput.additionalContext;
    assert.equal(stopped, readFileSync(join(claudeDest, "hooks/observer-stop.txt"), "utf8").trim());
    const diag = readFileSync(join(state, "diag.jsonl"), "utf8");
    for (const secret of [uuid, source, "PRIVATE-INVALID-ID", "PRIVATE-CHILD-ID", root]) assert(!diag.includes(secret));
    return { isolated_loopback: true, checks: ["canonical_origin", "app_managed_claude", "no_host_runner_injection", "codex_child_only", "repeat_suppression", "resume", "invalid_uuid", "child_skip", "stop", "diagnostic_privacy"] };
  } finally {
    await new Promise(done => server.close(done));
    removeGenerated(state, claudeDest);
  }
}

function writeIntegrity(dest) {
  const files = {};
  for (const rel of walkFiles(dest).filter(rel => rel !== "integrity.json")) files[rel] = digest(readFileSync(join(dest, rel)));
  jsonFile(join(dest, "integrity.json"), { algorithm: "sha256", files });
  for (const [rel, expected] of Object.entries(files)) assert.equal(digest(readFileSync(join(dest, rel))), expected);
  return Object.keys(files).length;
}

async function main() {
  assert.equal(process.platform, "win32", "this package requires the native Windows helper build");
  assert.equal(process.argv.length, 2, "packaging accepts no destination or configuration overrides");
  assert(existsSync(resources), "resource parent must already exist");
  assert.equal(normalized(realpathSync(resources)), normalized(resources), "resource parent is redirected");
  const skillFiles = walkFiles(join(root, "skills", "spellcast")).map(rel => `skills/spellcast/${rel}`);
  for (const rel of requiredSkillFiles) assert(skillFiles.includes(rel), `missing skill input ${rel}`);
  const nativeSnapshot = snapshotFiles([
    "hooks/claude-hooks.json", "hooks/claude-observer-runner.mjs",
    "hooks/observer-bootstrap.txt", "hooks/observer-stop.txt", ".mcp.json", "LICENSE", ...skillFiles,
  ]);
  const guiSnapshot = snapshotFiles(["extensions/ccgui-spellcast/manifest.json", "extensions/ccgui-spellcast/main.js", "extensions/ccgui-spellcast/README.md"]);
  const hooks = JSON.parse(nativeSnapshot.get("hooks/claude-hooks.json"));
  validateNativeHooks(hooks);
  assert.deepEqual(JSON.parse(nativeSnapshot.get(".mcp.json")), { mcpServers: { spellcast: { type: "http", url: mcpEndpoint } } });
  checkNodeSyntax(nativeSnapshot.get("hooks/claude-observer-runner.mjs"), "packaged observer runner");
  const guiManifest = validateGuiSnapshot(guiSnapshot);
  await runProcess(process.execPath, [join(root, "scripts/check-ccgui-spellcast-plugin.mjs")], { timeout: 30_000 });
  console.log("CC GUI source version, permissions, syntax and simulated SDK checks passed");
  await runProcess("cargo", ["build", "--release", "-p", "spellcast-hook"], { timeout: 240_000 });
  const releaseHelper = join(root, "target", "release", "spellcast-hook.exe");
  assert(lstatSync(releaseHelper).isFile(), "native release helper was not built");
  assertSnapshotStillCurrent(nativeSnapshot);
  assertSnapshotStillCurrent(guiSnapshot);
  const mappedNative = new Map([...nativeSnapshot].map(([rel, bytes]) => [rel === "hooks/claude-hooks.json" ? "hooks/hooks.json" : rel, bytes]));
  removeGenerated(claudeDest, claudeDest);
  mkdirSync(claudeDest);
  copySnapshot(mappedNative, claudeDest);
  mkdirSync(join(claudeDest, "bin"));
  copyFileSync(releaseHelper, join(claudeDest, "bin/spellcast-hook.exe"));
  mkdirSync(join(claudeDest, ".claude-plugin"));
  jsonFile(join(claudeDest, ".claude-plugin/plugin.json"), {
    name: "spellcast", version, description: "Native Spellcast checkpoints and Canvas for the original Claude conversation",
  });
  assert(!existsSync(join(claudeDest, ".codex-plugin")), "Codex plugin metadata must not be packaged");
  validateNativeHooks(JSON.parse(readFileSync(join(claudeDest, "hooks/hooks.json"), "utf8")));
  const validation = await validatePackagedHelper(hooks);
  jsonFile(join(claudeDest, "package-meta.json"), {
    name: "spellcast", version, host: "claude", platform: "windows",
    helper: "bin/spellcast-hook.exe", built_at: new Date().toISOString(), validation,
  });
  const nativeCount = writeIntegrity(claudeDest);
  assertSnapshotStillCurrent(guiSnapshot);
  removeGenerated(ccguiDest, ccguiDest);
  mkdirSync(ccguiDest);
  copySnapshot(new Map([...guiSnapshot].map(([rel, bytes]) => [rel.slice("extensions/ccgui-spellcast/".length), bytes])), ccguiDest);
  jsonFile(join(ccguiDest, "package-meta.json"), {
    name: guiManifest.id, version: guiManifest.version, platform: "ccgui-desktop",
    built_at: new Date().toISOString(),
    validation: { version: true, permissions: true, single_file_syntax: true, simulated_sdk: true },
  });
  const guiCount = writeIntegrity(ccguiDest);
  console.log(JSON.stringify({ claude: { path: claudeDest, files: nativeCount }, ccgui: { path: ccguiDest, files: guiCount }, validation }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

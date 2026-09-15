import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import {
  assertPackagedHelperStdout,
  assertSafeDest,
  assertSkillReferencesMatch,
  assertWindowsShellOnOff,
  findMissingRequired,
  LEGACY_WINDOWS_COMMAND_WINDOWS,
  parsePowerShellCommand,
  REQUIRED_RELATIVE,
  REQUIRED_SKILL_REFS,
  sha256Text,
  windowsCommandWindows,
} from "./package-codex-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/package-codex-plugin.mjs");
const art = join(root, "artifacts/spellcast-observer-hooks-20260911");
mkdirSync(art, { recursive: true });

function uniqueOut() {
  return join(art, `pkg-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
}

function run(out, extra = []) {
  return spawnSync(process.execPath, [script, "--out", out, ...extra], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const occupied = uniqueOut();
mkdirSync(join(occupied, "spellcast"), { recursive: true });
const payload = "do-not-touch-" + Date.now();
writeFileSync(join(occupied, "spellcast", "keep-me.txt"), payload);
const blocked = run(occupied);
if (blocked.status === 0) fail("expected non-empty dest to fail");
if (!String(blocked.stderr).includes("non-empty")) fail("expected non-empty refusal: " + blocked.stderr);
if (readFileSync(join(occupied, "spellcast", "keep-me.txt"), "utf8") !== payload) fail("occupied dest was mutated");

const ancestor = run(resolve(root, ".."));
if (ancestor.status === 0) fail("expected ancestor dest to fail");

const badPortDir = uniqueOut();
const badPort = run(badPortDir, ["--port", "nope"]);
if (badPort.status === 0) fail("expected invalid port to fail");
if (existsSync(join(badPortDir, "spellcast", ".codex-plugin"))) fail("invalid port created a package");

const fixture = uniqueOut();
mkdirSync(fixture, { recursive: true });
const missing = findMissingRequired(fixture);
if (missing.length !== REQUIRED_RELATIVE.length) fail("isolated fixture should miss every required input");

const dirRefSource = uniqueOut();
for (const rel of REQUIRED_RELATIVE) {
  const target = join(dirRefSource, rel);
  mkdirSync(dirname(target), { recursive: true });
  if (rel === REQUIRED_SKILL_REFS[0]) {
    mkdirSync(target, { recursive: true });
  } else {
    writeFileSync(target, "fixture\n");
  }
}
const dirMissing = findMissingRequired(dirRefSource);
if (!dirMissing.includes(REQUIRED_SKILL_REFS[0])) {
  fail("directory required ref should be rejected: " + JSON.stringify(dirMissing));
}
const dirRefOut = uniqueOut();
const dirRefPack = run(dirRefOut, ["--source", dirRefSource, "--port", "47203"]);
if (dirRefPack.status === 0) fail("expected directory required ref pack to fail");
if (!String(dirRefPack.stderr).includes("not a regular file")) {
  fail("expected regular-file refusal: " + dirRefPack.stderr);
}
if (existsSync(join(dirRefOut, "spellcast", "skills", "spellcast", "SKILL.md"))) {
  fail("SKILL root published despite directory required ref");
}

const mixedSrc = uniqueOut();
for (const rel of REQUIRED_RELATIVE) {
  const target = join(mixedSrc, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, rel), target);
}
writeFileSync(join(mixedSrc, "hooks/observer-bootstrap.txt"), "CHANGED-BOOTSTRAP-MUST-NOT-PACK\n");
const mixedOut = uniqueOut();
const mixedPack = run(mixedOut, ["--source", mixedSrc, "--port", "47204"]);
if (mixedPack.status === 0) fail("expected mixed hook texts to fail");
if (!String(mixedPack.stderr).includes("mixed hook")) {
  fail("expected mixed-hook refusal: " + mixedPack.stderr);
}
if (existsSync(join(mixedOut, "spellcast", "skills", "spellcast", "SKILL.md"))) {
  fail("SKILL root published despite mixed hook texts");
}

try {
  assertSafeDest(root, join(occupied, "spellcast"), occupied);
  fail("assertSafeDest should throw for occupied dest");
} catch (err) {
  if (!(err instanceof Error) || !err.message.includes("non-empty")) fail(String(err));
}

function assertPackage(dest, port) {
  const required = [
    ".codex-plugin/plugin.json",
    "hooks/observer-bootstrap.txt",
    "hooks/observer-stop.txt",
    "hooks/hooks.json",
    "INSTALL.md",
    "LICENSE",
    "skills/spellcast/SKILL.md",
    "skills/spellcast/references/asides.md",
    "skills/spellcast/references/canvas.md",
    "skills/spellcast/references/works.md",
    "skills/spellcast/references/feedback.md",
    "package-meta.json",
    process.platform === "win32" ? "bin/spellcast-hook.exe" : "bin/spellcast-hook",
  ];
  for (const rel of required) {
    if (!existsSync(join(dest, rel))) fail(`package missing ${rel}`);
  }
  const hooks = readFileSync(join(dest, "hooks/hooks.json"), "utf8");
  const mcp = readFileSync(join(dest, ".mcp.json"), "utf8");
  if (!hooks.includes(`127.0.0.1:${port}/api/observer/status`)) fail("hook endpoint mismatch");
  if (!mcp.includes(`127.0.0.1:${port}/mcp`)) fail("mcp endpoint mismatch");
  if (hooks.includes("Administrator") || mcp.includes("VibeProj")) fail("hardcoded machine path");
  const hooksJson = JSON.parse(hooks);
  const winCmd = hooksJson.hooks.SessionStart[0].hooks[0].commandWindows;
  const posixCmd = hooksJson.hooks.SessionStart[0].hooks[0].command;
  const promptWin = hooksJson.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  if (winCmd !== windowsCommandWindows(`http://127.0.0.1:${port}/api/observer/status`)) {
    fail("commandWindows is not the powershell launcher for this port");
  }
  if (promptWin !== winCmd) fail("SessionStart/UserPromptSubmit commandWindows differ");
  if (posixCmd !== `"\${PLUGIN_ROOT}/bin/spellcast-hook" --endpoint http://127.0.0.1:${port}/api/observer/status`) {
    fail("POSIX command changed");
  }
  if (hooksJson.hooks.SessionStart[0].matcher !== "startup|resume|clear|compact") fail("matcher changed");
  if (hooksJson.hooks.SessionStart[0].hooks[0].timeout !== 2) fail("timeout changed");
  if (winCmd.includes("${")) fail("commandWindows interpolates ${PLUGIN_ROOT}");
  if (!winCmd.includes("Join-Path") || !winCmd.startsWith("powershell.exe")) {
    fail("commandWindows is not the powershell.exe launcher");
  }
  try {
    assertSkillReferencesMatch(root, dest);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const legacyParse = parsePowerShellCommand(LEGACY_WINDOWS_COMMAND_WINDOWS);
if (legacyParse.ok) fail("legacy commandWindows should fail PowerShell parse");
if (!/UnexpectedToken|OperatorRequiresVariableOrProperty|endpoint/i.test(legacyParse.out + legacyParse.err)) {
  fail("legacy parse errors missing: " + JSON.stringify(legacyParse));
}
writeFileSync(
  join(art, `legacy-parse-${Date.now()}.json`),
  JSON.stringify({ command: LEGACY_WINDOWS_COMMAND_WINDOWS, ...legacyParse }, null, 2) + "\n",
);

const firstOut = uniqueOut();
const first = run(firstOut, ["--port", "47201"]);
if (first.status !== 0) fail("first unique pack failed: " + first.stderr + first.stdout);
assertPackage(join(firstOut, "spellcast"), "47201");
try {
  const helperCmp = assertPackagedHelperStdout(join(firstOut, "spellcast"));
  writeFileSync(join(firstOut, "helper-stdout-compare.json"), JSON.stringify(helperCmp, null, 2) + "\n");
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const dest = join(firstOut, "spellcast");
const spacedRoot = mkdtempSync(join(tmpdir(), "spellcast PLUGIN's root "));
mkdirSync(join(spacedRoot, "bin"), { recursive: true });
copyFileSync(
  join(dest, process.platform === "win32" ? "bin/spellcast-hook.exe" : "bin/spellcast-hook"),
  join(spacedRoot, process.platform === "win32" ? "bin/spellcast-hook.exe" : "bin/spellcast-hook"),
);
try {
  const shellCmp = assertWindowsShellOnOff({
    pluginRoot: spacedRoot,
    bootstrap: readFileSync(join(dest, "hooks/observer-bootstrap.txt"), "utf8").trim(),
    stop: readFileSync(join(dest, "hooks/observer-stop.txt"), "utf8").trim(),
  });
  if (shellCmp.powershellMs > 2000 || shellCmp.cmdMs > 2000) {
    fail(`shell launcher exceeded 2s timeout budget: ps=${shellCmp.powershellMs} cmd=${shellCmp.cmdMs}`);
  }
  writeFileSync(join(firstOut, "windows-shell-onoff.json"), JSON.stringify(shellCmp, null, 2) + "\n");
  const packedWin = JSON.parse(readFileSync(join(dest, "hooks/hooks.json"), "utf8")).hooks
    .SessionStart[0].hooks[0].commandWindows;
  writeFileSync(
    join(firstOut, "command-hash.json"),
    JSON.stringify(
      {
        legacy: LEGACY_WINDOWS_COMMAND_WINDOWS,
        legacySha256: sha256Text(LEGACY_WINDOWS_COMMAND_WINDOWS),
        packed: packedWin,
        packedSha256: sha256Text(packedWin),
      },
      null,
      2,
    ) + "\n",
  );
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const bootPath = join(firstOut, "spellcast", "hooks", "observer-bootstrap.txt");
const origBoot = readFileSync(bootPath);
writeFileSync(bootPath, Buffer.concat([origBoot, Buffer.from("\nTAMPERED-PACKAGED-TEXT\n")]));
let tamperThrew = false;
try {
  assertPackagedHelperStdout(join(firstOut, "spellcast"));
} catch (err) {
  tamperThrew = true;
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("does not match")) {
    writeFileSync(bootPath, origBoot);
    fail("tampered packaged text should fail helper-vs-text compare: " + message);
  }
}
writeFileSync(bootPath, origBoot);
if (!tamperThrew) fail("expected helper vs tampered packaged text to be rejected");
writeFileSync(join(firstOut, "helper-tamper-negative.json"), JSON.stringify({ rejected: true }, null, 2) + "\n");

const secondOut = uniqueOut();
const second = run(secondOut, ["--port", "47202"]);
if (second.status !== 0) fail("second unique pack failed: " + second.stderr + second.stdout);
assertPackage(join(secondOut, "spellcast"), "47202");

console.log("package checks ok");

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

export const HOOK_TEXT_RELS = [
  "hooks/observer-bootstrap.txt",
  "hooks/observer-stop.txt",
];

export const REQUIRED_SKILL_REFS = [
  "skills/spellcast/references/asides.md",
  "skills/spellcast/references/canvas.md",
  "skills/spellcast/references/works.md",
  "skills/spellcast/references/feedback.md",
];

export const REQUIRED_RELATIVE = [
  ".codex-plugin/plugin.json",
  "hooks/observer-bootstrap.txt",
  "hooks/observer-stop.txt",
  "hooks/INSTALL.md",
  "skills/spellcast/SKILL.md",
  ...REQUIRED_SKILL_REFS,
  "LICENSE",
];

function isRegularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findMissingRequired(sourceRoot) {
  return REQUIRED_RELATIVE.filter((rel) => !isRegularFile(join(sourceRoot, rel)));
}

export function assertHookTextsMatchHelperTree(sourceRoot, repoRoot) {
  for (const rel of HOOK_TEXT_RELS) {
    const fromSource = join(sourceRoot, rel);
    const fromRepo = join(repoRoot, rel);
    if (!isRegularFile(fromSource) || !isRegularFile(fromRepo)) {
      throw new Error(`missing hook text ${rel}`);
    }
    const a = readFileSync(fromSource);
    const b = readFileSync(fromRepo);
    if (a.length !== b.length || !a.equals(b)) {
      throw new Error(
        `refusing mixed hook package: ${rel} at --source differs from the helper source tree (include_str is built from the repo)`,
      );
    }
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Legacy commandWindows that PowerShell -Command cannot parse. */
export const LEGACY_WINDOWS_COMMAND_WINDOWS =
  `"\${PLUGIN_ROOT}/bin/spellcast-hook.exe" --endpoint http://127.0.0.1:47194/api/observer/status`;

/**
 * One commandWindows string that Codex runs through the user shell.
 * PowerShell: powershell -NoProfile -Command <this>
 * cmd: cmd /d /s /c with an extra quoted wrap (hook_runner raw_arg).
 * No $ interpolation in the outer string; PLUGIN_ROOT is read inside the inner powershell.
 */
export function windowsCommandWindows(statusUrl) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/observer\/status$/.test(statusUrl)) {
    throw new Error(`refusing non-loopback hook url ${statusUrl}`);
  }
  return `powershell.exe -NoProfile -NonInteractive -Command "& (Join-Path ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) 'bin/spellcast-hook.exe') --endpoint '${statusUrl}'"`;
}

export function parsePowerShellCommand(command) {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Management.Automation; $err=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Environment]::GetEnvironmentVariable('SPELLCAST_PARSE_CMD'), [ref]$null, [ref]$err); if($err -and $err.Count){ $err | ForEach-Object { $_.ToString() } } else { 'PARSE_OK' }",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, SPELLCAST_PARSE_CMD: command },
    },
  );
  const out = (r.stdout || "").trim();
  return { exit: r.status ?? 1, out, err: r.stderr || "", ok: out === "PARSE_OK" };
}

function shellEnv(pluginRoot, stateDir) {
  const env = { ...process.env };
  delete env.SPELLCAST_HOOK_ENDPOINT;
  delete env.SPELLCAST_HOOK_STATE_DIR;
  delete env.CLAUDE_PLUGIN_DATA;
  env.PLUGIN_ROOT = pluginRoot;
  env.PLUGIN_DATA = stateDir;
  return env;
}

function spawnShell(kind, commandWindows, { input, env }) {
  const t0 = Date.now();
  const r =
    kind === "powershell"
      ? spawnSync("powershell.exe", ["-NoProfile", "-Command", commandWindows], {
          input,
          encoding: "utf8",
          windowsHide: true,
          timeout: 8000,
          env,
        })
      : spawnSync("cmd.exe", ["/d", "/s", "/c", `"${commandWindows}"`], {
          input,
          encoding: "utf8",
          windowsHide: true,
          timeout: 8000,
          env,
          windowsVerbatimArguments: true,
        });
  return {
    kind,
    exit: r.status ?? 1,
    ms: Date.now() - t0,
    out: r.stdout || "",
    err: r.stderr || "",
    error: r.error ? String(r.error) : null,
  };
}

function startIsolatedMock(onStatus, offStatus) {
  const mockDir = mkdtempSync(join(tmpdir(), "spellcast-hook-mock-"));
  const readyFile = join(mockDir, `ready-${randomBytes(8).toString("hex")}.txt`);
  const hitsFile = join(mockDir, "hits.jsonl");
  const bodyFile = join(mockDir, "body.json");
  writeFileSync(bodyFile, JSON.stringify(onStatus));
  const serverProc = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const readyFile = ${JSON.stringify(readyFile)};
const hitsFile = ${JSON.stringify(hitsFile)};
const bodyFile = ${JSON.stringify(bodyFile)};
const server = createServer((req, res) => {
  appendFileSync(hitsFile, JSON.stringify({ ts: Date.now(), method: req.method, url: req.url }) + "\\n");
  let body = "{}";
  try { body = readFileSync(bodyFile, "utf8"); } catch {}
  res.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(readyFile, String(server.address().port));
});
`,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const deadline = Date.now() + 5000;
  while (!existsSync(readyFile) && Date.now() < deadline) sleepMs(20);
  if (!existsSync(readyFile)) {
    try {
      if (serverProc.pid) serverProc.kill();
    } catch {}
    throw new Error("loopback mock did not start");
  }
  const port = readFileSync(readyFile, "utf8").trim();
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) === 47194) {
    try {
      if (serverProc.pid) serverProc.kill();
    } catch {}
    throw new Error(`refusing mock port ${port}`);
  }
  return {
    port,
    endpoint: `http://127.0.0.1:${port}/api/observer/status`,
    setOff() {
      writeFileSync(bodyFile, JSON.stringify(offStatus));
    },
    hits() {
      if (!existsSync(hitsFile)) return [];
      return readFileSync(hitsFile, "utf8")
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    close() {
      try {
        if (serverProc.pid) serverProc.kill();
      } catch {}
      try {
        rmSync(mockDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function expectHook(out, label, eventName, expectedText) {
  if (!out || !out.trim()) throw new Error(`${label} empty stdout`);
  const parsed = parseHookStdout(out, label);
  if (parsed.hookEventName !== eventName) {
    throw new Error(`${label} hookEventName=${parsed.hookEventName}`);
  }
  if (parsed.additionalContext !== expectedText) {
    throw new Error(`${label} stdout text does not match packaged hook text`);
  }
  return parsed;
}

/**
 * Codex-shaped shells against one isolated mock: PowerShell SessionStart ON,
 * then cmd UserPromptSubmit OFF. PLUGIN_ROOT may contain spaces/apostrophes.
 */
export function assertWindowsShellOnOff({ pluginRoot, bootstrap, stop }) {
  const dataDir = mkdtempSync(join(tmpdir(), "spellcast-hook-shell-data-"));
  const env = shellEnv(pluginRoot, dataDir);
  const start = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "shell-check-sess",
    source: "startup",
  });
  const prompt = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "shell-check-sess",
  });
  const mock = startIsolatedMock(
    { enabled: true, paused: false, allowed: true, reason: "ok", policy_revision: 1 },
    { enabled: false, paused: false, allowed: false, reason: "disabled", policy_revision: 2 },
  );
  try {
    const cmd = windowsCommandWindows(mock.endpoint);
    if (cmd.includes("47194")) throw new Error("constructed mock command used 47194");
    if (cmd.includes("${")) throw new Error("commandWindows contains ${ interpolation");
    const first = spawnShell("powershell", cmd, { input: start, env });
    if (first.exit !== 0) throw new Error(`powershell ON exit ${first.exit} err=${first.err}`);
    if (first.err && first.err.trim()) throw new Error(`powershell ON stderr: ${first.err}`);
    expectHook(first.out, "powershell ON", "SessionStart", bootstrap);
    mock.setOff();
    const second = spawnShell("cmd", cmd, { input: prompt, env });
    if (second.exit !== 0) throw new Error(`cmd OFF exit ${second.exit} err=${second.err}`);
    if (second.err && second.err.trim()) throw new Error(`cmd OFF stderr: ${second.err}`);
    expectHook(second.out, "cmd OFF", "UserPromptSubmit", stop);
    const hits = mock.hits();
    if (hits.length < 2) throw new Error(`expected ON and OFF HTTP hits, got ${hits.length}`);
    const diagDir = join(dataDir, "spellcast-hook");
    const offDiag = lastDiag(diagDir, "UserPromptSubmit");
    if (offDiag.http !== "ok") throw new Error(`OFF path http=${offDiag.http}`);
    const onDiag = lastDiag(diagDir, "SessionStart");
    if (onDiag.http !== "ok") throw new Error(`ON path http=${onDiag.http}`);
    return {
      mockPort: mock.port,
      hits: hits.length,
      powershellMs: first.ms,
      cmdMs: second.ms,
      onEvent: "SessionStart",
      offEvent: "UserPromptSubmit",
      onHttp: onDiag.http,
      offHttp: offDiag.http,
      commandWindows: cmd,
      pluginRoot,
    };
  } finally {
    mock.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
}

function sleepMs(ms) {
  spawnSync(process.execPath, ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`], {
    windowsHide: true,
  });
}

function helperEnv() {
  const env = { ...process.env };
  delete env.PLUGIN_DATA;
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.SPELLCAST_HOOK_STATE_DIR;
  delete env.SPELLCAST_HOOK_ENDPOINT;
  return env;
}

function runHelper(exe, endpoint, stateDir, stdin) {
  return spawnSync(
    exe,
    ["--endpoint", endpoint, "--state-dir", stateDir, "--timeout-ms", "400"],
    { input: stdin, encoding: "utf8", timeout: 8000, windowsHide: true, env: helperEnv() },
  );
}

function parseHookStdout(out, label) {
  let value;
  try {
    value = JSON.parse(out);
  } catch (err) {
    throw new Error(`${label} stdout is not JSON: ${String(err)} out=${JSON.stringify(out)}`);
  }
  const spec = value?.hookSpecificOutput;
  if (!spec || typeof spec !== "object") {
    throw new Error(`${label} missing hookSpecificOutput`);
  }
  return {
    hookEventName: spec.hookEventName,
    additionalContext: String(spec.additionalContext ?? "").trim(),
  };
}

function lastDiag(stateDir, eventName) {
  const path = join(stateDir, "diag.jsonl");
  if (!existsSync(path)) throw new Error(`missing diag.jsonl for ${eventName}`);
  const lines = readFileSync(path, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const hit = [...lines].reverse().find((row) => row.event === eventName);
  if (!hit) throw new Error(`diag missing event ${eventName}`);
  return hit;
}

/**
 * One isolated loopback server for ON SessionStart then OFF UserPromptSubmit.
 * Unique ready file (never reused, never production 47194). Hits recorded.
 * Server process is stopped in finally.
 */
export function runIsolatedOnOff({ exe, stateDir, onStatus, offStatus, startStdin, promptStdin }) {
  mkdirSync(stateDir, { recursive: true });
  const mockDir = mkdtempSync(join(tmpdir(), "spellcast-hook-mock-"));
  const readyFile = join(mockDir, `ready-${randomBytes(8).toString("hex")}.txt`);
  const hitsFile = join(mockDir, "hits.jsonl");
  const bodyFile = join(mockDir, "body.json");
  writeFileSync(bodyFile, JSON.stringify(onStatus));
  const serverProc = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const readyFile = ${JSON.stringify(readyFile)};
const hitsFile = ${JSON.stringify(hitsFile)};
const bodyFile = ${JSON.stringify(bodyFile)};
const server = createServer((req, res) => {
  appendFileSync(hitsFile, JSON.stringify({ ts: Date.now(), method: req.method, url: req.url }) + "\\n");
  let body = "{}";
  try { body = readFileSync(bodyFile, "utf8"); } catch {}
  res.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(readyFile, String(server.address().port));
});
`,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile) && Date.now() < deadline) sleepMs(20);
    if (!existsSync(readyFile)) {
      throw new Error("loopback mock did not start");
    }
    const port = readFileSync(readyFile, "utf8").trim();
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) === 47194) {
      throw new Error(`refusing mock port ${port}`);
    }
    const endpoint = `http://127.0.0.1:${port}/api/observer/status`;
    const firstRaw = runHelper(exe, endpoint, stateDir, startStdin);
    writeFileSync(bodyFile, JSON.stringify(offStatus));
    const secondRaw = runHelper(exe, endpoint, stateDir, promptStdin);
    const hits = existsSync(hitsFile)
      ? readFileSync(hitsFile, "utf8").split(/\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return {
      port,
      hits,
      first: { code: firstRaw.status ?? 1, out: firstRaw.stdout || "", err: firstRaw.stderr || "" },
      second: { code: secondRaw.status ?? 1, out: secondRaw.stdout || "", err: secondRaw.stderr || "" },
    };
  } finally {
    try {
      if (serverProc.pid) serverProc.kill();
    } catch {
      // ignore
    }
    try {
      rmSync(mockDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function assertPackagedHelperStdout(dest) {
  const exeName = process.platform === "win32" ? "spellcast-hook.exe" : "spellcast-hook";
  const exe = join(dest, "bin", exeName);
  const bootstrap = readFileSync(join(dest, "hooks/observer-bootstrap.txt"), "utf8").trim();
  const stop = readFileSync(join(dest, "hooks/observer-stop.txt"), "utf8").trim();
  const stateDir = mkdtempSync(join(tmpdir(), "spellcast-hook-pkg-"));
  try {
    const start = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "pkg-check-sess",
      source: "startup",
    });
    const prompt = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "pkg-check-sess",
    });
    const on = {
      enabled: true,
      paused: false,
      allowed: true,
      reason: "ok",
      policy_revision: 1,
    };
    const off = {
      enabled: false,
      paused: false,
      allowed: false,
      reason: "disabled",
      policy_revision: 2,
    };
    const result = runIsolatedOnOff({
      exe,
      stateDir,
      onStatus: on,
      offStatus: off,
      startStdin: start,
      promptStdin: prompt,
    });
    if (result.first.code !== 0) {
      throw new Error(`helper exit ${result.first.code} err=${result.first.err}`);
    }
    if (result.first.err && result.first.err.trim()) {
      throw new Error(`helper stderr: ${result.first.err}`);
    }
    if (result.second.code !== 0) {
      throw new Error(`helper stop exit ${result.second.code} err=${result.second.err}`);
    }
    if (result.second.err && result.second.err.trim()) {
      throw new Error(`helper stop stderr: ${result.second.err}`);
    }
    const boot = parseHookStdout(result.first.out, "ON SessionStart");
    if (boot.hookEventName !== "SessionStart") {
      throw new Error(`ON hookEventName=${boot.hookEventName}`);
    }
    if (boot.additionalContext !== bootstrap) {
      throw new Error("packaged helper stdout bootstrap does not match packaged observer-bootstrap.txt");
    }
    const halt = parseHookStdout(result.second.out, "OFF UserPromptSubmit");
    if (halt.hookEventName !== "UserPromptSubmit") {
      throw new Error(`OFF hookEventName=${halt.hookEventName}`);
    }
    if (halt.additionalContext !== stop) {
      throw new Error("packaged helper stdout stop does not match packaged observer-stop.txt");
    }
    if (result.hits.length < 2) {
      throw new Error(`expected ON and OFF HTTP hits, got ${result.hits.length}`);
    }
    const offDiag = lastDiag(stateDir, "UserPromptSubmit");
    if (offDiag.http !== "ok") {
      throw new Error(`OFF path http=${offDiag.http} (must be ok, not unavailable/transport)`);
    }
    if (offDiag.action !== "stop") {
      throw new Error(`OFF path action=${offDiag.action}`);
    }
    const onDiag = lastDiag(stateDir, "SessionStart");
    if (onDiag.http !== "ok") {
      throw new Error(`ON path http=${onDiag.http}`);
    }
    return {
      helperSha256: sha256File(exe),
      bootstrapSha256: sha256File(join(dest, "hooks/observer-bootstrap.txt")),
      stopSha256: sha256File(join(dest, "hooks/observer-stop.txt")),
      firstStdout: result.first.out,
      secondStdout: result.second.out,
      hits: result.hits.length,
      mockPort: result.port,
      onHttp: onDiag.http,
      offHttp: offDiag.http,
      onEvent: boot.hookEventName,
      offEvent: halt.hookEventName,
    };
  } finally {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function listSkillReferenceRels(sourceRoot) {
  const dir = join(sourceRoot, "skills/spellcast/references");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => `skills/spellcast/references/${name}`);
}

export function assertSkillReferencesMatch(sourceRoot, destRoot) {
  const rels = listSkillReferenceRels(sourceRoot);
  if (!rels.length) throw new Error("source skill references are missing");
  for (const rel of rels) {
    const from = join(sourceRoot, rel);
    const to = join(destRoot, rel);
    if (!existsSync(to)) throw new Error(`package missing ${rel}`);
    const src = readFileSync(from);
    const dst = readFileSync(to);
    if (src.length !== dst.length || !src.equals(dst)) {
      throw new Error(`package byte mismatch ${rel}`);
    }
  }
}

export function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

export function assertSafeDest(repoRoot, dest, outRoot) {
  if (dest === repoRoot || isInside(repoRoot, dest)) {
    throw new Error("refusing to write into the source tree or an ancestor of it");
  }
  const artifactsRoot = join(repoRoot, "artifacts");
  if (isInside(dest, repoRoot) && !isInside(dest, artifactsRoot)) {
    throw new Error("plugin output inside the repo must stay under artifacts/");
  }
  if (existsSync(dest)) {
    const entries = readdirSync(dest);
    if (entries.length > 0) throw new Error(`refusing non-empty output: ${dest}`);
  }
  const metaAtRoot = join(outRoot, "package-meta.json");
  if (existsSync(metaAtRoot)) {
    throw new Error(`refusing to overwrite existing ${metaAtRoot}`);
  }
}

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function copyRequired(from, to, label) {
  if (!isRegularFile(from)) die(`required ${label} is not a regular file: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  function flag(name) {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) return null;
    return args[index + 1];
  }

  const portRaw = flag("--port") ?? process.env.SPELLCAST_PACKAGE_PORT ?? "47194";
  if (!/^\d+$/.test(portRaw)) die("invalid --port");
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die("invalid --port");

  const sourceRoot = resolve(flag("--source") ?? repoRoot);
  const defaultOut = join(repoRoot, "artifacts/spellcast-observer-hooks-20260911/phase-c2-package");
  const outRoot = resolve(flag("--out") ?? defaultOut);
  const dest = join(outRoot, "spellcast");

  try {
    assertSafeDest(repoRoot, dest, outRoot);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const missing = findMissingRequired(sourceRoot);
  if (missing.length) die(`missing or not a regular file: ${missing.join(", ")}`);
  try {
    assertHookTextsMatchHelperTree(sourceRoot, repoRoot);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const statusUrl = `http://127.0.0.1:${port}/api/observer/status`;

  const builtResult = spawnSync("cargo", ["build", "-p", "spellcast-hook", "--release"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (builtResult.status !== 0) process.exit(builtResult.status ?? 1);

  const exeName = process.platform === "win32" ? "spellcast-hook.exe" : "spellcast-hook";
  const built = join(repoRoot, "target/release", exeName);
  if (!existsSync(built)) die(`missing release helper ${built}`);

  for (const dir of [
    dest,
    join(dest, ".codex-plugin"),
    join(dest, "hooks"),
    join(dest, "skills", "spellcast", "references"),
    join(dest, "bin"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  copyRequired(join(sourceRoot, ".codex-plugin/plugin.json"), join(dest, ".codex-plugin/plugin.json"), "plugin manifest");
  copyRequired(join(sourceRoot, "hooks/observer-bootstrap.txt"), join(dest, "hooks/observer-bootstrap.txt"), "bootstrap text");
  copyRequired(join(sourceRoot, "hooks/observer-stop.txt"), join(dest, "hooks/observer-stop.txt"), "stop text");
  copyRequired(join(sourceRoot, "hooks/INSTALL.md"), join(dest, "INSTALL.md"), "install notes");
  for (const rel of REQUIRED_SKILL_REFS) {
    copyRequired(join(sourceRoot, rel), join(dest, rel), rel);
  }
  copyRequired(join(sourceRoot, "skills/spellcast/SKILL.md"), join(dest, "skills/spellcast/SKILL.md"), "canonical skill");
  copyRequired(join(sourceRoot, "LICENSE"), join(dest, "LICENSE"), "license");
  copyRequired(built, join(dest, "bin", exeName), "native helper");

  const references = join(sourceRoot, "skills/spellcast/references");
  if (existsSync(references) && statSync(references).isDirectory()) {
    for (const name of readdirSync(references)) {
      const rel = `skills/spellcast/references/${name}`;
      if (REQUIRED_SKILL_REFS.includes(rel)) continue;
      const from = join(references, name);
      if (statSync(from).isFile()) copyFileSync(from, join(dest, rel));
    }
  }

  writeFileSync(
    join(dest, ".mcp.json"),
    JSON.stringify({ mcpServers: { spellcast: { type: "http", url: mcpUrl } } }, null, 2) + "\n",
  );

  const unixCmd = `"\${PLUGIN_ROOT}/bin/spellcast-hook" --endpoint ${statusUrl}`;
  const winCmd = windowsCommandWindows(statusUrl);
  writeFileSync(
    join(dest, "hooks/hooks.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|clear|compact",
              hooks: [{ type: "command", command: unixCmd, commandWindows: winCmd, timeout: 2 }],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: unixCmd, commandWindows: winCmd, timeout: 2 }],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );

  const meta = { port, mcpUrl, statusUrl, helper: "bin/" + exeName, pluginRoot: "spellcast" };
  writeFileSync(join(dest, "package-meta.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify({ ...meta, dest }, null, 2));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();

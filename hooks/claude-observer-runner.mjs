// One-shot Claude Code observer. It never opens a Herdr workspace or a Supervisor session.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROXY = "http://127.0.0.1:7897";
const MODEL = "claude-opus-5-5";
const MAX_INPUT = 16_384;
const MAX_OUTPUT = 131_072;
const AUTH_TYPES = new Set(["pro", "max", "team", "enterprise"]);
const FORBIDDEN_CLAUDE_ENV = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CONFIG_DIR",
]);

const schema = {
  type: "object",
  properties: {
    thought: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { tease: { type: "string" }, body: { type: "string" } },
          required: ["tease"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["thought"],
  additionalProperties: false,
};

const systemPrompt = [
  "You are a short-lived independent Spellcast observer, not an implementer.",
  "Use only the supplied brief. Do not read files, edit, delegate, or infer missing facts.",
  "Decide whether one concrete non-blocking aside has value beyond the main answer.",
  "Silence is success. Return thought:null unless there is a worthwhile aside.",
  "If you speak, use the brief locale for both tease and body. Keep tease within 120 characters.",
  "Speak directly to the user about one concrete thing; do not narrate progress.",
].join(" ");

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function validateBrief(value, now = Date.now()) {
  if (!value || typeof value !== "object" || value.provider !== "claude"
    || typeof value.observer_id !== "string" || typeof value.source_id !== "string"
    || !["zh-CN", "en"].includes(value.locale)
    || !Number.isSafeInteger(value.expires_at_ms) || value.expires_at_ms <= now
    || !value.snapshot || typeof value.snapshot !== "object") throw failure("BRIEF_INVALID");
  const snapshot = value.snapshot;
  for (const key of ["checkpoint_id", "project", "goal", "change"]) {
    if (typeof snapshot[key] !== "string" || !snapshot[key].trim()) throw failure("BRIEF_INVALID");
  }
  if (!Array.isArray(snapshot.facts) || snapshot.facts.length > 4
    || snapshot.facts.some(fact => typeof fact !== "string")) throw failure("BRIEF_INVALID");
  return value;
}

export function parseClaudeResult(stdout) {
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw failure("CLAUDE_RESULT_INVALID"); }
  if (result.type !== "result" || result.subtype !== "success" || result.is_error) {
    throw failure("CLAUDE_RESULT_FAILED");
  }
  const models = Object.keys(result.modelUsage || {});
  if (!models.length || models.some(model => !model.startsWith(MODEL))) {
    throw failure("MODEL_NOT_VERIFIED");
  }
  const output = result.structured_output;
  if (!output || typeof output !== "object" || !("thought" in output)) {
    throw failure("CLAUDE_RESULT_INVALID");
  }
  if (output.thought === null) return null;
  const thought = output.thought;
  if (!thought || typeof thought.tease !== "string" || !thought.tease.trim()
    || [...thought.tease].length > 120 || typeof (thought.body ?? "") !== "string"
    || [...(thought.body ?? "")].length > 2_000) throw failure("THOUGHT_INVALID");
  return { tease: thought.tease.trim(), body: (thought.body ?? "").trim() };
}

export function buildLaunchEnv(base, managedProxyEnv, exe) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_")
      || FORBIDDEN_CLAUDE_ENV.has(key)) delete env[key];
  }
  Object.assign(env, managedProxyEnv(PROXY));
  env.CLAUDE_SUPERVISOR_CLAUDE_BIN = exe;
  return env;
}

async function collect(child, input, timeoutMs, guardCheck) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let closed = false;
    let checking = false;
    const guardTimer = guardCheck && setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try { await guardCheck(); }
      catch { child.kill(); reject(failure("PROXY_LOST")); }
      finally { checking = false; }
    }, 5_000);
    const finish = () => { closed = true; clearTimeout(timer); if (guardTimer) clearInterval(guardTimer); };
    const timer = setTimeout(() => { child.kill(); finish(); reject(failure("CLAUDE_TIMEOUT")); }, timeoutMs);
    child.on("error", error => { finish(); reject(error); });
    child.stdin.on("error", error => { finish(); reject(error); });
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT) { child.kill(); reject(failure("CLAUDE_OUTPUT_LIMIT")); }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT) { child.kill(); reject(failure("CLAUDE_OUTPUT_LIMIT")); }
    });
    child.on("close", code => {
      finish();
      if (code !== 0) reject(failure("CLAUDE_EXIT_FAILED"));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function runExe(exe, args, env, input, timeoutMs, guardCheck) {
  const child = spawn(exe, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return collect(child, input, timeoutMs, guardCheck);
}

async function readBrief() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > MAX_INPUT) throw failure("BRIEF_TOO_LARGE");
  }
  try { return validateBrief(JSON.parse(input)); }
  catch (error) { throw error.code ? error : failure("BRIEF_INVALID"); }
}

async function main() {
  if (process.platform !== "win32") throw failure("WINDOWS_ONLY");
  const brief = await readBrief();
  const home = process.env.USERPROFILE;
  if (!home) throw failure("HOME_UNKNOWN");
  const exe = path.join(home, ".local", "bin", "claude.exe");
  const guardPath = path.join(home, "plugins", "claude-supervisor", "scripts", "proxy-guard.mjs");
  if ((await fs.realpath(exe)).toLowerCase() !== path.resolve(exe).toLowerCase()
    || !(await fs.stat(guardPath)).isFile()) {
    throw failure("RUNTIME_PATH_UNVERIFIED");
  }
  const guard = await import(pathToFileURL(guardPath).href);
  const env = buildLaunchEnv(process.env, guard.managedProxyEnv, exe);
  guard.validateProxyEnv(env, PROXY);
  await guard.assertManagedProxy(PROXY, { env, verifyProcessEnv: true });
  const authText = await runExe(exe, ["--safe-mode", "auth", "status"], env, "", 15_000);
  let auth;
  try { auth = JSON.parse(authText); } catch { throw failure("AUTH_UNVERIFIED"); }
  if (auth.loggedIn !== true || auth.authMethod !== "claude.ai"
    || auth.apiProvider !== "firstParty" || !AUTH_TYPES.has(String(auth.subscriptionType).toLowerCase())) {
    throw failure("SUBSCRIPTION_UNVERIFIED");
  }
  const remaining = brief.expires_at_ms - Date.now() - 5_000;
  if (remaining <= 0) throw failure("BRIEF_EXPIRED");
  const output = await runExe(exe, [
    "-p", "--safe-mode", "--no-session-persistence", "--model", MODEL,
    "--effort", "xhigh", "--tools", "", "--disallowedTools", "mcp__*",
    "--permission-prompts", "none", "--output-format", "json",
    "--json-schema", JSON.stringify(schema), "--system-prompt", systemPrompt,
    "Read the supplied Spellcast brief and return only the requested structured decision.",
  ], env, JSON.stringify(brief), Math.min(remaining, 170_000),
  () => guard.assertManagedProxy(PROXY, { env, verifyProcessEnv: true, timeoutMs: 3_000 }));
  await guard.assertManagedProxy(PROXY, { env, verifyProcessEnv: true });
  if (Date.now() >= brief.expires_at_ms) throw failure("BRIEF_EXPIRED");
  const thought = parseClaudeResult(output);
  process.stdout.write(JSON.stringify({ status: thought ? "ready" : "silent", observer_id: brief.observer_id, thought }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stdout.write(JSON.stringify({ status: "unavailable", reason: error.code || "UNKNOWN" }) + "\n");
    process.exitCode = 1;
  });
}

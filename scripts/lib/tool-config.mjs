/**
 * Shared guards for any future installer / plugin script that thinks it
 * should "register MCP". Spellcast is not an MCP server. Default: refuse.
 *
 * Never write ~/.codex/**. Never dump Cursor `mcpServers` JSON into a .toml
 * file. If a Cursor merge is ever invoked, only touch `.cursor/mcp.json`,
 * abort when the target is TOML / not JSON, and merge one key.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, extname, basename, sep, join } from "node:path";

export const MCP_REGISTRATION_ENABLED = false;

export const INCIDENT_CURSOR_MCP_JSON = `{
  "mcpServers": {
    "spellcast": {
      "url": "http://127.0.0.1:47194/mcp"
    }
  }
}`;

export const SAMPLE_CODEX_CONFIG_TOML = `# Codex user config — TOML. Not Cursor MCP JSON.
model = "gpt-5"
model_reasoning_effort = "high"

[projects."C:\\\\work\\\\spellcast"]
trust_level = "trusted"

[plugins]
enabled = true

[marketplaces.official]
url = "https://example.invalid/marketplace"

[hooks]
notify = "echo done"

[mcp_servers.docs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
`;

export class ConfigSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigSafetyError";
    this.code = code;
  }
}

function parts(path) {
  return String(path).split(/[\\/]+/).filter(Boolean);
}

export function pathIsUnderCodex(path) {
  return parts(path).some((p) => p.toLowerCase() === ".codex");
}

export function pathIsCursorMcpJson(path) {
  const bits = parts(path);
  const file = bits[bits.length - 1] || "";
  const hasCursor = bits.some((p) => p.toLowerCase() === ".cursor");
  return file.toLowerCase() === "mcp.json" && hasCursor && !pathIsUnderCodex(path);
}

export function pathHasTomlExtension(path) {
  return extname(path).toLowerCase() === ".toml" || basename(path).toLowerCase().endsWith(".toml");
}

export function detectConfigFormat(bytes) {
  const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text) return "other";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    if (looksLikeToml(text)) return "toml";
    return "other";
  }
}

function looksLikeToml(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && !trimmed.startsWith("[{")) return true;
  return trimmed.split(/\r?\n/).some((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return false;
    if (t.startsWith("[") && t.endsWith("]")) return true;
    const eq = t.indexOf("=");
    if (eq < 1) return false;
    const key = t.slice(0, eq).trim();
    const rest = t.slice(eq + 1).trim();
    return key && !key.includes("{") && (rest.startsWith('"') || rest === "true" || rest === "false" || Number.isFinite(Number(rest)));
  });
}

function rejectTarget(path, existingBytes) {
  if (pathIsUnderCodex(path)) {
    throw new ConfigSafetyError("CodexPathForbidden", "refusing to write any path under .codex");
  }
  if (pathHasTomlExtension(path)) {
    throw new ConfigSafetyError("TomlTarget", "target is TOML; Cursor MCP config must be JSON");
  }
  if (existingBytes && Buffer.from(existingBytes).toString("utf8").trim()) {
    const format = detectConfigFormat(existingBytes);
    if (format === "toml") {
      throw new ConfigSafetyError("TomlTarget", "target is TOML; Cursor MCP config must be JSON");
    }
    if (format === "other") {
      throw new ConfigSafetyError("NotJson", "target is not JSON; aborting to avoid data loss");
    }
  }
  if (!pathIsCursorMcpJson(path)) {
    throw new ConfigSafetyError("NotCursorMcpPath", "refusing to write a non-Cursor MCP JSON path");
  }
}

export function mergeMcpServersObject(existing, name, server) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new ConfigSafetyError("NotJson", "target is not JSON; aborting to avoid data loss");
  }
  const root = { ...existing };
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? { ...root.mcpServers }
      : {};
  servers[name] = server;
  root.mcpServers = servers;
  return root;
}

/** Product entry: never register Spellcast into Codex or Cursor. */
export function registerSpellcastMcp() {
  throw new ConfigSafetyError(
    "RegistrationDisabled",
    "Spellcast is not an MCP server; registration is disabled",
  );
}

/**
 * Guarded write helper. Default product path never calls this.
 * Scripts must import this instead of writing tool configs themselves.
 */
export function mergeCursorMcpServer(path, name, server) {
  if (pathIsUnderCodex(path)) {
    throw new ConfigSafetyError("CodexPathForbidden", "refusing to write any path under .codex");
  }
  if (pathHasTomlExtension(path)) {
    throw new ConfigSafetyError("TomlTarget", "target is TOML; Cursor MCP config must be JSON");
  }
  const existingBytes = existsSync(path) ? readFileSync(path) : null;
  rejectTarget(path, existingBytes);
  let existing = {};
  if (existingBytes && existingBytes.toString("utf8").trim()) {
    try {
      existing = JSON.parse(existingBytes.toString("utf8"));
    } catch {
      throw new ConfigSafetyError("NotJson", "target is not JSON; aborting to avoid data loss");
    }
  }
  const merged = mergeMcpServersObject(existing, name, server);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `${basename(path)}.tmp-spellcast`);
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function autoRegisterSpellcastMcp(home) {
  const _cursor = join(home, ".cursor", "mcp.json");
  const _codex = join(home, ".codex", "config.toml");
  registerSpellcastMcp();
}

export { sep };

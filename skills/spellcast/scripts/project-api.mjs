#!/usr/bin/env node
// Authorized local project automation. Credentials never enter stdout or request bodies.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

try {
  const [requestFile, ...args] = process.argv.slice(2);
  if (!requestFile || args.length) throw new Error("Usage: node project-api.mjs <command-or-command-array.json>");
  const thread = process.env.CODEX_THREAD_ID;
  if (!thread || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread)) {
    throw new Error("Actual CODEX_THREAD_ID is required; do not infer another task's identity.");
  }
  const base = new URL(process.env.SPELLCAST_PROJECT_API_URL || "http://127.0.0.1:47194");
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password) {
    throw new Error("The project API credential may only be sent to the local Spellcast endpoint.");
  }
  const keyFile = process.env.SPELLCAST_PROJECT_KEY_FILE || path.join(os.homedir(), ".spellcast", "credentials", "project-api.key");
  const key = await fs.readFile(keyFile, "utf8");
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("Local project API credential is invalid.");
  const input = JSON.parse(await fs.readFile(path.resolve(requestFile), "utf8"));
  const commands = Array.isArray(input) ? input : [input];
  if (!commands.length || commands.length > 100) throw new Error("Provide between 1 and 100 commands.");
  for (const command of commands) {
    const response = await fetch(new URL("/api/projects/local/command", base), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-spellcast-project-key": key },
      body: JSON.stringify({ source_id: thread, thread_id: thread, cwd: process.cwd(), command }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Project API HTTP ${response.status}`);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Project API request failed.");
  process.exitCode = 1;
}

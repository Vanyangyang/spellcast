import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchEnv, parseClaudeResult, validateBrief } from "./claude-observer-runner.mjs";

const brief = {
  provider: "claude", observer_id: "observer-1", source_id: "source-1", locale: "zh-CN",
  expires_at_ms: 2_000,
  snapshot: { checkpoint_id: "c1", project: "Spellcast", goal: "Review", change: "New plan", facts: [] },
};

test("rejects a stale or wrong-provider brief before starting Claude", () => {
  assert.equal(validateBrief(brief, 1_000), brief);
  assert.throws(() => validateBrief(brief, 2_000), /BRIEF_INVALID/);
  assert.throws(() => validateBrief({ ...brief, provider: "codex" }, 1_000), /BRIEF_INVALID/);
});

test("removes credential and provider overrides while pinning the local proxy", () => {
  const env = buildLaunchEnv({
    ANTHROPIC_API_KEY: "do-not-use", ANTHROPIC_AUTH_TOKEN: "do-not-use",
    CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://other.example",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: wrong", CLAUDE_CODE_SIMPLE: "1",
  }, proxy => ({ HTTPS_PROXY: proxy, NO_PROXY: "localhost" }), "C:\\Claude\\claude.exe");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:17891");
  assert.equal(env.CLAUDE_SUPERVISOR_CLAUDE_BIN, "C:\\Claude\\claude.exe");
});

test("accepts only a successful verified Opus 5.5 structured decision", () => {
  const envelope = { type: "result", subtype: "success", is_error: false,
    modelUsage: { "claude-opus-5-5-20260901": {} },
    structured_output: { thought: { tease: "具体问题", body: "背景" } } };
  assert.deepEqual(parseClaudeResult(JSON.stringify(envelope)), { tease: "具体问题", body: "背景" });
  assert.equal(parseClaudeResult(JSON.stringify({ ...envelope, structured_output: { thought: null } })), null);
  assert.throws(() => parseClaudeResult(JSON.stringify({ ...envelope, modelUsage: { "claude-sonnet-5": {} } })), /MODEL_NOT_VERIFIED/);
});

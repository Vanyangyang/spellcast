import { t } from "./i18n";
import { claudeLink, claudeLinkText, codexLink, codexLinkText, liveCcguiHosts, type RecipientEvidence } from "./host-link-ui";
import type { HostSessionStatus, RecentAgent } from "./types";

/** Home and settings connection summary: one entry per client, combining its recent MCP activity
 * with its Canvas send-back link. Chats are never listed here: the exact recipient is chosen in
 * the Canvas "Send to" control, and connection identities stay in the host-link diagnostics.
 * Grouping by client name is presentation only; it does not establish trust or origin. */

type Tone = "live" | "stale" | "idle";
type Link = "ok" | "attention" | "none";
type Entry = { key: string; name: string; version: string; identities: string[]; lastCall: number; live?: boolean; state?: string; detail?: string; link?: Link };

const LIVE_SECONDS = 45;
const VERSION = /\s+v?(\d+(?:\.\d+)+(?:[-+][\w.-]+)?)$/i;
const CLIENTS: [RegExp, string, string][] = [
  [/codex/i, "codex", "Codex"], [/claude[\s_-]*code/i, "claude", "Claude Code"], [/cursor/i, "cursor", "Cursor"],
  [/grok/i, "grok", "Grok Build"], [/windsurf/i, "windsurf", "Windsurf"],
];

let evidence: RecipientEvidence = { bindings: [], confirmed: false, canReturn: false };
let hosts: HostSessionStatus[] = [], hostCheck: "pending" | "ok" | "error" = "pending";

/** Follows the same events as the host-link section. Call once. */
export function watchClientLinks(onChange: () => void) {
  window.addEventListener("spellcast:recipient-evidence", (event) => { evidence = (event as CustomEvent<RecipientEvidence>).detail; onChange(); });
  window.addEventListener("spellcast:host-sessions", (event) => { hosts = (event as CustomEvent<HostSessionStatus[]>).detail; hostCheck = "ok"; onChange(); });
  window.addEventListener("spellcast:host-sessions-error", () => { hosts = []; hostCheck = "error"; onChange(); });
}

export function ageText(seconds: number) {
  if (seconds < 60) return t("agent.ago.seconds", { n: Math.max(1, Math.floor(seconds)) });
  return t("agent.ago.minutes", { n: Math.floor(seconds / 60) });
}

/** Paints one row per client into `label` and returns the state for its status dot. */
export function paintClientSummary(label: HTMLElement, agents: RecentAgent[], empty: string, now = Date.now()): "ready" | "live" | "stale" {
  const entries = new Map<string, Entry>();
  const entry = (key: string, name: string) => {
    let item = entries.get(key);
    if (!item) entries.set(key, item = { key, name, version: "", identities: [], lastCall: 0 });
    return item;
  };
  for (const agent of agents) {
    const raw = agent.client.trim(), version = raw.match(VERSION);
    const base = version ? raw.slice(0, version.index).trim() : raw;
    const known = CLIENTS.find(([pattern]) => pattern.test(base));
    const item = entry(known?.[1] ?? "mcp:" + base.toLowerCase(), known?.[2] ?? base);
    item.identities.push(raw);
    if (agent.last_call_ms > item.lastCall) { item.lastCall = agent.last_call_ms; item.version = version?.[1] ?? ""; }
  }
  // Linked is not checked: only a fresh check of the Canvas recipient reads as ready for send-back.
  const codex = codexLink(evidence, now);
  if (codex.state !== "none" || entries.has("codex")) Object.assign(entry("codex", "Codex"), { state: codex.state, detail: codexLinkText(codex.state),
    link: codex.state === "checked" ? "ok" : codex.state === "unknown" || codex.state === "unavailable" ? "attention" : "none" });
  const live = liveCcguiHosts(hosts).length, claude = claudeLink(live, hostCheck === "error", hostCheck === "pending");
  if (live || claude === "error" || entries.has("claude")) Object.assign(entry("claude", "Claude Code"), { live: live > 0, state: claude,
    detail: claudeLinkText(claude, live), link: claude === "connected" ? "ok" : claude === "error" ? "attention" : "none" });
  const order = (item: Entry) => item.key === "codex" ? 0 : item.key === "claude" ? 1 : 2;
  const rows = [...entries.values()].sort((left, right) => order(left) - order(right) || right.lastCall - left.lastCall);
  if (!rows.length) { label.textContent = empty; return "ready"; }

  const list = document.createElement("ul");
  list.className = "client-summary";
  list.setAttribute("aria-label", t("agent.clients"));
  let overall: "ready" | "live" | "stale" = "ready";
  for (const item of rows) {
    const seconds = Math.max(0, (now - item.lastCall) / 1000);
    const tone: Tone = item.live || (item.lastCall && seconds <= LIVE_SECONDS) ? "live" : item.lastCall ? "stale" : "idle";
    if (tone === "live" || (tone === "stale" && overall === "ready")) overall = tone;
    const row = document.createElement("li"), chip = document.createElement("span"), detail = document.createElement("span");
    row.className = "client-summary-row";
    row.dataset.client = item.key;
    row.dataset.tone = tone;
    if (item.state) row.dataset.state = item.state;
    chip.className = `agent-chip ${tone}`;
    chip.textContent = item.name;
    if (item.identities.length) chip.title = item.identities.join("\n");
    if (item.version) {
      const version = document.createElement("span");
      version.className = "agent-chip-version";
      version.textContent = item.version;
      chip.append(" ", version);
    }
    detail.className = "client-summary-detail";
    detail.dataset.link = item.link ?? "none";
    detail.textContent = item.detail ?? t("agent.mcpOnly");
    row.append(chip, detail);
    if (item.lastCall) {
      const when = document.createElement("span");
      when.className = "client-summary-when";
      when.textContent = ageText(seconds);
      when.title = t("agent.last", { ago: when.textContent });
      row.append(when);
    }
    list.append(row);
  }
  label.replaceChildren(list);
  return overall;
}

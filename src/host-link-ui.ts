import { inTauri, apiBase, completeSetupStatus, nativeHostLinkKey, openClaudePluginFolder, fetchHostSessions } from "./api";
import { onLocale } from "./i18n";
import { ct } from "./i18n/canvas";
import { canReturnCanvas, recipientClient, readableRecipientLabel } from "./canvas-recipient";
import type { CodexBinding, HostSessionStatus, SetupReport, TaskTarget, TaskTargetStatus } from "./types";

export type RecipientEvidence = { bindings: CodexBinding[]; target?: TaskTarget; status?: TaskTargetStatus; confirmed: boolean; canReturn: boolean };
export type CodexLinkState = "checked" | "unknown" | "unavailable" | "bound" | "none";
export type ClaudeLinkState = "desktop" | "error" | "checking" | "connected" | "empty";

/** A binding record is durable, not live: only a fresh check of the committed Canvas recipient
 * turns "linked" into "checked". */
export function codexLink(evidence: RecipientEvidence, now = Date.now()): { state: CodexLinkState; bindings: CodexBinding[] } {
  const bindings = evidence.bindings.filter(binding => recipientClient(binding, [binding]) === "codex" && canReturnCanvas(binding.source_id, [binding]));
  const current = evidence.target, result = evidence.status;
  const currentCodex = evidence.confirmed && recipientClient(current, evidence.bindings) === "codex";
  const matches = Boolean(current && result && result.source_id === current.source_id && result.thread_id === current.thread_id && !result.host_pin);
  const fresh = Boolean(result && now - result.checked_at_ms >= 0 && now - result.checked_at_ms <= 30000);
  const state = currentCodex && matches && fresh && result?.status === "unknown" ? "unknown"
    : currentCodex && matches && fresh && result?.status === "available" && evidence.canReturn ? "checked"
    : currentCodex && matches && fresh && result?.status !== "available" ? "unavailable" : bindings.length ? "bound" : "none";
  return { state, bindings };
}
/** CC GUI windows that can take a Canvas request and confirm it durably. */
export function liveCcguiHosts(hosts: HostSessionStatus[]): HostSessionStatus[] {
  return hosts.filter(host => host.reachable && host.host_pin.client === "ccgui"
    && host.capabilities?.includes("canvas_requests") && host.capabilities.includes("durable_receipts"));
}
export function claudeLink(live: number, failed: boolean, pending: boolean): ClaudeLinkState {
  return !inTauri() ? "desktop" : failed ? "error" : pending ? "checking" : live ? "connected" : "empty";
}
export function codexLinkText(state: CodexLinkState): string {
  return ct(state === "checked" ? "connectionCodexChecked" : state === "unknown" ? "connectionCodexUnknown"
    : state === "unavailable" ? "connectionCodexUnavailable" : state === "bound" ? "connectionCodexBound" : "connectionCodexNone");
}
export function claudeLinkText(state: ClaudeLinkState, count: number): string {
  return state === "desktop" ? ct("hostLinkDesktop") : state === "error" ? ct("hostLinkUnavailable")
    : state === "checking" ? ct("hostLinkChecking") : state === "connected" ? ct("hostLinkConnected", { count }) : ct("hostLinkNoSessions");
}

/** CC GUI pairing and connection diagnostics. Per-client status lives in the connection summary
 * (connection-summary.ts); chats are listed only inside the collapsed diagnostics.
 * Installation evidence and live host leases are independent. Secrets pass
 * only from owner IPC to the clipboard, never into the DOM or snapshots. */
export function mountHostLinkSettings(parent: HTMLElement) {
  const section = document.createElement("section"), help = document.createElement("p");
  const actions = document.createElement("div"), open = document.createElement("button"), copy = document.createElement("button"), recheck = document.createElement("button");
  const folder = document.createElement("code"), notice = document.createElement("p");
  const cue = document.createElement("button"), diagnostics = document.createElement("details");
  const summary = document.createElement("summary"), diagnosticHelp = document.createElement("p"), diagnosticContext = document.createElement("p"), diagnosticSessions = document.createElement("ul");
  const codexDiagnosticTitle = document.createElement("h4"), codexDiagnosticSessions = document.createElement("ul");
  section.className = "settings-host-link"; section.dataset.claudePairing = "true"; section.hidden = true;
  diagnostics.className = "settings-host-diagnostics"; diagnostics.dataset.hostLinkDiagnostics = "true";
  diagnosticSessions.dataset.hostDiagnosticSessions = "true"; cue.dataset.hostDiagnosticHelp = "true";
  help.dataset.claudeConnectionStatus = "true"; codexDiagnosticSessions.dataset.codexDiagnosticSessions = "true";
  actions.className = "config-actions"; help.setAttribute("role", "status"); notice.setAttribute("role", "status");
  open.dataset.claudePluginFolder = "true"; copy.dataset.hostLinkCopy = "true"; recheck.dataset.claudeHostCheck = "true";
  for (const button of [open, copy, recheck, cue]) { button.type = "button"; button.className = "ghost"; }
  let report: SetupReport | null = null, claudeReport: SetupReport | null = null, hosts: HostSessionStatus[] = [], failed = false, checked = false, checking = false, alive = true;
  let claudeStatusRequested = false, claudeStatusLoading = false;
  let evidence: RecipientEvidence = { bindings: [], confirmed: false, canReturn: false };
  const codexRow = (binding: CodexBinding) => {
    const row = document.createElement("li"), name = document.createElement("strong"), project = document.createElement("code"), id = document.createElement("code");
    row.className = "settings-host-session"; name.textContent = readableRecipientLabel(binding) || ct("hostLinkConversation");
    project.textContent = ct("hostLinkProject", { cwd: binding.cwd }); id.textContent = ct("hostLinkSessionId", { id: binding.thread_id });
    row.append(name, project, id);
    return row;
  };
  const sessionRow = (host: HostSessionStatus) => {
    const row = document.createElement("li"), heading = document.createElement("div"), label = document.createElement("strong"), activity = document.createElement("span");
    const id = host.host_pin.native_session_id;
    label.textContent = readableRecipientLabel({ source_id: host.host_pin.source_id, thread_id: id,
      cwd: host.host_pin.cwd, label: host.label || "", host_pin: host.host_pin }) || ct("hostLinkConversation");
    activity.textContent = ct(host.active ? "hostLinkRecentlyActive" : "hostLinkOnline");
    row.className = "settings-host-session"; row.dataset.hostSource = host.host_pin.source_id; row.dataset.recentlyActive = String(Boolean(host.active));
    heading.className = "settings-host-session-heading"; heading.append(label, activity);
    const identity = document.createElement("code"), workspace = document.createElement("code"), windowId = document.createElement("code");
    identity.textContent = ct("hostLinkSessionId", { id }); workspace.textContent = ct("hostLinkProject", { cwd: host.host_pin.cwd });
    windowId.textContent = ct("hostLinkWindow", { id: host.host_pin.window_id });
    row.append(heading, identity, workspace, windowId);
    return row;
  };
  const paint = () => {
    section.hidden = !["claude-code", "codex"].includes(report?.client || "");
    const live = liveCcguiHosts(hosts);
    const state = claudeLink(live.length, failed, checking || !checked);
    open.textContent = ct("hostLinkOpen"); copy.textContent = ct("hostLinkCopy"); recheck.textContent = ct("hostLinkCheck");
    const installed = Boolean(claudeReport?.installed && claudeReport.ccgui_plugin_path);
    // Claude setup deploys and pairs the CC GUI plugin itself; older reports omit these fields.
    const ccguiMissing = claudeReport?.ccgui_detected === false;
    const ccguiPending = claudeReport?.ccgui_detected === true && !(claudeReport.ccgui_plugin_current && claudeReport.ccgui_paired);
    const { bindings } = codexLink(evidence);
    codexDiagnosticTitle.textContent = ct("recipientCodex") + " · " + ct("connectionCodexRecords", { count: bindings.length });
    codexDiagnosticSessions.replaceChildren(...bindings.map(codexRow)); codexDiagnosticTitle.hidden = !bindings.length;
    const sharedChat = live.some(host => live.some(other => other !== host && other.host_pin.native_session_id === host.host_pin.native_session_id));
    help.hidden = state === "checking" || state === "desktop";
    help.textContent = ct(state === "connected" ? sharedChat ? "hostLinkMultipleWindows" : "hostLinkConnectedHelp"
      : state === "error" ? "hostLinkErrorHelp" : ccguiMissing ? "hostLinkNoCcgui"
      : claudeReport && !installed || ccguiPending ? "hostLinkInstallFirst" : "hostLinkEmptyHelp");
    help.dataset.connected = String(state === "connected"); help.dataset.hostCheck = state;
    cue.textContent = ct(claudeReport ? "hostLinkConnectionHelp" : "hostLinkConfigureClaude"); cue.hidden = !["empty", "error"].includes(state);
    summary.textContent = ct("hostLinkAdvanced"); diagnosticHelp.textContent = ct("hostLinkHelp"); diagnosticContext.textContent = ct("hostLinkDiagnosticContext");
    open.disabled = !inTauri() || !installed; copy.disabled = !inTauri() || !installed; recheck.disabled = !inTauri() || checking;
    folder.textContent = claudeReport?.ccgui_plugin_path || ""; folder.hidden = !claudeReport?.ccgui_plugin_path;
    diagnosticSessions.hidden = state !== "connected"; diagnosticSessions.replaceChildren(...(state === "connected" ? live.map(sessionRow) : []));
  };
  const refresh = async () => {
    checking = true; failed = false; paint();
    try { const next = await fetchHostSessions(); if (!alive) return; hosts = next; failed = false; }
    catch { if (!alive) return; hosts = []; failed = true; }
    checking = false; checked = true; paint();
    // The connection summary and the other mounted section show the same read.
    window.dispatchEvent(failed ? new CustomEvent("spellcast:host-sessions-error") : new CustomEvent("spellcast:host-sessions", { detail: hosts }));
  };
  const loadClaudeStatus = async (retry = false) => {
    if (!inTauri() || claudeReport || claudeStatusLoading || claudeStatusRequested && !retry) return;
    claudeStatusRequested = true; claudeStatusLoading = true; notice.textContent = ct("hostLinkCheckingSetup");
    try {
      const next = await completeSetupStatus("claude-code", report?.mcp_url || (await apiBase()) + "/mcp");
      if (!alive) return; claudeReport = next; notice.textContent = next.installed ? "" : ct("hostLinkInstallFirst");
    } catch { if (alive) notice.textContent = ct("hostLinkSetupUnavailable"); }
    finally { claudeStatusLoading = false; if (alive) paint(); }
  };
  open.addEventListener("click", async () => { open.disabled = true; notice.textContent = ""; try { await openClaudePluginFolder(); } catch (cause) { notice.textContent = cause instanceof Error ? cause.message : String(cause); } finally { paint(); } });
  copy.addEventListener("click", async () => {
    copy.disabled = true; notice.textContent = "";
    try { await navigator.clipboard.writeText(await nativeHostLinkKey()); notice.textContent = ct("hostLinkCopied"); }
    catch (cause) { notice.textContent = cause instanceof Error ? cause.message : String(cause); }
    finally { paint(); }
  });
  recheck.addEventListener("click", () => { void loadClaudeStatus(true); void refresh(); });
  cue.addEventListener("click", () => { diagnostics.open = true; summary.focus(); void loadClaudeStatus(); });
  diagnostics.addEventListener("toggle", () => { if (diagnostics.open) void loadClaudeStatus(); });
  const onReport = (event: Event) => { report = (event as CustomEvent<SetupReport>).detail; if (report.client === "claude-code") claudeReport = report; paint(); if (["claude-code", "codex"].includes(report.client) && inTauri()) void refresh(); };
  const onEvidence = (event: Event) => { evidence = (event as CustomEvent<RecipientEvidence>).detail; paint(); };
  const onHosts = (event: Event) => { hosts = (event as CustomEvent<HostSessionStatus[]>).detail; failed = false; checked = true; checking = false; paint(); };
  const onHostError = () => { hosts = []; failed = true; checked = true; checking = false; paint(); };
  window.addEventListener("spellcast:setup-report", onReport); window.addEventListener("spellcast:host-sessions", onHosts);
  window.addEventListener("spellcast:host-sessions-error", onHostError);
  window.addEventListener("spellcast:recipient-evidence", onEvidence);
  actions.append(open, copy, recheck);
  diagnostics.append(summary, diagnosticHelp, folder, actions, diagnosticContext, codexDiagnosticTitle, codexDiagnosticSessions, diagnosticSessions, notice);
  section.append(help, cue, diagnostics); parent.append(section); paint();
  const locale = onLocale(paint);
  return () => { alive = false; locale(); window.removeEventListener("spellcast:setup-report", onReport); window.removeEventListener("spellcast:host-sessions", onHosts); window.removeEventListener("spellcast:host-sessions-error", onHostError); window.removeEventListener("spellcast:recipient-evidence", onEvidence); section.remove(); };
}

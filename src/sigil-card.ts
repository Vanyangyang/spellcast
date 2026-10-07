// Live Canvas card for a sigil (法阵). The plan and run live outside Canvas content; the card
// reads them on mount, on every board refresh and on each `spellcast-sigil` event for its id,
// and offers the user's actions. Agent text and file paths render literally.
import "./sigil-card.css";
import { st, type SigilKey } from "./i18n/sigil";
import { isDesktopShell } from "./shell";
import {
  approveCommand, automateSigil, controlSigil, decideCheck, decideHandover, deleteSigil, dispatchSigil, executeSigil, fetchSigil, fetchSigilDiff, fetchSigilStep, freezeSigil, noteSigil, reopenStep, reviewSigil,
  rerunChecks, revertAmendment, startSigil, unfreezeSigil, type AmendmentChange, type ChangedPath, type CheckResult, type PendingCommand, type SigilCheck,
  type SigilStep, type SigilView, type StepProgress,
} from "./sigil-api";

export type SigilReference = { type: "sigil"; sigil_id: string };
export type SigilCard = { refresh(): void; refreshLabels(): void; destroy(): void };

const VISIBLE_STEPS = 8;
const issueMessage = (issue: { code: string; message: string }) => issue.code === "native_review_required" ? st("nativeReviewRequired") : issue.message;
const VISIBLE_FILES = 12;

/** Cards to refresh when the app reports a change to their sigil, without repainting the board. */
const liveCards = new Map<string, Set<() => void>>();
let listening = false;
let stopListening: (() => void) | undefined;
let listenerGeneration = 0;

function ensureSigilListener() {
  if (!listening && liveCards.size) {
    listening = true;
    const generation = ++listenerGeneration;
    const notify = (sigilId: string) => { for (const card of liveCards.get(sigilId) ?? []) card(); };
    if (isDesktopShell()) {
      void import("@tauri-apps/api/event").then(({ listen }) => listen<{ sigil_id: string }>("spellcast-sigil", event => notify(event.payload.sigil_id)))
        .then(stop => { if (generation !== listenerGeneration || !liveCards.size) stop(); else stopListening = stop; })
        .catch(() => { if (generation === listenerGeneration) listening = false; });
    } else {
      // Browser fixtures dispatch the same event on the window, like the shim in main.ts.
      const listener = (event: Event) => {
        const sigilId = (event as CustomEvent<{ sigil_id?: string }>).detail?.sigil_id;
        if (sigilId) notify(sigilId);
      };
      window.addEventListener("spellcast-sigil", listener);
      stopListening = () => window.removeEventListener("spellcast-sigil", listener);
    }
  }
}

function watchSigil(id: string, refresh: () => void): () => void {
  if (!liveCards.has(id)) liveCards.set(id, new Set());
  liveCards.get(id)!.add(refresh);
  ensureSigilListener();
  return () => {
    const cards = liveCards.get(id);
    cards?.delete(refresh);
    if (cards && !cards.size) liveCards.delete(id);
    if (!liveCards.size) {
      ++listenerGeneration;
      stopListening?.(); stopListening = undefined;
      listening = false;
    }
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fileCount(n: number): string {
  return n === 1 ? st("file1") : st("files", { n });
}

function lineCounts(files: ChangedPath[]): string {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  return `+${added} −${deleted}`;
}

/** A modal confirmation built from plain nodes; resolves false on Escape or Cancel. */
function confirmDialog(title: string, body: Node[], confirmLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = el("dialog", "board-dialog sigil-dialog");
    const form = el("form");
    form.method = "dialog";
    const heading = el("h2", "sigil-dialog-title", title);
    const actions = el("div", "sigil-dialog-actions");
    const cancel = el("button", "", st("cancel"));
    cancel.value = "cancel";
    const confirm = el("button", "primary", confirmLabel);
    cancel.type = "submit"; confirm.type = "submit";
    confirm.value = "confirm";
    actions.append(cancel, confirm);
    form.append(heading, ...body, actions);
    dialog.append(form);
    dialog.addEventListener("close", () => { resolve(dialog.returnValue === "confirm"); dialog.remove(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) return "is-meta";
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-del";
  return "";
}

/** Loaded text for a dialog: shown line by line, or `empty` when there is none. */
type DialogText = { text: string; note: string; empty: string; lineClass?: (line: string) => string };

/** Shows loaded text, such as a patch or command output, as literal lines. It lives on the page,
 *  so card refreshes never replace it. */
function textDialog(title: string, loading: string, failed: (error: string) => string, load: () => Promise<DialogText>, extraClass = "") {
  const dialog = el("dialog", "board-dialog sigil-dialog sigil-diff-dialog");
  const form = el("form");
  form.method = "dialog";
  const status = el("p", "sigil-dialog-muted", loading);
  status.setAttribute("role", "status");
  const body = el("pre", `sigil-diff ${extraClass}`.trim());
  body.tabIndex = 0;
  body.hidden = true;
  const actions = el("div", "sigil-dialog-actions");
  const close = el("button", "primary", st("close"));
  close.type = "submit";
  close.value = "close";
  actions.append(close);
  form.append(el("h2", "sigil-dialog-title", title), status, body, actions);
  dialog.append(form);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  void load().then(result => {
    if (!result.text) { status.textContent = result.empty; return; }
    status.textContent = result.note;
    status.hidden = !result.note;
    for (const line of result.text.replace(/\n$/, "").split("\n")) body.append(el("span", result.lineClass?.(line) ?? "", line || " "));
    body.hidden = false;
  }).catch(error => { status.textContent = failed(errorText(error)); });
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
}

/** Timing and exit status of a check, or null when there is nothing to add. */
function checkMeta(result: CheckResult, definition: SigilCheck | undefined): HTMLElement | null {
  if (result.status === "running" && result.started_at_ms) {
    const elapsed = el("small", "sigil-card-check-meta sigil-card-elapsed");
    elapsed.dataset.since = String(result.started_at_ms);
    elapsed.textContent = st("checkElapsed", { s: Math.max(0, Math.round((Date.now() - result.started_at_ms) / 1000)) });
    return elapsed;
  }
  if (result.kind !== "command" || !result.started_at_ms || !result.finished_at_ms) return null;
  const parts = [st("checkSeconds", { s: seconds(result.finished_at_ms - result.started_at_ms) })];
  if (result.timed_out && definition?.kind === "command") parts.push(st("checkTimedOut", { s: definition.timeout_s }));
  else if (result.status === "failed" && result.exit_code !== undefined && result.exit_code !== null) parts.push(st("checkExit", { code: result.exit_code }));
  return el("small", "sigil-card-check-meta", parts.join(" · "));
}

function locationLine(location: "worktree" | "in_place", directory: string): HTMLElement {
  const line = el("p", "sigil-dialog-line");
  line.append(el("strong", "", `${st("freezeLocation")}：`), `${location === "worktree" ? st("freezeWorktree") : st("freezeInPlace")} · `);
  line.append(el("code", "", directory));
  return line;
}

function freezeSummary(view: SigilView, autonomous = false): Node[] {
  const { review } = view;
  const nodes: Node[] = [locationLine(review.location, review.execution_directory), el("h3", "sigil-dialog-subtitle", st("freezeCommands"))];
  if (!review.commands.length) nodes.push(el("p", "sigil-dialog-muted", st("freezeNoCommands")));
  else {
    const list = el("ol", "sigil-dialog-commands");
    for (const command of review.commands) {
      const item = el("li");
      item.append(el("span", "sigil-dialog-step", command.step_id), el("code", "", command.argv.join(" ")),
        el("small", "", `${command.label} · ${st("freezeTimeout", { n: command.timeout_s })}`));
      list.append(item);
    }
    nodes.push(list);
  }
  const warnings = review.issues.filter(issue => issue.level === "warning");
  if (warnings.length) {
    nodes.push(el("h3", "sigil-dialog-subtitle", st("freezeWarnings")));
    const list = el("ul", "sigil-dialog-warnings");
    for (const warning of warnings) list.append(el("li", "", warning.step_id ? `${warning.step_id} · ${warning.message}` : warning.message));
    nodes.push(list);
  }
  nodes.push(el("p", "sigil-dialog-consent", st(autonomous ? "executeConsent" : "freezeConsent")));
  return nodes;
}

function instruction(view: SigilView): string {
  if (view.delivery?.fallback_instruction) return view.delivery.fallback_instruction;
  const { sigil } = view;
  const directory = sigil.run?.execution_directory ?? sigil.freeze?.execution_directory ?? sigil.repository;
  return st("instruction", { id: sigil.id, title: sigil.title || st("untitled"), dir: directory });
}

function hasOriginalSession(view: SigilView): boolean {
  return Boolean(view.delivery?.thread_id?.trim() && view.sigil.owner_source
    && view.delivery.source_id === view.sigil.owner_source);
}

/** The verified original session may take this plan; its run state is a separate question. */
function canHandOver(view: SigilView): boolean {
  return hasOriginalSession(view) && !view.delivery?.handover_unavailable;
}

function handoverReason(code: string): string {
  const key = `handover.${code}` as SigilKey;
  const text = st(key);
  return text === key ? st("handover.unknown") : text;
}

function dispatchSummary(view: SigilView, retry = false): Node[] {
  const { sigil, delivery } = view;
  if (!delivery) return [];
  const targetDirectory = el("p", "sigil-dialog-line");
  targetDirectory.append(el("strong", "", `${st("dispatchCwd")}: `), el("code", "", delivery.cwd ?? st("dispatchCwdUnknown")));
  return [el("p", "", st(retry ? "dispatchRetryBody" : "dispatchBody")),
    el("p", "", st("dispatchTarget", { label: delivery.target_label })),
    el("p", "", st("dispatchSource", { source: delivery.source_id })),
    el("p", "", st("dispatchThread", { thread: delivery.thread_id ?? "" })), targetDirectory,
    locationLine(sigil.location, sigil.run?.execution_directory ?? sigil.freeze?.execution_directory ?? view.review.execution_directory)];
}

function stageText(current: SigilView): string {
  const { sigil } = current;
  if (sigil.state === "draft") return current.review.can_freeze ? st("stageDraftReady")
    : st("stageDraftNeeds", { n: current.review.issues.filter(issue => issue.level === "error").length });
  if (sigil.state === "frozen") return st("stageFrozen");
  if (sigil.state === "paused") return st("stagePaused");
  if (sigil.state === "completed") return st("stageCompleted");
  if (sigil.state === "aborted") return st("stageAborted");
  if (sigil.state === "archived") return st("stageArchived");
  if (!sigil.run?.executor) return st("stageWaiting");
  const checks = Object.values(sigil.run.steps ?? {}).flatMap(progress => progress.checks ?? []);
  if (current.pending_commands?.length || Object.values(current.lights).includes("needs_you")
    || checks.some(check => check.status === "waiting" || check.status === "needs_approval")) return st("stageNeedsYou");
  if (checks.some(check => check.status === "running" || check.status === "queued")
    || Object.values(current.lights).includes("verifying")) return st("stageVerifying");
  return st("stageActive", { label: sigil.run.executor.label });
}

export function mountSigilCard(host: HTMLElement, reference: SigilReference, onTitle: (title: string) => void): SigilCard {
  const root = el("section", "sigil-card");
  root.setAttribute("aria-live", "polite");
  const kind = el("small", "sigil-card-kind");
  const state = el("span", "sigil-card-state");
  const title = el("h3", "sigil-card-title");
  const explain = el("p", "sigil-card-explain");
  const owner = el("p", "sigil-card-owner");
  const goal = el("p", "sigil-card-goal");
  const stage = el("p", "sigil-card-stage");
  const delivery = el("div", "sigil-card-delivery");
  const deliveryInfo = el("div", "sigil-card-delivery-info");
  // One persistent alert: re-inserting it on every live refresh would announce it again.
  const deliveryAlert = el("p", "sigil-card-delivery-error");
  deliveryAlert.setAttribute("role", "alert");
  deliveryAlert.hidden = true;
  delivery.append(deliveryInfo, deliveryAlert);
  delivery.hidden = true;
  const run = el("div", "sigil-card-run");
  const stepsLabel = el("strong", "sigil-card-label");
  const steps = el("ol", "sigil-card-steps");
  const outside = el("div", "sigil-card-outside");
  const approvals = el("div", "sigil-card-approvals");
  const amendments = el("div", "sigil-card-amendments");
  const review = el("div", "sigil-card-review");
  const actions = el("div", "sigil-card-actions");
  const notice = el("p", "sigil-card-notice");
  notice.setAttribute("role", "status");
  root.append(kind, state, title, explain, owner, goal, stage, delivery, run, approvals, stepsLabel, steps, outside, amendments, review, actions, notice);
  host.append(root);

  let phase: "loading" | "ready" | "unavailable" = "loading";
  let view: SigilView | null = null, loading = false, queued = false, destroyed = false, busy = false;
  let message = "";
  let actionFocus: string | undefined;
  /** Open change lists survive the refreshes that live progress brings. */
  const expanded = new Set<string>();
  const decisionNotes = new Map<string, string>();
  const decisionKey = (step: SigilStep, result: CheckResult) => `decision:${step.id}:${result.index}:${result.attempt}`;

  const button = (label: string, action: () => Promise<void>, disabled = false, key = label) => {
    const node = el("button", "sigil-card-action", label);
    node.type = "button";
    node.disabled = disabled || busy;
    node.dataset.key = `action:${key}`;
    node.addEventListener("click", () => {
      if (busy || destroyed) return;
      actionFocus = node.dataset.key;
      busy = true; message = ""; render();
      void action().catch(error => { if (!destroyed) message = st("failed", { error: errorText(error) }); })
        .finally(() => { if (!destroyed) { busy = false; refresh(); } });
    });
    return node;
  };

  const toggle = (key: string, label: string, extraClass = "") => {
    const node = el("button", `sigil-card-toggle ${extraClass}`.trim(), label);
    node.type = "button";
    node.dataset.key = key;
    node.setAttribute("aria-expanded", String(expanded.has(key)));
    node.addEventListener("click", () => {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
    });
    return node;
  };

  const showDiff = (target: { step_id?: string; outside?: number; path?: string }, label: string) => {
    textDialog(st("diffTitle", { target: label }), st("diffLoading"), error => st("diffFailed", { error }), async () => {
      const diff = await fetchSigilDiff(reference.sigil_id, target);
      return { text: diff.patch, empty: st("diffEmpty"), lineClass: diffLineClass,
        note: diff.truncated ? st("diffTruncated", { n: Math.round(diff.max_bytes / 1024) }) : "" };
    });
  };

  const showOutput = (stepId: string, result: CheckResult) => {
    textDialog(st("outputTitle", { label: result.label }), st("outputLoading"), error => st("outputFailed", { error }), async () => {
      const step = await fetchSigilStep(reference.sigil_id, stepId);
      const truncated = (result.output_bytes ?? 0) > step.max_output_bytes;
      return { text: step.outputs[String(result.run)] ?? "", empty: st("outputEmpty"),
        note: truncated ? st("outputTruncated", { n: Math.round(step.max_output_bytes / 1024) }) : "" };
    }, "sigil-output");
  };

  /** Record a manual decision directly, with the optional note kept beside its check. */
  const decide = (step: SigilStep, result: CheckResult, passed: boolean) => button(passed ? st("decidePass") : st("decideFail"), async () => {
    const key = decisionKey(step, result);
    await decideCheck(reference.sigil_id, step.id, result.index, passed, (decisionNotes.get(key) ?? "").trim());
    decisionNotes.delete(key);
  }, false, `${decisionKey(step, result)}:${passed ? "pass" : "fail"}`);

  const checkRows = (step: SigilStep, progress: StepProgress, current: SigilView) => {
    const results = progress.checks ?? [];
    const box = el("div", "sigil-card-checks");
    const latest = results.some(result => result.attempt === progress.attempt);
    box.append(el("p", "sigil-card-checks-title", latest ? st("checksTitle") : st("checkPrevious", { n: results[0]?.attempt ?? 0 })));
    const open = current.sigil.state === "running" || current.sigil.state === "paused";
    const live = current.check_live;
    const list = el("ul", "sigil-card-check-list");
    for (const result of results) {
      const definition = step.checks[result.index];
      const row = el("li", "sigil-card-check");
      row.dataset.status = result.status;
      const head = el("div", "sigil-card-check-head");
      head.append(el("span", "sigil-card-check-status", st(`check.${result.status}` as SigilKey)), el("span", "sigil-card-check-label", result.label));
      const meta = checkMeta(result, definition);
      if (meta) head.append(meta);
      row.append(head);
      if (definition?.kind === "command") row.append(el("code", "sigil-card-check-argv", definition.argv.join(" ")));
      else if (definition?.kind === "manual" && definition.description) row.append(el("p", "sigil-card-check-text", definition.description));
      if (result.note) row.append(el("p", "sigil-card-check-text", st("decidedNote", { note: result.note })));
      if (result.error && result.status !== "passed") row.append(el("p", "sigil-card-check-error", result.error));
      if (result.disturbed?.length) {
        const disturbed = el("p", "sigil-card-check-disturbed", st("checkDisturbed"));
        disturbed.title = result.disturbed.join("\n");
        row.append(disturbed);
      }
      const output = result.status === "running" && live && live.run === result.run ? live.output_tail : result.tail;
      if (output) row.append(el("pre", "sigil-card-check-tail", lastLines(output, 8)));
      const buttons = el("div", "sigil-card-check-actions");
      if (result.kind === "command" && result.run && result.status !== "running") {
        const show = el("button", "sigil-card-toggle", st("checkOutput"));
        show.type = "button";
        show.dataset.key = `output:${step.id}:${result.run}`;
        show.addEventListener("click", () => showOutput(step.id, result));
        buttons.append(show);
      }
      // A decided check offers only the other decision, to change it until the run ends.
      const completedReview = current.sigil.state === "completed" && current.sigil.run?.automation === "autonomous"
        && definition?.kind === "manual" && definition.blocking !== true;
      if (result.kind === "manual" && (open || completedReview) && progress.status === "reported" && result.attempt === progress.attempt) {
        const note = el("textarea", "sigil-card-decision-note");
        const key = decisionKey(step, result);
        note.dataset.key = key;
        note.placeholder = st("decideNote");
        note.setAttribute("aria-label", st("decideNote"));
        note.rows = 2;
        note.value = decisionNotes.get(key) ?? "";
        note.disabled = busy;
        note.addEventListener("input", () => decisionNotes.set(key, note.value));
        row.append(note);
        if (result.status !== "passed") buttons.append(decide(step, result, true));
        if (result.status !== "failed") buttons.append(decide(step, result, false));
      }
      if (buttons.childElementCount) row.append(buttons);
      list.append(row);
    }
    box.append(list);
    const rerunnable = open && progress.status === "reported" && results.some(result => result.kind === "command"
      && result.attempt === progress.attempt && (result.status === "passed" || result.status === "failed" || result.status === "stopped"));
    if (rerunnable) box.append(button(st("rerun"), async () => { await rerunChecks(reference.sigil_id, step.id); }));
    return box;
  };

  const fileList = (files: ChangedPath[], total: number, keyPrefix: string, open: (path: string) => void) => {
    const list = el("ul", "sigil-card-files");
    for (const file of files.slice(0, VISIBLE_FILES)) {
      const row = el("li", "sigil-card-file");
      row.dataset.status = file.status;
      const status = el("span", "sigil-card-file-status", file.status);
      status.title = st(`status.${file.status}` as SigilKey);
      let name: HTMLElement;
      if (file.size === undefined) {
        const link = el("button", "sigil-card-file-path", file.path);
        link.type = "button";
        link.title = `${file.path} · ${st("openDiff")}`;
        link.dataset.key = `${keyPrefix}:${file.path}`;
        link.addEventListener("click", () => open(file.path));
        name = link;
      } else {
        name = el("span", "sigil-card-file-path", file.path);
        name.title = file.path;
      }
      const meta = file.size !== undefined ? st("notStored", { size: formatSize(file.size) })
        : file.binary ? st("binary") : `+${file.added ?? 0} −${file.deleted ?? 0}`;
      row.append(status, name, el("small", "sigil-card-file-meta", meta));
      if (file.out_of_scope) row.append(el("span", "sigil-card-file-scope", st("outsideScope")));
      list.append(row);
    }
    const hidden = total - Math.min(files.length, VISIBLE_FILES);
    if (hidden > 0) list.append(el("li", "sigil-card-more", st("moreFiles", { n: hidden })));
    return list;
  };

  const stepDetails = (step: SigilStep, progress: StepProgress, current: SigilView) => {
    const box = el("div", "sigil-card-step-details");
    const markers = progress.markers ?? [];
    if (markers.length) {
      const list = el("ul", "sigil-card-marker-list");
      for (const marker of markers) {
        const item = el("li");
        item.append(el("strong", "", st(`marker.${marker.kind}` as SigilKey)));
        if (marker.detail) item.append(el("span", "", marker.detail));
        list.append(item);
      }
      box.append(list);
    }
    if (progress.checks?.length) box.append(checkRows(step, progress, current));
    const changes = progress.changes ?? [];
    if (changes.length) {
      box.append(fileList(changes, progress.changed_files ?? changes.length, `diff:${step.id}`, path => showDiff({ step_id: step.id, path }, path)));
      const whole = el("button", "sigil-card-toggle", st("wholeStep"));
      whole.type = "button";
      whole.dataset.key = `whole:${step.id}`;
      whole.addEventListener("click", () => showDiff({ step_id: step.id }, step.title));
      box.append(whole);
    }
    return box;
  };

  const renderSteps = (current: SigilView) => {
    steps.replaceChildren();
    const all = current.sigil.steps;
    stepsLabel.textContent = st("steps", { n: all.length });
    if (!all.length) { steps.append(el("li", "sigil-card-empty", st("noSteps"))); return; }
    for (const step of all.slice(0, VISIBLE_STEPS)) {
      const lightName = current.lights?.[step.id] ?? "pending";
      const progress = current.sigil.run?.steps?.[step.id];
      const item = el("li", "sigil-card-step");
      item.dataset.light = lightName;
      if (current.next === step.id) item.classList.add("is-next");
      const light = el("span", "sigil-light");
      light.dataset.light = lightName;
      const label = el("span", "sigil-card-step-title", step.title);
      const meta = el("small", "", st(`light.${lightName}` as SigilKey));
      item.append(light, label, meta);
      const changed = progress?.changed_files ?? 0;
      const markers = progress?.markers?.length ?? 0;
      const checks = progress?.checks ?? [];
      const latestChecks = checks.filter(check => check.attempt === progress?.attempt);
      if (progress && (changed || markers || checks.length)) {
        const key = `step:${step.id}`;
        const parts: string[] = [];
        if (changed) parts.push(`${fileCount(changed)} ${lineCounts(progress.changes ?? [])}`);
        if (latestChecks.length) parts.push(st("checksCount", { passed: latestChecks.filter(check => check.status === "passed").length, total: step.checks.length }));
        if (markers) parts.push(st("markers", { n: markers }));
        item.append(toggle(key, parts.join(" · ") || st("checksTitle"), markers ? "has-markers" : ""));
        if (progress.status === "blocked" && progress.block_reason) item.append(el("p", "sigil-card-blocked", st("blocked", { reason: progress.block_reason })));
        if (expanded.has(key)) item.append(stepDetails(step, progress, current));
      } else if (progress?.status === "blocked" && progress.block_reason) {
        item.append(el("p", "sigil-card-blocked", st("blocked", { reason: progress.block_reason })));
      }
      if (lightName === "skipped" && (current.sigil.state === "running" || current.sigil.state === "paused")) {
        item.append(button(st("reopen"), async () => { await reopenStep(reference.sigil_id, step.id); }));
      }
      steps.append(item);
    }
    if (all.length > VISIBLE_STEPS) steps.append(el("li", "sigil-card-more", st("moreSteps", { n: all.length - VISIBLE_STEPS })));
  };

  const renderOutside = (current: SigilView) => {
    outside.replaceChildren();
    const windows = current.sigil.run?.observation?.outside ?? [];
    if (!windows.length) return;
    outside.append(toggle("outside", st("outsideTitle", { n: windows.length }), "has-markers"));
    if (!expanded.has("outside")) return;
    windows.forEach((gap, index) => {
      const section = el("div", "sigil-card-step-details");
      const label = st("outsideWindow", { n: index + 1, files: fileCount(gap.changed_files) });
      section.append(el("p", "sigil-card-gap", label),
        fileList(gap.files, gap.changed_files, `outside:${index}`, path => showDiff({ outside: index, path }, path)));
      const whole = el("button", "sigil-card-toggle", st("wholeWindow"));
      whole.type = "button";
      whole.dataset.key = `whole-outside:${index}`;
      whole.addEventListener("click", () => showDiff({ outside: index }, label));
      section.append(whole);
      outside.append(section);
    });
  };

  const renderRun = (current: SigilView) => {
    run.replaceChildren();
    const sigilRun = current.sigil.run;
    if (!sigilRun) return;
    run.append(el("p", "sigil-card-automation", st(sigilRun.automation === "autonomous" ? "automationAutonomous" : "automationSupervised")));
    if (sigilRun.automation === "autonomous") run.append(el("p", "sigil-card-observe", st("autonomousBody")));
    const id = reference.sigil_id;
    if (sigilRun.automation !== "autonomous" && (current.sigil.state === "running" || current.sigil.state === "paused")) {
      const upgrade = el("div", "sigil-card-automation-upgrade");
      const action = button(st("automate"), async () => { await automateSigil(id, current.sigil.revision); }, false, "automate");
      action.classList.add("is-primary");
      upgrade.append(el("p", "", st("automateBody")), action);
      if (current.sigil.state === "paused") upgrade.append(el("p", "", st("automatePaused")));
      run.append(upgrade);
    }
    if (sigilRun.executor) {
      run.append(el("p", "sigil-card-executor", st("executor", { label: sigilRun.executor.label })),
        el("p", "sigil-card-source", st("executorSource", { source: sigilRun.executor.source_id })));
    } else run.append(el("p", "sigil-card-executor", st("noExecutor")));
    for (const claim of sigilRun.pending_claims ?? []) {
      const row = el("div", "sigil-card-claim");
      row.append(el("span", "", st("claimRequest", { label: claim.label })),
        button(st("approve"), async () => { await decideHandover(id, claim.source_id, true); }),
        button(st("reject"), async () => { await decideHandover(id, claim.source_id, false); }));
      run.append(row);
    }
    const line = (text: string, warning = false) => run.append(el("p", `sigil-card-observe${warning ? " is-warning" : ""}`, text));
    const checking = Object.values(sigilRun.steps ?? {}).some(progress => (progress.checks ?? []).some(check => check.status === "queued" || check.status === "running"));
    if (current.sigil.state === "paused" && checking) line(st("checksPaused"), true);
    const observation = sigilRun.observation;
    if (!observation) return;
    const live = current.observation_live;
    if (observation.stopped) line(observation.stopped === "size_cap" ? st("observeCap") : st("observeUnavailable", { detail: observation.stopped_detail ?? "" }), true);
    else if (current.sigil.state === "running" || current.sigil.state === "paused") {
      let text = st("observeEvery", { s: Math.round((live?.interval_ms || 10_000) / 1000) });
      if (live && live.duration_ms > live.interval_ms) text += ` · ${st("observeSlow", { s: (live.duration_ms / 1000).toFixed(1) })}`;
      line(text);
      if (live?.error) line(st("observeError", { error: live.error }), true);
    }
    if (observation.partial?.length) line(st("observePartial", { n: observation.partial.length }), true);
    if (observation.inputs_differ_at_start?.length) line(st("inputsDiffer", { paths: observation.inputs_differ_at_start.join(", ") }), true);
  };

  const renderDelivery = (current: SigilView) => {
    const value = current.delivery, { state } = current.sigil;
    // Handover belongs to a frozen plan and its live run. The stage line already explains
    // the lifecycle, and a finished plan's steps are its record.
    const live = state === "frozen" || state === "running" || state === "paused";
    const error = live ? value?.error ?? value?.receipt?.error : undefined;
    const lines: Node[] = [];
    if (live && value?.phase) lines.push(el("p", "sigil-card-delivery-status", st("deliveryStatus", { phase: st(`delivery.${value.phase}` as SigilKey) })));
    const unclaimed = state === "frozen" || (state === "running" && !current.sigil.run?.executor);
    if (unclaimed && !canHandOver(current)) {
      lines.push(el("p", "sigil-card-delivery-fallback", st(state === "frozen" ? "dispatchFallback" : "dispatchFallbackRunning")));
      const reason = value?.handover_unavailable;
      if (reason && !error) lines.push(el("p", "sigil-card-delivery-reason", st("dispatchUnavailable", { reason: handoverReason(reason) })));
    }
    deliveryInfo.replaceChildren(...lines);
    const alert = error ? st("deliveryError", { error }) : "";
    if (deliveryAlert.textContent !== alert) deliveryAlert.textContent = alert;
    deliveryAlert.hidden = !alert;
    delivery.hidden = !lines.length && !alert;
  };

  /** Supervised runs retain individual approvals until the user switches the run's mode. */
  const renderApprovals = (current: SigilView) => {
    approvals.replaceChildren();
    const pending = current.pending_commands ?? [];
    const { sigil } = current;
    if (!pending.length || (sigil.state !== "running" && sigil.state !== "paused")) return;
    approvals.append(el("p", "sigil-card-approvals-title", st("pendingCommands", { n: pending.length })));
    const list = el("ul", "sigil-card-approval-list");
    for (const command of pending) {
      const step = sigil.steps.find(item => item.id === command.step_id);
      const row = el("li", "sigil-card-approval");
      row.append(el("span", "sigil-card-approval-label", `${step?.title ?? command.step_id} · ${command.label}`),
        el("code", "sigil-card-check-argv", command.argv.join(" ")), approveButton(current, command, step?.title ?? command.step_id));
      list.append(row);
    }
    approvals.append(list);
  };

  const approveButton = (current: SigilView, command: PendingCommand, stepTitle: string) => button(st("approveCommand"), async () => {
    const directory = current.sigil.run?.execution_directory ?? "";
    const body = [el("p", "", st("approveBody", { step: stepTitle, dir: directory, n: command.timeout_s })),
      el("pre", "sigil-dialog-command", command.argv.join(" ")), el("p", "sigil-dialog-consent", st("approveConsent"))];
    if (await confirmDialog(st("approveTitle"), body, st("approveConfirm"))) await approveCommand(reference.sigil_id, command.step_id, command.index);
  });

  const changeLine = (current: SigilView, change: AmendmentChange) => {
    const step = current.sigil.steps.find(item => item.id === change.step_id)?.title ?? change.step_id;
    const fields = (change.fields ?? []).map(field => st(`field.${field}` as SigilKey)).join(st("listSep"));
    return st(`change.${change.kind}` as SigilKey, { step, fields });
  };

  /** The agent's plan changes, each revertible by the user while the run is open. */
  const renderAmendments = (current: SigilView) => {
    amendments.replaceChildren();
    const list = current.sigil.run?.amendments ?? [];
    if (!list.length) return;
    amendments.append(toggle("amendments", st("amendmentsTitle", { n: list.length }), "has-markers"));
    if (!expanded.has("amendments")) return;
    const open = current.sigil.state === "running" || current.sigil.state === "paused";
    const items = el("ul", "sigil-card-amendment-list");
    for (const amendment of [...list].reverse()) {
      const item = el("li", "sigil-card-amendment");
      item.dataset.reverted = String(Boolean(amendment.reverted_at_ms));
      item.append(el("strong", "", st("amendmentLine", { revision: amendment.revision, reason: amendment.reason })));
      for (const change of amendment.changes) item.append(el("span", "", changeLine(current, change)));
      if (amendment.reverted_at_ms) item.append(el("small", "sigil-card-amendment-reverted", st("reverted")));
      else if (open) {
        item.append(button(st("revert"), async () => {
          if (await confirmDialog(st("revertTitle", { revision: amendment.revision }), [el("p", "", st("revertBody"))], st("revertConfirm"))) {
            await revertAmendment(reference.sigil_id, amendment.revision);
          }
        }));
      }
      items.append(item);
    }
    amendments.append(items);
  };

  const renderReview = (current: SigilView) => {
    review.replaceChildren();
    const { sigil } = current;
    if (sigil.state === "frozen") { review.append(el("p", "sigil-card-ready", st("frozenAt", { n: sigil.revision }))); return; }
    if (sigil.state !== "draft") return;
    const errors = current.review.issues.filter(issue => issue.level === "error");
    const warnings = current.review.issues.filter(issue => issue.level === "warning");
    if (errors.length) {
      review.append(el("p", "sigil-card-errors", st("errors", { n: errors.length })));
      const list = el("ul", "sigil-card-issues");
      for (const issue of errors) list.append(el("li", "", issue.step_id ? `${issue.step_id} · ${issueMessage(issue)}` : issueMessage(issue)));
      review.append(list);
    } else review.append(el("p", "sigil-card-ready", st("ready")));
    if (warnings.length) {
      const details = el("details", "sigil-card-warnings");
      details.append(el("summary", "", st("warnings", { n: warnings.length })));
      const list = el("ul", "sigil-card-issues");
      for (const issue of warnings) list.append(el("li", "", issue.step_id ? `${issue.step_id} · ${issueMessage(issue)}` : issueMessage(issue)));
      details.append(list);
      review.append(details);
    }
  };

  const renderActions = (current: SigilView) => {
    actions.replaceChildren();
    const { sigil } = current;
    const id = reference.sigil_id;
    if (sigil.state === "draft") {
      const pendingReview = current.review.issues.some(issue => issue.code === "native_review_required");
      if (!pendingReview || isDesktopShell()) {
        const execute = button(st(canHandOver(current) ? "startDispatch" : "start"), async () => {
          const latest = pendingReview ? await reviewSigil(id, sigil.revision) : await fetchSigil(id);
          if (!latest.review.can_freeze) { view = latest; message = latest.review.issues.map(issueMessage).join(" "); return; }
          const handover = canHandOver(latest);
          const body = [...freezeSummary(latest, true), el("p", "sigil-dialog-consent", st("autonomousBody")), ...(handover ? dispatchSummary(latest) : [])];
          if (!await confirmDialog(st(handover ? "startDispatchTitle" : "startTitle"), body, st(handover ? "startDispatchConfirm" : "startConfirm")) || destroyed) return;
          const result = await executeSigil(id, latest.sigil.revision);
          if (destroyed) return;
          if (result.sigil) view = { ...latest, sigil: result.sigil, review: result.review ?? latest.review };
          if (handover) {
            try {
              const startedAt = result.sigil?.run?.started_at_ms;
              if (!Number.isFinite(startedAt) || !startedAt) throw new Error(st("dispatchMissingRun"));
              const delivered = await dispatchSigil(id, startedAt!);
              if (!destroyed) view = delivered;
            } catch (error) { if (!destroyed) message = st("dispatchStartedError", { error: errorText(error) }); }
          }
          if (!destroyed) render();
        }, !current.review.can_freeze && !pendingReview, "execute");
        execute.classList.add("is-primary");
        actions.append(execute);
        actions.append(button(st(pendingReview ? "nativeReviewFreeze" : "freeze"), async () => {
        const latest = pendingReview ? await reviewSigil(id, sigil.revision) : await fetchSigil(id);
        if (!latest.review.can_freeze) { view = latest; message = latest.review.issues.map(issueMessage).join(" "); return; }
        if (await confirmDialog(st("freezeTitle"), freezeSummary(latest), st("freezeConfirm"))) await freezeSigil(id, latest.sigil.revision);
        }, !current.review.can_freeze && !pendingReview));
      }
    }
    if (sigil.state === "frozen") {
      if (canHandOver(current)) {
        const handover = button(st("startDispatch"), async () => {
          if (!await confirmDialog(st("startDispatchTitle"), [...dispatchSummary(current), el("p", "sigil-dialog-consent", st("autonomousBody"))], st("startDispatchConfirm")) || destroyed) return;
          const result = await startSigil(id, sigil.revision);
          if (destroyed) return;
          if (result.sigil) view = { ...current, sigil: result.sigil, review: result.review ?? current.review };
          try {
            const startedAt = result.sigil?.run?.started_at_ms;
            if (!Number.isFinite(startedAt) || !startedAt) throw new Error(st("dispatchMissingRun"));
            const delivered = await dispatchSigil(id, startedAt!);
            if (destroyed) return;
            view = delivered;
          } catch (error) {
            if (!destroyed) message = st("dispatchStartedError", { error: errorText(error) });
          }
          if (!destroyed) render();
        }, false, "start-dispatch");
        handover.classList.add("is-primary");
        actions.append(handover);
      }
      actions.append(button(st("start"), async () => {
        const body = [el("p", "", st("startBody")), locationLine(sigil.location, sigil.freeze?.execution_directory ?? current.review.execution_directory), el("p", "sigil-dialog-consent", st("autonomousBody"))];
        if (await confirmDialog(st("startTitle"), body, st("startConfirm")) && !destroyed) await startSigil(id, sigil.revision);
      }, false, "start"));
      actions.append(button(st("unfreeze"), async () => { await unfreezeSigil(id, sigil.revision); }));
    }
    if (sigil.state === "running" || sigil.state === "paused") {
      const value = current.delivery;
      if (sigil.state === "running" && !sigil.run?.executor && hasOriginalSession(current) && (value?.can_dispatch || value?.can_retry)) {
        const retry = Boolean(value?.can_retry);
        actions.append(button(st(retry ? "dispatchRetry" : "dispatch"), async () => {
          if (!await confirmDialog(st(retry ? "dispatchRetryTitle" : "dispatchTitle"), dispatchSummary(current, retry), st(retry ? "dispatchRetryConfirm" : "dispatchConfirm")) || destroyed) return;
          const startedAt = sigil.run?.started_at_ms;
          if (!Number.isFinite(startedAt) || !startedAt) throw new Error(st("dispatchMissingRun"));
          const delivered = await dispatchSigil(id, startedAt!, retry);
          if (!destroyed) view = delivered;
        }, false, "dispatch"));
      }
      actions.append(button(st("copyInstruction"), async () => { await navigator.clipboard.writeText(instruction(current)); if (!destroyed) message = st("copied"); }, false, "copy-instruction"));
      actions.append(sigil.state === "running"
        ? button(st("pause"), async () => { await controlSigil(id, "pause"); })
        : button(st("resume"), async () => { await controlSigil(id, "resume"); }));
      actions.append(button(st("note"), async () => {
        const text = el("textarea", "sigil-dialog-input");
        text.placeholder = st("notePlaceholder");
        text.rows = 4;
        if (await confirmDialog(st("noteTitle"), [text], st("noteConfirm")) && text.value.trim()) await noteSigil(id, text.value.trim());
      }));
      if (sigil.run?.executor) actions.append(button(st("revoke"), async () => { await controlSigil(id, "revoke"); }));
      actions.append(button(st("abort"), async () => {
        if (await confirmDialog(st("abortTitle"), [el("p", "", st("abortBody"))], st("abortConfirm"))) await controlSigil(id, "abort");
      }));
    }
    if (sigil.state === "draft" || sigil.state === "frozen") {
      actions.append(button(st("remove"), async () => {
        if (!await confirmDialog(st("removeTitle"), [el("p", "", st("removeBody"))], st("removeConfirm"))) return;
        const result = await deleteSigil(id, sigil.revision);
        if (result.kept_cards?.length) message = st("removeKept");
      }));
    }
  };

  function render() {
    if (destroyed) return;
    // Keep keyboard focus on the same control across a re-render.
    const active = (document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.key : undefined) ?? actionFocus;
    const selection = document.activeElement instanceof HTMLTextAreaElement && root.contains(document.activeElement)
      ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] as const : undefined;
    kind.textContent = st("kind");
    kind.title = st("explain");
    root.dataset.state = phase === "ready" && view ? view.sigil.state : phase;
    notice.textContent = message;
    if (phase === "ready" && view) {
      const { sigil } = view;
      state.textContent = st(`state.${sigil.state}`);
      title.textContent = sigil.title.trim() || st("untitled");
      explain.textContent = sigil.state === "draft" ? st("explain") : "";
      explain.hidden = sigil.state !== "draft";
      owner.textContent = sigil.owner_source ? st("ownerAgent", { source: sigil.owner_source }) : st("ownerNone");
      goal.textContent = sigil.goal.trim();
      goal.hidden = !sigil.goal.trim();
      stage.textContent = stageText(view);
      stage.hidden = false;
      renderDelivery(view);
      renderRun(view); renderApprovals(view); renderSteps(view); renderOutside(view); renderAmendments(view); renderReview(view); renderActions(view);
      onTitle(title.textContent);
    } else {
      for (const node of [explain, goal, stage, delivery]) node.hidden = true;
      owner.textContent = ""; stepsLabel.textContent = "";
      for (const section of [run, approvals, steps, outside, amendments, review, actions]) section.replaceChildren();
      const label = phase === "unavailable" ? st("unavailable") : st("loading");
      state.textContent = label; title.textContent = label; onTitle(label);
    }
    if (active) {
      const target = [...root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button[data-key], textarea[data-key]")].find(node => node.dataset.key === active && !node.disabled);
      if (target) { target.focus({ preventScroll: true }); if (target instanceof HTMLTextAreaElement && selection) target.setSelectionRange(...selection); actionFocus = undefined; }
    }
    tickElapsed();
  }

  /** A running command's elapsed time counts up between server refreshes. */
  let ticker: number | undefined;
  function tickElapsed() {
    const update = () => {
      const running = root.querySelectorAll<HTMLElement>(".sigil-card-elapsed");
      for (const node of running) node.textContent = st("checkElapsed", { s: Math.max(0, Math.round((Date.now() - Number(node.dataset.since)) / 1000)) });
      if (!running.length && ticker !== undefined) { window.clearInterval(ticker); ticker = undefined; }
      return running.length > 0;
    };
    if (update() && ticker === undefined) ticker = window.setInterval(update, 1000);
  }

  function refresh() {
    if (destroyed) return;
    ensureSigilListener();
    if (loading) { queued = true; return; }
    loading = true;
    void fetchSigil(reference.sigil_id).then(value => {
      if (destroyed) return;
      if (!value?.sigil || value.sigil.id !== reference.sigil_id || !Array.isArray(value.sigil.steps) || !value.review) throw new Error("invalid sigil response");
      view = value; phase = "ready";
    }).catch(() => { if (!destroyed) { view = null; phase = "unavailable"; } })
      .finally(() => {
        loading = false;
        if (destroyed) return;
        render();
        if (queued) { queued = false; refresh(); }
      });
  }

  const unwatch = watchSigil(reference.sigil_id, refresh);
  render(); refresh();
  return { refresh, refreshLabels: render, destroy() { destroyed = true; queued = false; unwatch(); window.clearInterval(ticker); root.remove(); } };
}

import "./styles.css";
import {
  createNode,
  deleteNode,
  fetchBoard,
  fetchForms,
  fetchProviders,
  importTranscript as importTranscriptApi,
  loadSettings,
  patchNode,
  resetBoard,
  saveSettings,
  sendChat,
  setForm as setFormApi,
} from "./api";
import { connectEnvironment, embedded, publishBoard, publishSelect, publishUttered } from "./embed";
import { createShell, isDesktopShell } from "./shell";
import { listScreens } from "./screens";
import { renderConstellation } from "./forms/constellation";
import { mountSpatial } from "./forms/spatial";
import { renderStack } from "./forms/stack";
import { renderTimeline } from "./forms/timeline";
import {
  applyDom,
  currentLocale,
  LOCALES,
  onLocale,
  providerHint as hintForProvider,
  providerLabel,
  setLocale,
  t,
} from "./i18n";
import type { Locale } from "./i18n";
import type {
  BoardSnapshot,
  FormInfo,
  FragmentWeight,
  NodeKind,
  ProviderInfo,
  Settings,
  StageForm,
  Surface,
  ThrownBubble,
} from "./types";
import { FORMS, formLabel, formReason, kindLabel, KINDS, weightLabel, WEIGHTS } from "./types";

const plane = document.querySelector<HTMLElement>("#plane")!;
const spatial = document.querySelector<HTMLCanvasElement>("#spatial")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const formsNav = document.querySelector<HTMLElement>("#forms")!;
const topicEl = document.querySelector<HTMLElement>("#topic")!;
const reasonEl = document.querySelector<HTMLElement>("#form-reason")!;
const logEl = document.querySelector<HTMLOListElement>("#log")!;
const inspector = document.querySelector<HTMLElement>("#inspector")!;
const input = document.querySelector<HTMLTextAreaElement>("#input")!;
const talk = document.querySelector<HTMLFormElement>("#talk")!;
const settingsDlg = document.querySelector<HTMLDialogElement>("#settings")!;
const importerDlg = document.querySelector<HTMLDialogElement>("#importer")!;
const providerSel = document.querySelector<HTMLSelectElement>("#provider")!;
const providerHint = document.querySelector<HTMLElement>("#provider-hint")!;

let board: BoardSnapshot = {
  topic: "",
  form: "constellation",
  form_reason: "",
  nodes: [],
  edges: [],
  messages: [],
};
let selected: string | null = null;
let settings: Settings = loadSettings();
let providers: ProviderInfo[] = [];
let forms: FormInfo[] = [];
let spatialHandle: ReturnType<typeof mountSpatial> | null = null;
let focusNode: string | null = null;
let sending = false;
let inspectorId: string | null = null;
let mode: Surface = initialMode();
let peekItem: ThrownBubble | null = null;
let screenCount = 1;

const insTitle = document.querySelector<HTMLInputElement>("#ins-title")!;
const insBody = document.querySelector<HTMLTextAreaElement>("#ins-body")!;
const insKind = document.querySelector<HTMLSelectElement>("#ins-kind")!;
const insWeight = document.querySelector<HTMLSelectElement>("#ins-weight")!;
const desktop = document.querySelector<HTMLElement>("#desktop")!;
const peek = document.querySelector<HTMLElement>("#peek")!;
const peekTitle = document.querySelector<HTMLElement>("#peek-title")!;
const peekBody = document.querySelector<HTMLElement>("#peek-body")!;
const peekNote = document.querySelector<HTMLTextAreaElement>("#peek-note")!;
const ambientInput = document.querySelector<HTMLInputElement>("#ambient-input")!;
const ambientHint = document.querySelector<HTMLElement>("#ambient-hint")!;
const ambientForm = document.querySelector<HTMLFormElement>("#ambient-form")!;

function initialMode(): Surface {
  const q = new URLSearchParams(location.search).get("mode");
  if (q === "ambient" || q === "focus") return q;
  if (embedded) return "focus";
  try {
    const saved = localStorage.getItem("orbit.mode");
    if (saved === "ambient" || saved === "focus") return saved;
  } catch {
    /* ignore */
  }
  return "ambient";
}

const shell = createShell(desktop, {
  onPoke: (item) => handlePoke(item),
});

function applyMode() {
  document.body.classList.toggle("mode-ambient", mode === "ambient");
  document.body.classList.toggle("mode-focus", mode === "focus");
}

async function setMode(next: Surface, opts?: { persist?: boolean }) {
  mode = next;
  applyMode();
  if (opts?.persist !== false) {
    try {
      localStorage.setItem("orbit.mode", next);
    } catch {
      /* ignore */
    }
  }
  if (next === "focus") {
    await shell.clear();
    closePeek();
    if (spatialHandle) {
      /* stage becomes visible again */
    }
  } else if (spatialHandle) {
    spatialHandle.destroy();
    spatialHandle = null;
  }
  paint();
}

async function boot() {
  try {
    [board, providers, forms] = await Promise.all([fetchBoard(), fetchProviders(), fetchForms()]);
  } catch (err) {
    reasonEl.textContent = err instanceof Error ? err.message : t("error.backend");
    forms = FORMS.map((id) => ({ id, label: formLabel(id), blurb: "" }));
    providers = [
      {
        id: "orbit",
        label: t("provider.orbit"),
        kind: "local",
        default_model: "orbit-local",
        default_base_url: "",
        needs_key: false,
        hint: t("providerHint.orbit"),
      },
    ];
  }
  applyMode();
  try {
    screenCount = (await listScreens()).length || 1;
  } catch {
    screenCount = 1;
  }
  connectEnvironment({
    utter: async (text, focus) => {
      if (focus) focusNode = focus;
      await converse(text);
    },
    importTranscript: async (transcript) => {
      board = await importTranscriptApi(transcript);
      selected = null;
      paint();
    },
    setForm: async (form) => {
      board = await setFormApi(form);
      paint();
    },
    reset: async () => {
      board = await resetBoard();
      selected = null;
      focusNode = null;
      paint();
    },
    getBoard: () => board,
  });
  fillLocaleSelect();
  applyDom();
  fillKindWeight();
  paintForms();
  paintProviders();
  paint();
  syncAmbientHint();
  document.querySelector("#mode-focus")?.addEventListener("click", () => void setMode("focus"));
  document.querySelector("#mode-desktop")?.addEventListener("click", () => void setMode("ambient"));
  onLocale(() => {
    applyDom();
    fillKindWeight();
    paintForms();
    paintProviders();
    paint();
    syncAmbientHint();
  });
}

function fillLocaleSelect() {
  const sel = document.querySelector<HTMLSelectElement>("#locale")!;
  sel.innerHTML = LOCALES.map(
    (item) =>
      `<option value="${item.id}" ${item.id === currentLocale() ? "selected" : ""}>${item.native}</option>`,
  ).join("");
  sel.onchange = () => setLocale(sel.value as Locale);
}

function fillKindWeight() {
  insKind.innerHTML = KINDS.map((id) => `<option value="${id}">${kindLabel(id)}</option>`).join("");
  insWeight.innerHTML = WEIGHTS.map((id) => `<option value="${id}">${weightLabel(id)}</option>`).join("");
}

function paintForms() {
  formsNav.innerHTML = forms
    .map(
      (f) =>
        `<button type="button" data-form="${f.id}" class="${f.id === board.form ? "is-on" : ""}" title="${formReason(f.id)}">${formLabel(f.id)}</button>`,
    )
    .join("");
  formsNav.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const form = btn.dataset.form as StageForm;
      try {
        board = await setFormApi(form);
        selected = selected && board.nodes.some((n) => n.id === selected) ? selected : null;
        paint();
      } catch (err) {
        flash(err);
      }
    });
  });
}

function paintProviders() {
  providerSel.innerHTML = providers
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === settings.provider ? "selected" : ""}>${providerLabel(p.id, p.label)}</option>`,
    )
    .join("");
  syncProviderFields();
}

function syncProviderFields() {
  const meta = providers.find((p) => p.id === providerSel.value);
  providerHint.textContent = meta ? hintForProvider(meta.id, meta.hint) : "";
  const model = document.querySelector<HTMLInputElement>("#model")!;
  const key = document.querySelector<HTMLInputElement>("#api-key")!;
  const base = document.querySelector<HTMLInputElement>("#base-url")!;
  if (!model.value) model.placeholder = meta?.default_model || t("settings.modelPh");
  if (!base.value) base.placeholder = meta?.default_base_url || t("settings.basePh");
  key.parentElement!.style.display = meta && !meta.needs_key ? "none" : "";
}

function paint() {
  topicEl.textContent = board.topic || t("topic.empty");
  reasonEl.textContent = formReason(board.form);
  empty.hidden = board.nodes.length > 0;
  paintLog();
  paintInspector();
  paintFormsState();
  paintStage();
  publishBoard(board);
}

function paintFormsState() {
  formsNav.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.form === board.form);
  });
}

function paintLog() {
  logEl.innerHTML = board.messages
    .slice(-8)
    .map((m) => `<li class="${m.role}">${escape(m.content)}</li>`)
    .join("");
  logEl.scrollTop = logEl.scrollHeight;
}

function paintInspector() {
  const node = board.nodes.find((n) => n.id === selected);
  inspector.hidden = !node;
  if (!node) {
    inspectorId = null;
    return;
  }
  const editing = inspector.contains(document.activeElement);
  if (editing && inspectorId === node.id) return;
  inspectorId = node.id;
  insTitle.value = node.title;
  insBody.value = node.body;
  insKind.value = node.kind;
  insWeight.value = node.weight;
}

function paintStage() {
  const isSpatial = board.form === "spatial";
  spatial.hidden = !isSpatial;
  plane.hidden = isSpatial;

  if (isSpatial) {
    if (!spatialHandle) {
      spatialHandle = mountSpatial(spatial, board, selected, onSelect);
    } else {
      spatialHandle.update(board, selected);
    }
    return;
  }

  if (spatialHandle) {
    spatialHandle.destroy();
    spatialHandle = null;
  }
  plane.replaceChildren();
  if (board.form === "timeline") renderTimeline(plane, board, selected, onSelect);
  else if (board.form === "stack") renderStack(plane, board, selected, onSelect);
  else {
    renderConstellation(plane, board, selected, {
      onSelect,
      onMove: (id, x, z) => void moveFragment(id, x, z),
      onCreateAt: (x, z) => void addFragment({ x, z }),
    });
  }
}

function onSelect(id: string | null) {
  selected = id;
  paintInspector();
  publishSelect(board.nodes.find((n) => n.id === id) ?? null);
  if (board.form === "spatial" && spatialHandle) {
    spatialHandle.update(board, selected);
    spatialHandle.focus(id);
  } else {
    paintStage();
  }
}

talk.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;
  await converse(text);
});

ambientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = ambientInput.value.trim();
  if (!text || sending) return;
  await converse(text);
});

async function addFragment(pos?: { x?: number; z?: number }) {
  try {
    const node = await createNode({
      title: t("fragment.newTitle"),
      body: t("fragment.newBody"),
      kind: "idea",
      weight: "note",
      x: pos?.x ?? 0,
      y: 0,
      z: pos?.z ?? 0,
    });
    board = await fetchBoard();
    selected = node.id;
    paint();
    insTitle.focus();
    insTitle.select();
  } catch (err) {
    flash(err);
  }
}

async function moveFragment(id: string, x: number, z: number) {
  const node = board.nodes.find((n) => n.id === id);
  if (node) {
    node.x = x;
    node.z = z;
  }
  try {
    await patchNode(id, { x, z });
  } catch (err) {
    flash(err);
  }
}

async function saveInspector() {
  if (!selected) return;
  const node = board.nodes.find((n) => n.id === selected);
  if (!node) return;
  const title = insTitle.value.trim() || node.title;
  const body = insBody.value;
  const kind = insKind.value as NodeKind;
  const weight = insWeight.value as FragmentWeight;
  node.title = title;
  node.body = body;
  node.kind = kind;
  node.weight = weight;
  try {
    await patchNode(selected, { title, body, kind, weight });
    paintStage();
  } catch (err) {
    flash(err);
  }
}

document.querySelector("#add-btn")!.addEventListener("click", () => void addFragment());
document.querySelector("#empty-add")?.addEventListener("click", () => void addFragment());

insTitle.addEventListener("change", () => void saveInspector());
insBody.addEventListener("change", () => void saveInspector());
insKind.addEventListener("change", () => void saveInspector());
insWeight.addEventListener("change", () => void saveInspector());

document.querySelector("#delete-btn")!.addEventListener("click", async () => {
  if (!selected) return;
  try {
    board = await deleteNode(selected);
    selected = null;
    paint();
  } catch (err) {
    flash(err);
  }
});

window.addEventListener("keydown", (event) => {
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement;
  if (event.key === "n" && !typing && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    void addFragment();
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !typing && selected) {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>("#delete-btn")?.click();
  }
  if (event.key === "Escape") {
    if (!peek.hidden) {
      closePeek();
      return;
    }
    selected = null;
    paintInspector();
    paintStage();
  }
});

document.querySelector("#focus-btn")!.addEventListener("click", async () => {
  if (!selected) return;
  focusNode = selected;
  input.value = input.value.trim() || t("focus.prompt");
  input.focus();
});

document.querySelector("#clear-btn")!.addEventListener("click", async () => {
  try {
    board = await resetBoard();
    selected = null;
    focusNode = null;
    paint();
  } catch (err) {
    flash(err);
  }
});

document.querySelector("#settings-btn")!.addEventListener("click", () => {
  document.querySelector<HTMLInputElement>("#model")!.value = settings.model;
  document.querySelector<HTMLInputElement>("#api-key")!.value = settings.apiKey;
  document.querySelector<HTMLInputElement>("#base-url")!.value = settings.baseUrl;
  providerSel.value = settings.provider;
  syncProviderFields();
  settingsDlg.showModal();
});

providerSel.addEventListener("change", syncProviderFields);

document.querySelector("#save-settings")!.addEventListener("click", (event) => {
  event.preventDefault();
  settings = {
    provider: providerSel.value,
    model: document.querySelector<HTMLInputElement>("#model")!.value.trim(),
    apiKey: document.querySelector<HTMLInputElement>("#api-key")!.value.trim(),
    baseUrl: document.querySelector<HTMLInputElement>("#base-url")!.value.trim(),
  };
  saveSettings(settings);
  settingsDlg.close();
});

document.querySelector("#import-btn")!.addEventListener("click", () => {
  importerDlg.showModal();
});

document.querySelector("#do-import")!.addEventListener("click", async (event) => {
  event.preventDefault();
  const transcript = document.querySelector<HTMLTextAreaElement>("#transcript")!.value;
  try {
    board = await importTranscriptApi(transcript);
    selected = null;
    importerDlg.close();
    paint();
  } catch (err) {
    flash(err);
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    talk.requestSubmit();
  }
});

async function converse(text: string) {
  sending = true;
  document.body.classList.add("busy");
  document.querySelector<HTMLButtonElement>("#send")!.disabled = true;
  ambientForm.querySelector("button")?.setAttribute("disabled", "true");
  try {
    try {
      screenCount = (await listScreens()).length || screenCount;
    } catch {
      /* keep last count */
    }
    const res = await sendChat([{ role: "user", content: text }], settings, focusNode, mode, screenCount);
    board = await fetchBoard();
    input.value = "";
    ambientInput.value = "";
    focusNode = null;
    if (mode === "ambient") {
      paint();
      const throws = res.throws ?? [];
      if (throws.length) {
        await shell.throwAll(throws);
        ambientHint.textContent = isDesktopShell() ? t("ambient.threw") : t("ambient.preview");
      } else {
        ambientHint.textContent = t("ambient.held");
      }
    } else {
      selected = res.nodes[0]?.id ?? selected;
      paint();
    }
    publishUttered(res.reply, res.form, res.nodes.length);
  } catch (err) {
    flash(err);
  } finally {
    sending = false;
    document.body.classList.remove("busy");
    document.querySelector<HTMLButtonElement>("#send")!.disabled = false;
    ambientForm.querySelector("button")?.removeAttribute("disabled");
    if (mode === "focus") input.focus();
    else ambientInput.focus();
  }
}

function syncAmbientHint() {
  if (!ambientHint) return;
  ambientHint.textContent = isDesktopShell() ? t("ambient.hint") : t("ambient.preview");
}

function handlePoke(item: ThrownBubble) {
  peekItem = item;
  if (item.on_poke === "focus") {
    if (item.node_id) selected = item.node_id;
    void setMode("focus");
    return;
  }
  if (item.on_poke === "pin") {
    closePeek();
    ambientHint.textContent = t("ambient.pinned");
    return;
  }
  openPeek(item, item.on_poke === "reply");
}

function openPeek(item: ThrownBubble, replyFirst: boolean) {
  peekItem = item;
  peek.hidden = false;
  peekTitle.textContent = item.title;
  peekBody.textContent = item.body;
  peekNote.value = "";
  if (replyFirst) peekNote.focus();
}

function closePeek() {
  peek.hidden = true;
  peekItem = null;
}

document.querySelector("#peek-reply")?.addEventListener("click", async () => {
  const item = peekItem;
  const note = peekNote.value.trim();
  if (!item || !note || sending) return;
  if (item.node_id) focusNode = item.node_id;
  closePeek();
  await converse(note);
});

document.querySelector("#peek-focus")?.addEventListener("click", () => {
  if (peekItem?.node_id) selected = peekItem.node_id;
  closePeek();
  void setMode("focus");
});

document.querySelector("#peek-dismiss")?.addEventListener("click", () => {
  closePeek();
});

ambientInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    ambientForm.requestSubmit();
  }
});

function flash(err: unknown) {
  const msg = err instanceof Error ? err.message : t("error.generic");
  reasonEl.textContent = msg;
  ambientHint.textContent = msg;
}

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

boot();

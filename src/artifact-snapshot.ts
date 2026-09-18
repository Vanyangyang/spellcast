import { apiBase, fetchArtifact } from "./api";
import { currentLocale } from "./i18n";
import type { ArtifactStatePreview, ReplyArtifactReference } from "./reply-types";
import "./artifacts.css";

const words = {
  "zh-CN": {
    close: "关闭", reproduce: "重现保存状态", loading: "正在加载保存的参数…", ready: "这是保存参数的只读重现。", noPreview: "此状态没有已保存的画面。", saved: "已保存状态", note: "展示的是保存参数的重现；动画不会逐像素冻结。", failed: "无法重现保存状态。",
  },
  en: {
    close: "Close", reproduce: "Reproduce saved state", loading: "Loading the saved parameters…", ready: "This is a read-only replay of the saved parameters.", noPreview: "No image was saved for this state.", saved: "Saved state", note: "This reproduces saved parameters; animation is not frozen pixel by pixel.", failed: "The saved state could not be reproduced.",
  },};
type Word = keyof typeof words.en;
function t(key: Word) { return words[currentLocale()][key]; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const element = document.createElement(tag); element.className = cls; element.textContent = text; return element;
}

const MAX_PREVIEW_BYTES = 256 * 1024;
function validPreview(value: unknown): value is ArtifactStatePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Partial<ArtifactStatePreview>;
  if (typeof preview.src !== "string" || typeof preview.alt !== "string" || preview.alt.length > 2000) return false;
  if (new TextEncoder().encode(preview.src).length > MAX_PREVIEW_BYTES) return false;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/i.test(preview.src) || preview.src.startsWith("/artifacts/");
}

/** Opens a saved-state viewer. The live work is never reused or mutated. */
export function openArtifactSnapshot(reference: ReplyArtifactReference): void {
  const savedState = structuredClone(reference.state);
  const preview = validPreview(reference.preview) ? { ...reference.preview } : null;
  const savedTitle = reference.title;
  const savedBundle = reference.bundle_id;
  const savedRevision = reference.state_revision;
  const overlay = el("dialog", "artifact-snapshot-overlay");
  const dialog = el("section", "artifact-snapshot-dialog");
  overlay.setAttribute("aria-label", savedTitle || t("saved"));
  const head = el("div", "artifact-snapshot-head");
  const title = el("h2", "", savedTitle || t("saved"));
  const close = el("button", "", t("close")); close.type = "button";
  head.append(title, close);
  const summary = el("p", "", `${t("saved")} · #${savedRevision}`);
  const note = el("p", "", t("note"));
  const status = el("p", "artifact-snapshot-status");
  const actions = el("div", "artifact-snapshot-actions");
  const reproduce = el("button", "", t("reproduce")); reproduce.type = "button";
  actions.append(reproduce);
  dialog.append(head, summary);
  const parameters = el("details");
  parameters.append(el("summary", "", t("saved")), el("pre", "artifact-state-json", JSON.stringify(savedState, null, 2)));
  dialog.append(parameters);

  let disposed = false;
  let previewImage: HTMLImageElement | null = null;
  if (preview) {
    previewImage = el("img", "artifact-snapshot-preview") as HTMLImageElement;
    previewImage.alt = preview.alt;
    if (preview.src.startsWith("data:")) previewImage.src = preview.src;
    else {
      void apiBase().then(base => {
        if (previewImage && !disposed) previewImage.src = new URL(preview.src, base).toString();
      }).catch(() => { if (!disposed) status.textContent = t("failed"); });
    }
    dialog.append(previewImage);
  } else dialog.append(el("p", "", t("noPreview")));
  dialog.append(note, actions, status);
  overlay.append(dialog);
  document.body.append(overlay);
  overlay.showModal();

  let frame: HTMLIFrameElement | null = null;
  let port: MessagePort | null = null;
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); dispose(); } };
  const onReady = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow || event.data?.type !== "spellcast:ready") return;
    const channel = new MessageChannel();
    port?.close();
    port = channel.port1;
    port.onmessage = message => {
      const data = message.data as { type?: unknown; value?: unknown } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "size" && typeof data.value === "number" && Number.isFinite(data.value) && frame) frame.style.height = `${Math.max(80, Math.min(700, data.value))}px`;
      if (data.type === "ready") { status.textContent = t("ready"); return; }
      if (data.type === "error") {
        const value = typeof data.value === "string" ? data.value : data.value && typeof data.value === "object" && "message" in data.value ? String(data.value.message) : t("failed");
        status.textContent = value.slice(0, 2000);
      }
      // State and outputs are deliberately ignored: this viewer has no dataflow or write path.
    };
    port.start();
    frame.contentWindow?.postMessage({ type: "spellcast:init", state: structuredClone(savedState), inputs: { revision: 0, ports: {} }, readOnly: true }, "*", [channel.port2]);
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("message", onReady);
    window.removeEventListener("keydown", onKey);
    port?.close(); port = null;
    frame?.remove(); frame = null;
    overlay.close();
    overlay.remove();
  }
  close.onclick = dispose;
  overlay.addEventListener("cancel", event => { event.preventDefault(); dispose(); });
  overlay.addEventListener("mousedown", event => { if (event.target === overlay) dispose(); });
  window.addEventListener("keydown", onKey);

  reproduce.onclick = () => {
    if (disposed || frame) return;
    reproduce.disabled = true;
    status.textContent = t("loading");
    window.addEventListener("message", onReady);
    void Promise.all([fetchArtifact(savedBundle), apiBase()]).then(([bundle, base]) => {
      if (disposed) return;
      frame = el("iframe", "artifact-snapshot-frame") as HTMLIFrameElement;
      frame.title = savedTitle || t("saved");
      frame.sandbox.add("allow-scripts");
      frame.tabIndex = -1;
      frame.inert = true;
      frame.referrerPolicy = "no-referrer";
      frame.allow = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'";
      frame.style.pointerEvents = "none";
      frame.src = `${base}/artifacts/${encodeURIComponent(savedBundle)}/${bundle.entry.split("/").map(encodeURIComponent).join("/")}`;
      dialog.append(frame);
    }).catch(() => {
      if (disposed) return;
      window.removeEventListener("message", onReady);
      status.textContent = t("failed");
      reproduce.disabled = false;
    });
  };
}

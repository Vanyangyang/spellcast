import { fetchArtifact } from "./api";
import type { ArtifactBundle, ReplyArtifactBlock } from "./reply-types";
import type { BoardSnapshot, CanvasBatchRequest, CanvasObject } from "./types";
import type { CanvasBinding, CanvasPortType } from "./canvas-data-types";
import { ct } from "./i18n/canvas";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const node = document.createElement(tag); node.textContent = text; return node; };
type Work = { object: CanvasObject; block: ReplyArtifactBlock };

function pair(left: string, right: string) {
  const a = left.trim(), b = right.trim();
  if (!a) return b;
  if (!b || b === a) return a;
  return `${a} · ${b}`;
}

function objectTitle(board: BoardSnapshot, object?: CanvasObject | null) {
  if (!object) return "";
  const content = object.content;
  if (content.type === "block") return content.block.title?.trim() || "";
  if (content.type === "text" || content.type === "image" || content.type === "shape") return content.title.trim();
  if (content.type === "reply") return board.replies?.find(reply => reply.id === content.id)?.title.trim() ?? "";
  if (content.type === "node") return board.nodes.find(node => node.id === content.id)?.title.trim() ?? "";
  return "";
}

function blockTitle(board: BoardSnapshot, object: CanvasObject | undefined, blockId?: string | null) {
  if (!object || !blockId || object.content.type !== "reply") return "";
  const replyId = object.content.id;
  const block = board.replies?.find(reply => reply.id === replyId)?.blocks.find(item => item.id === blockId);
  return block?.title?.trim() ?? "";
}

function contentLabel(board: BoardSnapshot, object: CanvasObject | undefined, blockId?: string | null) {
  return pair(objectTitle(board, object), blockTitle(board, object, blockId));
}

function endpointLabel(board: BoardSnapshot, object: CanvasObject | undefined, blockId: string | null | undefined, port: string) {
  return pair(contentLabel(board, object, blockId), port);
}

function workLabel(board: BoardSnapshot, work: Work) {
  return contentLabel(board, work.object, work.block.id);
}

function works(board: BoardSnapshot): Work[] {
  return (board.canvas?.objects ?? []).flatMap(object => {
    if (object.content.type !== "reply") return [];
    const id = object.content.id, reply = board.replies?.find(reply => reply.id === id);
    return (reply?.blocks ?? []).filter((block): block is ReplyArtifactBlock => block.type === "artifact")
      .map(block => ({ object, block }));
  });
}

function bindingCaption(board: BoardSnapshot, target: CanvasObject, binding: CanvasBinding) {
  const source = board.canvas?.objects.find(object => object.id === binding.from.object_id);
  const from = source ? endpointLabel(board, source, binding.from.block_id, binding.from.port) : ct("bindingSourceMissing");
  const to = endpointLabel(board, target, binding.to.block_id, binding.to.port);
  return {
    text: `${from} → ${to}`,
    title: `${binding.from.object_id} ${binding.from.block_id ?? ""} ${binding.from.port} → ${target.id} ${binding.to.block_id ?? ""} ${binding.to.port}`.replace(/\s+/g, " ").trim(),
  };
}

/** Explicit connections use the versions actually shown in this dialog. */
export function canvasConnections(apply: (request: CanvasBatchRequest) => Promise<void>) {
  const dialog = el("dialog"); dialog.className = "board-dialog canvas-connections"; document.body.append(dialog);
  let epoch = 0;
  dialog.addEventListener("close", () => { epoch++; });
  return {
    async show(current: BoardSnapshot, id: string) {
      const board = structuredClone(current), target = board.canvas?.objects.find(object => object.id === id);
      if (!target) return;
      const own = ++epoch;
      const close = el("button", ct("close")); close.type = "button"; close.className = "ghost"; close.onclick = () => dialog.close();
      const header = el("header"); header.append(el("h2", ct("dataConnections")), close);
      const status = el("p"); status.setAttribute("role", "status");
      dialog.replaceChildren(header, el("p", ct("dataHelp")), status); if (!dialog.open) dialog.showModal();
      const cache = new Map<string, Promise<ArtifactBundle>>();
      const bundle = (work: Work) => { if (!cache.has(work.block.bundle_id)) cache.set(work.block.bundle_id, fetchArtifact(work.block.bundle_id)); return cache.get(work.block.bundle_id)!; };
      const requests = new Map<string, CanvasBatchRequest>();
      let busy = false;
      async function save(bindings: CanvasBinding[]) {
        if (busy) return;
        busy = true; status.textContent = ct("nativeSaving");
        const key = JSON.stringify(bindings);
        if (!requests.has(key)) {
          const ids = new Set([id, ...bindings.map(binding => binding.from.object_id)]);
          requests.set(key, { request_id: crypto.randomUUID(), reads: [...ids].flatMap(id => {
            const object = board.canvas?.objects.find(object => object.id === id);
            return object ? [{ kind: "content" as const, id, revision: object.content_revision }] : [];
          }), operations: [{ op: "bind", id, expected_revision: target!.content_revision, bindings }] });
        }
        try { await apply(requests.get(key)!); if (own === epoch) dialog.close(); }
        catch (error) { if (own === epoch) status.textContent = error instanceof Error ? error.message : String(error); }
        finally { busy = false; }
      }
      const saved = el("div");
      for (const binding of target.bindings ?? []) {
        const caption = bindingCaption(board, target, binding);
        const row = el("p", caption.text + " "); row.title = caption.title;
        const remove = el("button", ct("dataDisconnect")); remove.type = "button"; remove.className = "ghost";
        remove.onclick = () => void save((target.bindings ?? []).filter(value => value !== binding));
        row.append(remove); saved.append(row);
      }
      dialog.append(saved);
      try {
        const all = works(board), sources = all.filter(work => work.object.id !== id);
        const inputs: { to: CanvasBinding["to"]; type?: CanvasPortType; label: string }[] = [];
        if (target.content.type === "text") inputs.push({ to: { port: "text" }, label: endpointLabel(board, target, null, "text") });
        for (const work of all.filter(work => work.object.id === id)) {
          for (const [port, type] of Object.entries((await bundle(work)).io?.inputs ?? {})) {
            inputs.push({ to: { block_id: work.block.id, port }, type, label: endpointLabel(board, work.object, work.block.id, port) });
          }
        }
        if (own !== epoch) return;
        if (!inputs.length || !sources.length) { status.textContent = ct("dataEmpty"); return; }
        const form = el("form"), destination = el("select"), source = el("select"), output = el("select");
        const field = (name: string, ...controls: HTMLElement[]) => { const label = el("label", name); label.append(...controls); return label; };
        inputs.forEach((input, index) => { const option = el("option", input.label); option.value = String(index); destination.append(option); });
        sources.forEach((work, index) => { const option = el("option", workLabel(board, work)); option.value = String(index); option.title = work.object.id; source.append(option); });
        destination.setAttribute("aria-label", ct("dataTo")); source.setAttribute("aria-label", ct("dataFrom")); output.setAttribute("aria-label", "Output port");
        const submit = el("button", ct("dataConnect")); submit.type = "submit"; submit.className = "primary"; submit.disabled = true;
        let sourceEpoch = 0;
        async function loadOutputs() {
          const request = ++sourceEpoch; submit.disabled = true; output.replaceChildren();
          try {
            const manifest = await bundle(sources[Number(source.value)]), input = inputs[Number(destination.value)];
            if (own === epoch && request === sourceEpoch) {
              for (const [port, type] of Object.entries(manifest.io?.outputs ?? {})) if (!input.type || input.type === type) { const option = el("option", `${port} · ${type}`); option.value = port; output.append(option); }
              submit.disabled = !output.options.length; status.textContent = submit.disabled ? ct("dataEmpty") : "";
            }
          } catch (error) { if (own === epoch && request === sourceEpoch) status.textContent = String(error); }
        }
        source.onchange = destination.onchange = () => void loadOutputs();
        form.onsubmit = event => {
          event.preventDefault(); if (submit.disabled) return;
          const work = sources[Number(source.value)], input = inputs[Number(destination.value)];
          const binding: CanvasBinding = { from: { object_id: work.object.id, block_id: work.block.id, port: output.value }, to: input.to };
          void save([...(target.bindings ?? []).filter(old => (old.to.block_id ?? null) !== (input.to.block_id ?? null) || old.to.port !== input.to.port), binding]);
        };
        form.append(field(ct("dataTo"), destination), field(ct("dataFrom"), source, output), submit); dialog.append(form);
        await loadOutputs();
      } catch (error) { if (own === epoch) status.textContent = String(error); }
    },
    destroy() { epoch++; dialog.remove(); },
  };
}

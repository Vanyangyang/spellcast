import type { BoardSnapshot, CanvasObject } from "./types";
import type { BoardReply, ReplyArtifactBlock, ReplyArtifactReference, ReplyBlock, ReplyTarget } from "./reply-types";
import { currentLocale } from "./i18n";
import { apiBase } from "./api";
import { workspaceIdentity } from "./content-origin";
import { sameIdea, immutableImage } from "./reply-image";
import { contentKey } from "./reply-drafts";
import { openArtifactSnapshot } from "./artifact-snapshot";

const words = {
  "zh-CN": { label: "作品状态", none: "不附作品状态", empty: "将作品与这个组件放入同一个想法，便可引用它已保存的状态。", saved: "已固定作品状态", changed: "原作品已更新 · 保留此状态", detached: "原作品已离开此想法 · 保留此状态", missing: "原作品不可用 · 保留此状态", refresh: "引用当前已保存状态", open: "查看这个状态", noPreview: "已保存参数 · 未提供画面预览", failed: "状态画面无法读取", work: "作品" },
  en: { label: "Work state", none: "No work state", empty: "Add a work and this component to the same Idea to reference its saved state.", saved: "Pinned work state", changed: "Original updated · keeping this state", detached: "Original left this Idea · keeping this state", missing: "Original unavailable · keeping this state", refresh: "Use current saved state", open: "View this state", noPreview: "Saved parameters · no image preview", failed: "State preview unavailable", work: "Work" },
  ja: { label: "作品の状態", none: "作品の状態なし", empty: "作品とこの部品を同じアイデアに入れると、保存済み状態を参照できます。", saved: "固定された作品の状態", changed: "元の作品は更新済み · この状態を保持", detached: "元の作品はアイデアの外 · この状態を保持", missing: "元の作品は利用不可 · この状態を保持", refresh: "現在の保存済み状態を参照", open: "この状態を見る", noPreview: "保存済みパラメータ · 画像プレビューなし", failed: "状態の画像を読み込めません", work: "作品" },
};
export const artifactText = (key: keyof typeof words.en) => words[currentLocale()][key];
export type ArtifactChoice = { object: CanvasObject; reply: BoardReply; block: ReplyArtifactBlock };
export function artifactChoices(board: BoardSnapshot | undefined, ownerId: string): ArtifactChoice[] {
  const canvas = board?.canvas, owner = canvas?.objects.find(o => o.id === ownerId);
  return (canvas?.objects ?? []).flatMap(object => {
    if (object.content.type !== "reply" || !sameIdea(canvas, ownerId, object.id)
      || (owner?.source_id && object.source_id && owner.source_id !== object.source_id)
      || (owner?.origin?.cwd && object.origin?.cwd && workspaceIdentity(owner.origin.cwd) !== workspaceIdentity(object.origin.cwd))) return [];
    const id = object.content.id, reply = board?.replies?.find(r => r.id === id);
    return reply ? reply.blocks.filter((b): b is ReplyArtifactBlock => b.type === "artifact").map(block => ({ object, reply, block })) : [];
  });
}
export const artifactChoiceKey = (choice: ArtifactChoice) => JSON.stringify([choice.object.id, choice.block.id]);
export function artifactSnapshot(choice: ArtifactChoice): ReplyArtifactReference {
  const { object, block } = choice;
  return { object_id: object.id, content_revision: object.content_revision, block_id: block.id, bundle_id: block.bundle_id,
    state_revision: block.state_revision, title: block.title || "", state: structuredClone(block.state || {}), ...(block.state_preview ? { preview: structuredClone(block.state_preview) } : {}) };
}
export function artifactReferenceState(board: BoardSnapshot | undefined, ownerId: string, reference: ReplyArtifactReference): "saved" | "changed" | "missing" | "detached" {
  if (!board) return "saved";
  const object = board.canvas?.objects.find(o => o.id === reference.object_id);
  if (!object || object.content.type !== "reply") return "missing";
  if (!sameIdea(board.canvas, ownerId, reference.object_id)) return "detached";
  const id = object.content.id, reply = board.replies?.find(r => r.id === id), block = reply?.blocks.find(b => b.id === reference.block_id);
  if (!reply || block?.type !== "artifact") return "missing";
  const normalized = { ...reference }; if (!normalized.preview) delete normalized.preview;
  return contentKey(artifactSnapshot({object, reply, block})) === contentKey(normalized) ? "saved" : "changed";
}
export function targetArtifact(block: ReplyBlock, target?: ReplyTarget): ReplyArtifactReference | undefined {
  if (block.type === "comparison" && target?.kind === "option") return block.options.find(o => o.id === target.id)?.artifact ?? undefined;
  if (block.type === "sequence" && target?.kind === "step") return block.steps.find(s => s.id === target.id)?.artifact ?? undefined;
  return undefined;
}
export function artifactReferencePreview(reference: ReplyArtifactReference, state: ReturnType<typeof artifactReferenceState>) {
  const figure = document.createElement("figure"); figure.className = "rb-artifact-reference"; figure.dataset.state = state;
  const label = document.createElement("figcaption"); label.textContent = artifactText(state);
  if (reference.preview && immutableImage(reference.preview.src)) {
    const image = document.createElement("img"); image.alt = reference.preview.alt || reference.title || artifactText("work");
    if (reference.preview.src.startsWith("/artifacts/")) void apiBase().then(base => { if (image.isConnected) image.src = base + reference.preview!.src; }); else image.src = reference.preview.src;
    image.addEventListener("error", () => { label.textContent = artifactText("failed"); }); figure.append(image);
  } else { const note = document.createElement("p"); note.textContent = artifactText("noPreview"); figure.append(note); }
  const open = document.createElement("button"); open.type = "button"; open.className = "rb-quiet"; open.textContent = artifactText("open");
  open.onclick = () => openArtifactSnapshot(structuredClone(reference));
  figure.append(label, open); return figure;
}

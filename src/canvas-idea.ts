import type { CanvasBatchRequest, CanvasComposition, CanvasRead } from "./types";
import { ct } from "./i18n/canvas";
import "./canvas-idea.css";

export type IdeaMember = { id: string; title: string; detail: string; reads: CanvasRead[] };
type IdeaInput = { id: string; group?: CanvasComposition; members: string[]; candidates: IdeaMember[] };
type Draft = { title: string; description: string; members: string[]; revision: number; reads: CanvasRead[]; request?: CanvasBatchRequest };

/** Edits composition metadata, never copies or rewrites its members' content. */
export function canvasIdea(save: (request: CanvasBatchRequest) => Promise<void>, reload: () => Promise<IdeaInput | undefined>) {
  const dialog = document.createElement("dialog"); dialog.className = "board-dialog canvas-idea";
  const form = document.createElement("form"); form.noValidate = true;
  const heading = document.createElement("h2"); heading.id = `idea-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const title = document.createElement("input"); title.name = "title";
  const description = document.createElement("textarea"); description.name = "description"; description.rows = 4;
  function field(label: string, control: HTMLElement) { const node = document.createElement("label"); node.append(document.createTextNode(label), control); return node; }
  const titleField = field("", title), descriptionField = field("", description);
  const help = document.createElement("p"); help.className = "canvas-idea-help";
  const list = document.createElement("ol"); list.className = "canvas-idea-members";
  const picker = document.createElement("select"); picker.setAttribute("aria-label", ct("ideaAddMember"));
  const error = document.createElement("p"); error.setAttribute("role", "alert"); error.hidden = true;
  const review = document.createElement("pre"); review.hidden = true; review.className = "canvas-idea-review";
  const actions = document.createElement("div"); actions.className = "canvas-idea-actions";
  function button(key: Parameters<typeof ct>[0], action: () => void) { const b = document.createElement("button"); b.type = "button"; b.textContent = ct(key); b.onclick = action; return b; }
  const cancel = button("close", () => { if (!busy) dialog.close(); });
  const refresh = button("proposalRefresh", () => { void reviewLatest(); }); refresh.hidden = true;
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "primary";
  actions.append(cancel, refresh, submit); form.append(titleField, descriptionField, help, list, picker, error, review, actions);
  dialog.append(heading, form); document.body.append(dialog);
  let input: IdeaInput | undefined, draft: Draft | undefined, busy = false, destroyed = false;
  const key = () => `spellcast.idea-draft:${input!.id}`;
  function persist() {
    if (!draft || !input) return;
    try { localStorage.setItem(key(), JSON.stringify(draft)); }
    catch { error.textContent = ct("draftUnsafe"); error.hidden = false; }
  }
  function changed() {
    if (!draft) return;
    draft.title = title.value; draft.description = description.value; delete draft.request; persist();
  }
  function setBusy(value: boolean) {
    busy = value; form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea").forEach(el => el.disabled = value);
    submit.textContent = ct(value ? "nativeSaving" : "save");
    if (!value) renderMembers();
  }
  function renderMembers() {
    list.replaceChildren(); picker.replaceChildren();
    if (!draft || !input) return;
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = ct("ideaAddMember"); picker.append(placeholder);
    for (const member of input.candidates) if (!draft.members.includes(member.id)) {
      const option = document.createElement("option"); option.value = member.id; option.textContent = `${member.title} · ${member.detail}`; picker.append(option);
    }
    for (const [index, id] of draft.members.entries()) {
      const member = input.candidates.find(item => item.id === id), row = document.createElement("li"); row.dataset.memberId = id;
      const label = document.createElement("span"); label.textContent = member?.title || id; label.title = member?.detail || ct("proposalMissing");
      const up = button("ideaEarlier", () => { if (index > 0) { [draft!.members[index - 1], draft!.members[index]] = [id, draft!.members[index - 1]]; changed(); renderMembers(); } });
      const down = button("ideaLater", () => { if (index + 1 < draft!.members.length) { [draft!.members[index + 1], draft!.members[index]] = [id, draft!.members[index + 1]]; changed(); renderMembers(); } });
      const detach = button("ideaDetach", () => { draft!.members.splice(index, 1); changed(); renderMembers(); });
      up.disabled = index === 0; down.disabled = index === draft.members.length - 1; detach.disabled = draft.members.length <= 1;
      row.append(label, up, down, detach); list.append(row);
    }
  }
  picker.onchange = () => {
    const member = input?.candidates.find(item => item.id === picker.value); if (!draft || !member) return;
    if (!draft.members.includes(member.id)) { draft.members.push(member.id); draft.reads.push(...member.reads); changed(); renderMembers(); }
  };
  title.oninput = changed; description.oninput = changed;
  async function reviewLatest() {
    if (busy || !draft) return; setBusy(true);
    try {
      const latest = await reload(); if (!latest || destroyed) throw new Error(ct("proposalMissing"));
      input = latest;
      review.textContent = `${ct("proposalCurrent")}\n${latest.group?.title || "—"}\n${latest.group?.description || ""}\n${(latest.group?.members || latest.members).map(id => latest.candidates.find(m => m.id === id)?.title || id).join(" → ")}`;
      review.hidden = false;
      draft.revision = latest.group?.revision || 0;
      draft.reads = draft.members.flatMap(id => latest.candidates.find(item => item.id === id)?.reads || []);
      delete draft.request; persist(); renderMembers();
      error.textContent = ct("ideaReviewChanges"); error.hidden = false;
    } catch (failure) { error.textContent = String(failure); error.hidden = false; }
    finally { if (!destroyed) setBusy(false); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !draft || !input) return;
    if (!title.value.trim() || [...title.value.trim()].length > 160 || [...description.value].length > 4000 || !draft.members.length || draft.members.length > 64) {
      error.textContent = ct("ideaInvalid"); error.hidden = false; return;
    }
    const reads = [...new Map(draft.reads.map(read => [`${read.kind}:${read.id}`, read])).values()];
    if (draft.revision) reads.push({ kind: "composition", id: input.id, revision: draft.revision });
    draft.request ||= { request_id: crypto.randomUUID(), reads, operations: [{ op: "compose", id: input.id, expected_revision: draft.revision, title: draft.title.trim(), description: draft.description.trim(), members: [...draft.members] }] };
    persist(); setBusy(true);
    try {
      await save(draft.request); if (destroyed) return;
      try { localStorage.removeItem(key()); } catch { /* The saved server content is authoritative. */ }
      dialog.close();
    } catch (failure) { if (!destroyed) { error.textContent = String(failure); error.hidden = false; refresh.hidden = false; } }
    finally { if (!destroyed) setBusy(false); }
  };
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  return {
    show(value: IdeaInput) {
      if (busy || destroyed) return; input = value;
      draft = { title: value.group?.title || "", description: value.group?.description || "", members: [...value.members], revision: value.group?.revision || 0, reads: value.members.flatMap(id => value.candidates.find(m => m.id === id)?.reads || []) };
      try { const saved = JSON.parse(localStorage.getItem(key()) || "null"); if (saved && typeof saved.title === "string" && typeof saved.description === "string" && Array.isArray(saved.members) && saved.members.every((id: unknown) => typeof id === "string") && Array.isArray(saved.reads) && typeof saved.revision === "number") draft = saved; } catch { /* Invalid local draft leaves saved content available. */ }
      title.value = draft!.title; description.value = draft!.description;
      heading.textContent = ct(value.group ? "ideaEdit" : "ideaCreate"); titleField.firstChild!.textContent = ct("ideaName"); descriptionField.firstChild!.textContent = ct("ideaDescription");
      help.textContent = ct("ideaHelp"); cancel.textContent = ct("close"); submit.textContent = ct("save"); refresh.textContent = ct("proposalRefresh");
      error.hidden = review.hidden = true; refresh.hidden = draft!.revision === (value.group?.revision || 0); renderMembers(); dialog.showModal(); title.focus();
    },
    destroy() { destroyed = true; dialog.remove(); },
  };
}

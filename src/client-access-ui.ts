import { invoke, isTauri } from "@tauri-apps/api/core";
import { onLocale } from "./i18n";
import { clientAccessText as text, type ClientAccessTextKey } from "./i18n/client-access";
import "./client-access.css";

type Identity = { path: string; sha256: string; sid: string; file_id: string };
type Scopes = { records: boolean; sigil_drafts: boolean; sigil_claims?: boolean; sigil_run?: boolean };
type Grant = { id: string; identity: Identity; scopes: Scopes; state: "approved" | "revoked"; revision: number; generation: number; approved_at_ms: number; updated_at_ms: number };
type Candidate = { id: string; identity: Identity; process_id: number; created_at: number; grant?: Grant };
type AccessList = { available: boolean; error_code?: string; candidates: Candidate[]; grants: Grant[] };
type Phase = "loading" | "ready" | "unavailable" | "loadFailed" | "writeFailed" | "saved" | "revokedDone";

function identityValid(value: unknown): value is Identity {
  if (!value || typeof value !== "object") return false;
  const data = value as Identity;
  return [data.path, data.sha256, data.sid, data.file_id].every(item => typeof item === "string" && item.length > 0);
}
function grantValid(value: unknown): value is Grant {
  if (!value || typeof value !== "object") return false;
  const data = value as Grant;
  return typeof data.id === "string" && identityValid(data.identity)
    && typeof data.scopes?.records === "boolean" && typeof data.scopes?.sigil_drafts === "boolean" && (data.scopes?.sigil_claims === undefined || typeof data.scopes.sigil_claims === "boolean") && (data.scopes?.sigil_run === undefined || typeof data.scopes.sigil_run === "boolean")
    && (data.state === "approved" || data.state === "revoked")
    && [data.revision, data.generation, data.approved_at_ms, data.updated_at_ms].every(item => Number.isSafeInteger(item) && item >= 0);
}
function listValid(value: unknown): value is AccessList {
  if (!value || typeof value !== "object") return false;
  const data = value as AccessList;
  return typeof data.available === "boolean" && Array.isArray(data.grants) && data.grants.every(grantValid)
    && Array.isArray(data.candidates) && data.candidates.every(candidate => typeof candidate.id === "string"
      && identityValid(candidate.identity) && Number.isSafeInteger(candidate.process_id) && candidate.process_id > 0
      && Number.isSafeInteger(candidate.created_at) && candidate.created_at >= 0 && (candidate.grant === undefined || grantValid(candidate.grant)));
}
function sameIdentity(left: Identity, right: Identity) {
  return left.path === right.path && left.sha256 === right.sha256 && left.sid === right.sid && left.file_id === right.file_id;
}

/** Listing and mounting are read-only. Only the visible confirmation approves a candidate. */
export function mountClientAccessSettings(parent: HTMLElement) {
  const native = isTauri();
  const section = document.createElement("section");
  section.className = "client-access";
  section.id = "client-access-settings";
  parent.append(section);
  const labels = new Map<HTMLElement, ClientAccessTextKey>();
  const localized = <K extends keyof HTMLElementTagNameMap>(tag: K, key: ClientAccessTextKey, container: HTMLElement) => {
    const node = document.createElement(tag);
    node.textContent = text(key);
    labels.set(node, key);
    container.append(node);
    return node;
  };
  const title = localized("h3", "title", section);
  title.id = "client-access-heading";
  section.setAttribute("aria-labelledby", title.id);
  localized("p", "description", section).className = "client-access-description";
  const refreshButton = localized("button", "refresh", section);
  refreshButton.type = "button";
  refreshButton.id = "client-access-refresh";
  const status = document.createElement("p");
  status.id = "client-access-status";
  status.className = "client-access-status";
  status.setAttribute("aria-live", "polite");
  section.append(status);
  localized("h4", "candidates", section);
  const candidates = document.createElement("div");
  candidates.id = "client-access-candidates";
  candidates.className = "client-access-list";
  section.append(candidates);
  localized("h4", "grants", section);
  const grants = document.createElement("div");
  grants.id = "client-access-grants";
  grants.className = "client-access-list";
  section.append(grants);
  const dialog = document.createElement("dialog");
  dialog.id = "client-access-confirmation";
  dialog.className = "client-access-confirmation";
  section.append(dialog);
  let phase: Phase = native ? "loading" : "unavailable";
  let busy = false;
  let available = false;
  let unavailableReason: ClientAccessTextKey | null = null;
  let disposed = false;
  let pending: { candidate: Candidate; scopes: Scopes; expectedRevision: number } | null = null;
  const actionButtons = new Set<HTMLButtonElement>();
  const scopeInputs = new Set<HTMLInputElement>();
  const reviewButtons = new Map<HTMLButtonElement, HTMLInputElement[]>();
  const dynamicLabels = new Set<HTMLElement>();
  const addLabel = <K extends keyof HTMLElementTagNameMap>(tag: K, key: ClientAccessTextKey, container: HTMLElement) => {
    const node = localized(tag, key, container);
    dynamicLabels.add(node);
    return node;
  };
  function paint() {
    for (const [node, key] of labels) node.textContent = text(key);
    section.dataset.state = phase;
    status.textContent = text(phase) + (!available && unavailableReason ? ` ${text(unavailableReason)}` : "");
    const error = phase === "loadFailed" || phase === "writeFailed";
    status.dataset.error = String(error);
    status.setAttribute("role", error ? "alert" : "status");
    refreshButton.disabled = !native || busy || dialog.open;
    for (const input of scopeInputs) input.disabled = busy || !available;
    for (const button of actionButtons) button.disabled = busy;
    for (const [button, inputs] of reviewButtons) button.disabled = busy || !available || !inputs.some(input => input.checked);
    if (pending && !busy) dialog.querySelector<HTMLButtonElement>("[data-confirm]")!.disabled = !available;
  }
  function showIdentity(identity: Identity, container: HTMLElement) {
    const details = document.createElement("dl");
    details.className = "client-access-identity";
    container.append(details);
    for (const [key, value] of [["path", identity.path], ["sha256", identity.sha256], ["sid", identity.sid]] as const) {
      addLabel("dt", key, details);
      const field = document.createElement("dd");
      field.dataset.identity = key;
      field.textContent = value;
      details.append(field);
    }
  }
  function showScopes(scopes: Scopes, container: HTMLElement) {
    const list = document.createElement("ul");
    container.append(list);
    if (scopes.records) addLabel("li", "records", list);
    if (scopes.sigil_drafts) addLabel("li", "sigilDrafts", list);
    if (scopes.sigil_claims) addLabel("li", "sigilClaims", list);
    if (scopes.sigil_run) addLabel("li", "sigilRun", list);
    if (!scopes.records && !scopes.sigil_drafts && !scopes.sigil_claims && !scopes.sigil_run) addLabel("li", "scopeNone", list);
  }
  function closeConfirmation() {
    if (busy) return;
    pending = null;
    dialog.close();
    paint();
  }
  function review(candidate: Candidate, scopes: Scopes) {
    if (busy || !available || dialog.open || !(scopes.records || scopes.sigil_drafts || scopes.sigil_claims || scopes.sigil_run)) return;
    for (const node of dialog.querySelectorAll<HTMLElement>("*")) { labels.delete(node); dynamicLabels.delete(node); }
    dialog.replaceChildren();
    pending = { candidate, scopes: { ...scopes }, expectedRevision: candidate.grant?.revision ?? 0 };
    const heading = addLabel("h2", "confirmTitle", dialog);
    heading.id = "client-access-confirm-heading";
    dialog.setAttribute("aria-labelledby", heading.id);
    addLabel("p", "confirmHint", dialog);
    showIdentity(candidate.identity, dialog);
    addLabel("h3", "selected", dialog);
    showScopes(scopes, dialog);
    for (const key of ["recordsWarning", "draftsWarning", "claimsWarning", "runWarning", "devicesWarning", "exclusions"] as const) addLabel("p", key, dialog).className = "client-access-warning";
    const menu = document.createElement("menu");
    dialog.append(menu);
    const cancel = addLabel("button", "cancel", menu);
    cancel.type = "button";
    cancel.addEventListener("click", closeConfirmation);
    const confirm = addLabel("button", "confirm", menu);
    confirm.type = "button";
    confirm.dataset.confirm = "true";
    confirm.addEventListener("click", () => { if (pending && dialog.open) void approve(pending); });
    dialog.showModal();
    cancel.focus();
    paint();
  }
  function render(data: AccessList) {
    for (const node of dynamicLabels) labels.delete(node);
    dynamicLabels.clear();
    actionButtons.clear();
    scopeInputs.clear();
    reviewButtons.clear();
    candidates.replaceChildren();
    grants.replaceChildren();
    if (!data.candidates.length || !data.available) addLabel("p", "noCandidates", candidates);
    if (!data.grants.length) addLabel("p", "noGrants", grants);
    for (const candidate of data.available ? data.candidates : []) {
      const card = document.createElement("article");
      card.className = "client-access-card";
      card.dataset.candidateId = candidate.id;
      candidates.append(card);
      showIdentity(candidate.identity, card);
      const process = document.createElement("p");
      addLabel("span", "process", process);
      process.append(document.createTextNode(`: ${candidate.process_id}`));
      card.append(process);
      addLabel("p", candidate.grant && !sameIdentity(candidate.identity, candidate.grant.identity) ? "identityChanged" : candidate.grant?.state ?? "pending", card);
      const scopeDefs = [
        { key: "records" as const, scope: "records" },
        { key: "sigilDrafts" as const, scope: "sigil_drafts" },
        { key: "sigilClaims" as const, scope: "sigil_claims" },
        { key: "sigilRun" as const, scope: "sigil_run" },
      ];
      const inputs = scopeDefs.map(({ key, scope }) => {
        const label = document.createElement("label");
        label.className = "client-access-scope";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.scope = scope;
        input.checked = false;
        label.append(input);
        addLabel("span", key, label);
        card.append(label);
        scopeInputs.add(input);
        input.addEventListener("change", paint);
        return input;
      });
      const button = addLabel("button", "review", card);
      button.type = "button";
      reviewButtons.set(button, inputs);
      button.addEventListener("click", () => review(candidate, {
        records: inputs[0].checked,
        sigil_drafts: inputs[1].checked,
        sigil_claims: inputs[2].checked,
        sigil_run: inputs[3].checked,
      }));
    }
    for (const grant of data.grants) {
      const card = document.createElement("article");
      card.className = "client-access-card";
      card.dataset.grantId = grant.id;
      grants.append(card);
      showIdentity(grant.identity, card);
      addLabel("p", grant.state, card);
      showScopes(grant.scopes, card);
      for (const [key, value] of [["revision", grant.revision], ["generation", grant.generation]] as const) {
        const detail = document.createElement("p");
        addLabel("span", key, detail);
        detail.append(document.createTextNode(`: ${value}`));
        card.append(detail);
      }
      if (grant.state === "approved") {
        const button = addLabel("button", "revoke", card);
        button.type = "button";
        actionButtons.add(button);
        button.addEventListener("click", () => { void revoke(grant); });
      }
    }
  }
  async function read() {
    const data = await invoke<AccessList>("client_access_list");
    if (!listValid(data)) throw new Error("Invalid application access list");
    if (disposed) return;
    available = data.available;
    unavailableReason = data.error_code === "storage_unprotected" ? "storageUnprotected" : data.error_code === "pipe_unavailable" ? "pipeUnavailable" : null;
    render(data);
  }
  async function refresh() {
    if (!native || busy || dialog.open || disposed) return;
    busy = true;
    phase = "loading";
    paint();
    try { await read(); phase = available ? "ready" : "unavailable"; }
    catch { available = false; phase = "loadFailed"; render({ available: false, candidates: [], grants: [] }); }
    finally { busy = false; if (!disposed) paint(); }
  }
  async function mutate(command: "client_access_approve" | "client_access_revoke", args: Record<string, unknown>, validate: (grant: Grant) => boolean) {
    if (!native || busy || (command === "client_access_approve" && !available) || disposed) return;
    busy = true;
    if (dialog.open) dialog.close();
    pending = null;
    phase = "loading";
    paint();
    let confirmed = false;
    try {
      const grant = await invoke<Grant>(command, args);
      confirmed = grantValid(grant) && validate(grant);
    } catch { /* Refresh after any uncertain reply; never expose native error payloads. */ }
    try {
      await read();
      phase = !confirmed ? "writeFailed" : command === "client_access_approve" ? "saved" : "revokedDone";
    } catch {
      available = false;
      render({ available: false, candidates: [], grants: [] });
      phase = "writeFailed";
    } finally { busy = false; if (!disposed) paint(); }
  }
  async function approve(request: NonNullable<typeof pending>) {
    await mutate("client_access_approve", { candidateId: request.candidate.id, expectedRevision: request.expectedRevision, scopes: request.scopes },
      grant => grant.state === "approved" && sameIdentity(grant.identity, request.candidate.identity)
        && grant.revision > request.expectedRevision
        && grant.scopes.records === request.scopes.records
        && grant.scopes.sigil_drafts === request.scopes.sigil_drafts
        && Boolean(grant.scopes.sigil_claims) === Boolean(request.scopes.sigil_claims)
        && Boolean(grant.scopes.sigil_run) === Boolean(request.scopes.sigil_run));
  }
  async function revoke(grant: Grant) {
    await mutate("client_access_revoke", { grantId: grant.id, expectedRevision: grant.revision },
      actual => actual.id === grant.id && actual.state === "revoked" && actual.revision > grant.revision && sameIdentity(actual.identity, grant.identity));
  }
  refreshButton.addEventListener("click", () => { void refresh(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeConfirmation(); });
  dialog.addEventListener("close", () => { pending = null; paint(); });
  const unsubscribe = onLocale(paint);
  render({ available: false, candidates: [], grants: [] });
  paint();
  void refresh();
  return { refresh, destroy() { disposed = true; unsubscribe(); if (dialog.open) dialog.close(); section.remove(); } };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * In-memory stand-in for candidates, immutable trials and adoptions. Mirrors the store rules the
 * UI depends on: no unlock for candidates, immutable deduplicated trials, explicit unlock and
 * latest revisions for adoption. Isolated fixture data only.
 */
export function createEvidenceFixture({ objects, history, recordKey, writeHistory, actor, tick }) {
  const candidates = new Map(), trials = new Map(), adoptions = new Map(), candidateHistory = new Map();
  const number = value => (String(value ?? "").trim() === "" ? null : Number(value));
  const base = parameter => { const p = parameter.planning.parameter; return { revision: parameter.revision, value: p.value, unit: p.unit, min: p.min, max: p.max }; };
  const sameDefinition = (a, b) => number(a.value) === number(b.value) && a.unit === b.unit && number(a.min) === number(b.min) && number(a.max) === number(b.max);
  const digest = run => { const copy = structuredClone(run); copy.source.project_id = ""; for (const d of copy.dependencies) d.project_id = ""; for (const c of copy.candidates || []) c.project_id = ""; return createHash("sha256").update(JSON.stringify(copy)).digest("hex"); };
  const savedSnapshot = (projectId, id, revision) => (history.get(recordKey(projectId, id)) || []).find(row => row.revision === revision)?.snapshot;
  function summary(trial) {
    const run = trial.run, flow = run.source.planning.flow, end = run.events.at(-1)?.to || flow.entry, step = flow.steps.find(s => s.id === end);
    const manualHere = run.events.at(-1)?.kind === "manual" && run.events.at(-1)?.to === end;
    return { id: trial.id, project_id: trial.project_id, flow_id: trial.flow_id, flow_revision: trial.flow_revision, flow_name: run.source.name, label: trial.label, origin: trial.origin,
      ...(trial.parent_trial_id ? { parent_trial_id: trial.parent_trial_id } : {}), ...(run.replay ? { base_trial_id: run.replay.base_trial_id, replay_status: run.replay.status } : {}),
      digest: trial.digest, created_at_ms: trial.created_at_ms, created_by: actor.label, event_count: run.events.length,
      manual_count: run.events.filter(e => e.kind === "manual").length, assumption_count: run.events.filter(e => e.assumption).length,
      end_step_id: end, end_step_title: step?.title || end, terminal: !!step?.terminal && (!step.external || manualHere),
      parameter_ids: run.dependencies.map(d => d.id), candidates: (run.candidates || []).map(c => ({ id: c.id, revision: c.revision, parameter_id: c.parameter_id, label: c.label, value: c.value })) };
  }
  function mutate(command) {
    if (command.op === "put_candidate") {
      const parameter = objects.get(command.parameter_id); assert.ok(parameter?.planning?.parameter, "candidate target must be a parameter");
      const current = candidates.get(command.id); assert.equal(command.expected_revision, current?.revision ?? 0, "candidate revision changed");
      let candidateBase;
      if (!current) { assert.equal(command.base_revision, parameter.revision, "stale candidate base"); candidateBase = base(parameter); }
      else if (command.base_revision === current.base.revision) candidateBase = current.base;
      else { assert.equal(command.base_revision, parameter.revision, "invalid rebase"); candidateBase = base(parameter); }
      const value = Number(command.value); assert.ok(command.value.trim() && Number.isFinite(value), "finite candidate value");
      if (number(candidateBase.min) !== null) assert.ok(value >= number(candidateBase.min), "below minimum");
      if (number(candidateBase.max) !== null) assert.ok(value <= number(candidateBase.max), "above maximum");
      const now = tick();
      const candidate = { id: command.id, project_id: command.project_id, parameter_id: command.parameter_id, label: command.label, value: command.value, reason: command.reason || "", base: candidateBase,
        ...(current?.from_variant || command.from_variant ? { from_variant: current?.from_variant || command.from_variant } : {}), revision: (current?.revision ?? 0) + 1, archived: !!command.archived,
        created_at_ms: current?.created_at_ms ?? now, updated_at_ms: now, updated_by: actor };
      candidates.set(candidate.id, candidate);
      const rows = candidateHistory.get(candidate.id) || []; rows.push({ project_id: candidate.project_id, kind: "candidate", id: candidate.id, revision: candidate.revision, at_ms: now, actor, operation: "put_candidate", request_id: command.request_id, snapshot: structuredClone(candidate) });
      candidateHistory.set(candidate.id, rows);
      return { candidate, replayed: false };
    }
    if (command.op === "save_trial") {
      const run = command.run; assert.equal(run.version, 2); assert.ok(run.events.length <= 200);
      assert.equal(objects.get(run.source.id)?.kind, "flow", "trial source must be a saved flow");
      for (const object of [run.source, ...run.dependencies]) assert.equal(JSON.stringify(savedSnapshot(command.project_id, object.id, object.revision)), JSON.stringify(object), `trial snapshot ${object.name} must be a saved revision`);
      for (const candidate of run.candidates || []) assert.equal(JSON.stringify(candidateHistory.get(candidate.id)?.find(row => row.revision === candidate.revision)?.snapshot), JSON.stringify(candidate), "trial candidate snapshot");
      assert.equal(command.origin === "replay", !!run.replay, "replay origin");
      if (run.replay) assert.ok(trials.has(run.replay.base_trial_id), "replay base exists");
      const hash = digest(run), existing = [...trials.values()].find(t => t.digest === hash);
      if (existing) return { trial: summary(existing), replayed: false, deduplicated: true };
      assert.ok(!trials.has(command.id), "saved trials are immutable");
      const trial = { id: command.id, project_id: command.project_id, flow_id: run.source.id, flow_revision: run.source.revision, label: command.label || "", origin: command.origin,
        ...(command.parent_trial_id ? { parent_trial_id: command.parent_trial_id } : {}), digest: hash, created_at_ms: tick(), created_by: actor, run: structuredClone(run) };
      trials.set(trial.id, trial);
      return { trial: summary(trial), replayed: false };
    }
    if (command.op === "adopt_candidate") {
      const current = objects.get(command.parameter_id); assert.equal(command.expected_revision, current.revision, "parameter revision changed");
      assert.ok(!current.planning.locked, "object is locked");
      const candidate = candidates.get(command.candidate_id); assert.equal(candidate.revision, command.candidate_revision, "candidate revision changed");
      assert.ok(sameDefinition(candidate.base, base(current)), "candidate base changed");
      assert.ok(command.reason.trim(), "reason required");
      for (const id of command.trial_ids) assert.ok(trials.get(id)?.run.dependencies.some(d => d.id === current.id), "trial evidence uses parameter");
      const object = { ...current, revision: current.revision + 1, planning: { ...current.planning, locked: command.lock_after, parameter: { ...current.planning.parameter, value: candidate.value } } };
      objects.set(object.id, object); writeHistory(object, "adopt_candidate", command.request_id, "object");
      const adoption = { id: command.adoption_id, project_id: command.project_id, parameter_id: current.id, parameter_revision_before: current.revision, parameter_revision_after: object.revision,
        value_before: current.planning.parameter.value, value_after: candidate.value, candidate: structuredClone(candidate), trial_ids: command.trial_ids, reason: command.reason, at_ms: tick(), actor, request_id: command.request_id };
      adoptions.set(adoption.id, adoption);
      return { object, adoption, replayed: false };
    }
    return undefined;
  }
  /** GET routes; returns undefined when the request is not an evidence route. */
  function route(method, parts, parsed) {
    if (method !== "GET") return undefined;
    if (parts[3] === "candidates") return [...candidates.values()];
    if (parts[3] === "adoptions") return [...adoptions.values()];
    if (parts[3] === "trials" && parts[4]) return trials.get(decodeURIComponent(parts[4])) ?? { error: "missing trial" };
    if (parts[3] === "trials") { const flow = parsed.searchParams.get("flow_id"); return [...trials.values()].filter(t => !flow || t.flow_id === flow).reverse().map(summary); }
    if (parts[3] === "history" && parts[4] === "candidate") return [...(candidateHistory.get(decodeURIComponent(parts[5])) || [])];
    return undefined;
  }
  return { mutate, route, candidates, trials, adoptions, candidateHistory };
}

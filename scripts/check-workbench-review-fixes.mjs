import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// In-memory model checks for UI decisions; no application database or desktop window.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({ stdin: { contents: `export { startFlowRun, confirmManualResult } from "./src/game-flow-model.ts";
  export { startReplay, reusableManual } from "./src/game-flow-replay.ts";
  export { replayCandidateProblems } from "./src/game-flow-trials.ts";`, resolveDir: root, loader: "ts" },
  bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent" });
const workbench = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const projectId = "review-fixture";
const parameter = { id: "parameter", project_id: projectId, name: "Energy", kind: "parameter", revision: 1, archived: false,
  planning: { scopes: ["R0"], confirmed: false, body: "", links: [], references: [], locked: true,
    parameter: { value: "3", unit: "pt", min: "0", max: "10", formula: "", variants: [] } } };
const flow = { id: "flow", project_id: projectId, name: "Manual encounter", kind: "flow", revision: 1, archived: false,
  planning: { scopes: ["R0"], confirmed: false, body: "", links: [{ target_id: parameter.id, relation: "uses", note: "", local: { value: "4", reason: "intro" } }],
    references: [], locked: true, flow: { entry: "manual", variables: [{ id: "energy", name: "Energy", value_type: "number", initial: "", unit: "pt", parameter_id: parameter.id }],
      steps: [{ id: "manual", title: "Encounter", goal: "", action: "", feedback: "", external: true, terminal: true, choices: [] }] } } };
const anchor = { id: "design", project_id: projectId, name: "Cue", kind: "hook", revision: 1, archived: false,
  planning: { scopes: ["R0"], confirmed: false, body: "", links: [], references: [], anchors: [{ flow_id: flow.id, step_id: "manual", phase: "cue" }] } };
const objects = [flow, parameter, anchor];
let base = workbench.startFlowRun(flow, objects, {});
base = workbench.confirmManualResult(base, { energy: "4" });
const replay = (currentFlow, currentObjects, inputs = {}) => workbench.startReplay({ trialId: "saved", run: base }, currentFlow, currentObjects, inputs, []);
assert.equal(workbench.reusableManual(replay(flow, objects), base).contextChanged, false, "Unchanged context stays clear");

const lockOnly = structuredClone(parameter); lockOnly.revision++; lockOnly.planning.locked = false;
assert.equal(workbench.reusableManual(replay(flow, [flow, lockOnly, anchor]), base).contextChanged, false, "Lock metadata is not an execution change");

const changedParameter = structuredClone(parameter); changedParameter.revision++; changedParameter.planning.parameter.value = "5";
const masked = replay(flow, [flow, changedParameter, anchor]);
assert.equal(masked.initial.energy, base.initial.energy, "Local override masks the changed shared value");
assert.equal(workbench.reusableManual(masked, base).contextChanged, true, "Changed dependency is still flagged");

const typed = replay(flow, objects, { energy: "4" });
assert.equal(typed.initial.energy, base.initial.energy);
assert.equal(workbench.reusableManual(typed, base).contextChanged, true, "Same value from a manual initial source is flagged");

const movedAnchor = structuredClone(anchor); movedAnchor.planning.anchors[0].phase = "payoff";
assert.equal(workbench.reusableManual(replay(flow, [flow, parameter, movedAnchor]), base).contextChanged, true, "Relevant design position change is flagged");

const candidate = { id: "candidate", parameter_id: parameter.id, label: "Low", value: "2", revision: 2, archived: false };
const setup = { baseId: "saved", candidates: { [parameter.id]: candidate.id }, candidateRevisions: { [parameter.id]: candidate.revision }, keepInputs: true };
assert.deepEqual(workbench.replayCandidateProblems(setup, [candidate]), []);
assert.match(workbench.replayCandidateProblems(setup, [{ ...candidate, archived: true }]).join(" "), /已归档/);
assert.match(workbench.replayCandidateProblems(setup, [{ ...candidate, revision: 3 }]).join(" "), /新版本/);
assert.match(workbench.replayCandidateProblems(setup, []).join(" "), /不可用/);
console.log("workbench review model checks passed: manual-context provenance, metadata boundary, candidate availability and revision");

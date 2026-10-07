//! Sigil application boundary: agent MCP writes, window-only user actions and the live Canvas
//! card. Agents author drafts and execute on an explicit user instruction; window-only
//! controls retain unfreeze, delete and handover authority.

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellcast_core::{inbox::now_ms, BoardSnapshot, CanvasBatchRequest, CanvasBatchStatus, CanvasContent, CanvasOperation,
    CanvasOrigin, CanvasPlacementFields, CanvasRead, CanvasTargetKind, SpellcastError};

use crate::sigil_amend::SigilAmendChange;
use crate::sigil_run::AgentRunOp;
use crate::sigil_store::{SigilChange, SigilMutation};
use crate::sigils::{freeze_record, review, validate_sigil_id, IssueLevel, SigilActor, SigilPlan};
use crate::Bridge;

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct SigilQuery {
    /// `list` (default), `sigil`, `events`, `next` (where the run stands and the next step),
    /// `wait` (block until a notice for the executor arrives), `step` (one step with its observed
    /// changes, markers and check results with their output) or `diff` (the patch of a step's
    /// observed changes).
    #[serde(default)]
    pub view: String,
    #[serde(default)]
    pub sigil_id: String,
    /// For step and diff.
    #[serde(default)]
    pub step_id: String,
    /// For diff: one repository-relative path instead of the whole step.
    #[serde(default)]
    pub path: String,
    /// For diff: the index of a window of edits made outside any step, instead of a step.
    #[serde(default)]
    pub outside: Option<usize>,
    /// For events and wait: only events after this sequence (the `cursor` you last received).
    #[serde(default)]
    pub since: u64,
    /// For events: at most this many (default and maximum 200).
    #[serde(default)]
    pub limit: Option<usize>,
    /// For wait: your stable source_id, so notices you have seen are not repeated.
    #[serde(default)]
    pub source_id: String,
    /// For wait: seconds to block, at most 55 (default 50).
    #[serde(default)]
    pub wait: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SigilAgentOp {
    /// Create a draft with expected_revision 0, or replace the plan of your own draft.
    PutPlan { expected_revision: u64, plan: SigilPlan },
    /// Freeze, start autonomously and claim your plan after the user explicitly asks to execute.
    /// Creating or receiving a draft alone is not execution authorization.
    Execute { expected_revision: u64 },
    /// Take on execution after the user starts the run. Another session's claim waits for the
    /// user's handover approval; your own source can claim again after compaction.
    Claim,
    /// Begin a step before editing files. A step still running is reported automatically.
    StartStep { step_id: String },
    /// Finish a step. Spellcast then runs its checks; your evidence is shown but never verifies.
    ReportStep {
        step_id: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        evidence: Vec<String>,
    },
    /// Stop on a stop_when condition or a question for the user.
    BlockStep { step_id: String, reason: String },
    /// Run a reported step's finished commands again, for example after a result was marked
    /// because files changed while it ran.
    RerunChecks { step_id: String },
    /// Change the running plan with a one-line reason. Applies at once; autonomous verification
    /// commands run directly, while supervised runs retain approvals.
    Amend { reason: String, changes: Vec<SigilAmendChange> },
    /// A timeline note; never changes a state.
    Note { text: String },
}

/// The wire format keeps `op` and its fields flat beside the common fields. The advertised schema
/// is written by hand below: deriving it from the flattened tagged enum puts `oneOf` at the top
/// level, which Claude rejects (Claude Code then drops the tool) while Codex accepts it.
#[derive(Debug, Deserialize)]
pub struct SigilUpdate {
    /// Stable for this request; retry an uncertain result with the identical request.
    pub request_id: String,
    /// Lowercase letters, digits and dashes. May be empty when creating; Spellcast then picks one.
    #[serde(default)]
    pub sigil_id: String,
    /// Your stable task identity, for example `claude:<UUID>` or `codex:<thread UUID>`.
    pub source_id: String,
    /// Shown to the user, for example the host and task name.
    #[serde(default)]
    pub label: String,
    #[serde(flatten)]
    pub op: SigilAgentOp,
}

impl JsonSchema for SigilUpdate {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "SigilUpdate".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut plan = generator.subschema_for::<SigilPlan>();
        plan.insert("description".into(), json!("put_plan: the complete plan."));
        let mut changes = generator.subschema_for::<Vec<SigilAmendChange>>();
        changes.insert("description".into(), json!("amend: the plan changes."));
        schemars::json_schema!({
            "type": "object",
            "properties": {
                "request_id": {"type": "string", "description": "Stable for this request; retry an uncertain result with the identical request."},
                "sigil_id": {"type": "string", "default": "", "description": "Lowercase letters, digits and dashes. May be empty when creating; Spellcast then picks one."},
                "source_id": {"type": "string", "description": "Your stable task identity, for example `claude:<UUID>` or `codex:<thread UUID>`."},
                "label": {"type": "string", "default": "", "description": "Shown to the user, for example the host and task name."},
                "op": {
                    "type": "string",
                    "enum": ["put_plan", "execute", "claim", "start_step", "report_step", "block_step", "rerun_checks", "amend", "note"],
                    "description": "put_plan {expected_revision, plan}: create or edit your draft. execute {expected_revision}: after the user explicitly authorizes execution, freeze, start autonomously and claim your draft or frozen plan in one request. Do not execute merely because a draft was received or created. claim: claim a started run; a different executor needs handover approval. start_step/report_step: begin before editing and report afterwards; Spellcast runs checks. block_step: only an explicit stop condition or a necessary user decision. rerun_checks: repeat command checks. amend: record a plan change and continue; autonomous runs automatically run new verification commands, supervised runs require their approval. note: append a timeline note."
                },
                "expected_revision": {"type": "integer", "format": "uint64", "minimum": 0, "description": "put_plan: 0 creates; otherwise current revision. execute: the draft or frozen plan's current revision."},
                "plan": plan,
                "step_id": {"type": "string", "description": "start_step, report_step, block_step and rerun_checks."},
                "summary": {"type": "string", "default": "", "description": "report_step."},
                "evidence": {"type": "array", "items": {"type": "string"}, "default": [], "description": "report_step."},
                "reason": {"type": "string", "description": "block_step and amend (one line)."},
                "changes": changes,
                "text": {"type": "string", "description": "note."}
            },
            "required": ["request_id", "source_id", "op"]
        })
    }
}

fn fail(error: impl ToString) -> SpellcastError {
    SpellcastError::user(error.to_string())
}

pub(crate) fn request_hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(crate) fn validate_request_id(request_id: &str) -> Result<(), SpellcastError> {
    spellcast_core::reply::validate_id(request_id)?;
    if request_id.len() > 120 {
        return Err(fail("request_id 最多 120 个字符。"));
    }
    Ok(())
}

fn card_id(sigil_id: &str) -> String {
    format!("sigil-{sigil_id}")
}

fn generated_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

impl Bridge {
    pub(crate) fn sigil_store(&self) -> Result<std::sync::MutexGuard<'_, crate::store::Store>, SpellcastError> {
        self.store.as_ref().ok_or_else(|| fail("法阵需要持久状态库；当前临时会话没有保存能力。"))?
            .lock().map_err(|_| fail("法阵状态库不可用。"))
    }

    pub fn sigil_query(&self, query: SigilQuery) -> Result<Value, SpellcastError> {
        let store = self.sigil_store()?;
        match query.view.as_str() {
            "" | "list" => serde_json::to_value(store.sigil_list().map_err(fail)?).map_err(fail),
            "sigil" => {
                validate_sigil_id(&query.sigil_id).map_err(fail)?;
                let sigil = store.sigil_get(&query.sigil_id).map_err(fail)?;
                drop(store);
                // Board invalidation mounts/refreshes cards automatically. A
                // delegated save must not indirectly read its repository here.
                // Explicit native review/freezing still uses window-only routes.
                let review = if sigil.state == crate::sigils::SigilState::Draft && sigil.updated_by.kind == "client" {
                    crate::sigils::SigilReview { can_freeze:false,
                        issues:vec![crate::sigils::SigilIssue {level:crate::sigils::IssueLevel::Error,step_id:None,
                            code:"native_review_required".into(),message:"客户端草稿尚未原生复核；请在 Spellcast 窗口点击原生审阅，核对方案后再冻结。".into()}],
                        commands:crate::sigils::commands(&sigil.plan),location:sigil.plan.location,
                        execution_directory:crate::sigils::execution_directory(&sigil.id,&sigil.plan) }
                } else { review(&sigil.id, &sigil.plan) };
                let run = sigil.run.as_ref();
                let lights: serde_json::Map<String, Value> = sigil.plan.steps.iter()
                    .map(|step| (step.id.clone(), json!(crate::sigils::step_light(&sigil.plan, run, step)))).collect();
                let executable = matches!(sigil.state, crate::sigils::SigilState::Running | crate::sigils::SigilState::Paused);
                let next = run.filter(|_| executable).and_then(|run| crate::sigils::next_step(&sigil.plan, run)).map(|step| step.id.clone());
                let live = self.sigil_observation_live(&sigil.id);
                let check_live = self.sigil_check_live(&sigil.id);
                let pending_commands = crate::sigil_amend::waiting_commands(&sigil);
                let delivery = self.sigil_delivery_view(&sigil)?;
                Ok(json!({"sigil": sigil, "review": review, "lights": lights, "next": next, "card_id": card_id(&query.sigil_id),
                    "observation_live": live, "check_live": check_live, "pending_commands": pending_commands, "delivery": delivery}))
            }
            "step" => {
                validate_sigil_id(&query.sigil_id).map_err(fail)?;
                let sigil = store.sigil_get(&query.sigil_id).map_err(fail)?;
                let step = sigil.plan.steps.iter().find(|step| step.id == query.step_id).ok_or_else(|| fail(format!("步骤 {} 不存在。", query.step_id)))?;
                let run = sigil.run.as_ref();
                let progress = run.and_then(|run| run.steps.get(&step.id)).cloned().unwrap_or_default();
                // Command output kept beside the sigil, up to 64 KiB per run.
                let runs: Vec<u64> = progress.checks.iter().map(|check| check.run).filter(|run| *run > 0).collect();
                let outputs = store.sigil_check_outputs(&sigil.id, &runs).map_err(fail)?;
                Ok(json!({"sigil_id": sigil.id, "step": step, "light": crate::sigils::step_light(&sigil.plan, run, step),
                    "verification": crate::sigils::verification(step, &progress), "progress": progress, "outputs": outputs,
                    "max_output_bytes": crate::sigil_process::MAX_OUTPUT_BYTES}))
            }
            "events" => {
                validate_sigil_id(&query.sigil_id).map_err(fail)?;
                store.sigil_get(&query.sigil_id).map_err(fail)?;
                let limit = query.limit.unwrap_or(200).clamp(1, 200);
                let events = store.sigil_events(&query.sigil_id, query.since, limit).map_err(fail)?;
                Ok(json!({"sigil_id": query.sigil_id, "events": events}))
            }
            "next" => {
                drop(store);
                self.sigil_next(&query.sigil_id)
            }
            "wait" | "diff" => Err(fail(format!("{} 需要异步调用。", query.view))),
            _ => Err(fail("未知法阵查询；可使用 list、sigil、events、next、wait、step 或 diff。")),
        }
    }

    /// Queries including the long-poll `wait` and `diff`, which reads the private snapshots.
    pub async fn sigil_query_async(&self, query: SigilQuery) -> Result<Value, SpellcastError> {
        match query.view.as_str() {
            "wait" => {
                if !query.source_id.is_empty() {
                    spellcast_core::reply::validate_id(&query.source_id)?;
                }
                let wait = query.wait.unwrap_or(50);
                self.sigil_wait(&query.sigil_id, &query.source_id, query.since, wait).await
            }
            "diff" => self.sigil_diff(&query.sigil_id, &query.step_id, query.outside, &query.path).await,
            _ => self.sigil_query(query),
        }
    }

    /// The agent path (native MCP). Ownership and state rules live in the store transaction.
    pub async fn sigil_agent_update(&self, update: SigilUpdate) -> Result<Value, SpellcastError> {
        validate_request_id(&update.request_id)?;
        spellcast_core::reply::validate_id(&update.source_id)?;
        if update.label.chars().count() > 160 {
            return Err(fail("label 最多 160 字。"));
        }
        let label = if update.label.trim().is_empty() { update.source_id.clone() } else { update.label.clone() };
        if let SigilAgentOp::Execute { expected_revision } = &update.op {
            let actor = SigilActor { kind: "agent".into(), source_id: Some(update.source_id.clone()), label };
            return self.sigil_execute(&update.sigil_id, &update.request_id, *expected_revision, &actor).await;
        }
        let run_op = match &update.op {
            SigilAgentOp::PutPlan { .. } | SigilAgentOp::Execute { .. } => None,
            SigilAgentOp::Claim => Some(AgentRunOp::Claim),
            SigilAgentOp::StartStep { step_id } => Some(AgentRunOp::StartStep { step_id }),
            SigilAgentOp::ReportStep { step_id, summary, evidence } => Some(AgentRunOp::ReportStep { step_id, summary, evidence }),
            SigilAgentOp::BlockStep { step_id, reason } => Some(AgentRunOp::BlockStep { step_id, reason }),
            SigilAgentOp::RerunChecks { step_id } => Some(AgentRunOp::RerunChecks { step_id }),
            SigilAgentOp::Amend { reason, changes } => Some(AgentRunOp::Amend { reason, changes }),
            SigilAgentOp::Note { text } => Some(AgentRunOp::Note { text }),
        };
        if let Some(op) = run_op {
            validate_sigil_id(&update.sigil_id).map_err(fail)?;
            let hash = request_hash(&json!({"sigil_id": update.sigil_id, "source_id": update.source_id, "label": update.label, "op": update.op}));
            return self.sigil_agent_run(&update.request_id, &hash, &update.sigil_id, &update.source_id, &label, op).await;
        }
        let SigilAgentOp::PutPlan { expected_revision, plan } = &update.op else { unreachable!() };
        let hash = request_hash(&json!({"op": "put_plan", "sigil_id": update.sigil_id, "source_id": update.source_id,
            "label": update.label, "expected_revision": expected_revision, "plan": plan}));
        let sigil_id = if update.sigil_id.is_empty() {
            if *expected_revision != 0 {
                return Err(fail("修改已有法阵时需要 sigil_id。"));
            }
            self.unused_sigil_id()?
        } else {
            validate_sigil_id(&update.sigil_id).map_err(fail)?;
            update.sigil_id.clone()
        };
        let actor = SigilActor { kind: "agent".into(), source_id: Some(update.source_id.clone()), label };
        let mutation = self.sigil_store()?
            .sigil_mutate(&update.request_id, &hash, &sigil_id, SigilChange::PutPlan { expected_revision: *expected_revision, plan }, &actor, now_ms())
            .map_err(fail)?;
        self.sigil_answer(mutation, &update.request_id)
    }

    fn unused_sigil_id(&self) -> Result<String, SpellcastError> {
        let store = self.sigil_store()?;
        for _ in 0..8 {
            let id = generated_id();
            if !store.sigil_exists(&id).map_err(fail)? {
                return Ok(id);
            }
        }
        Err(fail("没能生成新的法阵 id，请指定 sigil_id。"))
    }

    /// Pins a card for a new draft, refreshes the window and returns the review with the result.
    fn sigil_answer(&self, mutation: SigilMutation, request_id: &str) -> Result<Value, SpellcastError> {
        let mut card_error = None;
        if mutation.created && !mutation.replayed {
            crate::sigil_run::SIGIL_CHANGED.notify_waiters();
            if let Err(error) = self.pin_sigil(&mutation.sigil_id, &format!("{request_id}.card")) {
                card_error = Some(error.to_string());
            }
        } else if mutation.deleted {
            crate::sigil_run::SIGIL_CHANGED.notify_waiters();
            self.surface.board_changed();
        } else if !mutation.replayed {
            self.sigil_changed(&mutation.sigil_id);
        }
        let review = mutation.sigil.as_ref().map(|sigil| review(&sigil.id, &sigil.plan));
        let mut value = json!({
            "sigil_id": mutation.sigil_id,
            "sigil": mutation.sigil,
            "created": mutation.created,
            "deleted": mutation.deleted,
            "replayed": mutation.replayed,
            "card_id": card_id(&mutation.sigil_id),
        });
        if let Some(review) = review {
            value["review"] = serde_json::to_value(review).map_err(fail)?;
        }
        if let Some(error) = card_error {
            value["card_error"] = json!(error);
        }
        Ok(value)
    }

    /// Explicit native-window review only. Automatic card reads stay pure for
    /// client drafts. The HTTP caller MUST require the existing window credential.
    pub fn sigil_user_review(&self, id: &str, expected_revision: u64) -> Result<Value, SpellcastError> {
        let mut value=self.sigil_query(SigilQuery {view:"sigil".into(),sigil_id:id.into(),..Default::default()})?;
        let sigil:crate::sigils::Sigil=serde_json::from_value(value["sigil"].clone()).map_err(fail)?;
        if sigil.state!=crate::sigils::SigilState::Draft || sigil.revision!=expected_revision {return Err(fail("草稿版本已变化，请刷新后重新审阅。"));}
        let reviewed=review(id,&sigil.plan);
        let current=self.sigil_store()?.sigil_get(id).map_err(fail)?;
        if current.revision!=expected_revision || current.state!=crate::sigils::SigilState::Draft {return Err(fail("草稿在审阅期间变化，请重新审阅。"));}
        value["review"]=serde_json::to_value(reviewed).map_err(fail)?;
        Ok(value)
    }

    /// Window route only: the user creates a draft, for example from a Canvas selection.
    pub fn sigil_user_create(&self, request_id: &str, plan: SigilPlan) -> Result<Value, SpellcastError> {
        validate_request_id(request_id)?;
        let hash = request_hash(&json!({"op": "create", "plan": plan}));
        let sigil_id = self.unused_sigil_id()?;
        let mutation = self.sigil_store()?
            .sigil_mutate(request_id, &hash, &sigil_id, SigilChange::PutPlan { expected_revision: 0, plan: &plan }, &SigilActor::user(), now_ms())
            .map_err(fail)?;
        self.sigil_answer(mutation, request_id)
    }

    /// Window route only. The user may edit any draft, including one an agent authors.
    pub fn sigil_user_put_plan(&self, sigil_id: &str, request_id: &str, expected_revision: u64, plan: SigilPlan) -> Result<Value, SpellcastError> {
        validate_request_id(request_id)?;
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = request_hash(&json!({"op": "user_put_plan", "sigil_id": sigil_id, "expected_revision": expected_revision, "plan": plan}));
        let mutation = self.sigil_store()?
            .sigil_mutate(request_id, &hash, sigil_id, SigilChange::PutPlan { expected_revision, plan: &plan }, &SigilActor::user(), now_ms())
            .map_err(fail)?;
        self.sigil_answer(mutation, request_id)
    }

    /// Window route only. Freezing records input hashes and the exact commands the user saw.
    pub fn sigil_freeze(&self, sigil_id: &str, request_id: &str, expected_revision: u64) -> Result<Value, SpellcastError> {
        self.sigil_freeze_as(sigil_id, request_id, expected_revision, &SigilActor::user())
    }

    pub(crate) fn sigil_freeze_as(&self, sigil_id: &str, request_id: &str, expected_revision: u64, actor: &SigilActor) -> Result<Value, SpellcastError> {
        validate_request_id(request_id)?;
        validate_sigil_id(sigil_id).map_err(fail)?;
        let mut request = json!({"op": "freeze", "sigil_id": sigil_id, "expected_revision": expected_revision});
        if actor.kind != "user" { request["actor"] = json!(actor); }
        let hash = request_hash(&request);
        // Review and hashing happen without the store lock; the transaction replays a retried
        // freeze first and only then requires this review to match the current revision.
        let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
        let checked = review(sigil_id, &sigil.plan);
        let blocked = (!checked.can_freeze).then(|| {
            let errors: Vec<&str> = checked.issues.iter().filter(|issue| issue.level == IssueLevel::Error).map(|issue| issue.message.as_str()).collect();
            format!("还不能冻结：{}", errors.join("；"))
        });
        let record = freeze_record(sigil_id, &sigil.plan, sigil.revision + 1, now_ms());
        let change = SigilChange::Freeze { expected_revision, record, reviewed_revision: sigil.revision, blocked };
        let mutation = self.sigil_store()?
            .sigil_mutate(request_id, &hash, sigil_id, change, actor, now_ms())
            .map_err(fail)?;
        self.sigil_answer(mutation, request_id)
    }

    pub fn sigil_unfreeze(&self, sigil_id: &str, request_id: &str, expected_revision: u64) -> Result<Value, SpellcastError> {
        validate_request_id(request_id)?;
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = request_hash(&json!({"op": "unfreeze", "sigil_id": sigil_id, "expected_revision": expected_revision}));
        let mutation = self.sigil_store()?
            .sigil_mutate(request_id, &hash, sigil_id, SigilChange::Unfreeze { expected_revision }, &SigilActor::user(), now_ms())
            .map_err(fail)?;
        self.sigil_answer(mutation, request_id)
    }

    /// Deletes a draft or a frozen sigil that never ran, with its Canvas cards. Delete-locked cards
    /// stay and are reported; they then show the sigil as unavailable.
    pub fn sigil_delete(&self, sigil_id: &str, request_id: &str, expected_revision: u64) -> Result<Value, SpellcastError> {
        validate_request_id(request_id)?;
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = request_hash(&json!({"op": "delete", "sigil_id": sigil_id, "expected_revision": expected_revision}));
        let mutation = self.sigil_store()?
            .sigil_mutate(request_id, &hash, sigil_id, SigilChange::Delete { expected_revision }, &SigilActor::user(), now_ms())
            .map_err(fail)?;
        let kept = if mutation.replayed { vec![] } else { self.remove_sigil_cards(sigil_id) };
        let mut value = self.sigil_answer(mutation, request_id)?;
        value["kept_cards"] = json!(kept);
        Ok(value)
    }

    fn remove_sigil_cards(&self, sigil_id: &str) -> Vec<String> {
        let target = CanvasContent::Sigil { sigil_id: sigil_id.into() };
        let mut kept = Vec::new();
        let cards: Vec<String> = {
            let state = self.state.lock().unwrap();
            state.session.board.canvas.objects.iter().filter(|object| object.content == target).map(|object| object.id.clone()).collect()
        };
        for id in cards {
            let removed = self.update(|state| {
                let canvas = &state.session.board.canvas;
                let object = canvas.object(&id).ok_or_else(|| fail("法阵卡片已不存在。"))?;
                let revision = object.content_revision;
                let mut current = Vec::new();
                let mut member = id.clone();
                while let Some(parent) = canvas.parent_of(&member) {
                    current.push(CanvasRead { kind: CanvasTargetKind::Composition, id: parent.id.clone(), revision: parent.revision });
                    member = parent.id.clone();
                }
                state.session.delete_canvas_content(&id, revision, &current)
            });
            if removed.is_err() {
                kept.push(id);
            }
        }
        self.surface.board_changed();
        kept
    }

    /// Shows the sigil's card, creating it beside existing content or restoring a removed one.
    pub fn pin_sigil(&self, sigil_id: &str, request_id: &str) -> Result<BoardSnapshot, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        spellcast_core::reply::validate_id(request_id)?;
        let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
        let id = card_id(sigil_id);
        let content = CanvasContent::Sigil { sigil_id: sigil_id.into() };
        let snapshot = self.update(|state| {
            let canvas = &state.session.board.canvas;
            if canvas.object(&id).is_some_and(|object| object.content != content) {
                return Err(fail("法阵卡片 ID 已被其他内容使用；没有覆盖它。"));
            }
            let operations = match canvas.items.iter().find(|item| item.item_id == id) {
                Some(item) if !item.removed => return Ok(state.session.snapshot()),
                Some(item) => vec![CanvasOperation::Place { id: id.clone(), expected_revision: item.revision,
                    fields: CanvasPlacementFields { removed: Some(false), ..Default::default() } }],
                None => {
                    let x = canvas.items.iter().filter(|item| !item.removed).map(|item| item.x + item.width).fold(0.0_f64, f64::max) + 48.0;
                    // Canvas origins need an absolute workspace; a fresh user draft may not have one yet.
                    // The label names the authoring task, as other origins do; the card shows the kind.
                    let author = if sigil.owner_source.is_empty() { String::new() }
                        else if sigil.updated_by.source_id.as_deref() == Some(sigil.owner_source.as_str()) { sigil.updated_by.label.clone() }
                        else { sigil.owner_source.clone() };
                    let origin = std::path::Path::new(&sigil.plan.repository).is_absolute().then(|| CanvasOrigin {
                        cwd: sigil.plan.repository.clone(), thread_id: None,
                        source_id: (!sigil.owner_source.is_empty()).then(|| sigil.owner_source.clone()), label: author });
                    vec![CanvasOperation::Create { id: id.clone(), content: content.clone(), origin,
                        placement: CanvasPlacementFields { x: Some(x), y: Some(80.0), width: Some(480.0), height: Some(360.0), ..Default::default() },
                        bindings: vec![] }]
                }
            };
            let request = CanvasBatchRequest { request_id: request_id.into(), reads: vec![], operations, feedback_sequences: vec![] };
            let result = state.session.apply_canvas_batch(request, None)?;
            if result.status != CanvasBatchStatus::Applied {
                return Err(fail("法阵卡片已变化，请刷新画布后重试。"));
            }
            Ok(state.session.snapshot())
        })?;
        self.surface.board_changed();
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigils::{SigilCheck, SigilState, SigilStep};
    use crate::Headless;
    use std::path::{Path, PathBuf};

    struct Fixture {
        db: PathBuf,
        repo: PathBuf,
        bridge: Bridge,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Release the exclusive database before removing it.
            drop(std::mem::replace(&mut self.bridge, Bridge::new(Headless, 0)));
            let _ = std::fs::remove_file(&self.db);
            let _ = std::fs::remove_dir_all(&self.repo);
        }
    }

    fn fixture() -> Fixture {
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let db = std::env::temp_dir().join(format!("spellcast-sigil-{unique}.sqlite3"));
        let repo = std::env::temp_dir().join(format!("spellcast-sigil-repo-{unique}"));
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/lib.rs"), "pub fn answer() -> u8 { 42 }\n").unwrap();
        let bridge = Bridge::open(Headless, 0, &db).unwrap();
        Fixture { db, repo, bridge }
    }

    fn plan(repo: &Path) -> SigilPlan {
        let step = |id: &str, depends_on: Vec<String>| SigilStep {
            id: id.into(), title: format!("Step {id}"), instructions: "Do it.".into(), inputs: vec!["src/lib.rs".into()],
            scope: vec!["src/**".into()], depends_on, stop_when: vec![],
            checks: vec![SigilCheck::Command { label: "tests".into(), argv: vec!["cargo".into(), "test".into()], timeout_s: 600 }],
        };
        SigilPlan { title: "Build the thing".into(), goal: "It works".into(), repository: repo.to_string_lossy().into(),
            steps: vec![step("a", vec![]), step("b", vec!["a".into()]), step("c", vec!["b".into()])], ..Default::default() }
    }

    async fn put(bridge: &Bridge, request: &str, id: &str, source: &str, revision: u64, plan: &SigilPlan) -> Result<Value, SpellcastError> {
        bridge.sigil_agent_update(SigilUpdate { request_id: request.into(), sigil_id: id.into(), source_id: source.into(), label: "Agent".into(),
            op: SigilAgentOp::PutPlan { expected_revision: revision, plan: plan.clone() } }).await
    }

    fn cards(bridge: &Bridge, id: &str) -> usize {
        let target = CanvasContent::Sigil { sigil_id: id.into() };
        bridge.board().canvas.objects.iter().filter(|object| object.content == target).count()
    }

    #[tokio::test]
    async fn agent_drafts_pin_one_card_replay_exactly_and_respect_authorship() {
        let f = fixture();
        let first = put(&f.bridge, "draft-1", "build", "claude:aaaa", 0, &plan(&f.repo)).await.unwrap();
        assert_eq!(first["created"], true);
        assert_eq!(first["sigil"]["revision"], 1);
        assert_eq!(first["sigil"]["state"], "draft");
        assert_eq!(first["review"]["can_freeze"], true);
        assert_eq!(cards(&f.bridge, "build"), 1);

        let replay = put(&f.bridge, "draft-1", "build", "claude:aaaa", 0, &plan(&f.repo)).await.unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(cards(&f.bridge, "build"), 1);
        let mut changed = plan(&f.repo);
        changed.title = "Different".into();
        assert!(put(&f.bridge, "draft-1", "build", "claude:aaaa", 0, &changed).await.unwrap_err().to_string().contains("request_id"));

        assert!(put(&f.bridge, "draft-2", "build", "claude:aaaa", 0, &plan(&f.repo)).await.unwrap_err().to_string().contains("已存在"));
        assert!(put(&f.bridge, "draft-3", "build", "claude:aaaa", 5, &changed).await.unwrap_err().to_string().contains("已经变化"));
        assert!(put(&f.bridge, "draft-4", "build", "codex:other", 1, &changed).await.unwrap_err().to_string().contains("另一个来源"));
        let updated = put(&f.bridge, "draft-5", "build", "claude:aaaa", 1, &changed).await.unwrap();
        assert_eq!(updated["sigil"]["revision"], 2);
        assert_eq!(updated["created"], false);

        let generated = put(&f.bridge, "draft-6", "", "claude:aaaa", 0, &plan(&f.repo)).await.unwrap();
        let id = generated["sigil_id"].as_str().unwrap().to_string();
        assert_eq!(id.len(), 8);
        assert_eq!(put(&f.bridge, "draft-6", "", "claude:aaaa", 0, &plan(&f.repo)).await.unwrap()["sigil_id"], id.as_str());
        assert_eq!(f.bridge.sigil_query(SigilQuery::default()).unwrap().as_array().unwrap().len(), 2);
        let events = f.bridge.sigil_query(SigilQuery { view: "events".into(), sigil_id: "build".into(), ..Default::default() }).unwrap();
        let kinds: Vec<&str> = events["events"].as_array().unwrap().iter().map(|event| event["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["created", "plan_updated"]);
        let later = f.bridge.sigil_query(SigilQuery { view: "events".into(), sigil_id: "build".into(), since: 1, limit: Some(5), ..Default::default() }).unwrap();
        assert_eq!(later["events"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn user_freezes_only_runnable_plans_and_agents_cannot_edit_frozen_ones() {
        let f = fixture();
        let mut broken = plan(&f.repo);
        broken.steps[0].depends_on = vec!["c".into()];
        put(&f.bridge, "create", "cycle", "claude:aaaa", 0, &broken).await.unwrap();
        assert!(f.bridge.sigil_freeze("cycle", "freeze-1", 1).unwrap_err().to_string().contains("还不能冻结"));

        put(&f.bridge, "fix", "cycle", "claude:aaaa", 1, &plan(&f.repo)).await.unwrap();
        let frozen = f.bridge.sigil_freeze("cycle", "freeze-2", 2).unwrap();
        assert_eq!(frozen["sigil"]["state"], "frozen");
        assert_eq!(frozen["sigil"]["freeze"]["commands"].as_array().unwrap().len(), 3);
        assert_eq!(frozen["sigil"]["freeze"]["input_hashes"]["src/lib.rs"].as_str().unwrap().len(), 64);
        assert_eq!(f.bridge.sigil_freeze("cycle", "freeze-2", 2).unwrap()["replayed"], true);
        assert!(put(&f.bridge, "late", "cycle", "claude:aaaa", 3, &plan(&f.repo)).await.unwrap_err().to_string().contains("只有草稿"));

        let draft = f.bridge.sigil_unfreeze("cycle", "unfreeze", 3).unwrap();
        assert_eq!(draft["sigil"]["state"], "draft");
        assert!(draft["sigil"].get("freeze").is_none());
        let user = f.bridge.sigil_user_put_plan("cycle", "user-edit", 4, plan(&f.repo)).unwrap();
        assert_eq!(user["sigil"]["updated_by"]["kind"], "user");
        assert_eq!(user["sigil"]["owner_source"], "claude:aaaa");
    }

    #[tokio::test]
    async fn user_drafts_adopt_their_first_agent_author_and_deletion_removes_cards() {
        let f = fixture();
        let created = f.bridge.sigil_user_create("user-create", SigilPlan { title: "From selection".into(), ..Default::default() }).unwrap();
        let id = created["sigil_id"].as_str().unwrap().to_string();
        assert_eq!(created["sigil"]["owner_source"], "");
        assert_eq!(created["review"]["can_freeze"], false);
        assert_eq!(cards(&f.bridge, &id), 1);
        let written = put(&f.bridge, "agent-fill", &id, "codex:writer", 1, &plan(&f.repo)).await.unwrap();
        assert_eq!(written["sigil"]["owner_source"], "codex:writer");
        assert!(put(&f.bridge, "intruder", &id, "claude:other", 2, &plan(&f.repo)).await.is_err());

        let deleted = f.bridge.sigil_delete(&id, "delete", 2).unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["kept_cards"].as_array().unwrap().len(), 0);
        assert_eq!(cards(&f.bridge, &id), 0);
        assert!(f.bridge.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: id.clone(), ..Default::default() }).is_err());
        assert_eq!(f.bridge.sigil_delete(&id, "delete", 2).unwrap()["replayed"], true);
    }

    #[tokio::test]
    async fn sigils_and_receipts_survive_restart() {
        let mut f = fixture();
        put(&f.bridge, "persist", "keep", "claude:aaaa", 0, &plan(&f.repo)).await.unwrap();
        f.bridge.sigil_freeze("keep", "persist-freeze", 1).unwrap();
        // Release the exclusive database before reopening it, as an app restart does.
        drop(std::mem::replace(&mut f.bridge, Bridge::new(Headless, 0)));
        let reopened = Bridge::open(Headless, 0, &f.db).unwrap();
        let read = reopened.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: "keep".into(), ..Default::default() }).unwrap();
        assert_eq!(read["sigil"]["state"], serde_json::to_value(SigilState::Frozen).unwrap());
        assert_eq!(read["sigil"]["revision"], 2);
        assert_eq!(reopened.sigil_freeze("keep", "persist-freeze", 1).unwrap()["replayed"], true);
        assert_eq!(cards(&reopened, "keep"), 1);
        drop(reopened);
    }
}

//! Natural-language goals in the game workspace. A goal is a durable request log entry, not a
//! work record. Sending reuses durable feedback delivery to one explicitly chosen, already
//! bound Codex task; nothing here starts, wakes or guesses a host.
use crate::{
    feedback::{DeliveryPhase, DeliveryReceipt},
    project_api::{owner, Fail},
    project_records::{RecordActor, RecordFields, SourceReference},
    Bridge,
};
use axum::{
    extract::{Path as RoutePath, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellcast_core::{inbox::now_ms, types::SayRequest, SpellcastError};
use std::sync::Arc;

const MAX_GOAL_CHARS: usize = 4_000;
const MAX_GOALS: usize = 500;
const MAX_CONTEXT_SOURCES: usize = 96;
const DOCUMENT_REVIEW_SCOPE: &str = "spellcast.document-review.v1";

pub(crate) fn init_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS spellcast_project_goals(
                project_id TEXT NOT NULL, id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                request_hash TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id,id));",
        )
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GoalSource {
    pub path: String,
    pub hash: String,
}

/// Which part of the game view the user was looking at. Context only; it grants nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GoalContext {
    /// overview | experience | object
    #[serde(default)]
    pub scale: String,
    #[serde(default)]
    pub zone_id: String,
    #[serde(default)]
    pub location_id: String,
    #[serde(default)]
    pub entity_kind: String,
    #[serde(default)]
    pub entity_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub source_revision: String,
    #[serde(default)]
    pub sources: Vec<GoalSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalTarget {
    pub source_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGoal {
    pub id: String,
    pub project_id: String,
    pub text: String,
    #[serde(default)]
    pub context: GoalContext,
    /// unsent | sent
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<GoalTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at_ms: Option<u64>,
    /// Set only when the user turns this goal into tracked implementation or verification work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    /// Document-question answer records, attributed to the receiving task and durable across restarts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub response_record_ids: Vec<String>,
    pub revision: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoalDelivery {
    pub phase: DeliveryPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handled_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoalView {
    #[serde(flatten)]
    pub goal: ProjectGoal,
    /// Live receipt state. Absent for unsent goals, and after a handled receipt aged out.
    pub delivery: Option<GoalDelivery>,
    pub proposal_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGoal {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub context: GoalContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendGoal {
    pub source_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReturnFeedback {
    pub request_id: String,
    pub proposal_id: String,
    pub item_ids: Vec<String>,
    pub note: String,
}

fn fail(e: impl ToString) -> SpellcastError {
    SpellcastError::user(e.to_string())
}
fn bad(e: impl ToString) -> Fail {
    (StatusCode::BAD_REQUEST, Json(json!({"error":e.to_string()})))
}
fn hash(value: &impl Serialize) -> Result<String, SpellcastError> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value).map_err(fail)?)))
}
fn delivery(receipt: &DeliveryReceipt) -> GoalDelivery {
    GoalDelivery {
        phase: receipt.phase,
        error: receipt.error.clone(),
        host_status: receipt.desktop.as_ref().map(|desktop| desktop.host_status.clone()).filter(|status| !status.is_empty()),
        attention: receipt.desktop.as_ref().and_then(|desktop| desktop.attention.clone()),
        received_at_ms: receipt.received_at_ms,
        handled_at_ms: receipt.handled_at_ms,
    }
}
fn validate_context(context: &GoalContext) -> Result<(), SpellcastError> {
    if !matches!(context.scale.as_str(), "" | "overview" | "experience" | "object") {
        return Err(fail("目标视图只能是全貌、体验或对象。"));
    }
    for value in [&context.zone_id, &context.location_id, &context.entity_kind, &context.source_revision] {
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err(fail("目标上下文标识无效。"));
        }
    }
    let document_question = context.entity_kind == "document_question";
    if context.entity_id.len() > if document_question { 1024 } else { 256 }
        || context.entity_id.chars().any(char::is_control) {
        return Err(fail("目标上下文标识无效。"));
    }
    if context.label.chars().count() > 200 || context.sources.len() > MAX_CONTEXT_SOURCES {
        return Err(fail("目标上下文过大，请选择更小的对象。"));
    }
    for source in &context.sources {
        if source.path.len() > 1024 || source.hash.len() > 128 {
            return Err(fail("目标上下文来源无效。"));
        }
    }
    if document_question {
        let path = &context.entity_id;
        if path.is_empty() || path.starts_with(|c| c == '/' || c == '\\') || path.contains('\\')
            || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
            || context.sources.iter().filter(|source| source.path == *path).count() != 1
            || !context.sources.iter().any(|source| source.path == *path
                && source.hash.len() == 64 && source.hash.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err(fail("文档询问需要相对文档路径及唯一的 SHA-256 来源。"));
        }
    }
    Ok(())
}

fn document_goal_uri(project: &str, goal: &str) -> String {
    format!("spellcast://project/{project}/goal/{goal}")
}

fn document_reference_uri(root: &str, relative: &str) -> String {
    // Mirror the reader's documentFileUri/encodeURI output, including reserved URI characters.
    let full = format!("{}/{}", root.trim_end_matches(|c| c == '/' || c == '\\'), relative).replace('\\', "/");
    let absolute = if full.starts_with('/') { full } else { format!("/{full}") };
    let mut encoded = String::new();
    for b in absolute.bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~:!$&'()*+,;=@".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("file://{encoded}")
}

fn matches_document_reference(reference: &SourceReference, expected_uri: &str, hash: &str) -> bool {
    reference.version == hash && reference.uri.split('#').next() == Some(expected_uri)
}

impl Bridge {
    fn read_goal(&self, project: &str, id: &str) -> Result<Option<(ProjectGoal, String)>, SpellcastError> {
        let store = self.project_store()?;
        store.project_get(project).map_err(fail)?;
        let row: Option<(String, String)> = store
            .connection
            .query_row("SELECT value, request_hash FROM spellcast_project_goals WHERE project_id=?1 AND id=?2", params![project, id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(fail)?;
        row.map(|(value, hash)| Ok((serde_json::from_str(&value).map_err(fail)?, hash))).transpose()
    }

    fn write_goal(&self, goal: &ProjectGoal, request_hash: &str) -> Result<(), SpellcastError> {
        let store = self.project_store()?;
        store
            .connection
            .execute(
                "INSERT INTO spellcast_project_goals(project_id,id,created_at_ms,request_hash,value) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(project_id,id) DO UPDATE SET value=excluded.value",
                params![goal.project_id, goal.id, goal.created_at_ms as i64, request_hash, serde_json::to_string(goal).map_err(fail)?],
            )
            .map_err(fail)?;
        Ok(())
    }

    fn goal_view(&self, goal: ProjectGoal, proposals: &[crate::project_proposals::ProjectProposal]) -> GoalView {
        let delivery = goal.sequence.and_then(|sequence| {
            self.state.lock().unwrap().deliveries.iter().find(|receipt| receipt.event.seq == sequence).map(delivery)
        });
        let proposal_ids = proposals.iter().filter(|proposal| proposal.goal_id.as_deref() == Some(goal.id.as_str())).map(|proposal| proposal.id.clone()).collect();
        GoalView { goal, delivery, proposal_ids }
    }

    pub fn project_goals(&self, project: &str) -> Result<Vec<GoalView>, SpellcastError> {
        let (goals, proposals) = {
            let store = self.project_store()?;
            store.project_get(project).map_err(fail)?;
            let mut statement = store
                .connection
                .prepare("SELECT value FROM spellcast_project_goals WHERE project_id=?1 ORDER BY created_at_ms DESC, id ASC LIMIT 200")
                .map_err(fail)?;
            let goals: Vec<ProjectGoal> = statement
                .query_map([project], |row| row.get::<_, String>(0))
                .map_err(fail)?
                .map(|row| serde_json::from_str(&row.map_err(fail)?).map_err(fail))
                .collect::<Result<_, SpellcastError>>()?;
            drop(statement);
            (goals, store.project_proposals(project, true).map_err(fail)?)
        };
        Ok(goals.into_iter().map(|goal| self.goal_view(goal, &proposals)).collect())
    }

    /// Saves the user's words first, so an unreachable or missing task never loses them.
    pub fn create_project_goal(&self, project: &str, request: CreateGoal) -> Result<GoalView, SpellcastError> {
        uuid::Uuid::parse_str(&request.id).map_err(|_| fail("目标需要稳定的 UUID。"))?;
        let text = request.text.trim().to_string();
        if text.is_empty() || text.chars().count() > MAX_GOAL_CHARS {
            return Err(fail("请用 1 至 4000 字写下目标或问题。"));
        }
        validate_context(&request.context)?;
        let request_hash = hash(&(&text, &request.context))?;
        if let Some((goal, stored)) = self.read_goal(project, &request.id)? {
            if stored != request_hash {
                return Err(fail("这个目标标识已用于不同内容；没有覆盖原目标。"));
            }
            return Ok(self.goal_view(goal, &[]));
        }
        {
            let store = self.project_store()?;
            let project_row = store.project_get(project).map_err(fail)?;
            if project_row.archived {
                return Err(fail("项目已归档，请先恢复。"));
            }
            let count: i64 = store.connection.query_row("SELECT COUNT(*) FROM spellcast_project_goals WHERE project_id=?1", [project], |r| r.get(0)).map_err(fail)?;
            if count as usize >= MAX_GOALS {
                return Err(fail("这个项目保存的目标已达上限；请先整理旧目标。"));
            }
        }
        let now = now_ms();
        let goal = ProjectGoal {
            id: request.id, project_id: project.into(), text, context: request.context, status: "unsent".into(),
            target: None, sequence: None, sent_at_ms: None, record_id: None, response_record_ids: vec![], revision: 1, created_at_ms: now, updated_at_ms: now,
        };
        self.write_goal(&goal, &request_hash)?;
        self.surface.board_changed();
        Ok(self.goal_view(goal, &[]))
    }

    fn project_context(&self, project: &str, kind: &str, extra: Value) -> Result<Value, SpellcastError> {
        let name = self.project_store()?.project_get(project).map_err(fail)?.name;
        let root = self.game_connection(project)?.map(|connection| connection.root);
        let mut context = json!({"kind": kind, "project_id": project, "project_name": name, "repository_root": root,
            "runtime_verified": false});
        if let (Some(target), Value::Object(fields)) = (context.as_object_mut(), extra) {
            target.extend(fields);
        }
        Ok(context)
    }

    fn bound_target(&self, source_id: &str, thread_id: &str) -> Result<GoalTarget, SpellcastError> {
        let binding = self
            .feedback_state(None)
            .bindings
            .into_iter()
            .find(|binding| binding.source_id == source_id && binding.thread_id == thread_id)
            .ok_or_else(|| fail("接收任务不是当前已关联的 Codex 任务；目标仍保存为未发送。"))?;
        Ok(GoalTarget { source_id: binding.source_id, thread_id: binding.thread_id, cwd: binding.cwd, label: binding.label })
    }

    /// Sends a saved goal to one explicitly chosen, already bound task. Idempotent per goal.
    pub fn send_project_goal(&self, project: &str, id: &str, request: SendGoal) -> Result<GoalView, SpellcastError> {
        let (mut goal, request_hash) = self.read_goal(project, id)?.ok_or_else(|| fail("找不到这个目标。"))?;
        if goal.status == "sent" {
            let same = goal.target.as_ref().is_some_and(|target| target.source_id == request.source_id && target.thread_id == request.thread_id);
            if same {
                return Ok(self.goal_view(goal, &[]));
            }
            return Err(fail("这个目标已发送给另一个任务；没有重复发送。"));
        }
        let target = self.bound_target(&request.source_id, &request.thread_id)?;
        let document_question = goal.context.entity_kind == "document_question";
        let context = self.project_context(project, if document_question { "document_question" } else { "goal" }, json!({"goal_id": goal.id, "view": goal.context,
            "response": if document_question {
                "Answer with spellcast_project_update op=put_record, scope=spellcast.document-review.v1, first reference=the quoted document URI and SHA-256, another reference=spellcast://project/<projectId>/goal/<goalId>; answer only, do not edit the document or canonical planning design."
            } else { "spellcast_project_update op=put_proposal with this goal_id" }}))?;
        let event = self.say_with_project_context(
            SayRequest {
                text: goal.text.clone(),
                request_id: Some(format!("project-goal-{}", goal.id)),
                source_id: Some(target.source_id.clone()),
                target_thread_id: Some(target.thread_id.clone()),
                ..Default::default()
            },
            Some(context),
        )?;
        let now = now_ms();
        goal.status = "sent".into();
        goal.target = Some(target);
        goal.sequence = Some(event.seq);
        goal.sent_at_ms = Some(now);
        goal.updated_at_ms = now;
        goal.revision += 1;
        self.write_goal(&goal, &request_hash)?;
        self.surface.board_changed();
        Ok(self.goal_view(goal, &[]))
    }

    /// A proposal from the goal's own receiving task answers it: the receipt becomes responded.
    /// Acknowledgement (handled) stays the task's explicit act.
    pub(crate) fn note_goal_response(&self, project: &str, goal_id: &str, proposal_id: &str, author_thread: Option<&str>) {
        let Ok(Some((goal, _))) = self.read_goal(project, goal_id) else { return };
        if goal.context.entity_kind == "document_question" { return; }
        let (Some(sequence), Some(target)) = (goal.sequence, goal.target) else { return };
        if author_thread != Some(target.thread_id.as_str()) {
            return;
        }
        let _ = self.update(|state| {
            for receipt in &mut state.deliveries {
                if receipt.event.seq == sequence {
                    receipt.responded_at_ms.get_or_insert_with(now_ms);
                    receipt.response_request_id = Some(proposal_id.into());
                    if receipt.phase != DeliveryPhase::Handled {
                        receipt.phase = DeliveryPhase::Responded;
                    }
                    receipt.error = None;
                }
            }
            Ok(())
        });
        self.surface.board_changed();
    }

    /// A document answer counts only for its explicitly linked, sent question and receiving task.
    pub(crate) fn note_document_goal_response(&self, project: &str, record_id: &str, fields: &RecordFields, actor: &RecordActor) {
        if fields.scope != DOCUMENT_REVIEW_SCOPE || fields.goal.trim().is_empty() || fields.result.trim().is_empty()
            || fields.references.len() < 2 { return; }
        let Some(goal_id) = fields.references[1..].iter().find_map(|reference| {
            let id = reference.uri.strip_prefix(&format!("spellcast://project/{project}/goal/"))?;
            (uuid::Uuid::parse_str(id).is_ok() && document_goal_uri(project, id) == reference.uri).then_some(id)
        }) else { return };
        // Keep read, validation and append under one store mutex. Two successful record writes
        // can call this concurrently, but neither can replace the other's response ID.
        let sequence = (|| -> Result<Option<u64>, SpellcastError> {
            let store = self.project_store()?;
            let row: Option<String> = store.connection.query_row(
                "SELECT value FROM spellcast_project_goals WHERE project_id=?1 AND id=?2",
                params![project, goal_id], |row| row.get(0),
            ).optional().map_err(fail)?;
            let Some(raw) = row else { return Ok(None) };
            let mut goal: ProjectGoal = serde_json::from_str(&raw).map_err(fail)?;
            if goal.status != "sent" || goal.context.entity_kind != "document_question" { return Ok(None); }
            let (Some(sequence), Some(target)) = (goal.sequence, goal.target.as_ref()) else { return Ok(None) };
            if actor.kind != "agent" || actor.thread_id.as_deref() != Some(target.thread_id.as_str()) { return Ok(None); }
            let Some(source) = goal.context.sources.iter().find(|source| source.path == goal.context.entity_id) else { return Ok(None) };
            let connection: Option<String> = store.connection.query_row(
                "SELECT value FROM spellcast_project_game_connections WHERE project_id=?1",
                [project], |row| row.get(0),
            ).optional().map_err(fail)?;
            let Some(connection) = connection else { return Ok(None) };
            let connection: crate::project_game::GameConnection = serde_json::from_str(&connection).map_err(fail)?;
            let expected_uri = document_reference_uri(&connection.root, &source.path);
            if !matches_document_reference(&fields.references[0], &expected_uri, &source.hash) { return Ok(None); }
            if !goal.response_record_ids.iter().any(|id| id == record_id) {
                goal.response_record_ids.push(record_id.into());
                goal.updated_at_ms = now_ms();
                goal.revision += 1;
                let changed = store.connection.execute(
                    "UPDATE spellcast_project_goals SET value=?3 WHERE project_id=?1 AND id=?2 AND value=?4",
                    params![project, goal_id, serde_json::to_string(&goal).map_err(fail)?, raw],
                ).map_err(fail)?;
                if changed != 1 { return Ok(None); }
            }
            Ok(Some(sequence))
        })();
        let Ok(Some(sequence)) = sequence else { return };
        let _ = self.update(|state| {
            for receipt in &mut state.deliveries {
                if receipt.event.seq == sequence {
                    receipt.responded_at_ms.get_or_insert_with(now_ms);
                    receipt.response_request_id = Some(record_id.into());
                    if receipt.phase != DeliveryPhase::Handled { receipt.phase = DeliveryPhase::Responded; }
                    receipt.error = None;
                }
            }
            Ok(())
        });
        self.surface.board_changed();
    }

    /// Only when implementation or verification needs tracking does a goal become a record.
    pub fn promote_project_goal(&self, project: &str, id: &str) -> Result<GoalView, SpellcastError> {
        let (mut goal, request_hash) = self.read_goal(project, id)?.ok_or_else(|| fail("找不到这个目标。"))?;
        if goal.record_id.is_some() {
            return Ok(self.goal_view(goal, &[]));
        }
        let first = goal.text.lines().next().unwrap_or_default();
        let title: String = if first.chars().count() > 80 { format!("{}…", first.chars().take(80).collect::<String>()) } else { first.to_string() };
        let record_id = format!("goal-{}", goal.id);
        let command = serde_json::from_value(json!({"request_id": format!("goal-record-{}", goal.id), "project_id": project, "op": "put_record",
            "id": record_id, "expected_revision": 0, "fields": {"title": title, "goal": goal.text, "scope": goal.context.label, "status": "planned",
            "result": "", "boundaries": "由目标转为事项；尚未执行，也没有 Unity 或玩家验证结果。", "next_step": "由接手任务记录实际实施与验证结果。"}}))
            .map_err(fail)?;
        self.project_user_mutate(command)?;
        goal.record_id = Some(record_id);
        goal.updated_at_ms = now_ms();
        goal.revision += 1;
        self.write_goal(&goal, &request_hash)?;
        Ok(self.goal_view(goal, &[]))
    }

    /// After the user returns items, tell the task that wrote the proposal. Without a bound
    /// target the note stays on the proposal and nothing is sent.
    pub fn send_proposal_feedback(&self, project: &str, request: ReturnFeedback) -> Result<Value, SpellcastError> {
        uuid::Uuid::parse_str(&request.request_id).map_err(|_| fail("请求需要稳定的 UUID。"))?;
        let proposal = self.project_store()?.project_proposal(project, &request.proposal_id).map_err(fail)?;
        let author = &proposal.created_by;
        let goal_target = proposal.goal_id.as_ref().and_then(|goal| self.read_goal(project, goal).ok().flatten()).and_then(|(goal, _)| goal.target);
        let candidates = [author.source_id.clone().zip(author.thread_id.clone()), goal_target.map(|target| (target.source_id, target.thread_id))];
        let bindings = self.feedback_state(None).bindings;
        let Some((source_id, thread_id)) = candidates.into_iter().flatten().find(|(source, thread)| bindings.iter().any(|binding| &binding.source_id == source && &binding.thread_id == thread)) else {
            return Ok(json!({"sent": false, "reason": "提案作者或原接收任务当前没有关联；退回说明已保存在提案中，没有发送。"}));
        };
        let context = self.project_context(project, "proposal_return", json!({"proposal_id": proposal.id, "proposal_revision": proposal.revision,
            "item_ids": request.item_ids, "goal_id": proposal.goal_id}))?;
        let event = self.say_with_project_context(
            SayRequest {
                text: request.note.trim().to_string(),
                request_id: Some(format!("proposal-return-{}", request.request_id)),
                source_id: Some(source_id),
                target_thread_id: Some(thread_id),
                ..Default::default()
            },
            Some(context),
        )?;
        self.surface.board_changed();
        Ok(json!({"sent": true, "sequence": event.seq}))
    }
}

#[cfg(test)]
#[path = "project_goal_tests.rs"]
mod tests;

pub(crate) fn router() -> Router<Arc<Bridge>> {
    Router::new()
        .route("/api/projects/:project/goals", get(list).post(create))
        .route("/api/projects/:project/goals/:id/send", post(send))
        .route("/api/projects/:project/goals/:id/record", post(promote))
        .route("/api/projects/:project/proposals/return", post(return_items))
}

async fn list(State(b): State<Arc<Bridge>>, RoutePath(project): RoutePath<String>) -> Result<Json<Value>, Fail> {
    b.project_goals(&project).map(|goals| Json(json!(goals))).map_err(bad)
}
async fn create(State(b): State<Arc<Bridge>>, RoutePath(project): RoutePath<String>, headers: HeaderMap, Json(request): Json<CreateGoal>) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    b.create_project_goal(&project, request).map(|goal| Json(json!(goal))).map_err(bad)
}
async fn send(State(b): State<Arc<Bridge>>, RoutePath((project, id)): RoutePath<(String, String)>, headers: HeaderMap, Json(request): Json<SendGoal>) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    b.send_project_goal(&project, &id, request).map(|goal| Json(json!(goal))).map_err(bad)
}
async fn promote(State(b): State<Arc<Bridge>>, RoutePath((project, id)): RoutePath<(String, String)>, headers: HeaderMap) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    b.promote_project_goal(&project, &id).map(|goal| Json(json!(goal))).map_err(bad)
}
async fn return_items(State(b): State<Arc<Bridge>>, RoutePath(project): RoutePath<String>, headers: HeaderMap, Json(request): Json<ReturnFeedback>) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    b.send_proposal_feedback(&project, request).map(Json).map_err(bad)
}

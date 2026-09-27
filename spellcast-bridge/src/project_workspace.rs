//! Project record application boundary. Canvas ownership and project write grants are separate.

use rmcp::schemars::{self, JsonSchema};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellcast_core::{inbox::now_ms, BoardSnapshot, CanvasBatchRequest, CanvasContent,
    CanvasOperation, CanvasPlacementFields, SpellcastError};
use crate::{codex, project_records::*, Bridge};

pub(crate) fn init_access_schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS spellcast_project_access (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS spellcast_project_access_history (
        id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(id,revision));").map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectAccess {
    pub id: String,
    pub project_id: String,
    pub source_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub label: String,
    pub state: String,
    pub revision: u64,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProjectAccessRequest {
    pub project_id: String,
    /// Attribution only. Permission is never inferred from this value or cwd.
    pub source_id: String,
    /// Actual Codex task UUID, checked against host metadata before asking the user.
    pub thread_id: String,
    pub cwd: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProjectAgentMutation {
    /// Secret returned by spellcast_project_access. Keep it private; never put it in a record.
    pub access_token: String,
    pub command: RecordCommand,
}

/// A local OS-user automation request, distinct from a project-scoped grant.
#[derive(Deserialize, JsonSchema)]
pub struct ProjectLocalCommand {
    pub source_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub command: RecordCommand,
}

#[derive(Deserialize, JsonSchema)]
pub struct ProjectLocalMutation {
    /// Private local automation key. Never put it in records, output, or exports.
    pub local_token: String,
    pub request: ProjectLocalCommand,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ProjectQuery {
    /// projects | objects | records | record | history | export | markdown | candidates | trials | trial | adoptions | proposals | proposal | goals
    #[serde(default)]
    pub view: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub id: String,
    /// For history: project | object | record | candidate.
    #[serde(default)]
    pub kind: String,
    /// For trials: optional flow object ID filter.
    #[serde(default)]
    pub flow_id: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
}

fn fail(error: impl ToString) -> SpellcastError { SpellcastError::user(error.to_string()) }
fn hashed(token: &str) -> String { format!("{:x}", Sha256::digest(token.as_bytes())) }
fn user_actor() -> RecordActor {
    RecordActor { kind: "user".into(), source_id: None, thread_id: None, cwd: None, label: "用户".into() }
}
fn to_value(value: impl Serialize) -> Result<Value, SpellcastError> {
    serde_json::to_value(value).map_err(fail)
}

impl Bridge {
    /// Exposed to the main Tauri window by IPC only, never by HTTP or native Agent tools.
    pub fn project_window_key(&self) -> String { self.project_window_key.clone() }

    /// Explicit startup configuration for trusted headless UI clients / isolated fixtures.
    pub fn with_project_window_key(mut self, key: String) -> Result<Self, String> {
        if key.len()!=64 || !key.bytes().all(|b|b.is_ascii_hexdigit()) { return Err("项目窗口凭据必须是 64 位随机十六进制值。".into()); }
        self.project_window_key=key; Ok(self)
    }

    pub(crate) fn is_project_window_key(&self, key: &str) -> bool {
        key.len()==self.project_window_key.len() && key.bytes().zip(self.project_window_key.bytes()).fold(0_u8,|acc,(a,b)|acc|(a^b))==0
    }

    pub fn with_project_local_key(mut self, key: String) -> Result<Self, String> {
        if key.len()!=64 || !key.bytes().all(|b|b.is_ascii_hexdigit()) || key==self.project_window_key {
            return Err("本机项目凭据必须是独立的 64 位随机十六进制值。".into());
        }
        self.project_local_key=Some(key);
        Ok(self)
    }

    pub(crate) fn is_project_local_key(&self, key: &str) -> bool {
        self.project_local_key.as_ref().is_some_and(|expected| {
            key.len()==expected.len() && key.bytes().zip(expected.bytes()).fold(0_u8,|acc,(a,b)|acc|(a^b))==0
        })
    }

    pub async fn project_local_mutate(&self, request: ProjectLocalMutation) -> Result<RecordMutationResult, SpellcastError> {
        if !self.is_project_local_key(&request.local_token) {
            return Err(fail("本机项目 API 需要当前系统用户的独立凭据；窗口凭据、来源 ID 和目录别名不能替代。"));
        }
        let request=request.request;
        spellcast_core::reply::validate_id(&request.source_id)?;
        if request.source_id!=request.thread_id && request.source_id!=format!("codex:{}",request.thread_id) {
            return Err(fail("必须使用当前实际 Codex 任务 UUID，不能借用旧任务来源。"));
        }
        if !matches!(&request.command.change, RecordChange::CreateProject{..}|RecordChange::UpdateProject{..}|RecordChange::PutObject{..}|RecordChange::RestoreObject{..}|RecordChange::SetObjectLock{..}|RecordChange::PutRecord{..}|RecordChange::ArchiveRecord{..}|RecordChange::RestoreRecord{..}|RecordChange::PutProposal{..}) {
            return Err(fail("本机项目 API 不支持导入、数值候选、试走保存、候选采用或提案决定；这些请在窗口中明确操作。"));
        }
        let binding=codex::verify_binding(request.source_id,request.thread_id,Some(request.cwd))
            .await.map_err(|error|fail(error.message))?;
        self.project_local_mutate_verified(request.command,binding)
    }

    fn project_local_mutate_verified(&self, command: RecordCommand, binding: codex::CodexBinding) -> Result<RecordMutationResult, SpellcastError> {
        let actor=RecordActor {kind:"agent".into(),source_id:Some(binding.source_id),thread_id:Some(binding.thread_id),cwd:Some(binding.cwd),label:binding.label};
        let result=self.project_store()?.project_mutate(&command,&actor).map_err(fail)?;
        self.answered_goal(&command,&actor,&result);
        self.surface.board_changed();
        Ok(result)
    }

    fn answered_goal(&self, command: &RecordCommand, actor: &RecordActor, result: &RecordMutationResult) {
        if let RecordChange::PutProposal { id, goal_id: Some(goal), .. } = &command.change {
            self.note_goal_response(&command.project_id, goal, id, actor.thread_id.as_deref());
        } else if let RecordChange::PutRecord { .. } = &command.change {
            if let Some(record) = &result.record {
                self.note_document_goal_response(&command.project_id, &record.id, &record.fields, &record.updated_by);
            }
        }
    }

    pub(crate) fn project_store(&self) -> Result<std::sync::MutexGuard<'_, crate::store::Store>, SpellcastError> {
        self.store.as_ref().ok_or_else(|| fail("项目记录需要持久状态库；当前临时会话没有保存能力。"))?
            .lock().map_err(|_| fail("项目状态库不可用。"))
    }

    pub fn project_query(&self, request: ProjectQuery) -> Result<Value, SpellcastError> {
        let store = self.project_store()?;
        match request.view.as_str() {
            "" | "projects" => to_value(store.project_list().map_err(fail)?),
            "project" => to_value(store.project_get(&request.project_id).map_err(fail)?),
            "objects" => to_value(store.project_objects(&request.project_id).map_err(fail)?),
            "records" => to_value(store.project_records(&request.project_id, &request.query, request.status.as_deref(), request.include_archived).map_err(fail)?),
            "record" => to_value(store.project_record(&request.project_id, &request.id).map_err(fail)?),
            "history" => to_value(store.project_history(&request.project_id, if request.kind.is_empty() { "record" } else { &request.kind }, &request.id).map_err(fail)?),
            "export" => to_value(store.project_export(&request.project_id).map_err(fail)?),
            "markdown" => Ok(json!({"markdown":store.project_markdown(&request.project_id).map_err(fail)?})),
            "candidates" => to_value(store.project_candidates(&request.project_id).map_err(fail)?),
            "trials" => to_value(store.project_trials(&request.project_id, &request.flow_id).map_err(fail)?),
            "trial" => to_value(store.project_trial(&request.project_id, &request.id).map_err(fail)?),
            "adoptions" => to_value(store.project_adoptions(&request.project_id).map_err(fail)?),
            "proposals" => to_value(store.project_proposals(&request.project_id, request.include_archived).map_err(fail)?),
            "proposal" => to_value(store.project_proposal(&request.project_id, &request.id).map_err(fail)?),
            "goals" => { drop(store); to_value(self.project_goals(&request.project_id)?) }
            _ => Err(fail("未知项目查询；可使用 projects、project、objects、records、record、history、export、markdown、candidates、trials、trial、adoptions、proposals、proposal 或 goals。")),
        }
    }

    /// Local application route only. Agent tools must use project_agent_mutate.
    pub fn project_user_mutate(&self, command: RecordCommand) -> Result<RecordMutationResult, SpellcastError> {
        let result = self.project_store()?.project_mutate(&command, &user_actor()).map_err(fail)?;
        self.surface.board_changed();
        Ok(result)
    }

    pub async fn project_request_access(&self, request: ProjectAccessRequest) -> Result<Value, SpellcastError> {
        spellcast_core::reply::validate_id(&request.source_id)?;
        if request.source_id != request.thread_id && request.source_id != format!("codex:{}",request.thread_id) {
            return Err(fail("项目申请的 source_id 必须是当前实际任务 UUID（或 codex:UUID）；不能借用旧任务的来源。"));
        }
        self.project_store()?.project_get(&request.project_id).map_err(fail)?;
        let binding = codex::verify_binding(request.source_id, request.thread_id, Some(request.cwd))
            .await.map_err(|error|fail(error.message))?;
        self.create_project_access(&request.project_id, binding)
    }

    /// Only after host verification; tests simulate exactly that verified boundary.
    pub(crate) fn create_project_access(&self, project_id: &str, binding: codex::CodexBinding) -> Result<Value, SpellcastError> {
        let mut store = self.project_store()?;
        let project = store.project_get(project_id).map_err(fail)?;
        if project.archived { return Err(fail("项目已归档，请在窗口恢复后申请接手。")); }
        let created = now_ms();
        let access = ProjectAccess { id: uuid::Uuid::new_v4().to_string(), project_id: project_id.into(),
            source_id: binding.source_id, thread_id: binding.thread_id, cwd: binding.cwd,
            label: binding.label, state: "pending".into(), revision: 1, created_at_ms: created,
            expires_at_ms: created + 7 * 24 * 60 * 60 * 1000 };
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let value = serde_json::to_string(&access).map_err(fail)?;
        let tx = store.connection.transaction().map_err(fail)?;
        tx.execute("INSERT INTO spellcast_project_access(id,project_id,token_hash,value) VALUES(?1,?2,?3,?4)",
            params![access.id, project_id, hashed(&token), value]).map_err(fail)?;
        tx.execute("INSERT INTO spellcast_project_access_history(id,revision,value) VALUES(?1,1,?2)",
            params![access.id, value]).map_err(fail)?;
        tx.commit().map_err(fail)?;
        drop(store);
        self.surface.board_changed();
        Ok(json!({"access":access,"access_token":token,
            "next":"请在 Spellcast 项目记录的任务授权中批准此申请。凭据只返回本次调用；不要写进事项或导出。项目别名不会授予写权限。"}))
    }

    pub fn project_access_list(&self, project_id: &str) -> Result<Vec<ProjectAccess>, SpellcastError> {
        let store = self.project_store()?;
        store.project_get(project_id).map_err(fail)?;
        let mut stmt = store.connection.prepare("SELECT value FROM spellcast_project_access WHERE project_id=?1 ORDER BY rowid DESC LIMIT 500").map_err(fail)?;
        let rows = stmt.query_map([project_id], |row| row.get::<_,String>(0)).map_err(fail)?;
        rows.map(|r| serde_json::from_str(&r.map_err(fail)?).map_err(fail)).collect()
    }

    pub fn project_decide_access(&self, project_id: &str, id: &str, expected_revision: u64, decision: &str) -> Result<ProjectAccess, SpellcastError> {
        if !matches!(decision,"approved"|"revoked") { return Err(fail("授权操作只支持批准或撤销。")); }
        let mut store = self.project_store()?;
        store.project_get(project_id).map_err(fail)?;
        let tx = store.connection.transaction().map_err(fail)?;
        let raw: String = tx.query_row("SELECT value FROM spellcast_project_access WHERE id=?1 AND project_id=?2", params![id,project_id], |r| r.get(0)).map_err(fail)?;
        let mut access: ProjectAccess = serde_json::from_str(&raw).map_err(fail)?;
        if access.revision == expected_revision + 1 && access.state == decision { return Ok(access); }
        if access.revision != expected_revision { return Err(fail("授权记录已变化，请刷新后重试。")); }
        if decision == "approved" && access.expires_at_ms <= now_ms() { return Err(fail("申请已过期，请让任务重新申请。")); }
        access.revision += 1;
        access.state = decision.into();
        let value = serde_json::to_string(&access).map_err(fail)?;
        tx.execute("UPDATE spellcast_project_access SET value=?2 WHERE id=?1",params![id,value]).map_err(fail)?;
        tx.execute("INSERT INTO spellcast_project_access_history(id,revision,value) VALUES(?1,?2,?3)",params![id,access.revision,value]).map_err(fail)?;
        tx.commit().map_err(fail)?;
        Ok(access)
    }

    pub fn project_agent_mutate(&self, request: ProjectAgentMutation) -> Result<RecordMutationResult, SpellcastError> {
        // Hold one store lock throughout authorization + mutation, so revoke cannot race a write.
        let mut store = self.project_store()?;
        if request.access_token.len() != 64 { return Err(fail("项目写入未授权；需要窗口批准的有效凭据。")); }
        let raw: Option<String> = store.connection.query_row(
            "SELECT value FROM spellcast_project_access WHERE token_hash=?1 AND project_id=?2",
            params![hashed(&request.access_token),request.command.project_id], |r| r.get(0)).optional().map_err(fail)?;
        let access: ProjectAccess = serde_json::from_str(&raw.ok_or_else(|| fail("项目写入未授权；来源 ID 或目录别名不能替代凭据。"))?).map_err(fail)?;
        if access.state != "approved" || access.expires_at_ms <= now_ms() { return Err(fail("项目凭据未批准、已撤销或已过期。请在窗口核对任务授权。")); }
        let op = serde_json::to_value(&request.command).map_err(fail)?;
        if !matches!(op["op"].as_str(),Some("put_object"|"put_record"|"archive_record"|"restore_record"|"put_proposal")) {
            return Err(fail("Agent 权限只覆盖事项、非规划开发对象与提案；项目管理、导入和提案决定请在窗口完成。"));
        }
        let actor = RecordActor { kind:"agent".into(),source_id:Some(access.source_id),thread_id:Some(access.thread_id),cwd:Some(access.cwd),label:access.label };
        let result = store.project_mutate(&request.command, &actor).map_err(fail)?;
        drop(store);
        self.answered_goal(&request.command, &actor, &result);
        self.surface.board_changed();
        Ok(result)
    }

    pub fn pin_project_record(&self, project_id: &str, record_id: &str, request_id: &str) -> Result<BoardSnapshot, SpellcastError> {
        let (record, project) = {
            let store = self.project_store()?;
            (store.project_record(project_id,record_id).map_err(fail)?, store.project_get(project_id).map_err(fail)?)
        };
        spellcast_core::reply::validate_id(request_id)?;
        let id = format!("work-{project_id}-{record_id}");
        let snapshot = self.update(|state| {
            let canvas = &state.session.board.canvas;
            if canvas.object(&id).is_some_and(|object| object.content != (CanvasContent::WorkRecord { project_id:project_id.into(),record_id:record_id.into() })) {
                return Err(fail("引用卡片 ID 已被其他内容使用；没有覆盖它。"));
            }
            // The canonical reference is stable; re-pinning preserves the user's geometry.
            let operations = if let Some(item) = canvas.items.iter().find(|item| item.item_id == id) {
                vec![CanvasOperation::Place { id:id.clone(), expected_revision:item.revision,
                    fields: CanvasPlacementFields { removed:Some(false), ..Default::default() } }]
            } else {
                let x = canvas.items.iter().filter(|i| !i.removed).map(|i| i.x+i.width).fold(0.0_f64,f64::max) + 48.0;
                vec![CanvasOperation::Create { id:id.clone(),content:CanvasContent::WorkRecord {project_id:project_id.into(),record_id:record.id.clone()},
                    origin:project.aliases.first().map(|cwd|spellcast_core::CanvasOrigin {cwd:cwd.clone(),thread_id:None,source_id:None,label:project.name.clone()}),
                    placement:CanvasPlacementFields {x:Some(x),y:Some(80.0),width:Some(480.0),height:Some(300.0),..Default::default()},bindings:vec![] }]
            };
            // Replays use the saved exact request; repeated explicit pin is a presentation operation.
            let request = if let Some(proposal) = state.session.board.canvas.proposal(request_id) {
                if proposal.request.operations.iter().any(|op|match op { CanvasOperation::Create{id:old,..}|CanvasOperation::Place{id:old,..}=>old!=&id,_=>true }) {
                    return Err(fail("request_id 已用于另一项画布操作。"));
                }
                proposal.request.clone()
            } else { CanvasBatchRequest {request_id:request_id.into(),reads:vec![],operations,feedback_sequences:vec![]} };
            let result = state.session.apply_canvas_batch(request,None)?;
            if result.status != spellcast_core::CanvasBatchStatus::Applied { return Err(fail("引用卡片已变化，请刷新画布后重试。")); }
            Ok(state.session.snapshot())
        })?;
        self.surface.board_changed();
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Headless;
    use std::{path::PathBuf,sync::Arc};
    use axum::{body::Body,http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn fixture() -> (PathBuf,Bridge,String) {
        let path = std::env::temp_dir().join(format!("spellcast-project-{}.sqlite3",uuid::Uuid::new_v4()));
        let bridge = Bridge::open(Headless,0,&path).unwrap();
        let project = uuid::Uuid::new_v4().to_string();
        bridge.project_user_mutate(serde_json::from_value(json!({"request_id":"project-create","project_id":project,"op":"create_project","name":"Isolated fixture","aliases":[]})).unwrap()).unwrap();
        (path,bridge,project)
    }
    fn command(project:&str,id:&str,request:&str,revision:u64,title:&str)->RecordCommand {
        serde_json::from_value(json!({"project_id":project,"request_id":request,"op":"put_record","id":id,"expected_revision":revision,"fields":{"title":title,"status":"active","result":"source verified","boundaries":"player path unverified","next_step":"run a real journey"}})).unwrap()
    }
    fn grant(bridge:&Bridge,project:&str,source:&str)->(String,String) {
        // Fixture simulates ONLY the successful metadata-verification boundary; no host claim.
        let value=bridge.create_project_access(project,codex::CodexBinding{source_id:source.into(),thread_id:uuid::Uuid::new_v4().to_string(),cwd:"C:/fixture".into(),label:source.into(),executable:"fixture".into(),protocol_agent:"fixture".into(),bound_at_ms:now_ms()}).unwrap();
        (value["access"]["id"].as_str().unwrap().into(),value["access_token"].as_str().unwrap().into())
    }
    #[test]
    fn project_credentials_require_approval_reject_impersonation_and_persist_handoff() {
        let (path,bridge,p)=fixture(); let id=uuid::Uuid::new_v4().to_string();
        let (a,token_a)=grant(&bridge,&p,"task-a");
        assert!(bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_a.clone(),command:command(&p,&id,"first",0,"first")}).is_err());
        assert!(bridge.project_agent_mutate(ProjectAgentMutation{access_token:"task-a".into(),command:command(&p,&id,"forged",0,"forged")}).is_err());
        bridge.project_decide_access(&p,&a,1,"approved").unwrap();
        let first=bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_a.clone(),command:command(&p,&id,"first",0,"first")}).unwrap();
        assert_eq!(serde_json::to_value(first).unwrap()["record"]["updated_by"]["source_id"],"task-a");
        let replay=bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_a.clone(),command:command(&p,&id,"first",0,"first")}).unwrap();
        assert!(replay.replayed);
        let (b,token_b)=grant(&bridge,&p,"task-b");
        bridge.project_decide_access(&p,&b,1,"approved").unwrap();
        assert!(bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_b.clone(),command:command(&p,&id,"stale",0,"stale")}).is_err());
        bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_b.clone(),command:command(&p,&id,"handoff",1,"continued")}).unwrap();
        let history=bridge.project_query(ProjectQuery{view:"history".into(),project_id:p.clone(),id:id.clone(),kind:"record".into(),..Default::default()}).unwrap();
        assert_eq!(history.as_array().unwrap().len(),2);
        let dump=bridge.project_query(ProjectQuery{view:"export".into(),project_id:p.clone(),..Default::default()}).unwrap().to_string();
        assert!(!dump.contains(&token_a)&&!dump.contains(&token_b)&&!dump.contains("token_hash"));
        bridge.project_decide_access(&p,&b,2,"revoked").unwrap();
        assert!(bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_b.clone(),command:command(&p,&id,"revoked",2,"bad")}).is_err());
        drop(bridge);
        let bridge=Bridge::open(Headless,0,&path).unwrap();
        assert_eq!(bridge.project_query(ProjectQuery{view:"record".into(),project_id:p.clone(),id:id.clone(),..Default::default()}).unwrap()["title"],"continued");
        assert!(bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_b,command:command(&p,&id,"revoked",2,"bad")}).is_err());
        bridge.project_agent_mutate(ProjectAgentMutation{access_token:token_a,command:command(&p,&id,"after-restart",2,"retained")}).unwrap();
        drop(bridge);let _=std::fs::remove_file(path);
    }

    #[test]
    fn project_canvas_references_remove_and_lock_without_record_loss() {
        let(path,bridge,p)=fixture();let id=uuid::Uuid::new_v4().to_string();
        bridge.project_user_mutate(command(&p,&id,"record",0,"canonical")).unwrap();
        let pinned=bridge.pin_project_record(&p,&id,"pin").unwrap();let object=pinned.canvas.objects[0].id.clone();
        assert_eq!(bridge.pin_project_record(&p,&id,"pin").unwrap().canvas.objects.len(),1);
        let current=|b:&Bridge|spellcast_core::CanvasRead{kind:spellcast_core::CanvasTargetKind::Presentation,id:object.clone(),revision:b.board().canvas.placement(&object).unwrap().revision};
        bridge.set_canvas_delete_lock(vec![current(&bridge)],true).unwrap();
        assert!(bridge.remove_canvas_item(&object,current(&bridge).revision).is_err());
        bridge.set_canvas_delete_lock(vec![current(&bridge)],false).unwrap();
        bridge.remove_canvas_item(&object,current(&bridge).revision).unwrap();
        assert_eq!(bridge.project_query(ProjectQuery{view:"record".into(),project_id:p.clone(),id:id.clone(),..Default::default()}).unwrap()["title"],"canonical");
        bridge.pin_project_record(&p,&id,"repin").unwrap();
        assert!(!bridge.board().canvas.placement(&object).unwrap().removed);
        bridge.delete_canvas_content(&object,1,vec![]).unwrap();
        assert_eq!(bridge.project_query(ProjectQuery{view:"history".into(),project_id:p,id,kind:"record".into(),..Default::default()}).unwrap().as_array().unwrap().len(),1);
        drop(bridge);let _=std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn project_access_requires_valid_host_metadata() {
        let(path,bridge,p)=fixture();
        assert!(bridge.project_request_access(ProjectAccessRequest{project_id:p.clone(),source_id:"not-a-real-thread".into(),thread_id:"not-a-real-thread".into(),cwd:"C:/fixture".into()}).await.is_err());
        assert!(bridge.project_request_access(ProjectAccessRequest{project_id:p.clone(),source_id:"old-task".into(),thread_id:uuid::Uuid::new_v4().to_string(),cwd:"C:/fixture".into()}).await.is_err());
        assert!(bridge.project_access_list(&p).unwrap().is_empty());
        drop(bridge);let _=std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn local_management_requires_separate_key_and_real_task_identity() {
        let(path,bridge,p)=fixture();
        let key="ab".repeat(32);
        let bridge=bridge.with_project_local_key(key.clone()).unwrap();
        let request=|| ProjectLocalCommand{source_id:"not-a-task".into(),thread_id:"not-a-task".into(),cwd:"C:/fixture".into(),command:command(&p,"record","local-denied",0,"must not exist")};
        assert!(bridge.project_local_mutate(ProjectLocalMutation{local_token:bridge.project_window_key(),request:request()}).await.is_err());
        assert!(bridge.project_local_mutate(ProjectLocalMutation{local_token:key.clone(),request:request()}).await.is_err());
        let(a,token)=grant(&bridge,&p,"other-agent");
        bridge.project_decide_access(&p,&a,1,"approved").unwrap();
        assert!(bridge.project_local_mutate(ProjectLocalMutation{local_token:token,request:request()}).await.is_err());
        let bridge=Arc::new(bridge);let app=crate::api::router(bridge.clone());
        let body=json!({"source_id":"not-a-task","thread_id":"not-a-task","cwd":"C:/fixture","command":command(&p,"record","http-local-denied",0,"must not exist")}).to_string();
        for provided in [String::new(),bridge.project_window_key()] {
            let response=app.clone().oneshot(Request::post("/api/projects/local/command").header("content-type","application/json").header("origin","http://tauri.localhost").header("x-spellcast-project-key",provided).body(Body::from(body.clone())).unwrap()).await.unwrap();
            assert_eq!(response.status(),axum::http::StatusCode::FORBIDDEN);
        }
        let response=app.clone().oneshot(Request::post("/api/projects/local/command").header("content-type","application/json").header("x-spellcast-project-key",key.clone()).body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(),axum::http::StatusCode::BAD_REQUEST);
        let export=bridge.project_query(ProjectQuery{view:"export".into(),project_id:p,..Default::default()}).unwrap();
        assert!(!export.to_string().contains(&key));
        assert!(export["records"].as_array().unwrap().is_empty());
        drop(app);drop(bridge);let _=std::fs::remove_file(path);
    }

    #[test]
    fn verified_local_project_creation_keeps_receipts_revisions_and_agent_provenance() {
        let(path,bridge,_)=fixture();
        let p=uuid::Uuid::new_v4().to_string();let record=uuid::Uuid::new_v4().to_string();
        let thread=uuid::Uuid::new_v4().to_string();
        // Only the host verification boundary is simulated in this unit test.
        let binding=|| codex::CodexBinding{source_id:thread.clone(),thread_id:thread.clone(),cwd:"C:/fixture".into(),label:"Local API fixture".into(),executable:"fixture".into(),protocol_agent:"fixture".into(),bound_at_ms:now_ms()};
        let create:RecordCommand=serde_json::from_value(json!({"request_id":"local-create","project_id":p,"op":"create_project","name":"Local API","aliases":["C:/fixture"]})).unwrap();
        bridge.project_local_mutate_verified(create.clone(),binding()).unwrap();
        assert!(bridge.project_local_mutate_verified(create,binding()).unwrap().replayed);
        let first=bridge.project_local_mutate_verified(command(&p,&record,"local-first",0,"First"),binding()).unwrap();
        let actor=&first.record.unwrap().updated_by;
        assert_eq!(actor.kind,"agent");assert_eq!(actor.thread_id.as_deref(),Some(thread.as_str()));
        assert!(bridge.project_local_mutate_verified(command(&p,&record,"local-stale",0,"Wrong"),binding()).is_err());
        assert!(bridge.project_local_mutate_verified(command(&p,&record,"local-first",0,"Changed retry"),binding()).is_err());
        let history=bridge.project_query(ProjectQuery{view:"history".into(),project_id:p,id:record,kind:"record".into(),..Default::default()}).unwrap();
        assert_eq!(history.as_array().unwrap().len(),1);
        drop(bridge);let _=std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn evidence_reads_are_routed_and_agents_cannot_write_candidates_trials_or_adoptions() {
        let(path,bridge,p)=fixture();
        let parameter=json!({"request_id":"param","project_id":p,"op":"put_object","id":"reward","expected_revision":0,"name":"Reward","kind":"parameter","archived":false,
            "planning":{"scopes":["R0"],"locked":true,"parameter":{"value":"3"}}});
        bridge.project_user_mutate(serde_json::from_value(parameter).unwrap()).unwrap();
        let candidate=|request:&str,id:&str|->RecordCommand{serde_json::from_value(json!({"request_id":request,"project_id":p,"op":"put_candidate","id":id,"expected_revision":0,
            "parameter_id":"reward","label":"Low","value":"1","base_revision":1})).unwrap()};
        bridge.project_user_mutate(candidate("candidate","low")).unwrap();
        let(a,token)=grant(&bridge,&p,"evidence-agent");bridge.project_decide_access(&p,&a,1,"approved").unwrap();
        let denied=bridge.project_agent_mutate(ProjectAgentMutation{access_token:token,command:candidate("agent-candidate","agent")}).unwrap_err();
        assert!(denied.to_string().contains("Agent 权限"),"{denied}");
        let bridge=Arc::new(bridge);let app=crate::api::router(bridge.clone());
        for (route,expected) in [("candidates",1),("trials",0),("trials?flow_id=none",0),("adoptions",0)] {
            let response=app.clone().oneshot(Request::get(format!("/api/projects/{p}/{route}")).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),axum::http::StatusCode::OK,"{route}");
            let body:Value=serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
            assert_eq!(body.as_array().unwrap().len(),expected,"{route}");
        }
        let missing=app.clone().oneshot(Request::get(format!("/api/projects/{p}/trials/absent")).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(missing.status(),axum::http::StatusCode::BAD_REQUEST);
        let read=rpc(&app,1,"tools/call",json!({"name":"spellcast_project_query","arguments":{"view":"candidates","project_id":p}})).await;
        assert_eq!(read["result"]["structuredContent"][0]["label"],"Low","{read}");
        let history=bridge.project_query(ProjectQuery{view:"history".into(),project_id:p.clone(),id:"low".into(),kind:"candidate".into(),..Default::default()}).unwrap();
        assert_eq!(history.as_array().unwrap().len(),1);
        drop(app);drop(bridge);let _=std::fs::remove_file(path);
    }

    async fn rpc(app:&axum::Router,id:u64,method:&str,params:Value)->Value {
        let response=app.clone().oneshot(Request::post("/mcp").header("host","127.0.0.1:47194").header("content-type","application/json").header("accept","application/json, text/event-stream")
            .body(Body::from(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(),axum::http::StatusCode::OK);
        let data=response.into_body().collect().await.unwrap().to_bytes();serde_json::from_slice(&data).unwrap()
    }
    #[tokio::test]
    async fn project_http_and_mcp_transport_respect_distinct_authority() {
        let(path,bridge,p)=fixture(); let bridge=Arc::new(bridge); let app=crate::api::router(bridge.clone());
        let id=uuid::Uuid::new_v4().to_string();
        let body=serde_json::to_string(&command(&p,&id,"http",0,"HTTP fixture")).unwrap();
        let denied=app.clone().oneshot(Request::post("/api/projects/command").header("content-type","application/json").body(Body::from(body.clone())).unwrap()).await.unwrap();
        assert_eq!(denied.status(),axum::http::StatusCode::FORBIDDEN);
        let forged_origin=app.clone().oneshot(Request::post("/api/projects/command").header("content-type","application/json").header("origin","http://tauri.localhost").body(Body::from(body.clone())).unwrap()).await.unwrap();
        assert_eq!(forged_origin.status(),axum::http::StatusCode::FORBIDDEN);
        let allowed=app.clone().oneshot(Request::post("/api/projects/command").header("content-type","application/json").header("origin","http://tauri.localhost").header("x-spellcast-window",bridge.project_window_key()).body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(allowed.status(),axum::http::StatusCode::OK);
        let listed=rpc(&app,1,"tools/list",json!({})).await;
        let names=listed["result"]["tools"].as_array().unwrap();
        for name in ["spellcast_project_query","spellcast_project_access","spellcast_project_update","spellcast_project_manage"]{assert!(names.iter().any(|t|t["name"]==name));}
        let read=rpc(&app,2,"tools/call",json!({"name":"spellcast_project_query","arguments":{"view":"record","project_id":p,"id":id}})).await;
        assert_eq!(read["result"]["structuredContent"]["title"],"HTTP fixture");
        let denied=rpc(&app,3,"tools/call",json!({"name":"spellcast_project_update","arguments":{"access_token":"forged","command":command(&p,&id,"mcp-forged",1,"overwrite")}})).await;
        assert!(denied["error"].is_object()||denied["result"]["isError"]==true);
        let(a,token)=grant(&bridge,&p,"mcp-fixture");bridge.project_decide_access(&p,&a,1,"approved").unwrap();
        let self_approval=app.clone().oneshot(Request::post(format!("/api/projects/{p}/access/{a}")).header("content-type","application/json").header("origin","http://tauri.localhost").header("x-spellcast-window",&token).body(Body::from(json!({"expected_revision":2,"decision":"revoked"}).to_string())).unwrap()).await.unwrap();
        assert_eq!(self_approval.status(),axum::http::StatusCode::FORBIDDEN);
        let written=rpc(&app,4,"tools/call",json!({"name":"spellcast_project_update","arguments":{"access_token":token,"command":command(&p,&id,"mcp-authorized",1,"authorized")}})).await;
        assert_eq!(written["result"]["structuredContent"]["record"]["title"],"authorized","{written}");
        drop(app);drop(bridge);let _=std::fs::remove_file(path);
    }
}

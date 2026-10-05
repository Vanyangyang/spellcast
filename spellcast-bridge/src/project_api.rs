//! Application UI routes. Agent writes use the separate credential-gated MCP methods.
use std::sync::Arc;
use axum::{extract::{Path,Query,State},http::{HeaderMap,header,StatusCode},routing::{get,post},Json,Router};
use serde::Deserialize;
use serde_json::{json,Value};
use crate::{Bridge,project_records::RecordCommand,project_workspace::{ProjectQuery,ProjectLocalCommand,ProjectLocalMutation},TRUSTED_ORIGINS};
pub(crate) type Fail = (StatusCode,Json<Value>);
pub(crate) fn owner(headers:&HeaderMap,bridge:&Bridge)->Result<(),Fail>{
    if headers.get("x-spellcast-project-key").and_then(|v|v.to_str().ok()).is_some_and(|key|bridge.is_project_local_key(key)) {return Ok(());}
    application(headers,bridge)
}
fn bad(e:impl ToString)->Fail {(StatusCode::BAD_REQUEST,Json(json!({"error":e.to_string()})))}
pub(crate) fn application(headers:&HeaderMap,bridge:&Bridge)->Result<(),Fail>{
    if !headers.get("x-spellcast-window").and_then(|v|v.to_str().ok()).is_some_and(|v|bridge.is_project_window_key(v)) {
        return Err((StatusCode::FORBIDDEN,Json(json!({"error":"项目管理需要主窗口私有凭据；伪造 Origin 或来源 ID 不会获得授权。"}))));
    }
    if !headers.get(header::ORIGIN).and_then(|v|v.to_str().ok()).is_some_and(|v|TRUSTED_ORIGINS.contains(&v)) {
        return Err((StatusCode::FORBIDDEN,Json(json!({"error":"项目管理操作请在 Spellcast 窗口完成；Agent 写入需要项目授权凭据。"}))));
    }
    Ok(())
}
pub(crate) fn router()->Router<Arc<Bridge>> {
    Router::new().route("/api/projects",get(projects))
        .merge(crate::project_game::router())
        .merge(crate::project_goals::router())
        .route("/api/projects/:project/proposals",get(proposals))
        .route("/api/projects/:project/proposals/:id",get(proposal))
        .route("/api/projects/local/command",post(local_command).layer(axum::extract::DefaultBodyLimit::max(1024*1024)))
        .route("/api/projects/command",post(command).layer(axum::extract::DefaultBodyLimit::max(40*1024*1024)))
        .route("/api/projects/:project/objects",get(objects))
        .route("/api/projects/:project/candidates",get(candidates))
        .route("/api/projects/:project/trials",get(trials))
        .route("/api/projects/:project/trials/:id",get(trial))
        .route("/api/projects/:project/adoptions",get(adoptions))
        .route("/api/projects/:project/records",get(records))
        .route("/api/projects/:project/records/:id",get(record))
        .route("/api/projects/:project/history/:kind/:id",get(history))
        .route("/api/projects/:project/export",get(export))
        .route("/api/projects/:project/markdown",get(markdown))
        .route("/api/projects/:project/pin",post(pin))
        .route("/api/projects/:project/access",get(access))
        .route("/api/projects/:project/access/:id",post(decide))
}
async fn projects(State(b):State<Arc<Bridge>>)->Result<Json<Value>,Fail>{ b.project_query(ProjectQuery::default()).map(Json).map_err(bad) }
async fn command(State(b):State<Arc<Bridge>>,headers:HeaderMap,Json(req):Json<RecordCommand>)->Result<Json<Value>,Fail>{application(&headers,&b)?; b.project_user_mutate(req).and_then(|v|serde_json::to_value(v).map_err(|e|spellcast_core::SpellcastError::user(e.to_string()))).map(Json).map_err(bad)}
async fn local_command(State(b):State<Arc<Bridge>>,headers:HeaderMap,Json(request):Json<ProjectLocalCommand>)->Result<Json<Value>,Fail>{
    let key=headers.get("x-spellcast-project-key").and_then(|v|v.to_str().ok()).unwrap_or("");
    if !b.is_project_local_key(key) { return Err((StatusCode::FORBIDDEN,Json(json!({"error":"本机项目 API 凭据缺失或无效。"})))); }
    b.project_local_mutate(ProjectLocalMutation{local_token:key.into(),request}).await
        .and_then(|v|serde_json::to_value(v).map_err(|e|spellcast_core::SpellcastError::user(e.to_string()))).map(Json).map_err(bad)
}
async fn objects(State(b):State<Arc<Bridge>>,Path(project):Path<String>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"objects".into(),project_id:project,..Default::default()}).map(Json).map_err(bad)}
async fn candidates(State(b):State<Arc<Bridge>>,Path(project):Path<String>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"candidates".into(),project_id:project,..Default::default()}).map(Json).map_err(bad)}
#[derive(Deserialize,Default)] struct TrialQuery {#[serde(default)]flow_id:String}
async fn trials(State(b):State<Arc<Bridge>>,Path(project):Path<String>,Query(q):Query<TrialQuery>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"trials".into(),project_id:project,flow_id:q.flow_id,..Default::default()}).map(Json).map_err(bad)}
async fn trial(State(b):State<Arc<Bridge>>,Path((project,id)):Path<(String,String)>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"trial".into(),project_id:project,id,..Default::default()}).map(Json).map_err(bad)}
async fn proposals(State(b):State<Arc<Bridge>>,Path(project):Path<String>,Query(q):Query<ListQuery>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"proposals".into(),project_id:project,include_archived:q.archived,..Default::default()}).map(Json).map_err(bad)}
async fn proposal(State(b):State<Arc<Bridge>>,Path((project,id)):Path<(String,String)>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"proposal".into(),project_id:project,id,..Default::default()}).map(Json).map_err(bad)}
async fn adoptions(State(b):State<Arc<Bridge>>,Path(project):Path<String>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"adoptions".into(),project_id:project,..Default::default()}).map(Json).map_err(bad)}
#[derive(Deserialize,Default)] struct ListQuery {#[serde(default)]query:String,status:Option<String>,#[serde(default)]archived:bool}
async fn records(State(b):State<Arc<Bridge>>,Path(project):Path<String>,Query(q):Query<ListQuery>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"records".into(),project_id:project,query:q.query,status:q.status,include_archived:q.archived,..Default::default()}).map(Json).map_err(bad)}
async fn record(State(b):State<Arc<Bridge>>,Path((project,id)):Path<(String,String)>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"record".into(),project_id:project,id,..Default::default()}).map(Json).map_err(bad)}
async fn history(State(b):State<Arc<Bridge>>,Path((project,kind,id)):Path<(String,String,String)>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"history".into(),project_id:project,kind,id,..Default::default()}).map(Json).map_err(bad)}
async fn export(State(b):State<Arc<Bridge>>,Path(project):Path<String>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"export".into(),project_id:project,..Default::default()}).map(Json).map_err(bad)}
async fn markdown(State(b):State<Arc<Bridge>>,Path(project):Path<String>)->Result<Json<Value>,Fail>{b.project_query(ProjectQuery{view:"markdown".into(),project_id:project,..Default::default()}).map(Json).map_err(bad)}
#[derive(Deserialize)] struct PinRequest {record_id:String,request_id:String}
async fn pin(State(b):State<Arc<Bridge>>,Path(project):Path<String>,headers:HeaderMap,Json(req):Json<PinRequest>)->Result<Json<spellcast_core::BoardSnapshot>,Fail>{application(&headers,&b)?;b.pin_project_record(&project,&req.record_id,&req.request_id).map(Json).map_err(bad)}
async fn access(State(b):State<Arc<Bridge>>,Path(project):Path<String>)->Result<Json<Vec<crate::project_workspace::ProjectAccess>>,Fail>{b.project_access_list(&project).map(Json).map_err(bad)}
#[derive(Deserialize)] struct Decision {expected_revision:u64,decision:String}
async fn decide(State(b):State<Arc<Bridge>>,Path((project,id)):Path<(String,String)>,headers:HeaderMap,Json(req):Json<Decision>)->Result<Json<crate::project_workspace::ProjectAccess>,Fail>{application(&headers,&b)?;b.project_decide_access(&project,&id,req.expected_revision,&req.decision).map(Json).map_err(bad)}

//! Window routes for sigils. Writes need the main window's private credential and a trusted
//! origin; agents use the native MCP tools instead.
use std::sync::Arc;

use axum::{extract::{DefaultBodyLimit, Path, Query, State}, http::{HeaderMap, StatusCode}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{project_api::{application, Fail}, sigil_run::RunControl, sigil_workspace::SigilQuery, sigils::SigilPlan, Bridge};

const PLAN_BODY_LIMIT: usize = 8 * 1024 * 1024;

fn bad(error: impl ToString) -> Fail {
    (StatusCode::BAD_REQUEST, Json(json!({"error": error.to_string()})))
}

pub(crate) fn router() -> Router<Arc<Bridge>> {
    Router::new()
        .route("/api/sigils", get(list).post(create).layer(DefaultBodyLimit::max(PLAN_BODY_LIMIT)))
        .route("/api/sigils/:id", get(sigil))
        .route("/api/sigils/:id/diff", get(diff))
        .route("/api/sigils/:id/step", get(step))
        .route("/api/sigils/:id/checks/decide", post(decide))
        .route("/api/sigils/:id/checks/rerun", post(rerun))
        .route("/api/sigils/:id/commands/approve", post(approve))
        .route("/api/sigils/:id/amendments/revert", post(revert))
        .route("/api/sigils/:id/steps/reopen", post(reopen))
        .route("/api/sigils/:id/plan", post(put_plan).layer(DefaultBodyLimit::max(PLAN_BODY_LIMIT)))
        .route("/api/sigils/:id/freeze", post(freeze))
        .route("/api/sigils/:id/unfreeze", post(unfreeze))
        .route("/api/sigils/:id/delete", post(delete))
        .route("/api/sigils/:id/pin", post(pin))
        .route("/api/sigils/:id/start", post(start))
        .route("/api/sigils/:id/dispatch", post(dispatch))
        .route("/api/sigils/:id/pause", post(pause))
        .route("/api/sigils/:id/resume", post(resume))
        .route("/api/sigils/:id/abort", post(abort))
        .route("/api/sigils/:id/handover", post(handover))
        .route("/api/sigils/:id/revoke", post(revoke))
        .route("/api/sigils/:id/note", post(note))
}

#[derive(Deserialize)]
struct Request {
    request_id: String,
}

#[derive(Deserialize)]
struct Handover {
    request_id: String,
    source_id: String,
    approve: bool,
}

#[derive(Deserialize)]
struct Note {
    request_id: String,
    text: String,
}

async fn start(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Transition>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_start(&id, &req.request_id, req.expected_revision).await.map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct Dispatch {
    request_id: String,
    started_at_ms: u64,
    #[serde(default)]
    retry: bool,
}

async fn dispatch(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Dispatch>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_dispatch(&id, &req.request_id, req.started_at_ms, req.retry).await.map(Json).map_err(bad)
}

async fn control(b: &Bridge, headers: &HeaderMap, id: &str, request_id: &str, control: RunControl) -> Result<Json<Value>, Fail> {
    application(headers, b)?;
    b.sigil_control(id, request_id, control).map(Json).map_err(bad)
}

async fn pause(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Request>) -> Result<Json<Value>, Fail> {
    control(&b, &headers, &id, &req.request_id, RunControl::Pause).await
}

async fn resume(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Request>) -> Result<Json<Value>, Fail> {
    control(&b, &headers, &id, &req.request_id, RunControl::Resume).await
}

async fn abort(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Request>) -> Result<Json<Value>, Fail> {
    control(&b, &headers, &id, &req.request_id, RunControl::Abort).await
}

async fn handover(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Handover>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_handover(&id, &req.request_id, &req.source_id, req.approve).map(Json).map_err(bad)
}

async fn revoke(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Request>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_revoke(&id, &req.request_id).map(Json).map_err(bad)
}

async fn note(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Note>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_user_note(&id, &req.request_id, &req.text).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct Decide {
    request_id: String,
    step_id: String,
    index: usize,
    passed: bool,
    #[serde(default)]
    note: String,
}

async fn decide(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Decide>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_decide_check(&id, &req.request_id, &req.step_id, req.index, req.passed, &req.note).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct Rerun {
    request_id: String,
    step_id: String,
}

async fn rerun(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Rerun>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_rerun_checks(&id, &req.request_id, &req.step_id).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct Approve {
    request_id: String,
    step_id: String,
    index: usize,
}

async fn approve(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Approve>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_approve_command(&id, &req.request_id, &req.step_id, req.index).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct Revert {
    request_id: String,
    revision: u64,
}

async fn revert(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Revert>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_revert_amendment(&id, &req.request_id, req.revision).map(Json).map_err(bad)
}

async fn reopen(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Rerun>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_reopen_step(&id, &req.request_id, &req.step_id).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct Create {
    request_id: String,
    #[serde(default)]
    plan: SigilPlan,
}

#[derive(Deserialize)]
struct PutPlan {
    request_id: String,
    expected_revision: u64,
    plan: SigilPlan,
}

#[derive(Deserialize)]
struct Transition {
    request_id: String,
    expected_revision: u64,
}

#[derive(Deserialize)]
struct Pin {
    request_id: String,
}

async fn list(State(b): State<Arc<Bridge>>) -> Result<Json<Value>, Fail> {
    b.sigil_query(SigilQuery::default()).map(Json).map_err(bad)
}

async fn sigil(State(b): State<Arc<Bridge>>, Path(id): Path<String>) -> Result<Json<Value>, Fail> {
    b.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: id, ..Default::default() }).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct DiffQuery {
    #[serde(default)]
    step_id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    outside: Option<usize>,
}

#[derive(Deserialize)]
struct StepQuery {
    step_id: String,
}

/// One step with its check results and kept command output; read-only like the sigil.
async fn step(State(b): State<Arc<Bridge>>, Path(id): Path<String>, Query(query): Query<StepQuery>) -> Result<Json<Value>, Fail> {
    b.sigil_query(SigilQuery { view: "step".into(), sigil_id: id, step_id: query.step_id, ..Default::default() }).map(Json).map_err(bad)
}

/// Read-only, like the sigil itself: the local request guard already refuses other origins.
async fn diff(State(b): State<Arc<Bridge>>, Path(id): Path<String>, Query(query): Query<DiffQuery>) -> Result<Json<Value>, Fail> {
    b.sigil_diff(&id, &query.step_id, query.outside, &query.path).await.map(Json).map_err(bad)
}

async fn create(State(b): State<Arc<Bridge>>, headers: HeaderMap, Json(req): Json<Create>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_user_create(&req.request_id, req.plan).map(Json).map_err(bad)
}

async fn put_plan(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<PutPlan>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_user_put_plan(&id, &req.request_id, req.expected_revision, req.plan).map(Json).map_err(bad)
}

async fn freeze(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Transition>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_freeze(&id, &req.request_id, req.expected_revision).map(Json).map_err(bad)
}

async fn unfreeze(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Transition>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_unfreeze(&id, &req.request_id, req.expected_revision).map(Json).map_err(bad)
}

async fn delete(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Transition>) -> Result<Json<Value>, Fail> {
    application(&headers, &b)?;
    b.sigil_delete(&id, &req.request_id, req.expected_revision).map(Json).map_err(bad)
}

async fn pin(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(req): Json<Pin>) -> Result<Json<spellcast_core::BoardSnapshot>, Fail> {
    application(&headers, &b)?;
    b.pin_sigil(&id, &req.request_id).map(Json).map_err(bad)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Headless;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn rpc(app: &Router, id: u64, method: &str, params: Value) -> Value {
        let response = app.clone().oneshot(Request::post("/mcp").header("host", "127.0.0.1:47194").header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(Body::from(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    async fn post(app: &Router, path: &str, headers: &[(&str, &str)], body: Value) -> (StatusCode, Value) {
        let mut request = Request::post(path).header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = app.clone().oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = response.status();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }

    async fn get(app: &Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, Value) {
        let mut request = Request::get(path).header("host", "127.0.0.1:47194");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        (status, serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }

    /// Runs on its own runtime: the router's delivery worker and observation loop hold the bridge
    /// until the runtime shuts down, and only then can the fixture database be removed.
    #[test]
    fn agents_draft_over_mcp_while_freezing_needs_the_window_credential() {
        let root = std::env::temp_dir().join(format!("spellcast-sigil-http-{}", uuid::Uuid::new_v4().simple()));
        let (db, repo) = (root.join("state.sqlite3"), root.join("repo"));
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        runtime.block_on(transport_and_window_credential(&db, &repo));
        drop(runtime);
        let _ = std::fs::remove_dir_all(root);
    }

    async fn transport_and_window_credential(db: &std::path::Path, repo: &std::path::Path) {
        let (db, repo) = (db.to_path_buf(), repo.to_path_buf());
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join("README.md"), "fixture\n").unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["add", "-A"], &["commit", "-q", "-m", "init"]] {
            let output = std::process::Command::new("git").args(["-c", "user.name=Sigil Test", "-c", "user.email=sigil@test.invalid", "-c", "commit.gpgsign=false"])
                .args(args).current_dir(&repo).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
        let bridge = Arc::new(Bridge::open(Headless, 0, &db).unwrap());
        let app = crate::api::router(bridge.clone());

        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
        assert!(names.contains(&"spellcast_sigil_query") && names.contains(&"spellcast_sigil_update"));
        assert!(!names.iter().any(|name| name.contains("freeze")));

        let plan = json!({"title": "HTTP plan", "goal": "Check transport", "repository": repo.to_string_lossy(), "location": "in_place",
            "steps": [{"id": "only", "title": "One step", "scope": ["src/**"],
                "checks": [{"kind": "command", "label": "version", "argv": ["git", "--version"]}]}]});
        let created = rpc(&app, 2, "tools/call", json!({"name": "spellcast_sigil_update", "arguments": {"request_id": "mcp-create",
            "sigil_id": "transport", "source_id": "claude:transport", "label": "Claude", "op": "put_plan", "expected_revision": 0, "plan": plan}})).await;
        let content = &created["result"]["structuredContent"];
        assert_eq!(content["created"], true, "{created}");
        assert_eq!(content["sigil"]["steps"][0]["checks"][0]["timeout_s"], 600);
        assert_eq!(content["review"]["can_freeze"], true);
        let read = rpc(&app, 3, "tools/call", json!({"name": "spellcast_sigil_query", "arguments": {"view": "sigil", "sigil_id": "transport"}})).await;
        assert_eq!(read["result"]["structuredContent"]["sigil"]["state"], "draft");

        let body = json!({"request_id": "window-freeze", "expected_revision": 1});
        let key = bridge.project_window_key();
        assert_eq!(post(&app, "/api/sigils/transport/freeze", &[], body.clone()).await.0, StatusCode::FORBIDDEN);
        assert_eq!(post(&app, "/api/sigils/transport/freeze", &[("origin", "http://tauri.localhost")], body.clone()).await.0, StatusCode::FORBIDDEN);
        assert_eq!(post(&app, "/api/sigils/transport/freeze", &[("x-spellcast-window", key.as_str())], body.clone()).await.0, StatusCode::FORBIDDEN);
        let (status, frozen) = post(&app, "/api/sigils/transport/freeze", &[("origin", "http://tauri.localhost"), ("x-spellcast-window", key.as_str())], body).await;
        assert_eq!(status, StatusCode::OK, "{frozen}");
        assert_eq!(frozen["sigil"]["state"], "frozen");

        // Starting and steering the run are window actions; agents claim and report over MCP.
        let window = [("origin", "http://tauri.localhost"), ("x-spellcast-window", key.as_str())];
        let start = json!({"request_id": "window-start", "expected_revision": 2});
        assert_eq!(post(&app, "/api/sigils/transport/start", &[], start.clone()).await.0, StatusCode::FORBIDDEN);
        let (status, started) = post(&app, "/api/sigils/transport/start", &window, start).await;
        assert_eq!(status, StatusCode::OK, "{started}");
        assert_eq!(started["sigil"]["state"], "running");
        let call = |id: u64, arguments: Value| rpc(&app, id, "tools/call", json!({"name": "spellcast_sigil_update", "arguments": arguments}));
        let claimed = call(4, json!({"request_id": "mcp-claim", "sigil_id": "transport", "source_id": "claude:transport", "op": "claim"})).await;
        assert_eq!(claimed["result"]["structuredContent"]["status"], "accepted", "{claimed}");
        let begun = call(5, json!({"request_id": "mcp-start", "sigil_id": "transport", "source_id": "claude:transport", "op": "start_step", "step_id": "only"})).await;
        assert_eq!(begun["result"]["structuredContent"]["step"]["light"], "running", "{begun}");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/app.js"), "export const ready = true;
").unwrap();
        assert_eq!(post(&app, "/api/sigils/transport/pause", &[], json!({"request_id": "pause"})).await.0, StatusCode::FORBIDDEN);
        assert_eq!(post(&app, "/api/sigils/transport/note", &window, json!({"request_id": "note", "text": "Keep going"})).await.0, StatusCode::OK);
        let reported = call(6, json!({"request_id": "mcp-report", "sigil_id": "transport", "source_id": "claude:transport", "op": "report_step",
            "step_id": "only", "summary": "Built"})).await;
        let reported = &reported["result"]["structuredContent"];
        assert_eq!(reported["step"]["light"], "verifying");
        assert_eq!(reported["notices"][0]["kind"], "user_note");
        assert_eq!(reported["step"]["changed_files"], 1, "the report snapshot saw the new file");

        // Spellcast runs the reported step's command on its own; passing it completes the run.
        let mut done = Value::Null;
        for _ in 0..300 {
            let (_, view) = get(&app, "/api/sigils/transport", &[]).await;
            if view["sigil"]["state"] == "completed" {
                done = view;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(done["lights"]["only"], "passed", "{done}");
        let next = rpc(&app, 7, "tools/call", json!({"name": "spellcast_sigil_query", "arguments": {"view": "next", "sigil_id": "transport"}})).await;
        assert_eq!(next["result"]["structuredContent"]["remaining"], 0);
        let (status, step) = get(&app, "/api/sigils/transport/step?step_id=only", &[]).await;
        assert_eq!(status, StatusCode::OK, "{step}");
        let run = step["progress"]["checks"][0]["run"].as_u64().unwrap();
        assert!(step["outputs"][run.to_string()].as_str().unwrap().contains("git version"), "{step}");
        let rerun = json!({"request_id": "window-rerun", "step_id": "only"});
        assert_eq!(post(&app, "/api/sigils/transport/checks/rerun", &[], rerun.clone()).await.0, StatusCode::FORBIDDEN);
        assert_eq!(post(&app, "/api/sigils/transport/checks/rerun", &window, rerun).await.0, StatusCode::BAD_REQUEST, "the run has ended");
        let decide = json!({"request_id": "window-decide", "step_id": "only", "index": 0, "passed": true});
        assert_eq!(post(&app, "/api/sigils/transport/checks/decide", &[], decide).await.0, StatusCode::FORBIDDEN);
        for (route, body) in [("commands/approve", json!({"request_id": "a", "step_id": "only", "index": 0})),
            ("amendments/revert", json!({"request_id": "r", "revision": 3})), ("steps/reopen", json!({"request_id": "o", "step_id": "only"}))] {
            assert_eq!(post(&app, &format!("/api/sigils/transport/{route}"), &[], body.clone()).await.0, StatusCode::FORBIDDEN, "{route}");
            assert_eq!(post(&app, &format!("/api/sigils/transport/{route}"), &window, body).await.0, StatusCode::BAD_REQUEST, "{route} after the run ended");
        }

        // Observed changes are readable by the window and by agents, never by other origins.
        let (status, diff) = get(&app, "/api/sigils/transport/diff?step_id=only&path=src/app.js", &[]).await;
        assert_eq!(status, StatusCode::OK, "{diff}");
        assert!(diff["patch"].as_str().unwrap().contains("+export const ready = true;"), "{diff}");
        assert_eq!(get(&app, "/api/sigils/transport/diff?step_id=only", &[("origin", "https://example.com")]).await.0, StatusCode::FORBIDDEN);
        let step = rpc(&app, 8, "tools/call", json!({"name": "spellcast_sigil_query", "arguments": {"view": "step", "sigil_id": "transport", "step_id": "only"}})).await;
        assert_eq!(step["result"]["structuredContent"]["progress"]["changes"][0]["path"], "src/app.js", "{step}");
        let patch = rpc(&app, 9, "tools/call", json!({"name": "spellcast_sigil_query", "arguments": {"view": "diff", "sigil_id": "transport", "step_id": "only"}})).await;
        assert!(patch["result"]["structuredContent"]["patch"].as_str().unwrap().contains("src/app.js"), "{patch}");
    }
}

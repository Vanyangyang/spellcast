//! Local HTTP adapter used by the web preview and editor-side integrations.

use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use spellcast_core::types::{
    forms, BoardNode, BoardSnapshot, BubbleRequest, ImportRequest, NodeDraft, NodePatch,
    PresentPayload, SayRequest, SetFormRequest, SpellcastError, ThrownBubble,
};
use spellcast_core::{BoardReply, ReplyActionInput, ReplyPatchRequest};
use tower_http::cors::{Any, CorsLayer};

use crate::feedback::{BindCodexRequest, ReplySubmission};
use crate::{mcp, Bridge, TRUSTED_ORIGINS};

type Shared = Arc<Bridge>;
type Fail = (StatusCode, Json<Value>);

fn bad(err: SpellcastError) -> Fail {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": err.to_string() })),
    )
}

pub fn router(bridge: Shared) -> Router {
    bridge.start_delivery_worker();
    let allowed_origins = TRUSTED_ORIGINS.map(HeaderValue::from_static);
    let mcp_service = mcp::service(bridge.clone());
    Router::new()
        .route("/api/health", get(health))
        .route("/api/forms", get(list_forms))
        .route("/api/board", get(board).delete(reset))
        .route("/api/board/form", post(set_form))
        .route("/api/canvas", post(patch_canvas).delete(delete_canvas_item))
        .route("/api/canvas/restore", post(restore_canvas_item))
        .route("/api/canvas/content", axum::routing::delete(delete_canvas_content))
        // A fixed inline image can be up to 2 MB before base64 encoding and may
        // appear both as the source object and as its reference in one transaction.
        .route("/api/canvas/batch", post(canvas_batch).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/api/canvas/blocks/:id/action", post(canvas_block_action).layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024)))
        .route("/api/canvas/proposals/:id", post(canvas_proposal))
        .route("/api/nodes", post(create_node))
        .route(
            "/api/nodes/:id",
            axum::routing::patch(patch_node).delete(delete_node),
        )
        .route("/api/import", post(import))
        .route("/api/say", post(say).layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024)))
        .route("/api/poke", post(poke))
        .route("/api/dismiss", post(dismiss))
        .route("/api/keep", post(keep))
        .route("/api/unkeep", post(unkeep))
        .route("/api/expired", post(expired))
        .route("/api/surface", post(set_surface))
        .route("/api/paused", post(set_paused))
        .route("/api/observer/status", get(observer_status))
        .route("/api/observer/settings", post(set_observer_settings))
        .route("/api/focus", post(focus))
        .route("/api/events", get(events))
        .route("/api/present", post(present))
        .route("/api/bubble", post(bubble))
        .route("/api/listen", get(listen))
        .route("/api/replies", post(write_reply).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/api/replies/patch", post(patch_reply).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/api/replies/action", post(reply_action).layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024)))
        .route("/api/artifacts", post(publish_artifact))
        .route("/api/artifacts/state", post(artifact_state))
        .route(
            "/api/artifacts/edit",
            post(artifact_edit).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/api/artifacts/:id", get(artifact_manifest))
        .route("/api/artifacts/:id/history", get(artifact_history))
        .route("/api/artifacts/:id/file", get(artifact_raw_file))
        .route("/api/feedback", get(feedback))
        .route("/api/feedback/ack", post(ack_feedback))
        .route("/api/feedback/:sequence/retry", post(retry_feedback))
        .route("/api/bindings/codex", post(bind_codex))
        .route("/api/task-target", post(task_target))
        .route("/api/bindings/:source", axum::routing::delete(unbind_codex))
        .route("/api/memories", get(memories).post(remember))
        .route("/api/memories/:id", axum::routing::delete(forget))
        .nest_service("/mcp", mcp_service)
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(middleware::from_fn(local_request_guard))
        .merge(Router::new().route("/artifacts/:id/*name", get(artifact_resource)))
        .with_state(bridge)
}

async fn task_target(State(b): State<Shared>, Json(req): Json<crate::task_target::TaskTargetRequest>) -> Result<Json<crate::task_target::TaskTargetStatus>, Fail> {
    b.task_target_status(req).await.map(Json).map_err(bad)
}

async fn publish_artifact(
    State(b): State<Shared>,
    Json(req): Json<crate::artifacts::PublishArtifact>,
) -> Result<Json<BoardReply>, Fail> {
    // Directory reading and SQLite writes are blocking local I/O.
    tokio::task::spawn_blocking(move || b.publish_artifact(req))
        .await
        .map_err(|e| bad(SpellcastError::user(e.to_string())))?
        .map(Json)
        .map_err(bad)
}

async fn artifact_state(
    State(b): State<Shared>,
    Json(req): Json<spellcast_core::ArtifactStatePatch>,
) -> Result<Json<BoardReply>, Fail> {
    b.save_artifact_state(req).map(Json).map_err(bad)
}

async fn artifact_manifest(
    State(b): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<crate::artifacts::ArtifactBundle>, Fail> {
    b.artifact(&id).map(Json).map_err(bad)
}

async fn artifact_history(
    State(b): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<Vec<crate::artifacts::ArtifactBundle>>, Fail> {
    b.artifact_history(&id).map(Json).map_err(bad)
}

#[derive(Deserialize)]
struct ArtifactFileQuery {
    name: String,
}

async fn artifact_raw_file(
    State(b): State<Shared>,
    Path(id): Path<String>,
    Query(query): Query<ArtifactFileQuery>,
) -> Result<Response, Fail> {
    let (_, bytes) = b.artifact_file(&id, &query.name).map_err(bad)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_DISPOSITION, "attachment"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

async fn artifact_edit(
    State(b): State<Shared>,
    Json(req): Json<crate::artifacts::ArtifactEdit>,
) -> Result<Json<BoardReply>, Fail> {
    tokio::task::spawn_blocking(move || b.edit_artifact(req))
        .await
        .map_err(|e| bad(SpellcastError::user(e.to_string())))?
        .map(Json)
        .map_err(bad)
}

async fn artifact_resource(
    State(b): State<Shared>,
    Path((id, name)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> Response {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1");
    if !is_loopback_host(host) {
        return StatusCode::FORBIDDEN.into_response();
    }
    crate::artifacts::resource_response(
        &b,
        &id,
        &name,
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        host,
    )
}

async fn local_request_guard(request: Request, next: Next) -> Response {
    if let Some(value) = request.headers().get(header::HOST) {
        let Ok(host) = value.to_str() else {
            return StatusCode::FORBIDDEN.into_response();
        };
        if !is_loopback_host(host) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    if let Some(value) = request.headers().get(header::ORIGIN) {
        let Ok(origin) = value.to_str() else {
            return StatusCode::FORBIDDEN.into_response();
        };
        if !is_trusted_origin(origin) {
            return StatusCode::FORBIDDEN.into_response();
        }
    } else if request
        .headers()
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|site| site != "none" && site != "same-origin")
    {
        // Opaque frames can send no-CORS requests without Origin, including GETs.
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    ["localhost", "127.0.0.1", "[::1]"].iter().any(|base| {
        host == *base
            || host
                .strip_prefix(&format!("{base}:"))
                .is_some_and(|port| port.parse::<u16>().is_ok())
    })
}

fn is_trusted_origin(origin: &str) -> bool {
    TRUSTED_ORIGINS.contains(&origin)
}

async fn health(State(b): State<Shared>) -> Json<Value> {
    let st = b.status();
    let observer = b.observer_status();
    Json(json!({
        "ok": true,
        "name": "spellcast",
        "version": crate::VERSION,
        "port": st.port,
        "surface": st.surface,
        "board_focused": st.board_focused,
        "mcp": format!("http://127.0.0.1:{}/mcp", st.port),
        "client": st.client,
        "last_call_ms": st.last_call_ms,
        "calls": st.calls,
        "agents": st.agents,
        "sources": st.sources,
        "paused": st.paused,
        "observer_enabled": observer.enabled,
        "observer_policy_revision": observer.policy_revision,
        "observer_allowed": observer.allowed,
        "observer_reason": observer.reason,
    }))
}

fn observer_payload(b: &Bridge) -> Value {
    let observer = b.observer_status();
    json!({
        "enabled": observer.enabled,
        "paused": observer.paused,
        "allowed": observer.allowed,
        "reason": observer.reason,
        "policy_revision": observer.policy_revision,
    })
}

async fn list_forms() -> Json<Value> {
    Json(json!({ "forms": forms() }))
}

async fn board(State(b): State<Shared>) -> Json<BoardSnapshot> {
    Json(b.board())
}

async fn patch_canvas(
    State(b): State<Shared>,
    Json(patch): Json<spellcast_core::CanvasPatch>,
) -> Result<Json<spellcast_core::CanvasLayout>, Fail> {
    b.patch_canvas(patch).map(Json).map_err(bad)
}

#[derive(serde::Deserialize)]
struct CanvasDelete {
    item_id: String,
    expected_revision: u64,
    #[serde(default)]
    current: Vec<spellcast_core::CanvasRead>,
}

async fn delete_canvas_item(
    State(b): State<Shared>,
    Json(req): Json<CanvasDelete>,
) -> Result<Json<BoardSnapshot>, Fail> {
    b.remove_canvas_item(&req.item_id, req.expected_revision)
        .map(Json)
        .map_err(bad)
}

async fn restore_canvas_item(State(b): State<Shared>, Json(req): Json<CanvasDelete>) -> Result<Json<BoardSnapshot>, Fail> {
    b.restore_canvas_item(&req.item_id, req.expected_revision).map(Json).map_err(bad)
}

async fn delete_canvas_content(State(b): State<Shared>, Json(req): Json<CanvasDelete>) -> Result<Json<BoardSnapshot>, Fail> {
    b.delete_canvas_content(&req.item_id, req.expected_revision, req.current).map(Json).map_err(bad)
}

async fn canvas_batch(State(b): State<Shared>, Json(req): Json<spellcast_core::CanvasBatchRequest>) -> Result<Json<crate::canvas::CanvasOutcome>, Fail> {
    b.canvas_batch(req, None).map(Json).map_err(bad)
}

async fn canvas_block_action(State(b): State<Shared>, Path(id): Path<String>, Json(req): Json<crate::canvas_blocks::BlockActionRequest>) -> Result<Json<crate::canvas_blocks::BlockActionOutcome>, Fail> {
    b.canvas_block_action(&id, req).map(Json).map_err(bad)
}

async fn canvas_proposal(State(b): State<Shared>, Path(id): Path<String>, Json(req): Json<crate::canvas::CanvasProposalAction>) -> Result<Json<crate::canvas::CanvasOutcome>, Fail> {
    b.canvas_proposal(&id, req).map(Json).map_err(bad)
}

async fn reset(State(b): State<Shared>) -> Result<Json<BoardSnapshot>, Fail> {
    b.reset_by_user().map(Json).map_err(bad)
}

async fn set_form(
    State(b): State<Shared>,
    Json(req): Json<SetFormRequest>,
) -> Result<Json<BoardSnapshot>, Fail> {
    b.set_form(req).map(Json).map_err(bad)
}

async fn create_node(
    State(b): State<Shared>,
    Json(draft): Json<NodeDraft>,
) -> Result<Json<BoardNode>, Fail> {
    b.add_node(draft).map(Json).map_err(bad)
}

async fn patch_node(
    State(b): State<Shared>,
    Path(id): Path<String>,
    Json(patch): Json<NodePatch>,
) -> Result<Json<BoardNode>, Fail> {
    b.patch_node(&id, patch).map(Json).map_err(bad)
}

async fn delete_node(
    State(b): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<BoardSnapshot>, Fail> {
    b.remove_node(&id).map(Json).map_err(bad)
}

async fn import(
    State(b): State<Shared>,
    Json(req): Json<ImportRequest>,
) -> Result<Json<BoardSnapshot>, Fail> {
    b.import_transcript(req).map(Json).map_err(bad)
}

async fn say(State(b): State<Shared>, Json(req): Json<SayRequest>) -> Result<Json<Value>, Fail> {
    b.say(req)
        .map(|e| Json(serde_json::to_value(e).unwrap_or(Value::Null)))
        .map_err(bad)
}

async fn poke(
    State(b): State<Shared>,
    Json(bubble): Json<ThrownBubble>,
) -> Result<Json<Value>, Fail> {
    b.poke(&bubble)
        .map(|event| Json(serde_json::to_value(event).unwrap_or(Value::Null)))
        .map_err(bad)
}

async fn keep(
    State(b): State<Shared>,
    Json(bubble): Json<ThrownBubble>,
) -> Result<Json<Value>, Fail> {
    b.keep(&bubble)
        .map(|(node, event)| Json(json!({ "node": node, "event": event })))
        .map_err(bad)
}

async fn unkeep(
    State(b): State<Shared>,
    Json(bubble): Json<ThrownBubble>,
) -> Result<Json<Value>, Fail> {
    b.unkeep(&bubble)
        .map(|(removed, event)| {
            Json(json!({ "removed": removed, "node_id": event.node_id.clone(), "event": event }))
        })
        .map_err(bad)
}

#[derive(Deserialize)]
struct BubbleId {
    bubble_id: String,
}

async fn dismiss(State(b): State<Shared>, Json(req): Json<BubbleId>) -> Result<Json<Value>, Fail> {
    b.dismiss(&req.bubble_id)
        .map(|event| Json(serde_json::to_value(event).unwrap_or(Value::Null)))
        .map_err(bad)
}

async fn expired(State(b): State<Shared>, Json(req): Json<BubbleId>) -> Result<Json<Value>, Fail> {
    b.expired(&req.bubble_id)
        .map(|event| Json(serde_json::to_value(event).unwrap_or(Value::Null)))
        .map_err(bad)
}

#[derive(Deserialize)]
struct SurfaceReq {
    surface: String,
}

async fn set_surface(State(b): State<Shared>, Json(req): Json<SurfaceReq>) -> Json<Value> {
    Json(serde_json::to_value(b.set_surface(&req.surface)).unwrap_or(Value::Null))
}

#[derive(Deserialize)]
struct PauseRequest {
    paused: bool,
}

async fn set_paused(
    State(b): State<Shared>,
    Json(req): Json<PauseRequest>,
) -> Result<Json<Value>, Fail> {
    b.set_paused(req.paused)
        .map(|status| Json(json!(status)))
        .map_err(bad)
}

async fn observer_status(State(b): State<Shared>) -> Json<Value> {
    Json(observer_payload(&b))
}

#[derive(Deserialize)]
struct ObserverSettingsRequest {
    enabled: bool,
}

async fn set_observer_settings(
    State(b): State<Shared>,
    Json(req): Json<ObserverSettingsRequest>,
) -> Result<Json<Value>, Fail> {
    b.set_observer_enabled(req.enabled)
        .map(|status| Json(json!(status)))
        .map_err(bad)
}

async fn focus(State(b): State<Shared>) -> Json<Value> {
    b.focus();
    Json(json!({ "ok": true }))
}

#[derive(Deserialize, Default)]
struct Since {
    #[serde(default)]
    since: u64,
    #[serde(default)]
    wait: u32,
    #[serde(default)]
    source_id: Option<String>,
}

async fn events(State(b): State<Shared>, Query(q): Query<Since>) -> Json<Value> {
    let (events, last_seq) = b.events_since(q.since);
    Json(json!({ "events": events, "last_seq": last_seq }))
}

async fn listen(State(b): State<Shared>, Query(q): Query<Since>) -> Json<Value> {
    let (events, last_seq) = b
        .listen_scoped(q.since, q.wait, q.source_id.as_deref())
        .await;
    Json(json!({ "events": events, "last_seq": last_seq }))
}

async fn present(
    State(b): State<Shared>,
    Json(payload): Json<PresentPayload>,
) -> Result<Json<Value>, Fail> {
    b.present(payload)
        .map(|r| Json(serde_json::to_value(r).unwrap_or(Value::Null)))
        .map_err(bad)
}

async fn bubble(
    State(b): State<Shared>,
    Json(req): Json<BubbleRequest>,
) -> Result<Json<Value>, Fail> {
    b.bubble(req)
        .await
        .map(|r| Json(serde_json::to_value(r).unwrap_or(Value::Null)))
        .map_err(bad)
}

async fn write_reply(
    State(b): State<Shared>,
    Json(req): Json<ReplySubmission>,
) -> Result<Json<BoardReply>, Fail> {
    b.write_reply_for_feedback(req.reply, &req.feedback_sequences)
        .map(Json)
        .map_err(bad)
}

async fn patch_reply(
    State(b): State<Shared>,
    Json(req): Json<ReplyPatchRequest>,
) -> Result<Json<BoardReply>, Fail> {
    b.patch_reply(req).map(Json).map_err(bad)
}

async fn reply_action(
    State(b): State<Shared>,
    Json(req): Json<ReplyActionInput>,
) -> Result<Json<Value>, Fail> {
    b.reply_action(req)
        .map(|(reply, event)| Json(json!({ "reply": reply, "event": event })))
        .map_err(bad)
}

async fn feedback(State(b): State<Shared>, Query(q): Query<Since>) -> Json<Value> {
    Json(json!(b.feedback_state(q.source_id.as_deref())))
}

async fn bind_codex(
    State(b): State<Shared>,
    Json(req): Json<BindCodexRequest>,
) -> Result<Json<Value>, Fail> {
    b.bind_codex(req)
        .await
        .map(|binding| Json(json!(binding)))
        .map_err(bad)
}

async fn unbind_codex(
    State(b): State<Shared>,
    Path(source): Path<String>,
) -> Result<Json<Value>, Fail> {
    b.unbind_codex(&source)
        .map(|()| Json(json!({ "unbound": true })))
        .map_err(bad)
}

async fn retry_feedback(
    State(b): State<Shared>,
    Path(sequence): Path<u64>,
) -> Result<Json<Value>, Fail> {
    b.retry_feedback(sequence)
        .await
        .map(|receipt| Json(json!(receipt)))
        .map_err(bad)
}

#[derive(Deserialize)]
struct AckRequest {
    source_id: String,
    sequences: Vec<u64>,
}

async fn ack_feedback(
    State(b): State<Shared>,
    Json(req): Json<AckRequest>,
) -> Result<Json<Value>, Fail> {
    b.acknowledge_feedback(&req.source_id, &req.sequences)
        .map(|count| Json(json!({ "acknowledged": count })))
        .map_err(bad)
}

#[derive(Deserialize, Default)]
struct MemoryQuery {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct MemoryRequest {
    title: Option<String>,
    text: String,
}

async fn memories(
    State(b): State<Shared>,
    Query(q): Query<MemoryQuery>,
) -> Result<Json<Value>, Fail> {
    b.recall(&q.query, q.limit.unwrap_or(20))
        .map(|items| Json(json!({ "memories": items })))
        .map_err(bad)
}

async fn remember(
    State(b): State<Shared>,
    Json(req): Json<MemoryRequest>,
) -> Result<Json<Value>, Fail> {
    b.remember(req.title, req.text)
        .map(|item| Json(json!({ "memory": item })))
        .map_err(bad)
}

async fn forget(State(b): State<Shared>, Path(id): Path<String>) -> Result<Json<Value>, Fail> {
    b.forget(&id)
        .map(|item| Json(json!({ "forgotten": item })))
        .map_err(bad)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn tagged_op_names(schema: &Value) -> Vec<String> {
        let mut names = Vec::new();
        fn walk(value: &Value, names: &mut Vec<String>) {
            match value {
                Value::Object(map) => {
                    if let Some(op) = map.get("properties").and_then(|p| p.get("op")) {
                        if let Some(name) = op.get("const").and_then(Value::as_str) {
                            names.push(name.to_string());
                        }
                        if let Some(items) = op.get("enum").and_then(Value::as_array) {
                            for item in items {
                                if let Some(name) = item.as_str() {
                                    names.push(name.to_string());
                                }
                            }
                        }
                    }
                    for child in map.values() {
                        walk(child, names);
                    }
                }
                Value::Array(items) => {
                    for child in items {
                        walk(child, names);
                    }
                }
                _ => {}
            }
        }
        walk(schema, &mut names);
        names.sort();
        names.dedup();
        names
    }

    fn mcp_call_failed(reply: &Value) -> bool {
        reply["error"].is_object() || reply["result"]["isError"] == true
    }

    async fn rpc(app: &Router, id: u64, method: &str, params: Value) -> Value {
        let res = app
            .clone()
            .oneshot(
                Request::post("/mcp")
                    .header("host", "127.0.0.1:47194")
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "method": method,
                            "params": params
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn mcp_initialize_reports_the_server_and_client() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        let res = app
            .clone()
            .oneshot(
                Request::post("/mcp")
                    .header("host", "127.0.0.1:47194")
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": mcp::PROTOCOL_VERSION,
                                "clientInfo": { "name": "Cursor", "version": "1.0" },
                                "capabilities": {}
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply["result"]["serverInfo"]["name"], "spellcast");

        let health = app
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = health.into_body().collect().await.unwrap().to_bytes();
        let status: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status["client"], "Cursor 1.0");
        assert!(status["last_call_ms"].as_u64().unwrap() > 0);
        assert_eq!(status["calls"].as_u64().unwrap(), 0);
        assert_eq!(status["agents"][0]["client"], "Cursor 1.0");
        assert!(status["agents"][0]["last_call_ms"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn mcp_initialize_records_grok_cli_client_info() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        let res = app
            .clone()
            .oneshot(
                Request::post("/mcp")
                    .header("host", "127.0.0.1:47194")
                    .header("content-type", "application/json")
                    .header("accept", "application/json, text/event-stream")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": mcp::PROTOCOL_VERSION,
                                "clientInfo": { "name": "grok-cli", "version": "1.0" },
                                "capabilities": {}
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let health = app
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = health.into_body().collect().await.unwrap().to_bytes();
        let status: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status["client"], "grok-cli 1.0");
        assert_eq!(status["agents"][0]["client"], "grok-cli 1.0");
        assert!(status["agents"][0]["last_call_ms"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn mcp_initialize_keeps_recent_agents() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        let params = |name: &str, version: &str| {
            json!({
                "protocolVersion": mcp::PROTOCOL_VERSION,
                "clientInfo": { "name": name, "version": version },
                "capabilities": {}
            })
        };
        rpc(&app, 1, "initialize", params("Cursor", "1.0")).await;
        rpc(&app, 2, "initialize", params("Codex", "2.0")).await;

        let health = app
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = health.into_body().collect().await.unwrap().to_bytes();
        let status: Value = serde_json::from_slice(&bytes).unwrap();
        let agents = status["agents"].as_array().unwrap();
        let names: Vec<&str> = agents
            .iter()
            .filter_map(|agent| agent["client"].as_str())
            .collect();
        assert!(names.contains(&"Cursor 1.0"));
        assert!(names.contains(&"Codex 2.0"));
        assert!(agents
            .iter()
            .all(|agent| agent["last_call_ms"].as_u64().unwrap() > 0));
        assert_eq!(status["client"], "Codex 2.0");
        assert_eq!(status["calls"].as_u64().unwrap(), 0);
        assert_eq!(agents[0]["client"], "Codex 2.0");
    }

    #[tokio::test]
    async fn mcp_canvas_batch_has_flat_schema_and_keeps_proposals_atomic() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let tool = listed["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "spellcast_canvas_batch").unwrap();
        for name in ["source_id", "request_id", "reads", "operations", "feedback_sequences"] {
            assert!(tool["inputSchema"]["properties"][name].is_object(), "{tool}");
        }
        assert!(
            tool["description"]
                .as_str()
                .unwrap_or("")
                .contains("Spellcast window"),
            "{tool}"
        );
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(!names.contains(&"spellcast_present"), "{names:?}");
        let ops = tagged_op_names(&tool["inputSchema"]);
        for name in ["create", "patch_content", "compose"] {
            assert!(ops.iter().any(|op| op == name), "{ops:?}");
        }
        for name in ["place", "arrange", "annotate", "remove_annotation", "ungroup"] {
            assert!(!ops.iter().any(|op| op == name), "{ops:?}");
        }
        let arguments = json!({"source_id":"naming-task","request_id":"names","operations":[
            {"op":"create","id":"first-name","content":{"type":"text","title":"雾港档案","text":"从消失的地名追踪一座港口。"},"placement":{"x":10,"y":20}},
            {"op":"create","id":"second-name","content":{"type":"text","title":"灯塔失语","text":"最后一盏灯不再指向归航者。"},"placement":{"x":460,"y":20}},
            {"op":"compose","id":"directions","expected_revision":0,"title":"两个故事方向","members":["first-name","second-name"]}
        ]});
        let result = rpc(&app, 2, "tools/call", json!({"name":"spellcast_canvas_batch","arguments":arguments})).await;
        assert_eq!(result["result"]["structuredContent"]["result"]["status"], "applied", "{result}");
        let again = rpc(&app, 3, "tools/call", json!({"name":"spellcast_canvas_batch","arguments":arguments})).await;
        assert_eq!(again["result"]["structuredContent"]["result"]["status"], "applied", "{again}");
        assert_eq!(bridge.board().canvas.objects.len(), 2);
        let before = bridge.board().canvas.items;
        let stale = rpc(&app, 4, "tools/call", json!({"name":"spellcast_canvas_batch","arguments":{
            "source_id":"naming-task","request_id":"stale-title","operations":[
                {"op":"patch_content","id":"first-name","expected_revision":0,"fields":{"title":"错版"}}
            ]
        }})).await;
        assert_eq!(stale["result"]["structuredContent"]["result"]["status"], "proposed", "{stale}");
        assert_eq!(bridge.board().canvas.items, before);
    }

    #[tokio::test]
    async fn mcp_canvas_batch_rejects_window_operations() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        rpc(&app, 1, "initialize", json!({
            "protocolVersion": mcp::PROTOCOL_VERSION,
            "clientInfo": { "name": "Cursor", "version": "1.0" },
            "capabilities": {}
        })).await;
        rpc(&app, 2, "tools/call", json!({"name":"spellcast_canvas_batch","arguments":{
            "source_id":"naming-task","request_id":"seed","operations":[
                {"op":"create","id":"note","content":{"type":"text","title":"雾港","text":"原文"},"placement":{"x":10,"y":20}}
            ]
        }})).await;
        let placed = rpc(&app, 3, "tools/call", json!({"name":"spellcast_canvas_batch","arguments":{
            "source_id":"naming-task","request_id":"move","operations":[
                {"op":"place","id":"note","expected_revision":1,"fields":{"x":999}}
            ]
        }})).await;
        assert!(mcp_call_failed(&placed), "{placed}");
        assert_ne!(placed["result"]["structuredContent"]["result"]["status"], "applied");
        let annotated = rpc(&app, 4, "tools/call", json!({"name":"spellcast_canvas_batch","arguments":{
            "source_id":"naming-task","request_id":"mark","operations":[
                {"op":"annotate","id":"mark","expected_revision":0,"anchor":{"object_id":"note","content_revision":1},"text":"批注"}
            ]
        }})).await;
        assert!(mcp_call_failed(&annotated), "{annotated}");
        let presented = rpc(&app, 5, "tools/call", json!({"name":"spellcast_present","arguments":{
            "reply":"keep","nodes":[{"title":"碎片"}]
        }})).await;
        assert!(mcp_call_failed(&presented), "{presented}");
    }

    #[tokio::test]
    async fn mcp_structured_reply_and_local_feedback_round_trip() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        for name in [
            "spellcast_reply",
            "spellcast_update",
            "spellcast_canvas_batch",
            "spellcast_ack",
            "spellcast_artifact",
            "spellcast_artifact_read",
        ] {
            assert!(tools.iter().any(|t| t["name"] == name));
        }
        assert!(!tools.iter().any(|t| t["name"] == "spellcast_present"));
        let update_schema = tools
            .iter()
            .find(|t| t["name"] == "spellcast_update")
            .unwrap();
        assert!(update_schema["inputSchema"]["properties"]["source_id"].is_object());
        assert!(update_schema["inputSchema"]["properties"]["block"].is_object());

        let created = rpc(&app, 2, "tools/call", json!({
            "name":"spellcast_reply",
            "arguments": {
                "id":"story", "source_id":"codex:launch", "source_label":"Astra", "title":"雨声的三个方向",
                "blocks":[
                    {"id":"intro","type":"text","text":"让雨声成为一种可以探索的语言。"},
                    {"id":"choices","type":"comparison","criteria":["体验"],"options":[
                        {"id":"a","title":"循声","values":["探索"]},
                        {"id":"b","title":"节奏","values":["解码"]}
                    ]},
                    {"id":"graph","type":"graph","nodes":[{"id":"rain","title":"雨声"},{"id":"path","title":"路径"}],
                        "edges":[{"id":"leads","from":"rain","to":"path","label":"引导"}]},
                    {"id":"scenes","type":"sequence","steps":[{"id":"notice","title":"察觉","action":"走近檐下"}]}
                ]
            }
        })).await;
        assert_eq!(
            created["result"]["structuredContent"]["revision"], 1,
            "{created}"
        );
        assert_eq!(
            created["result"]["structuredContent"]["blocks"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        let res = app.clone().oneshot(
            Request::post("/api/replies/action").header("content-type","application/json")
                .body(Body::from(json!({"reply_id":"story","block_id":"choices","action":"select","option_id":"b"}).to_string())).unwrap()
        ).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let action: Value =
            serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(action["event"]["kind"], "canvas_state");
        let heard = rpc(
            &app,
            3,
            "tools/call",
            json!({
                "name":"spellcast_listen","arguments":{"source_id":"codex:launch","since":99999}
            }),
        )
        .await;
        assert_eq!(heard["result"]["structuredContent"]["events"], json!([]));
        let res = app.clone().oneshot(Request::post("/api/replies/action").header("content-type","application/json")
            .body(Body::from(json!({"reply_id":"story","block_id":"choices","action":"ask","text":"按最终选择继续。"}).to_string())).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let sent: Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
        let sequence = sent["event"]["seq"].as_u64().unwrap();
        let changed = rpc(
            &app,
            4,
            "tools/call",
            json!({
                "name":"spellcast_update","arguments":{
                    "source_id":"codex:launch","reply_id":"story","expected_revision":2,"feedback_sequences":[sequence],
                    "block":{"id":"intro","type":"text","text":"接着展开你选择的节奏方向。"}
                }
            }),
        )
        .await;
        assert_eq!(
            changed["result"]["structuredContent"]["revision"], 3,
            "{changed}"
        );
        assert_eq!(
            changed["result"]["structuredContent"]["blocks"][1]["selected_id"],
            "b"
        );
        let acknowledged = rpc(&app, 5, "tools/call", json!({
            "name":"spellcast_ack","arguments":{"source_id":"codex:launch","sequences":[sequence]}
        })).await;
        assert_eq!(
            acknowledged["result"]["structuredContent"]["acknowledged"],
            1
        );
        assert!(bridge.pending_feedback(None).is_empty());
    }

    #[tokio::test]
    async fn mcp_exact_feedback_requires_source_and_never_replays_acknowledged_history() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let first = bridge.say(SayRequest { text: "无关的早先请求".into(), source_id: Some("codex:a".into()), ..Default::default() }).unwrap();
        let target = bridge.say(SayRequest { text: "这只是测试".into(), source_id: Some("codex:a".into()), ..Default::default() }).unwrap();
        let other = bridge.say(SayRequest { text: "其他任务".into(), source_id: Some("codex:b".into()), ..Default::default() }).unwrap();
        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let listen = listed["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "spellcast_listen").unwrap();
        assert!(listen["inputSchema"]["properties"]["sequence"].is_object());
        let request = |source: &str, sequence: u64| json!({"name":"spellcast_listen","arguments":{"source_id":source,"sequence":sequence,"since":99999,"wait":120}});
        let heard = rpc(&app, 2, "tools/call", request("codex:a", target.seq)).await;
        let content = &heard["result"]["structuredContent"];
        assert_eq!(content["events"].as_array().unwrap().len(), 1);
        assert_eq!(content["events"][0]["text"], "这只是测试");
        assert_eq!(content["pending_sequences"], json!([target.seq]));
        assert_eq!(content["status"], "pending");
        assert!(content["handling"].as_array().unwrap().len() >= 2);
        let foreign = rpc(&app, 3, "tools/call", request("codex:a", other.seq)).await;
        assert_eq!(foreign["result"]["structuredContent"]["events"], json!([]));
        let missing_source = rpc(&app, 4, "tools/call", json!({"name":"spellcast_listen","arguments":{"sequence":target.seq}})).await;
        assert!(missing_source["error"].is_object() || missing_source["result"]["isError"] == true);
        bridge.acknowledge_feedback("codex:a", &[target.seq]).unwrap();
        let repeated = rpc(&app, 5, "tools/call", request("codex:a", target.seq)).await;
        assert_eq!(repeated["result"]["structuredContent"]["status"], "not_pending");
        assert_eq!(repeated["result"]["structuredContent"]["events"], json!([]));
        assert_eq!(repeated["result"]["structuredContent"]["pending_sequences"], json!([]));
        let general = rpc(&app, 6, "tools/call", json!({"name":"spellcast_listen","arguments":{"source_id":"codex:a","since":0}})).await;
        assert!(general["result"]["structuredContent"]["events"].as_array().unwrap().iter().any(|e| e["seq"] == target.seq));
        assert_eq!(general["result"]["structuredContent"]["pending_sequences"], json!([first.seq]));
    }

    #[tokio::test]
    async fn mcp_memory_tools_list_and_round_trip() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let names = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"spellcast_remember"));
        assert!(names.contains(&"spellcast_recall"));
        assert!(names.contains(&"spellcast_forget"));

        let remembered = rpc(
            &app,
            2,
            "tools/call",
            json!({
                "name": "spellcast_remember",
                "arguments": { "title": "语气", "text": "保留一点不合时宜的幽默" }
            }),
        )
        .await;
        let id = remembered["result"]["structuredContent"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let recalled = rpc(
            &app,
            3,
            "tools/call",
            json!({ "name": "spellcast_recall", "arguments": { "query": "不合时宜" } }),
        )
        .await;
        assert_eq!(
            recalled["result"]["structuredContent"]["memories"][0]["id"],
            id
        );

        rpc(
            &app,
            4,
            "tools/call",
            json!({ "name": "spellcast_forget", "arguments": { "id": id } }),
        )
        .await;
        let recalled = rpc(
            &app,
            5,
            "tools/call",
            json!({ "name": "spellcast_recall", "arguments": { "query": "不合时宜" } }),
        )
        .await;
        assert!(recalled["result"]["structuredContent"]["memories"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn rest_say_shows_up_in_listen() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/say")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "text": "别急着合" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = app
            .oneshot(
                Request::get("/api/events?since=0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let listened: Value = serde_json::from_slice(&bytes).unwrap();
        let events = listened["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["kind"], "say");
        assert_eq!(events[0]["text"], "别急着合");
    }

    #[tokio::test]
    async fn rejects_remote_origins_before_they_can_mutate_state() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let res = app
            .oneshot(
                Request::post("/api/say")
                    .header("host", "127.0.0.1:47194")
                    .header("origin", "https://attacker.example")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "text": "不该写入" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(bridge.events_since(0).0.is_empty());
    }

    #[tokio::test]
    async fn rejects_non_loopback_host_headers() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        let res = app
            .oneshot(
                Request::get("/api/health")
                    .header("host", "attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn accepts_the_desktop_and_local_preview_origins() {
        let app = router(Arc::new(Bridge::new(crate::Headless, 0)));
        for origin in ["http://tauri.localhost", "http://127.0.0.1:47193"] {
            let res = app
                .clone()
                .oneshot(
                    Request::post("/api/say")
                        .header("host", "127.0.0.1:47194")
                        .header("origin", origin)
                        .header("content-type", "application/json")
                        .body(Body::from(json!({ "text": origin }).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK, "origin {origin}");
        }
    }

    #[tokio::test]
    async fn observer_http_settings_and_readonly_mcp_status() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let status = app
            .clone()
            .oneshot(Request::get("/api/observer/status").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &status.into_body().collect().await.unwrap().to_bytes(),
        )
        .unwrap();
        assert_eq!(body["enabled"], false);
        assert_eq!(body["allowed"], false);
        assert_eq!(body["reason"], "disabled");
        assert_eq!(body["policy_revision"], 0);

        let health = app
            .clone()
            .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let health_body: Value = serde_json::from_slice(
            &health.into_body().collect().await.unwrap().to_bytes(),
        )
        .unwrap();
        assert_eq!(health_body["observer_enabled"], false);

        let bad = app
            .clone()
            .oneshot(
                Request::post("/api/observer/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "enabled": "yes" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            bad.status().is_client_error(),
            "invalid enabled should fail: {}",
            bad.status()
        );
        assert!(!bridge.observer_status().enabled);

        let on = app
            .clone()
            .oneshot(
                Request::post("/api/observer/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "enabled": true }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(on.status(), StatusCode::OK);
        let on_body: Value =
            serde_json::from_slice(&on.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(on_body["enabled"], true);
        assert!(on_body["policy_revision"].as_u64().unwrap() > 0);

        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "spellcast_observer_status"));
        assert!(!tools.iter().any(|t| t["name"]
            .as_str()
            .is_some_and(|name| name.contains("observer_set")
                || name.contains("observer_enable")
                || name == "spellcast_observer_settings")));
        let called = rpc(
            &app,
            2,
            "tools/call",
            json!({ "name": "spellcast_observer_status", "arguments": {} }),
        )
        .await;
        assert_eq!(
            called["result"]["structuredContent"]["enabled"],
            true,
            "{called}"
        );
    }
}

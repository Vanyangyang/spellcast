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
use spellcast_core::{BoardReply, ReplyActionInput, ReplyPatchRequest, ReplyRequest};
use tower_http::cors::{Any, CorsLayer};

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
    let allowed_origins = TRUSTED_ORIGINS.map(HeaderValue::from_static);
    let mcp_service = mcp::service(bridge.clone());
    Router::new()
        .route("/api/health", get(health))
        .route("/api/forms", get(list_forms))
        .route("/api/board", get(board).delete(reset))
        .route("/api/board/form", post(set_form))
        .route("/api/nodes", post(create_node))
        .route(
            "/api/nodes/:id",
            axum::routing::patch(patch_node).delete(delete_node),
        )
        .route("/api/import", post(import))
        .route("/api/say", post(say))
        .route("/api/poke", post(poke))
        .route("/api/dismiss", post(dismiss))
        .route("/api/keep", post(keep))
        .route("/api/unkeep", post(unkeep))
        .route("/api/expired", post(expired))
        .route("/api/surface", post(set_surface))
        .route("/api/paused", post(set_paused))
        .route("/api/focus", post(focus))
        .route("/api/events", get(events))
        .route("/api/present", post(present))
        .route("/api/bubble", post(bubble))
        .route("/api/listen", get(listen))
        .route("/api/replies", post(write_reply))
        .route("/api/replies/patch", post(patch_reply))
        .route("/api/replies/action", post(reply_action))
        .route("/api/feedback", get(feedback))
        .route("/api/feedback/ack", post(ack_feedback))
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
        .with_state(bridge)
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
    }
    next.run(request).await
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    host == "localhost"
        || host.starts_with("localhost:")
        || host == "127.0.0.1"
        || host.starts_with("127.0.0.1:")
        || host == "[::1]"
        || host.starts_with("[::1]:")
}

fn is_trusted_origin(origin: &str) -> bool {
    TRUSTED_ORIGINS.contains(&origin)
}

async fn health(State(b): State<Shared>) -> Json<Value> {
    let st = b.status();
    Json(json!({
        "ok": true,
        "name": "spellcast",
        "version": crate::VERSION,
        "port": st.port,
        "surface": st.surface,
        "mcp": format!("http://127.0.0.1:{}/mcp", st.port),
        "client": st.client,
        "last_call_ms": st.last_call_ms,
        "calls": st.calls,
        "agents": st.agents,
        "sources": st.sources,
        "paused": st.paused,
    }))
}

async fn list_forms() -> Json<Value> {
    Json(json!({ "forms": forms() }))
}

async fn board(State(b): State<Shared>) -> Json<BoardSnapshot> {
    Json(b.board())
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
    Json(req): Json<ReplyRequest>,
) -> Result<Json<BoardReply>, Fail> {
    b.write_reply(req).map(Json).map_err(bad)
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
    Json(json!({ "pending": b.pending_feedback(q.source_id.as_deref()) }))
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
    async fn mcp_structured_reply_and_local_feedback_round_trip() {
        let bridge = Arc::new(Bridge::new(crate::Headless, 0));
        let app = router(bridge.clone());
        let listed = rpc(&app, 1, "tools/list", json!({})).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        for name in ["spellcast_reply", "spellcast_update", "spellcast_ack"] {
            assert!(tools.iter().any(|t| t["name"] == name));
        }
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
        let sequence = action["event"]["seq"].as_u64().unwrap();
        let heard = rpc(
            &app,
            3,
            "tools/call",
            json!({
                "name":"spellcast_listen","arguments":{"source_id":"codex:launch","since":99999}
            }),
        )
        .await;
        assert_eq!(
            heard["result"]["structuredContent"]["events"][0]["option_id"],
            "b"
        );
        let changed = rpc(
            &app,
            4,
            "tools/call",
            json!({
                "name":"spellcast_update","arguments":{
                    "source_id":"codex:launch","reply_id":"story","expected_revision":2,
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
}

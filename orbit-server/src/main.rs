use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use orbit_core::types::{
    catalog, forms, BoardNode, BoardSnapshot, ChatRequest, ChatResponse, ImportRequest, NodeDraft,
    NodePatch, SetFormRequest, StageForm,
};
use orbit_core::Session;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

struct AppState {
    session: Mutex<Session>,
}

type Shared = Arc<AppState>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "orbit_server=info".into()),
        )
        .init();

    let state = Arc::new(AppState {
        session: Mutex::new(Session::default()),
    });

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/providers", get(providers))
        .route("/api/forms", get(list_forms))
        .route("/api/board", get(board).delete(reset))
        .route("/api/board/form", post(set_form))
        .route("/api/chat", post(chat))
        .route("/api/import", post(import))
        .route("/api/nodes", post(create_node))
        .route("/api/nodes/:id", axum::routing::patch(patch_node).delete(delete_node))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let port: u16 = std::env::var("ORBIT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(47194);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("Orbit API on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve");
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "name": "orbit" }))
}

async fn providers() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "providers": catalog() }))
}

async fn list_forms() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "forms": forms() }))
}

async fn board(State(state): State<Shared>) -> Json<BoardSnapshot> {
    Json(state.session.lock().await.snapshot())
}

async fn reset(State(state): State<Shared>) -> Json<BoardSnapshot> {
    let mut session = state.session.lock().await;
    session.reset();
    Json(session.snapshot())
}

async fn set_form(
    State(state): State<Shared>,
    Json(req): Json<SetFormRequest>,
) -> Json<BoardSnapshot> {
    let mut session = state.session.lock().await;
    session.set_form(StageForm::parse(&req.form));
    Json(session.snapshot())
}

async fn chat(
    State(state): State<Shared>,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, (StatusCode, Json<serde_json::Value>)> {
    let mut session = state.session.lock().await;
    match session.chat(req).await {
        Ok(res) => Ok(Json(res)),
        Err(err) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err.to_string() })),
        )),
    }
}

async fn create_node(State(state): State<Shared>, Json(draft): Json<NodeDraft>) -> Json<BoardNode> {
    Json(state.session.lock().await.add_node(draft))
}

async fn patch_node(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Json(patch): Json<NodePatch>,
) -> Result<Json<BoardNode>, (StatusCode, Json<serde_json::Value>)> {
    match state.session.lock().await.patch_node(&id, patch) {
        Ok(node) => Ok(Json(node)),
        Err(err) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err.to_string() })),
        )),
    }
}

async fn delete_node(
    State(state): State<Shared>,
    Path(id): Path<String>,
) -> Result<Json<BoardSnapshot>, (StatusCode, Json<serde_json::Value>)> {
    let mut session = state.session.lock().await;
    match session.remove_node(&id) {
        Ok(()) => Ok(Json(session.snapshot())),
        Err(err) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err.to_string() })),
        )),
    }
}

async fn import(
    State(state): State<Shared>,
    Json(req): Json<ImportRequest>,
) -> Result<Json<BoardSnapshot>, (StatusCode, Json<serde_json::Value>)> {
    let mut session = state.session.lock().await;
    match session.import_transcript(&req.transcript) {
        Ok(board) => Ok(Json(board)),
        Err(err) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err.to_string() })),
        )),
    }
}

//! Synthetic, in-process HTTP tests: no listener, host binding, or model runner.
use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use spellcast_core::{CanvasBatchRequest, CanvasBatchResult, CanvasBatchStatus};
use std::sync::Arc;
use tower::ServiceExt;

const RECEIPT: &str = "/api/canvas/batch?response=receipt";

fn create(request_id: &str, id: &str) -> Value {
    json!({"request_id": request_id, "operations": [
        {"op":"create", "id":id, "content":{"type":"text", "text":"synthetic content"}}
    ]})
}

fn batch(value: Value) -> CanvasBatchRequest {
    serde_json::from_value(value).unwrap()
}

async fn post(app: &Router, uri: &str, request: &Value) -> (StatusCode, Value, usize) {
    let response = app
        .clone()
        .oneshot(
            Request::post(uri)
                .header("content-type", "application/json")
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap(), bytes.len())
}

fn fixture() -> Arc<Bridge> {
    Arc::new(Bridge::new(Headless, 0))
}

#[tokio::test]
async fn large_board_receipt_is_small_and_legacy_replay_is_compatible() {
    let bridge = fixture();
    let operations: Vec<_> = (0..40)
        .map(|index| {
            json!({
                "op":"create", "id":format!("large-{index}"),
                "content":{"type":"text", "text":"x".repeat(60_000)}
            })
        })
        .collect();
    let seeded = bridge
        .canvas_batch_receipt(
            batch(json!({
                "request_id":"large-seed", "operations":operations
            })),
            None,
        )
        .unwrap();
    assert!(seeded.is_applied());
    let board_bytes = serde_json::to_vec(&bridge.board()).unwrap().len();
    assert!(board_bytes > 2 * 1024 * 1024);

    let app = api::router(bridge.clone());
    let request = create("small-write", "small-object");
    let (status, receipt, receipt_bytes) = post(&app, RECEIPT, &request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(receipt.as_object().unwrap().len(), 3);
    let result: CanvasBatchResult = serde_json::from_value(receipt.clone()).unwrap();
    assert_eq!(result.request_id, "small-write");
    assert!(result.is_applied());
    assert!(!result.targets.is_empty());
    assert!(receipt_bytes < 4096);
    assert!(bridge.board().canvas.object("small-object").is_some());

    // Deliberate replay only tests idempotency; it is not a recovery from an unknown receipt.
    let before_replay = serde_json::to_value(bridge.board()).unwrap();
    let (status, legacy, legacy_bytes) = post(&app, "/api/canvas/batch", &request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(legacy.as_object().unwrap().len(), 2);
    assert_eq!(legacy["result"], receipt);
    assert_eq!(legacy["board"], before_replay);
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before_replay);
    assert!(legacy_bytes > 2 * 1024 * 1024);
    println!("synthetic board={board_bytes} bytes, receipt={receipt_bytes} bytes, legacy={legacy_bytes} bytes");
}

#[tokio::test]
async fn legacy_default_and_unrecognized_response_keep_board() {
    let bridge = fixture();
    let app = api::router(bridge.clone());
    for (index, uri) in ["/api/canvas/batch", "/api/canvas/batch?response=other"]
        .iter()
        .enumerate()
    {
        let id = format!("legacy-{index}");
        let (status, body, _) = post(&app, uri, &create(&id, &id)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"]["status"], "applied");
        assert_eq!(body["board"], serde_json::to_value(bridge.board()).unwrap());
    }
}

#[test]
fn receipt_replay_preserves_source_fingerprint_and_does_not_repeat_mutation() {
    let bridge = Bridge::new(Headless, 0);
    let request = batch(create("same-request", "owned-object"));
    let first = bridge
        .canvas_batch_receipt(request.clone(), Some("synthetic-source"))
        .unwrap();
    assert!(first.is_applied());
    let before = serde_json::to_value(bridge.board()).unwrap();
    assert_eq!(
        bridge
            .canvas_batch_receipt(request.clone(), Some("synthetic-source"))
            .unwrap(),
        first
    );
    assert_eq!(
        bridge
            .canvas_batch(request.clone(), Some("synthetic-source"))
            .unwrap()
            .result,
        first
    );
    for source in [None, Some("different-source")] {
        assert!(bridge
            .canvas_batch_receipt(request.clone(), source)
            .is_err());
    }
    let mut changed = create("same-request", "owned-object");
    changed["operations"][0]["content"]["text"] = json!("different payload");
    assert!(bridge
        .canvas_batch_receipt(batch(changed), Some("synthetic-source"))
        .is_err());
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);
}

#[tokio::test]
async fn receipt_http_rejects_reused_id_with_different_payload() {
    let bridge = fixture();
    let app = api::router(bridge.clone());
    let request = create("reused", "original");
    let (status, first, _) = post(&app, RECEIPT, &request).await;
    assert_eq!(status, StatusCode::OK);
    let before = serde_json::to_value(bridge.board()).unwrap();
    let (status, repeated, _) = post(&app, RECEIPT, &request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, repeated);
    let (status, error, _) = post(&app, RECEIPT, &create("reused", "different")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["error"].is_string());
    assert!(error.get("status").is_none());
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);
}

#[tokio::test]
async fn different_request_with_stale_revision_returns_proposed_receipt() {
    let bridge = fixture();
    let app = api::router(bridge.clone());
    assert_eq!(
        post(&app, RECEIPT, &create("seed", "target")).await.1["status"],
        "applied"
    );
    let patch = |id: &str| {
        json!({"request_id":id, "operations":[
            {"op":"patch_content", "id":"target", "expected_revision":1, "fields":{"text":"updated"}}
        ]})
    };
    assert_eq!(
        post(&app, RECEIPT, &patch("first-edit")).await.1["status"],
        "applied"
    );
    let object = bridge.board().canvas.object("target").unwrap().clone();
    let revision = bridge.board().canvas.revision;
    let (status, receipt, _) = post(&app, RECEIPT, &patch("stale-edit")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(receipt["status"], "proposed");
    assert!(receipt["targets"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["status"] == "conflict"));
    assert!(receipt.get("board").is_none());
    assert_eq!(bridge.board().canvas.object("target"), Some(&object));
    assert_eq!(bridge.board().canvas.revision, revision);
}

// Each persistence test owns a newly created SQLite file. No real state store is opened.
fn persistent_fixture() -> (Arc<Bridge>, std::path::PathBuf) {
    let directory =
        std::env::temp_dir().join(format!("spellcast-receipt-{}", uuid::Uuid::new_v4()));
    assert!(!directory.exists());
    let path = directory.join("state.sqlite3");
    let mut bridge = Bridge::new(Headless, 0);
    bridge.store = Some(Mutex::new(store::Store::open(&path).unwrap()));
    (Arc::new(bridge), path)
}

#[tokio::test]
async fn receipt_is_durable_before_http_success() {
    let (bridge, path) = persistent_fixture();
    let app = api::router(bridge.clone());
    let (status, receipt, _) = post(&app, RECEIPT, &create("durable", "saved")).await;
    assert_eq!(status, StatusCode::OK);
    let result: CanvasBatchResult = serde_json::from_value(receipt).unwrap();
    assert_eq!(result.status, CanvasBatchStatus::Applied);
    let persisted: PersistedState = bridge
        .store
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .load()
        .unwrap()
        .unwrap();
    assert!(persisted.session.board.canvas.object("saved").is_some());
    assert_eq!(
        persisted
            .session
            .board
            .canvas
            .proposal("durable")
            .unwrap()
            .result,
        result
    );
    drop(app);
    drop(bridge);
    let reopened = store::Store::open(&path).unwrap();
    let restored: PersistedState = reopened.load().unwrap().unwrap();
    assert_eq!(
        restored
            .session
            .board
            .canvas
            .proposal("durable")
            .unwrap()
            .result,
        result
    );
    drop(reopened);
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(path.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn persistence_failure_returns_error_and_preserves_memory_and_disk() {
    let (bridge, path) = persistent_fixture();
    bridge
        .canvas_batch_receipt(batch(create("saved-before", "saved-before")), None)
        .unwrap();
    let before = serde_json::to_value(bridge.board()).unwrap();
    // Connection-local failure injection on this fresh test database, not filesystem permissions.
    bridge
        .store
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    let app = api::router(bridge.clone());
    for (index, uri) in [RECEIPT, "/api/canvas/batch"].iter().enumerate() {
        let id = format!("cannot-save-{index}");
        let (status, error, _) = post(&app, uri, &create(&id, &id)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"].is_string());
        assert!(error.get("status").is_none());
        assert!(error.get("result").is_none());
        assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);
        let persisted: PersistedState = bridge
            .store
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .load()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(persisted.session.snapshot()).unwrap(),
            before
        );
    }
    drop(app);
    drop(bridge);
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(path.parent().unwrap()).unwrap();
}

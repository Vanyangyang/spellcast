use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use spellcast_core::{AgentEvent, SayRequest};
use tower::ServiceExt;

use crate::feedback::DeliveryPhase;
use crate::host_sessions::{HostHeartbeat, HostReceipt, HostRegistration, RegisteredHost};
use crate::{Bridge, Headless};

const SECRET: &str = "isolated-test-bootstrap-credential-00000001";
const A: &str = "a1000000-0000-4000-8000-000000000001";
const B: &str = "b1000000-0000-4000-8000-000000000002";

fn bridge() -> Bridge {
    let bridge = Bridge::new(Headless, 0);
    bridge.configure_host_bootstrap_secret(SECRET).unwrap();
    bridge
}

fn descriptor(native: &str, instance: &str) -> HostRegistration {
    HostRegistration {
        source_id: format!("claude:{native}"),
        client: "ccgui".into(),
        engine: "claude".into(),
        native_session_id: native.into(),
        gui_session_id: native.into(),
        cwd: "G:/isolated-project".into(),
        client_instance_id: instance.into(),
        window_id: "window-1".into(),
        capabilities: vec!["canvas_requests".into(), "durable_receipts".into()],
        label: format!("Conversation {native}"),
        active: true,
    }
}

fn register(bridge: &Bridge, native: &str, instance: &str) -> RegisteredHost {
    bridge
        .register_host(SECRET, descriptor(native, instance))
        .unwrap()
}

fn say(bridge: &Bridge, host: &RegisteredHost, id: &str) -> AgentEvent {
    bridge
        .say(SayRequest {
            text: "Only explain this request".into(),
            source_id: Some(host.host_pin.source_id.clone()),
            host_pin: Some(host.host_pin.clone()),
            request_id: Some(id.into()),
            ..Default::default()
        })
        .unwrap()
}

fn receipt(host: &RegisteredHost, event: &AgentEvent, phase: DeliveryPhase) -> HostReceipt {
    HostReceipt {
        truncated: false,
        receipt_seq: match phase {
            DeliveryPhase::Queued => 1,
            DeliveryPhase::Received => 1,
            DeliveryPhase::Executing => 2,
            DeliveryPhase::AwaitingPermission => 3,
            _ => 4,
        },
        request_id: event.request_id.clone().unwrap(),
        event_seq: event.seq,
        host_pin: host.host_pin.clone(),
        phase,
        text: None,
    }
}

#[tokio::test]
async fn exact_sources_instances_and_immutable_queue_survive_active_switch() {
    let bridge = bridge();
    let first = register(&bridge, A, "instance-1");
    let same_source = register(&bridge, A, "instance-2");
    let other = register(&bridge, B, "instance-1");
    let event = say(&bridge, &first, "ask-first");
    say(&bridge, &same_source, "ask-second-instance");
    say(&bridge, &other, "ask-other");
    let polled = bridge
        .host_requests(&first.lease_token, &first.host_pin.lease_id, 0, 0)
        .await
        .unwrap();
    assert_eq!(polled.requests.len(), 1);
    assert_eq!(polled.requests[0].event.seq, event.seq);
    assert_eq!(
        polled.requests[0].event.host_pin,
        Some(first.host_pin.clone())
    );
    assert!(bridge
        .host_requests(&other.lease_token, &first.host_pin.lease_id, 0, 0)
        .await
        .is_err());
    let twice = bridge
        .host_requests(&first.lease_token, &first.host_pin.lease_id, 0, 0)
        .await
        .unwrap();
    assert_eq!(twice.requests[0].event.seq, event.seq);
    let state = bridge.feedback_state(Some(&first.host_pin.source_id));
    assert_eq!(state.deliveries.len(), 2);
    assert!(state
        .deliveries
        .iter()
        .all(|r| r.received_at_ms.is_none() && r.phase == DeliveryPhase::Queued));
    let status = bridge
        .task_target_status(crate::task_target::TaskTargetRequest {
            source_id: first.host_pin.source_id.clone(),
            thread_id: None,
            cwd: None,
            host_pin: None,
        })
        .await
        .unwrap();
    assert_eq!(status.status, "ambiguous");
    assert!(status.host_pin.is_none());
    let pinned = bridge
        .task_target_status(crate::task_target::TaskTargetRequest {
            source_id: first.host_pin.source_id.clone(),
            thread_id: None,
            cwd: None,
            host_pin: Some(first.host_pin.clone()),
        })
        .await
        .unwrap();
    assert_eq!(pinned.status, "available");
    assert!(
        !pinned
            .hosts
            .iter()
            .find(|s| s.host_pin == first.host_pin)
            .unwrap()
            .active
    );
    assert!(bridge
        .say(SayRequest {
            text: "No guessed route".into(),
            source_id: Some(first.host_pin.source_id.clone()),
            request_id: Some("ambiguous-send".into()),
            ..Default::default()
        })
        .is_err());
}

#[tokio::test]
async fn receipt_auth_phase_order_and_replay_are_distinct_from_poll_and_model_ack() {
    let bridge = bridge();
    let host = register(&bridge, A, "instance");
    let event = say(&bridge, &host, "ask-phase");
    bridge
        .listen_scoped(0, 0, Some(&host.host_pin.source_id))
        .await;
    bridge
        .read_feedback_request(&host.host_pin.source_id, event.seq)
        .unwrap();
    assert!(bridge.feedback_state(None).deliveries[0]
        .received_at_ms
        .is_none());
    assert!(bridge
        .host_receipt("wrong", receipt(&host, &event, DeliveryPhase::Received))
        .is_err());
    assert!(bridge
        .host_receipt(
            &host.lease_token,
            receipt(&host, &event, DeliveryPhase::Executing)
        )
        .is_err());
    let accepted = receipt(&host, &event, DeliveryPhase::Received);
    let first = bridge
        .host_receipt(&host.lease_token, accepted.clone())
        .unwrap();
    let duplicate = bridge
        .host_receipt(&host.lease_token, accepted.clone())
        .unwrap();
    assert_eq!(duplicate.received_at_ms, first.received_at_ms);
    bridge
        .host_receipt(
            &host.lease_token,
            receipt(&host, &event, DeliveryPhase::Executing),
        )
        .unwrap();
    bridge
        .host_receipt(
            &host.lease_token,
            receipt(&host, &event, DeliveryPhase::AwaitingPermission),
        )
        .unwrap();
    assert!(bridge
        .host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .requests
        .is_empty());
    bridge
        .acknowledge_feedback(&host.host_pin.source_id, &[event.seq])
        .unwrap();
    let acked = bridge.feedback_state(None).deliveries[0].clone();
    assert_eq!(acked.phase, DeliveryPhase::AwaitingPermission);
    assert!(acked.handled_at_ms.is_some());
    assert!(acked.completed_at_ms.is_none());
    let mut completed = receipt(&host, &event, DeliveryPhase::Completed);
    completed.text = Some("A finite real answer".into());
    let done = bridge
        .host_receipt(&host.lease_token, completed.clone())
        .unwrap();
    assert_eq!(done.phase, DeliveryPhase::Completed);
    assert!(
        done.received_at_ms.is_some()
            && done.executing_at_ms.is_some()
            && done.awaiting_permission_at_ms.is_some()
            && done.completed_at_ms.is_some()
    );
    assert!(done.responded_at_ms.is_some());
    bridge
        .host_receipt(&host.lease_token, completed.clone())
        .unwrap();
    bridge.host_receipt(&host.lease_token, accepted).unwrap();
    assert_eq!(bridge.board().replies.len(), 1);
    assert_eq!(bridge.board().replies[0].source_id, host.host_pin.source_id);
    completed.text = Some("Changed duplicate must fail".into());
    assert!(bridge.host_receipt(&host.lease_token, completed).is_err());
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Completed
    );
}

#[tokio::test]
async fn expired_or_re_registered_leases_never_migrate_or_fall_back_to_codex() {
    let bridge = bridge();
    let old = register(&bridge, A, "instance");
    let event = say(&bridge, &old, "old-route");
    bridge.dispatch_feedback(event.seq, false).await.unwrap();
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Queued
    );
    assert!(bridge.feedback_state(None).deliveries[0].desktop.is_none());
    let mut forged = receipt(&old, &event, DeliveryPhase::Received);
    forged.host_pin.generation += 1;
    assert!(bridge.host_receipt(&old.lease_token, forged).is_err());
    let new = register(&bridge, A, "instance");
    assert!(new.host_pin.generation > old.host_pin.generation);
    assert_ne!(old.host_pin.lease_id, new.host_pin.lease_id);
    assert!(bridge
        .heartbeat_host(
            &old.lease_token,
            HostHeartbeat {
                host_pin: old.host_pin.clone(),
                active: true
            }
        )
        .is_err());
    assert!(bridge
        .host_requests(&old.lease_token, &old.host_pin.lease_id, 0, 0)
        .await
        .is_err());
    assert!(bridge
        .host_requests(&new.lease_token, &new.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .requests
        .is_empty());
    bridge.dispatch_feedback(event.seq, false).await.unwrap();
    let old_receipt = bridge.feedback_state(None).deliveries[0].clone();
    assert_eq!(old_receipt.phase, DeliveryPhase::Unknown);
    assert!(old_receipt.desktop.is_none() && old_receipt.attempted_at_ms.is_none());
    assert_eq!(old_receipt.event.host_pin, Some(old.host_pin.clone()));
    assert!(bridge.retry_feedback(event.seq).await.is_err());
    let next_event = say(&bridge, &new, "new-route");
    bridge.hosts.lock().unwrap().clock_offset = std::time::Duration::from_secs(31);
    let status = bridge.host_status(SECRET).unwrap();
    assert!(status.iter().all(|s| !s.reachable));
    assert!(bridge
        .host_receipt(
            &new.lease_token,
            receipt(&new, &next_event, DeliveryPhase::Received)
        )
        .is_err());
    assert_eq!(
        bridge.feedback_state(None).deliveries[1].phase,
        DeliveryPhase::Unknown
    );
}

#[test]
fn strict_native_identity_and_every_pin_field_are_checked_before_recording() {
    let bridge = bridge();
    for native in [
        "not-a-uuid",
        "A1000000-0000-4000-8000-000000000001",
        "a1000000000040008000000000000001",
        "00000000-0000-0000-0000-000000000000",
    ] {
        assert!(bridge
            .register_host(SECRET, descriptor(native, "instance"))
            .is_err());
    }
    let mut wrong_source = descriptor(A, "instance");
    wrong_source.source_id = format!("codex:{A}");
    assert!(bridge.register_host(SECRET, wrong_source).is_err());
    let mut wrong_capability = descriptor(A, "instance");
    wrong_capability.capabilities = vec!["unavailable".into()];
    assert!(bridge.register_host(SECRET, wrong_capability).is_err());
    let host = register(&bridge, A, "instance");
    for field in [
        "source_id",
        "client",
        "engine",
        "native_session_id",
        "gui_session_id",
        "cwd",
        "client_instance_id",
        "window_id",
        "lease_id",
    ] {
        let mut forged = serde_json::to_value(&host.host_pin).unwrap();
        forged[field] = json!("wrong");
        let pin = serde_json::from_value(forged).unwrap();
        assert!(
            bridge
                .say(SayRequest {
                    text: "No misroute".into(),
                    source_id: Some(host.host_pin.source_id.clone()),
                    host_pin: Some(pin),
                    request_id: Some(format!("bad-{field}")),
                    ..Default::default()
                })
                .is_err(),
            "{field}"
        );
    }
    assert!(bridge.pending_feedback(None).is_empty());
    assert!(bridge.feedback_state(None).deliveries.is_empty());
}

#[test]
fn request_id_and_receipt_sequence_must_match_exactly() {
    let bridge = bridge();
    let host = register(&bridge, A, "instance");
    let event = say(&bridge, &host, "idempotent-request");
    let same = say(&bridge, &host, "idempotent-request");
    assert_eq!(same.seq, event.seq);
    assert_eq!(bridge.pending_feedback(None).len(), 1);
    assert!(bridge
        .say(SayRequest {
            text: "Different content".into(),
            source_id: Some(host.host_pin.source_id.clone()),
            host_pin: Some(host.host_pin.clone()),
            request_id: Some("idempotent-request".into()),
            ..Default::default()
        })
        .is_err());
    let mut mismatch = receipt(&host, &event, DeliveryPhase::Received);
    mismatch.request_id = "other-request".into();
    assert!(bridge.host_receipt(&host.lease_token, mismatch).is_err());
    let mut mismatch = receipt(&host, &event, DeliveryPhase::Received);
    mismatch.event_seq += 1;
    assert!(bridge.host_receipt(&host.lease_token, mismatch).is_err());
    assert!(bridge.feedback_state(None).deliveries[0]
        .received_at_ms
        .is_none());
}

#[tokio::test]
async fn endpoints_require_bearer_loopback_and_redact_all_public_snapshots() {
    let bridge = Arc::new(bridge());
    let app = crate::api::router(bridge.clone());
    let payload = serde_json::to_value(descriptor(A, "instance")).unwrap();
    let register_request = |token: Option<&str>, host: &str| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/hosts/register")
            .header("host", host)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        request.body(Body::from(payload.to_string())).unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(register_request(None, "127.0.0.1:47194"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(register_request(Some("wrong"), "127.0.0.1:47194"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(register_request(Some(SECRET), "evil.example"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let result = app
        .clone()
        .oneshot(register_request(Some(SECRET), "127.0.0.1:47194"))
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&result.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let token = body["lease_token"].as_str().unwrap();
    let pin = serde_json::from_value(body["host_pin"].clone()).unwrap();
    bridge
        .say(SayRequest {
            text: "queue".into(),
            request_id: Some("api-request".into()),
            source_id: Some(format!("claude:{A}")),
            host_pin: Some(pin),
            ..Default::default()
        })
        .unwrap();
    let poll = Request::builder()
        .uri(format!(
            "/api/hosts/requests?lease_id={}&since=0&wait_ms=0",
            body["host_pin"]["lease_id"].as_str().unwrap()
        ))
        .header("host", "localhost")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let polled = app.clone().oneshot(poll).await.unwrap();
    assert_eq!(polled.status(), StatusCode::OK);
    let polled: Value =
        serde_json::from_slice(&polled.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(polled["requests"][0]["event"]["request_id"], "api-request");
    assert!(bridge.feedback_state(None).deliveries[0]
        .received_at_ms
        .is_none());
    let heartbeat = Request::builder()
        .method("POST")
        .uri("/api/hosts/heartbeat")
        .header("host", "localhost")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"host_pin":body["host_pin"],"active":false}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(heartbeat).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(bridge.feedback_state(None).deliveries.len(), 1);
    for phase in ["received", "executing", "completed", "completed"] {
        let receipt_seq = match phase {
            "received" => 1,
            "executing" => 2,
            _ => 3,
        };
        let mut payload = json!({"receipt_seq":receipt_seq,"host_pin":body["host_pin"],"request_id":"api-request","event_seq":polled["requests"][0]["event"]["seq"],"phase":phase});
        if phase == "completed" {
            payload["text"] = json!("Endpoint result");
        }
        let request = Request::builder()
            .method("POST")
            .uri("/api/hosts/receipt")
            .header("host", "localhost")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{phase}");
    }
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Completed
    );
    assert_eq!(bridge.board().replies.len(), 1);
    assert_eq!(bridge.board().replies[0].source_id, format!("claude:{A}"));
    for path in [
        "/api/health",
        "/api/board",
        "/api/feedback",
        "/api/hosts/status",
    ] {
        let request = Request::builder()
            .uri(path)
            .header("host", "localhost:47194")
            .header("authorization", format!("Bearer {SECRET}"))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(
            !text.contains(SECRET) && !text.contains(token) && !text.contains("lease_token"),
            "{path}"
        );
    }
    let denied = Request::builder()
        .uri("/api/hosts/status")
        .header("host", "localhost")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.oneshot(denied).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn storage_failure_cannot_acknowledge_acceptance_or_create_response() {
    let path = std::env::temp_dir().join(format!(
        "spellcast-host-fail-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bridge.configure_host_bootstrap_secret(SECRET).unwrap();
        let host = register(&bridge, A, "instance");
        let event = say(&bridge, &host, "durable-request");
        let schema = |sql: &str| {
            bridge
                .store
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .connection
                .execute_batch(sql)
                .unwrap()
        };
        schema("CREATE TRIGGER fail_save BEFORE UPDATE ON spellcast_state BEGIN SELECT RAISE(FAIL, 'isolated save failure'); END;");
        assert!(bridge
            .host_receipt(
                &host.lease_token,
                receipt(&host, &event, DeliveryPhase::Received)
            )
            .is_err());
        assert!(bridge.feedback_state(None).deliveries[0]
            .received_at_ms
            .is_none());
        assert_eq!(
            bridge.feedback_state(None).deliveries[0].phase,
            DeliveryPhase::Queued
        );
        assert!(bridge
            .register_host(SECRET, descriptor(A, "instance"))
            .is_err());
        let statuses = bridge.host_status(SECRET).unwrap();
        assert_eq!(statuses.len(), 1);
        assert!(statuses[0].reachable);
        assert_eq!(statuses[0].host_pin, host.host_pin);
        let still_usable = bridge
            .heartbeat_host(
                &host.lease_token,
                HostHeartbeat {
                    host_pin: host.host_pin.clone(),
                    active: false,
                },
            )
            .unwrap();
        assert_eq!(still_usable.host_pin, host.host_pin);
        assert!(still_usable.reachable);
        schema("DROP TRIGGER fail_save;");
        bridge
            .host_receipt(
                &host.lease_token,
                receipt(&host, &event, DeliveryPhase::Received),
            )
            .unwrap();
        schema("CREATE TRIGGER fail_save BEFORE UPDATE ON spellcast_state BEGIN SELECT RAISE(FAIL, 'isolated save failure'); END;");
        let mut done = receipt(&host, &event, DeliveryPhase::Completed);
        done.text = Some("Real result".into());
        done.truncated = true;
        assert!(bridge.host_receipt(&host.lease_token, done).is_err());
        assert!(bridge.board().replies.is_empty());
        assert_eq!(
            bridge.feedback_state(None).deliveries[0].phase,
            DeliveryPhase::Received
        );
        assert!(!bridge.feedback_state(None).deliveries[0].response_truncated);
        assert!(bridge.feedback_state(None).deliveries[0]
            .response_note
            .is_none());
        schema("DROP TRIGGER fail_save;");
        let replacement = register(&bridge, A, "instance");
        assert_eq!(
            replacement.host_pin.generation,
            host.host_pin.generation + 1,
            "Failed staged registration does not consume generation"
        );
    }
    {
        let restored = Bridge::open(Headless, 0, &path).unwrap();
        assert_eq!(
            restored.feedback_state(None).deliveries[0].phase,
            DeliveryPhase::Unknown
        );
        assert!(restored.feedback_state(None).deliveries[0]
            .received_at_ms
            .is_some());
        assert!(restored.feedback_state(None).deliveries[0]
            .completed_at_ms
            .is_none());
        assert!(restored.board().replies.is_empty());
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn bounded_poll_wakes_on_queue_and_paginates_without_skipping_queued_events() {
    let bridge = Arc::new(bridge());
    let host = register(&bridge, A, "instance");
    let started = std::time::Instant::now();
    let empty = bridge
        .host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 25)
        .await
        .unwrap();
    assert!(empty.requests.is_empty());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    let waiter = {
        let bridge = bridge.clone();
        let token = host.lease_token.clone();
        let lease = host.host_pin.lease_id.clone();
        tokio::spawn(async move { bridge.host_requests(&token, &lease, 0, 25_000).await })
    };
    tokio::task::yield_now().await;
    let event = say(&bridge, &host, "wake-request");
    let awakened = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(awakened.requests[0].event.seq, event.seq);
    for index in 1..70 {
        say(&bridge, &host, &format!("batch-{index}"));
    }
    let first = bridge
        .host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 0)
        .await
        .unwrap();
    assert_eq!(first.requests.len(), 64);
    let second = bridge
        .host_requests(
            &host.lease_token,
            &host.host_pin.lease_id,
            first.last_seq,
            0,
        )
        .await
        .unwrap();
    assert_eq!(second.requests.len(), 6);
    assert_eq!(first.requests.last().unwrap().event.seq, first.last_seq);
}

#[test]
fn captured_context_uses_only_unique_explicit_source_route() {
    let bridge = bridge();
    let host = register(&bridge, A, "first");
    let brief = crate::observer::ObserverBrief {
        observer_id: "isolated".into(),
        source_id: host.host_pin.source_id.clone(),
        provider: "claude".into(),
        locale: "en".into(),
        snapshot: serde_json::from_value(
            json!({"checkpoint_id":"isolated-checkpoint","project":"project","goal":"goal","change":"change","facts":[]}),
        )
        .unwrap(),
        expires_at_ms: 0,
    };
    let captured = bridge.capture_from_brief(&brief);
    assert_eq!(captured.host_pin, Some(host.host_pin.clone()));
    assert_eq!(captured.thread_id, Some(A.into()));
    assert_eq!(captured.cwd, Some(host.host_pin.cwd.clone()));
    register(&bridge, A, "second");
    let ambiguous = bridge.capture_from_brief(&brief);
    assert!(
        ambiguous.host_pin.is_none()
            && ambiguous.thread_id.as_deref() == Some(A)
            && ambiguous.cwd.is_none()
    );
    assert_eq!(ambiguous.source_id, host.host_pin.source_id);
}

#[tokio::test]
async fn durable_gui_queued_acceptance_stamps_receipt_without_claiming_model_execution() {
    let bridge = bridge();
    let host = register(&bridge, A, "busy-instance");
    let event = say(&bridge, &host, "busy-gui-acceptance");
    let polled = bridge
        .host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 0)
        .await
        .unwrap();
    assert_eq!(polled.requests[0].phase, DeliveryPhase::Queued);
    assert!(bridge.feedback_state(None).deliveries[0]
        .received_at_ms
        .is_none());

    let queued = receipt(&host, &event, DeliveryPhase::Queued);
    let accepted = bridge
        .host_receipt(&host.lease_token, queued.clone())
        .unwrap();
    assert_eq!(accepted.phase, DeliveryPhase::Queued);
    assert!(accepted.received_at_ms.is_some());
    assert!(accepted.executing_at_ms.is_none() && accepted.completed_at_ms.is_none());
    let duplicate = bridge
        .host_receipt(&host.lease_token, queued.clone())
        .unwrap();
    assert_eq!(duplicate.received_at_ms, accepted.received_at_ms);

    let mut premature_execution = receipt(&host, &event, DeliveryPhase::Executing);
    premature_execution.receipt_seq = 2;
    assert!(bridge
        .host_receipt(&host.lease_token, premature_execution)
        .is_err());
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Queued
    );
    let mut received = receipt(&host, &event, DeliveryPhase::Received);
    received.receipt_seq = 2;
    let received = bridge.host_receipt(&host.lease_token, received).unwrap();
    assert_eq!(received.received_at_ms, accepted.received_at_ms);
    let mut executing = receipt(&host, &event, DeliveryPhase::Executing);
    executing.receipt_seq = 3;
    bridge.host_receipt(&host.lease_token, executing).unwrap();
    let completed = receipt(&host, &event, DeliveryPhase::Completed);
    bridge.host_receipt(&host.lease_token, completed).unwrap();
    let mut late_queue = queued.clone();
    late_queue.receipt_seq = 5;
    assert!(bridge.host_receipt(&host.lease_token, late_queue).is_err());
    let stale = bridge.host_receipt(&host.lease_token, queued).unwrap();
    assert_eq!(stale.phase, DeliveryPhase::Completed);
    assert_eq!(stale.received_at_ms, accepted.received_at_ms);
    assert!(bridge
        .host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .requests
        .is_empty());
}

#[test]
fn receipt_sequence_rejects_conflicts_preserves_terminal_and_allows_permission_resume() {
    let bridge = bridge();
    let host = register(&bridge, A, "instance");
    let event = say(&bridge, &host, "sequenced-request");
    let accepted = receipt(&host, &event, DeliveryPhase::Received);
    bridge
        .host_receipt(&host.lease_token, accepted.clone())
        .unwrap();
    let mut conflict = accepted.clone();
    conflict.phase = DeliveryPhase::Executing;
    assert!(bridge.host_receipt(&host.lease_token, conflict).is_err());
    bridge
        .host_receipt(
            &host.lease_token,
            receipt(&host, &event, DeliveryPhase::Executing),
        )
        .unwrap();
    bridge
        .host_receipt(
            &host.lease_token,
            receipt(&host, &event, DeliveryPhase::AwaitingPermission),
        )
        .unwrap();
    let mut resumed = receipt(&host, &event, DeliveryPhase::Executing);
    resumed.receipt_seq = 4;
    assert_eq!(
        bridge
            .host_receipt(&host.lease_token, resumed.clone())
            .unwrap()
            .phase,
        DeliveryPhase::Executing
    );
    let mut stale = accepted;
    stale.phase = DeliveryPhase::Failed;
    let unchanged = bridge.host_receipt(&host.lease_token, stale).unwrap();
    assert_eq!(unchanged.host_receipt_seq, 4);
    assert_eq!(unchanged.phase, DeliveryPhase::Executing);
    assert_eq!(
        bridge
            .host_receipt(&host.lease_token, resumed)
            .unwrap()
            .host_receipt_seq,
        4
    );
    let mut done = receipt(&host, &event, DeliveryPhase::Completed);
    done.receipt_seq = 5;
    done.text = Some("Final result".into());
    let completed = bridge
        .host_receipt(&host.lease_token, done.clone())
        .unwrap();
    assert_eq!(completed.host_receipt_seq, 5);
    assert!(completed.host_receipt_hash.is_some());
    bridge
        .host_receipt(&host.lease_token, done.clone())
        .unwrap();
    done.text = Some("A conflicting final result".into());
    assert!(bridge.host_receipt(&host.lease_token, done).is_err());
    let mut late = receipt(&host, &event, DeliveryPhase::Executing);
    late.receipt_seq = 6;
    assert!(bridge.host_receipt(&host.lease_token, late).is_err());
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Completed
    );
    assert_eq!(bridge.board().replies.len(), 1);
    assert!(
        !bridge.pending_feedback(None).is_empty(),
        "Completion alone is not a model ack"
    );
}

#[test]
fn generation_persists_across_restart_without_persisting_credentials_or_live_leases() {
    let path = std::env::temp_dir().join(format!(
        "spellcast-host-generation-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let previous_generation;
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bridge.configure_host_bootstrap_secret(SECRET).unwrap();
        register(&bridge, A, "first");
        let latest = register(&bridge, B, "second");
        previous_generation = latest.host_pin.generation;
        let persisted: String = bridge
            .store
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .connection
            .query_row("SELECT value FROM spellcast_state WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!persisted.contains(SECRET) && !persisted.contains(&latest.lease_token));
        assert!(
            !persisted.contains("lease_token")
                && !persisted.contains("bootstrap_hash")
                && !persisted.contains("token_hash")
        );
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        assert!(
            bridge.host_status(SECRET).is_err(),
            "Bootstrap credentials are not restored from board state"
        );
        bridge.configure_host_bootstrap_secret(SECRET).unwrap();
        assert!(bridge.host_status(SECRET).unwrap().is_empty());
        let registered = register(&bridge, A, "first");
        assert!(registered.host_pin.generation > previous_generation);
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn hundreds_of_reconnects_retire_runtime_leases_but_preserve_original_frozen_request() {
    let bridge = bridge();
    let original = register(&bridge, A, "instance");
    let event = say(&bridge, &original, "frozen-before-reconnects");
    let mut latest = register(&bridge, A, "instance");
    for _ in 0..300 {
        latest = register(&bridge, A, "instance");
    }
    let statuses = bridge.host_status(SECRET).unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].host_pin, latest.host_pin);
    assert!(latest.host_pin.generation > 256);
    assert!(bridge
        .heartbeat_host(
            &original.lease_token,
            HostHeartbeat {
                host_pin: original.host_pin.clone(),
                active: false
            }
        )
        .is_err());
    assert!(bridge
        .host_requests(&latest.lease_token, &latest.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .requests
        .is_empty());
    let old = bridge.feedback_state(None).deliveries[0].clone();
    assert_eq!(old.phase, DeliveryPhase::Unknown);
    assert_eq!(old.event.host_pin, Some(original.host_pin.clone()));
    assert_eq!(old.event.seq, event.seq);
    assert!(old.received_at_ms.is_none() && old.desktop.is_none());
    assert!(bridge.retry_feedback(event.seq).await.is_err());
    let replay = say(&bridge, &original, "frozen-before-reconnects");
    assert_eq!(replay.seq, event.seq);
    assert_eq!(bridge.feedback_state(None).deliveries.len(), 1);
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Unknown
    );
}

#[tokio::test]
async fn live_capacity_allows_exact_reconnect_and_reclaims_expired_routes_without_migrating_events()
{
    let bridge = bridge();
    let first = register(&bridge, A, "instance-0");
    let event = say(&bridge, &first, "capacity-original");
    let mut survivor = register(&bridge, A, "instance-1");
    for index in 2..256 {
        survivor = register(&bridge, A, &format!("instance-{index}"));
    }
    assert_eq!(bridge.host_status(SECRET).unwrap().len(), 256);
    assert!(bridge
        .register_host(SECRET, descriptor(A, "over-capacity"))
        .is_err());
    let replacement = register(&bridge, A, "instance-0");
    assert_eq!(bridge.host_status(SECRET).unwrap().len(), 256);
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Unknown
    );
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].event.host_pin,
        Some(first.host_pin.clone())
    );
    assert!(bridge
        .heartbeat_host(
            &survivor.lease_token,
            HostHeartbeat {
                host_pin: survivor.host_pin.clone(),
                active: false
            }
        )
        .is_ok());
    assert!(bridge
        .host_requests(
            &replacement.lease_token,
            &replacement.host_pin.lease_id,
            0,
            0
        )
        .await
        .unwrap()
        .requests
        .is_empty());
    bridge.hosts.lock().unwrap().clock_offset = std::time::Duration::from_secs(31);
    let fresh = register(&bridge, B, "fresh-instance");
    assert_eq!(bridge.host_status(SECRET).unwrap().len(), 1);
    assert!(bridge
        .host_requests(&fresh.lease_token, &fresh.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .requests
        .is_empty());
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].event.seq,
        event.seq
    );
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Unknown
    );
}

#[test]
fn liveness_only_heartbeats_preserve_explicit_attention_without_sending() {
    let bridge = bridge();
    let first = register(&bridge, A, "instance");
    let second = register(&bridge, B, "instance");
    let second_alive = bridge
        .heartbeat_host(
            &second.lease_token,
            HostHeartbeat {
                host_pin: second.host_pin.clone(),
                active: false,
            },
        )
        .unwrap();
    assert!(
        second_alive.active,
        "Liveness does not clear recently explicit attention"
    );
    let first_alive = bridge
        .heartbeat_host(
            &first.lease_token,
            HostHeartbeat {
                host_pin: first.host_pin.clone(),
                active: false,
            },
        )
        .unwrap();
    assert!(
        !first_alive.active,
        "Liveness from another tab cannot steal attention"
    );
    assert!(
        bridge
            .host_status(SECRET)
            .unwrap()
            .iter()
            .find(|status| status.host_pin == second.host_pin)
            .unwrap()
            .active
    );
    let first_explicit = bridge
        .heartbeat_host(
            &first.lease_token,
            HostHeartbeat {
                host_pin: first.host_pin.clone(),
                active: true,
            },
        )
        .unwrap();
    assert!(first_explicit.active);
    assert!(
        !bridge
            .host_status(SECRET)
            .unwrap()
            .iter()
            .find(|status| status.host_pin == second.host_pin)
            .unwrap()
            .active
    );
    assert!(bridge.feedback_state(None).deliveries.is_empty());
    assert_eq!(bridge.state.lock().unwrap().inbox.last_seq(), 0);
}

#[test]
fn oversized_unicode_completion_is_rejected_and_truncated_completion_has_explicit_note() {
    let bridge = bridge();
    let host = register(&bridge, A, "instance");
    let event = say(&bridge, &host, "long-response");
    bridge
        .host_receipt(
            &host.lease_token,
            receipt(&host, &event, DeliveryPhase::Received),
        )
        .unwrap();
    let mut completion = receipt(&host, &event, DeliveryPhase::Completed);
    completion.text = Some("😀".repeat(16_001));
    completion.truncated = true;
    assert!(bridge
        .host_receipt(&host.lease_token, completion.clone())
        .is_err());
    assert!(bridge.board().replies.is_empty());
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Received
    );
    assert!(!bridge.feedback_state(None).deliveries[0].response_truncated);
    completion.text = Some("😀".repeat(16_000));
    let accepted = bridge
        .host_receipt(&host.lease_token, completion.clone())
        .unwrap();
    assert_eq!(accepted.phase, DeliveryPhase::Completed);
    assert!(accepted.response_truncated);
    assert!(accepted
        .response_note
        .as_deref()
        .unwrap()
        .contains("完整结果保存在原 GUI 会话"));
    let reply = bridge.board().replies[0].clone();
    assert_eq!(reply.source_id, host.host_pin.source_id);
    assert!(reply.title.contains("已截断"));
    assert!(
        matches!(&reply.blocks[0], spellcast_core::ReplyBlock::Text { text, .. } if text.chars().count() == 16_000)
    );
    assert!(
        matches!(&reply.blocks[1], spellcast_core::ReplyBlock::Text { title, text, .. } if title.contains("已截断") && text.contains("完整结果保存在原 GUI 会话"))
    );
    bridge
        .host_receipt(&host.lease_token, completion.clone())
        .unwrap();
    assert_eq!(bridge.board().replies.len(), 1);
    completion.truncated = false;
    assert!(
        bridge.host_receipt(&host.lease_token, completion).is_err(),
        "Truncation is part of immutable receipt fingerprint"
    );
}

fn ready_observation(bridge: &Bridge, source: &str) -> crate::observer::ObserverBrief {
    let result = bridge
        .checkpoint(crate::observer::CheckpointRequest {
            source_id: source.into(),
            snapshot: Some(crate::observer::ProjectSnapshot {
                checkpoint_id: "frozen-observer-context".into(),
                project: "Project".into(),
                goal: "Goal".into(),
                change: "Ready before host changes".into(),
                facts: vec![],
            }),
        })
        .unwrap();
    if result.status == "scheduled" {
        assert!(result.brief.is_none(), "managed Claude observations never expose a host brief");
        bridge.test_observer_brief(source).unwrap()
    } else {
        assert_eq!(result.status, "ready");
        result.brief.unwrap()
    }
}

fn finish_observation(
    bridge: &Bridge,
    brief: &crate::observer::ObserverBrief,
) -> spellcast_core::CapturedContext {
    let result = bridge
        .complete_observation(crate::observer::ObserverCompletion {
            observer_id: brief.observer_id.clone(),
            provider: Some(brief.provider.clone()),
            thought: Some(crate::observer::ObserverThought {
                tease: "The original task owns this aside.".into(),
                body: "Original project context.".into(),
                kind: None,
                shape: None,
            }),
        })
        .unwrap();
    assert_eq!(result.status, "accepted");
    let (source, captured) = bridge.test_bubble_maps(result.bubble_id.as_ref().unwrap());
    assert_eq!(source.as_deref(), Some(brief.source_id.as_str()));
    captured.unwrap()
}

#[test]
fn ready_observer_freezes_original_claude_pin_across_focus_reconnect_and_expiry_for_each_judge() {
    for judge in ["codex", "claude"] {
        let (bridge, surface) = crate::tests::bridge();
        let runner_fixture = crate::observer_runner::test_support::Fixture::new();
        if judge == "claude" {
            bridge.configure_claude_observer_runner(runner_fixture.runner());
        }
        bridge.configure_host_bootstrap_secret(SECRET).unwrap();
        bridge.set_observer_enabled(true).unwrap();
        bridge.set_observer_provider(judge).unwrap();
        let original = register(&bridge, A, "instance");
        let brief = ready_observation(&bridge, &original.host_pin.source_id);
        assert_eq!(brief.provider, judge);
        let public_brief = serde_json::to_string(&brief).unwrap();
        assert!(
            !public_brief.contains("host_pin") && !public_brief.contains("captured_context"),
            "Server-owned capture does not alter observer wire"
        );
        register(&bridge, B, "instance");
        let mut changed = descriptor(A, "instance");
        changed.cwd = "G:/changed-after-ready".into();
        changed.active = false;
        let replacement = bridge.register_host(SECRET, changed).unwrap();
        assert_ne!(original.host_pin.lease_id, replacement.host_pin.lease_id);
        bridge.hosts.lock().unwrap().clock_offset = std::time::Duration::from_secs(31);
        let captured = finish_observation(&bridge, &brief);
        assert_eq!(captured.source_id, original.host_pin.source_id);
        assert_eq!(captured.thread_id.as_deref(), Some(A));
        assert_eq!(
            captured.cwd.as_deref(),
            Some(original.host_pin.cwd.as_str())
        );
        assert_eq!(captured.host_pin, Some(original.host_pin.clone()));
        assert_eq!(
            surface.thrown.lock().unwrap()[0].captured_context,
            Some(captured)
        );
        assert!(bridge.feedback_state(None).deliveries.is_empty());
    }
}

#[test]
fn ambiguous_ready_observer_stays_unpinned_when_a_unique_new_lease_appears() {
    let (bridge, _) = crate::tests::bridge();
    bridge.configure_host_bootstrap_secret(SECRET).unwrap();
    bridge.set_observer_enabled(true).unwrap();
    let first = register(&bridge, A, "first");
    register(&bridge, A, "second");
    let brief = ready_observation(&bridge, &first.host_pin.source_id);
    bridge.hosts.lock().unwrap().clock_offset = std::time::Duration::from_secs(31);
    register(&bridge, A, "new-unique");
    assert_eq!(bridge.host_status(SECRET).unwrap().len(), 1);
    let captured = finish_observation(&bridge, &brief);
    assert_eq!(captured.source_id, first.host_pin.source_id);
    assert_eq!(captured.thread_id.as_deref(), Some(A));
    assert!(
        captured.host_pin.is_none() && captured.cwd.is_none(),
        "Ambiguity at ready must not later acquire another lease"
    );
}

#[test]
fn unlinked_claude_ready_preserves_native_uuid_and_never_uses_codex_binding_or_late_host() {
    let (bridge, _) = crate::tests::bridge();
    bridge.configure_host_bootstrap_secret(SECRET).unwrap();
    bridge.set_observer_enabled(true).unwrap();
    let source = format!("claude:{A}");
    bridge
        .update(|state| {
            state.bindings.push(crate::codex::CodexBinding {
                source_id: source.clone(),
                thread_id: B.into(),
                cwd: "G:/spoofed-codex-cwd".into(),
                label: "Must not own Claude".into(),
                executable: "never-launch-test.exe".into(),
                protocol_agent: "test".into(),
                bound_at_ms: 1,
            });
            Ok(())
        })
        .unwrap();
    let brief = ready_observation(&bridge, &source);
    register(&bridge, A, "appeared-after-ready");
    let captured = finish_observation(&bridge, &brief);
    assert_eq!(captured.source_id, source);
    assert_eq!(captured.thread_id.as_deref(), Some(A));
    assert!(captured.cwd.is_none() && captured.host_pin.is_none());
    for invalid in [
        "claude:not-a-uuid",
        "CLAUDE:a1000000-0000-4000-8000-000000000001",
        "claude:A1000000-0000-4000-8000-000000000001",
        "claude:00000000-0000-0000-0000-000000000000",
    ] {
        assert!(bridge
            .checkpoint(crate::observer::CheckpointRequest {
                source_id: invalid.into(),
                snapshot: Some(brief.snapshot.clone())
            })
            .is_err());
    }
}

#[test]
fn codex_alias_observer_capture_is_frozen_before_binding_changes_with_claude_judge() {
    for source in [A.to_string(), format!("codex:{A}")] {
        let (bridge, _) = crate::tests::bridge();
        let runner_fixture = crate::observer_runner::test_support::Fixture::new();
        bridge.configure_claude_observer_runner(runner_fixture.runner());
        bridge.set_observer_enabled(true).unwrap();
        bridge.set_observer_provider("claude").unwrap();
        bridge
            .update(|state| {
                state.bindings.push(crate::codex::CodexBinding {
                    source_id: format!("codex:{A}"),
                    thread_id: A.into(),
                    cwd: "G:/original-codex-cwd".into(),
                    label: "Codex".into(),
                    executable: "never-launch-test.exe".into(),
                    protocol_agent: "test".into(),
                    bound_at_ms: 1,
                });
                Ok(())
            })
            .unwrap();
        let brief = ready_observation(&bridge, &source);
        bridge
            .update(|state| {
                state.bindings[0].cwd = "G:/newer-codex-cwd".into();
                Ok(())
            })
            .unwrap();
        let captured = finish_observation(&bridge, &brief);
        assert_eq!(captured.source_id, source);
        assert_eq!(captured.thread_id.as_deref(), Some(A));
        assert_eq!(captured.cwd.as_deref(), Some("G:/original-codex-cwd"));
        assert!(captured.host_pin.is_none());
    }
}

fn native_runtime_phase(
    bridge: &Bridge,
    host: &RegisteredHost,
    event: &AgentEvent,
    phase: DeliveryPhase,
) -> crate::feedback::DeliveryReceipt {
    bridge
        .host_receipt(
            &host.lease_token,
            receipt(host, event, DeliveryPhase::Received),
        )
        .unwrap();
    let executing = bridge
        .host_receipt(
            &host.lease_token,
            receipt(host, event, DeliveryPhase::Executing),
        )
        .unwrap();
    if phase == DeliveryPhase::Executing {
        executing
    } else {
        bridge
            .host_receipt(&host.lease_token, receipt(host, event, phase))
            .unwrap()
    }
}

fn assert_native_runtime_preserved(
    actual: &crate::feedback::DeliveryReceipt,
    before: &crate::feedback::DeliveryReceipt,
) {
    assert_eq!(actual.phase, before.phase);
    assert_eq!(actual.error, before.error);
    assert_eq!(actual.host_receipt_seq, before.host_receipt_seq);
    assert_eq!(actual.host_receipt_hash, before.host_receipt_hash);
    assert_eq!(actual.event.host_pin, before.event.host_pin);
    assert_eq!(actual.received_at_ms, before.received_at_ms);
    assert_eq!(actual.executing_at_ms, before.executing_at_ms);
    assert_eq!(
        actual.awaiting_permission_at_ms,
        before.awaiting_permission_at_ms
    );
    assert_eq!(actual.completed_at_ms, before.completed_at_ms);
}

fn native_mcp_batch(
    id: &str,
    operations: Value,
    sequences: &[u64],
    reads: Value,
) -> spellcast_core::CanvasBatchRequest {
    serde_json::from_value(json!({"request_id":id,"operations":operations,"feedback_sequences":sequences,"reads":reads})).unwrap()
}

fn native_result_object(id: &str, text: &str) -> Value {
    json!({"op":"create","id":id,"content":{"type":"text","title":"Original model result","text":text},"placement":{"x":120,"y":80,"width":320,"height":180}})
}

#[test]
fn mcp_applied_batch_preserves_host_runtime_and_completion_keeps_primary_result_association() {
    for phase in [
        DeliveryPhase::Executing,
        DeliveryPhase::AwaitingPermission,
        DeliveryPhase::Completed,
        DeliveryPhase::Unknown,
        DeliveryPhase::Failed,
    ] {
        let bridge = bridge();
        let host = register(&bridge, A, "mcp-batch-instance");
        let event = say(&bridge, &host, "mcp-batch-request");
        let before = native_runtime_phase(&bridge, &host, &event, phase);
        bridge
            .read_feedback_request(&host.host_pin.source_id, event.seq)
            .unwrap();
        let result = bridge
            .canvas_batch(
                native_mcp_batch(
                    "native-applied-result",
                    json!([native_result_object(
                        "structured-result",
                        "完整的结构化结果"
                    )]),
                    &[event.seq],
                    json!([]),
                ),
                Some(&host.host_pin.source_id),
            )
            .unwrap();
        assert_eq!(result.result.status, "applied");
        let after = bridge.feedback_state(None).deliveries[0].clone();
        assert_native_runtime_preserved(&after, &before);
        assert_eq!(
            after.response_request_id.as_deref(),
            Some("native-applied-result")
        );
        assert_eq!(after.response_object_ids, vec!["structured-result"]);
        assert!(after.responded_at_ms.is_some());

        bridge
            .acknowledge_feedback(&host.host_pin.source_id, &[event.seq])
            .unwrap();
        let acked = bridge.feedback_state(None).deliveries[0].clone();
        assert_native_runtime_preserved(&acked, &before);
        assert!(acked.handled_at_ms.is_some());
        let mut completion = receipt(&host, &event, DeliveryPhase::Completed);
        completion.receipt_seq = before.host_receipt_seq + 1;
        completion.text = Some("原聊天最终总结".into());
        if matches!(
            phase,
            DeliveryPhase::Executing | DeliveryPhase::AwaitingPermission
        ) {
            let completed = bridge
                .host_receipt(&host.lease_token, completion.clone())
                .unwrap();
            assert_eq!(completed.phase, DeliveryPhase::Completed);
            assert_eq!(completed.response_request_id, after.response_request_id);
            assert_eq!(completed.response_reply_id, after.response_reply_id);
            assert!(completed
                .response_object_ids
                .contains(&"structured-result".to_string()));
            let summary = format!("reply:host-response-{}", completed.client_message_id);
            assert_eq!(
                completed
                    .response_object_ids
                    .iter()
                    .filter(|id| *id == &summary)
                    .count(),
                1
            );
            assert_eq!(completed.response_object_ids.len(), 2);
            bridge.host_receipt(&host.lease_token, completion).unwrap();
            assert_eq!(bridge.board().replies.len(), 1);
        } else {
            assert!(bridge.host_receipt(&host.lease_token, completion).is_err());
            assert_native_runtime_preserved(&bridge.feedback_state(None).deliveries[0], &before);
        }
        assert!(
            matches!(&bridge.board().canvas.object("structured-result").unwrap().content,
            spellcast_core::CanvasContent::Text { text, .. } if text == "完整的结构化结果")
        );
    }
}

#[test]
fn later_model_proposal_adoption_preserves_host_phase_error_and_original_structure() {
    for phase in [
        DeliveryPhase::Executing,
        DeliveryPhase::AwaitingPermission,
        DeliveryPhase::Completed,
        DeliveryPhase::Unknown,
        DeliveryPhase::Failed,
    ] {
        let bridge = bridge();
        let host = register(&bridge, A, "proposal-instance");
        bridge
            .canvas_batch(
                native_mcp_batch(
                    "proposal-seed",
                    json!([native_result_object("original", "Original text")]),
                    &[],
                    json!([]),
                ),
                Some(&host.host_pin.source_id),
            )
            .unwrap();
        let event = say(&bridge, &host, "proposal-request");
        native_runtime_phase(&bridge, &host, &event, DeliveryPhase::Executing);
        bridge.canvas_batch(native_mcp_batch("user-edit-before-proposal", json!([{"op":"patch_content","id":"original","expected_revision":1,"fields":{"text":"User newer text"}}]), &[], json!([])), None).unwrap();
        let proposed = bridge.canvas_batch(native_mcp_batch("native-stale-proposal", json!([{"op":"patch_content","id":"original","expected_revision":1,"fields":{"text":"Reviewed proposal result"}}]), &[event.seq], json!([{"kind":"content","id":"original","revision":1}])), Some(&host.host_pin.source_id)).unwrap();
        assert_eq!(proposed.result.status, "proposed");
        if phase != DeliveryPhase::Executing {
            bridge
                .host_receipt(&host.lease_token, receipt(&host, &event, phase))
                .unwrap();
        }
        let before = bridge.feedback_state(None).deliveries[0].clone();
        bridge
            .acknowledge_feedback(&host.host_pin.source_id, &[event.seq])
            .unwrap();
        assert_native_runtime_preserved(&bridge.feedback_state(None).deliveries[0], &before);
        let applied = bridge
            .canvas_proposal(
                "native-stale-proposal",
                crate::canvas::CanvasProposalAction {
                    action: "apply".into(),
                    current: vec![spellcast_core::CanvasRead {
                        kind: spellcast_core::CanvasTargetKind::Content,
                        id: "original".into(),
                        revision: 2,
                    }],
                },
            )
            .unwrap();
        assert_eq!(applied.result.status, "applied");
        let after = bridge.feedback_state(None).deliveries[0].clone();
        assert_native_runtime_preserved(&after, &before);
        assert_eq!(
            after.response_request_id.as_deref(),
            Some("native-stale-proposal")
        );
        assert_eq!(after.response_object_ids, vec!["original"]);
        let mut completed = receipt(&host, &event, DeliveryPhase::Completed);
        completed.receipt_seq = before.host_receipt_seq + 1;
        if matches!(
            phase,
            DeliveryPhase::Executing | DeliveryPhase::AwaitingPermission
        ) {
            assert_eq!(
                bridge
                    .host_receipt(&host.lease_token, completed)
                    .unwrap()
                    .phase,
                DeliveryPhase::Completed
            );
        } else {
            assert!(bridge.host_receipt(&host.lease_token, completed).is_err());
        }
        assert!(
            matches!(&bridge.board().canvas.object("original").unwrap().content,
            spellcast_core::CanvasContent::Text { text, .. } if text == "Reviewed proposal result")
        );
        assert_eq!(
            bridge
                .board()
                .canvas
                .object("original")
                .unwrap()
                .source_id
                .as_deref(),
            Some(host.host_pin.source_id.as_str())
        );
    }
}

#[test]
fn mcp_reply_primary_link_survives_sdk_summary_and_terminal_ack_preserves_host_error() {
    for phase in [
        DeliveryPhase::Executing,
        DeliveryPhase::AwaitingPermission,
        DeliveryPhase::Unknown,
        DeliveryPhase::Failed,
    ] {
        let bridge = bridge();
        let host = register(&bridge, A, "mcp-reply-instance");
        let event = say(&bridge, &host, "mcp-reply-request");
        let before = native_runtime_phase(&bridge, &host, &event, phase);
        bridge
            .write_reply_for_feedback(
                spellcast_core::ReplyRequest {
                    id: Some("native-primary-reply".into()),
                    source_id: host.host_pin.source_id.clone(),
                    source_label: None,
                    origin_node_id: None,
                    title: "Actual MCP result".into(),
                    expected_revision: Some(0),
                    blocks: vec![spellcast_core::ReplyBlock::Text {
                        id: "real-result".into(),
                        title: String::new(),
                        text: "完整的原始 MCP 回复".into(),
                    }],
                },
                &[event.seq],
            )
            .unwrap();
        let after = bridge.feedback_state(None).deliveries[0].clone();
        assert_native_runtime_preserved(&after, &before);
        assert_eq!(
            after.response_reply_id.as_deref(),
            Some("native-primary-reply")
        );
        bridge
            .acknowledge_feedback(&host.host_pin.source_id, &[event.seq])
            .unwrap();
        assert_native_runtime_preserved(&bridge.feedback_state(None).deliveries[0], &before);
        if matches!(
            phase,
            DeliveryPhase::Executing | DeliveryPhase::AwaitingPermission
        ) {
            let mut completion = receipt(&host, &event, DeliveryPhase::Completed);
            completion.receipt_seq = before.host_receipt_seq + 1;
            completion.text = Some("GUI 最终摘要".into());
            let completed = bridge
                .host_receipt(&host.lease_token, completion.clone())
                .unwrap();
            assert_eq!(completed.response_reply_id, after.response_reply_id);
            assert_eq!(completed.response_request_id, after.response_request_id);
            let summary_id = format!("reply:host-response-{}", completed.client_message_id);
            assert!(completed.response_object_ids.contains(&summary_id));
            bridge.host_receipt(&host.lease_token, completion).unwrap();
            assert_eq!(bridge.board().replies.len(), 2);
        }
        let original = bridge
            .board()
            .replies
            .into_iter()
            .find(|reply| reply.id == "native-primary-reply")
            .unwrap();
        assert!(
            matches!(&original.blocks[0], spellcast_core::ReplyBlock::Text { text, .. } if text == "完整的原始 MCP 回复")
        );
    }
}

#[test]
fn ordinary_codex_mcp_read_reply_and_ack_keep_existing_receipt_behavior() {
    let bridge = Bridge::new(Headless, 0);
    let event = bridge
        .say(SayRequest {
            text: "A normal Codex request".into(),
            source_id: Some("codex:ordinary".into()),
            ..Default::default()
        })
        .unwrap();
    bridge
        .read_feedback_request("codex:ordinary", event.seq)
        .unwrap();
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Received
    );
    bridge
        .write_reply_for_feedback(
            spellcast_core::ReplyRequest {
                id: Some("ordinary-reply".into()),
                source_id: "codex:ordinary".into(),
                source_label: None,
                origin_node_id: None,
                title: "Original Codex result".into(),
                expected_revision: Some(0),
                blocks: vec![spellcast_core::ReplyBlock::Text {
                    id: "body".into(),
                    title: String::new(),
                    text: "Normal result".into(),
                }],
            },
            &[event.seq],
        )
        .unwrap();
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Responded
    );
    bridge
        .acknowledge_feedback("codex:ordinary", &[event.seq])
        .unwrap();
    assert_eq!(
        bridge.feedback_state(None).deliveries[0].phase,
        DeliveryPhase::Handled
    );
    assert!(bridge.feedback_state(None).deliveries[0].error.is_none());
}

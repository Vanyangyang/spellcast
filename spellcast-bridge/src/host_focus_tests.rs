//! Attention timestamps and focus requests: what lets Spellcast see that a chat was opened and take the
//! user back to it. The host plugin already reports attention with an `active: true` heartbeat.
use std::time::Duration;

use crate::host_sessions::{HostHeartbeat, HostRegistration, RegisteredHost};
use crate::{Bridge, Headless};

const SECRET: &str = "isolated-test-bootstrap-credential-00000002";
const A: &str = "a2000000-0000-4000-8000-000000000001";
const B: &str = "b2000000-0000-4000-8000-000000000002";

fn bridge() -> Bridge {
    let bridge = Bridge::new(Headless, 0);
    bridge.configure_host_bootstrap_secret(SECRET).unwrap();
    bridge
}

fn register(bridge: &Bridge, native: &str, instance: &str, active: bool) -> RegisteredHost {
    bridge
        .register_host(
            SECRET,
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
                active,
            },
        )
        .unwrap()
}

fn heartbeat(bridge: &Bridge, host: &RegisteredHost, active: bool) {
    bridge
        .heartbeat_host(
            &host.lease_token,
            HostHeartbeat {
                host_pin: host.host_pin.clone(),
                active,
            },
        )
        .unwrap();
}

fn source(native: &str) -> String {
    format!("claude:{native}")
}

/// Attention is stamped in milliseconds and must come after the request to answer it; a real plugin
/// needs a poll and a chat switch first, so tests that attest at once wait one tick.
fn tick() {
    std::thread::sleep(Duration::from_millis(3));
}

#[test]
fn attention_is_stamped_only_by_explicit_attention_of_a_live_host() {
    let bridge = bridge();
    assert_eq!(bridge.host_attention(&source(A)), None, "no host, no answer");
    let host = register(&bridge, A, "first", false);
    assert_eq!(bridge.host_attention(&source(A)), Some(0), "registered, never attended");
    // Liveness reports are not attention.
    heartbeat(&bridge, &host, false);
    assert_eq!(bridge.host_attention(&source(A)), Some(0));
    let before = spellcast_core::inbox::now_ms();
    heartbeat(&bridge, &host, true);
    let stamped = bridge.host_attention(&source(A)).unwrap();
    assert!(stamped >= before, "{stamped} < {before}");
    // Another conversation is not affected, and an unknown source stays unknown.
    register(&bridge, B, "first", false);
    assert_eq!(bridge.host_attention(&source(B)), Some(0));
    assert_eq!(bridge.host_attention(&source(A)), Some(stamped));
    assert_eq!(bridge.host_attention("claude:00000000-0000-4000-8000-000000000000"), None);
    // Registering already attended (the plugin's explicit connect) counts as attention.
    let attended = register(&bridge, "c2000000-0000-4000-8000-000000000003", "first", true);
    assert!(bridge.host_attention(&attended.host_pin.source_id).unwrap() > 0);
    // A lease that lapsed no longer answers for the chat.
    bridge.hosts.lock().unwrap().clock_offset = Duration::from_secs(60);
    assert_eq!(bridge.host_attention(&source(A)), None);
}

#[tokio::test]
async fn focus_request_is_delivered_with_the_poll_until_the_chat_gets_attention() {
    let bridge = bridge();
    let host = register(&bridge, A, "first", false);
    let poll = || bridge.host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 0);
    assert!(poll().await.unwrap().focus.is_none(), "nothing asked yet");
    let ticket = bridge.request_host_focus(&source(A)).unwrap();
    assert!(!bridge.host_focus_acked(&ticket));
    let first = poll().await.unwrap().focus.expect("delivered");
    // The same request keeps arriving (the plugin de-duplicates by id) until it is answered.
    assert_eq!(poll().await.unwrap().focus.unwrap().id, first.id);
    assert!(!bridge.host_focus_acked(&ticket));
    // A liveness heartbeat does not answer it; explicit attention on that chat does.
    heartbeat(&bridge, &host, false);
    assert!(!bridge.host_focus_acked(&ticket));
    tick();
    heartbeat(&bridge, &host, true);
    assert!(bridge.host_focus_acked(&ticket));
    assert!(poll().await.unwrap().focus.is_none(), "answered requests are not delivered again");
    // The JSON a plugin sees carries focus only while one is pending.
    let quiet = serde_json::to_value(poll().await.unwrap()).unwrap();
    assert!(quiet.get("focus").is_none(), "{quiet}");
    bridge.request_host_focus(&source(A)).unwrap();
    let pending = serde_json::to_value(poll().await.unwrap()).unwrap();
    assert!(pending["focus"]["id"].is_string(), "{pending}");
}

#[tokio::test]
async fn focus_request_goes_stale_and_never_targets_another_chat_or_a_dead_host() {
    let bridge = bridge();
    let host = register(&bridge, A, "first", false);
    let other = register(&bridge, B, "first", false);
    bridge.request_host_focus(&source(A)).unwrap();
    // Only the lease of the asked chat sees it.
    assert!(bridge
        .host_requests(&other.lease_token, &other.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .focus
        .is_none());
    // A click that waited too long is dropped rather than delivered later.
    bridge.hosts.lock().unwrap().clock_offset = Duration::from_secs(9);
    heartbeat(&bridge, &host, false);
    heartbeat(&bridge, &other, false);
    assert!(bridge
        .host_requests(&host.lease_token, &host.host_pin.lease_id, 0, 0)
        .await
        .unwrap()
        .focus
        .is_none());
    // No live host, no request.
    bridge.hosts.lock().unwrap().clock_offset = Duration::from_secs(120);
    assert!(bridge.request_host_focus(&source(A)).is_err());
    assert!(bridge.request_host_focus("claude:00000000-0000-4000-8000-000000000000").is_err());
}

#[test]
fn with_two_live_leases_the_most_recently_attended_one_is_asked() {
    let bridge = bridge();
    let old = register(&bridge, A, "instance-1", false);
    let new = register(&bridge, A, "instance-2", false);
    // Neither attended: the newest registration wins.
    let ticket = bridge.request_host_focus(&source(A)).unwrap();
    tick();
    heartbeat(&bridge, &new, true);
    assert!(bridge.host_focus_acked(&ticket), "answered by the lease that was asked");
    // The older window got the attention later: now it is the one asked.
    tick();
    heartbeat(&bridge, &old, true);
    tick();
    let ticket = bridge.request_host_focus(&source(A)).unwrap();
    tick();
    heartbeat(&bridge, &new, true);
    assert!(!bridge.host_focus_acked(&ticket), "attention elsewhere does not answer it");
    tick();
    heartbeat(&bridge, &old, true);
    assert!(bridge.host_focus_acked(&ticket));
}

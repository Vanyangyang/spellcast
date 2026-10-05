use super::*;
use crate::observer_runner::test_support::{assert_exited, checkpoint, wait, Fixture};
use std::time::{Duration, Instant};

fn configured(f: &Fixture) -> (Arc<Bridge>, Arc<crate::tests::Recording>) {
    let (bridge, surface) = crate::tests::bridge();
    bridge.set_observer_enabled(true).unwrap();
    bridge.set_observer_provider("claude").unwrap();
    bridge.configure_claude_observer_runner(f.runner());
    (bridge, surface)
}

fn active(bridge: &Bridge) -> usize {
    bridge.observers.lock().unwrap().dispatcher.as_ref().map_or(0, |d| d.active())
}

#[test]
fn slow_claude_is_accepted_without_a_host_brief_and_completes_directly() {
    let f = Fixture::new();
    let (bridge, surface) = configured(&f);
    let began = Instant::now();
    let response = bridge.checkpoint(checkpoint("main", "hold")).unwrap();
    assert_eq!(response.status, "scheduled");
    assert!(response.brief.is_none(), "the host must not receive a courier task");
    assert!(began.elapsed() < Duration::from_secs(1), "checkpoint waited for an observation");
    let received = f.wait_started("main");
    assert_eq!(received["source"], "main");
    assert_eq!(received["provider"], "claude");
    assert_eq!(received["locale"], "zh-CN");
    assert_eq!(active(&bridge), 1);
    assert!(surface.thrown.lock().unwrap().is_empty());

    // The main caller has already returned. A duplicate cannot start a second process.
    assert_eq!(bridge.checkpoint(checkpoint("main", "hold")).unwrap().status, "duplicate");
    assert_eq!(active(&bridge), 1);
    f.release("main");
    wait(|| active(&bridge) == 0);
    let bubbles = surface.thrown.lock().unwrap();
    assert_eq!(bubbles.len(), 1);
    assert_eq!(bubbles[0].source_id.as_deref(), Some("main"));
    assert!(bubbles[0].tease.contains("main/hold"));
    drop(bubbles);
    assert_eq!(bridge.complete_observation(ObserverCompletion {
        observer_id: received["id"].as_str().unwrap().into(),
        provider: Some("claude".into()),
        thought: None,
    }).unwrap().status, "stale", "the internal completion consumed the ticket once");
}

#[test]
fn cancelling_a_source_kills_only_its_tree_and_rejects_late_results() {
    let f = Fixture::new();
    let (bridge, surface) = configured(&f);
    assert_eq!(bridge.checkpoint(checkpoint("a", "tree")).unwrap().status, "scheduled");
    assert_eq!(bridge.checkpoint(checkpoint("b", "hold")).unwrap().status, "scheduled");
    let a = f.wait_started("a");
    f.wait_started("b");
    let child = f.child("a");
    assert_eq!(bridge.checkpoint(CheckpointRequest { source_id: "a".into(), snapshot: None }).unwrap().status, "cancelled");
    wait(|| active(&bridge) == 1);
    assert_exited(a["pid"].as_u64().unwrap() as u32);
    assert_exited(child);
    assert_eq!(bridge.complete_observation(ObserverCompletion {
        observer_id: a["id"].as_str().unwrap().into(),
        provider: Some("claude".into()),
        thought: Some(ObserverThought { tease: "late".into(), body: String::new(), kind: None, shape: None }),
    }).unwrap().status, "stale");
    f.release("a");
    f.release("b");
    wait(|| active(&bridge) == 0);
    let bubbles = surface.thrown.lock().unwrap();
    assert_eq!(bubbles.len(), 1);
    assert_eq!(bubbles[0].source_id.as_deref(), Some("b"));
}

#[test]
fn changed_context_cancels_running_work_even_during_cooldown() {
    let f = Fixture::new();
    let (bridge, surface) = configured(&f);
    bridge.checkpoint(checkpoint("context", "tree")).unwrap();
    let first = f.wait_started("context");
    let child = f.child("context");
    let response = bridge.checkpoint(checkpoint("context", "a different plan")).unwrap();
    assert_eq!(response.status, "cooldown");
    assert!(response.brief.is_none());
    wait(|| active(&bridge) == 0);
    assert_exited(first["pid"].as_u64().unwrap() as u32);
    assert_exited(child);
    assert!(surface.thrown.lock().unwrap().is_empty());
}

#[test]
fn replacement_starts_only_after_the_previous_process_was_reaped() {
    let f = Fixture::new();
    let (bridge, surface) = configured(&f);
    bridge.checkpoint(checkpoint("replace", "tree")).unwrap();
    let first = f.wait_started("replace");
    let old_child = f.child("replace");
    // Advance only the ticket cooldown, without waiting two minutes in a regression test.
    bridge.observers.lock().unwrap().sources.get_mut("replace").unwrap().last_started =
        Some(spellcast_core::inbox::now_ms() - COOLDOWN_MS);
    assert_eq!(bridge.checkpoint(checkpoint("replace", "new plan")).unwrap().status, "scheduled");
    wait(|| f.started("replace").is_some_and(|value| value["mode"] == "new plan"));
    assert_exited(first["pid"].as_u64().unwrap() as u32);
    assert_exited(old_child);
    f.release("replace");
    wait(|| active(&bridge) == 0);
    let bubbles = surface.thrown.lock().unwrap();
    assert_eq!(bubbles.len(), 1);
    assert!(bubbles[0].tease.contains("new plan"));
}

#[test]
fn disabling_pausing_and_changing_locale_cancel_jobs_not_just_tickets() {
    for policy in ["disable", "pause", "locale"] {
        let f = Fixture::new();
        let (bridge, surface) = configured(&f);
        bridge.checkpoint(checkpoint("policy", "hold")).unwrap();
        let started = f.wait_started("policy");
        match policy {
            "disable" => { bridge.set_observer_enabled(false).unwrap(); }
            "pause" => { bridge.set_paused(true).unwrap(); }
            _ => { bridge.set_ui_locale("en").unwrap(); }
        }
        wait(|| active(&bridge) == 0);
        assert_exited(started["pid"].as_u64().unwrap() as u32);
        assert!(surface.thrown.lock().unwrap().is_empty(), "{policy}");
    }
}

#[test]
fn changing_provider_cancels_claude_and_preserves_codex_host_execution() {
    let f = Fixture::new();
    let (bridge, surface) = configured(&f);
    bridge.checkpoint(checkpoint("provider", "hold")).unwrap();
    let started = f.wait_started("provider");
    bridge.set_observer_provider("codex").unwrap();
    wait(|| active(&bridge) == 0);
    assert_exited(started["pid"].as_u64().unwrap() as u32);
    assert!(surface.thrown.lock().unwrap().is_empty());
    let next = bridge.checkpoint(checkpoint("codex-source", "hold")).unwrap();
    assert_eq!(next.status, "ready");
    assert_eq!(next.brief.unwrap().provider, "codex");
    assert!(f.started("codex-source").is_none(), "the app must not launch a Claude for a Codex ticket");
}

#[test]
fn app_shutdown_and_bridge_drop_end_observer_trees() {
    for dropping in [false, true] {
        let f = Fixture::new();
        let (bridge, surface) = configured(&f);
        bridge.checkpoint(checkpoint("exit", "tree")).unwrap();
        let started = f.wait_started("exit");
        let child = f.child("exit");
        if dropping {
            drop(bridge);
        } else {
            bridge.shutdown_observers();
            assert_eq!(bridge.checkpoint(checkpoint("later", "hold")).unwrap().status, "unavailable");
        }
        assert_exited(started["pid"].as_u64().unwrap() as u32);
        assert_exited(child);
        assert!(surface.thrown.lock().unwrap().is_empty());
    }
}

#[test]
fn failed_or_silent_jobs_settle_without_a_bubble_or_a_host_retry() {
    for mode in ["finish-failed", "finish-invalid", "finish-silent"] {
        let f = Fixture::new();
        let (bridge, surface) = configured(&f);
        let response = bridge.checkpoint(checkpoint("failure", mode)).unwrap();
        assert_eq!(response.status, "scheduled");
        assert!(response.brief.is_none());
        wait(|| active(&bridge) == 0);
        assert!(surface.thrown.lock().unwrap().is_empty(), "{mode}");
        assert!(bridge.observers.lock().unwrap().sources.get("failure").unwrap().pending.is_none());
        assert_eq!(bridge.checkpoint(checkpoint("failure", mode)).unwrap().status, "duplicate");
    }
}

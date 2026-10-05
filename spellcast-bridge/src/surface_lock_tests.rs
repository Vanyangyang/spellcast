use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::observer::{CheckpointRequest, ObserverCompletion, ProjectSnapshot};
use crate::{Bridge, PresentResult, Surface, ThrownBubble};

#[derive(Default)]
struct FocusProbe {
    bridge: Mutex<Weak<Bridge>>,
    calls: AtomicUsize,
}

impl Surface for Arc<FocusProbe> {
    fn agent_seen(&self, _client: &str) {}
    fn throw(&self, _bubbles: &[ThrownBubble]) -> Result<usize, String> {
        Ok(0)
    }
    fn presented(&self, _result: &PresentResult) {}
    fn board_changed(&self) {}
    fn close_bubbles(&self) {}
    fn focus(&self) {}

    fn board_is_focused(&self) -> bool {
        let bridge = self.bridge.lock().unwrap().upgrade().unwrap();
        // A desktop getter may wait for the UI to read the board or change
        // observer settings. Fail without hanging when those locks are held.
        assert!(
            bridge.state.try_lock().is_ok(),
            "focus query blocks UI board reads"
        );
        assert!(
            bridge.status.try_lock().is_ok(),
            "focus query blocks UI presentation changes"
        );
        assert!(
            bridge.observers.try_lock().is_ok(),
            "focus query blocks UI observer changes"
        );
        let _ = bridge.board();
        self.calls.fetch_add(1, Ordering::SeqCst);
        true
    }
}

fn bridge() -> (Arc<Bridge>, Arc<FocusProbe>) {
    let surface = Arc::new(FocusProbe::default());
    let bridge = Arc::new(Bridge::new(surface.clone(), 0));
    *surface.bridge.lock().unwrap() = Arc::downgrade(&bridge);
    (bridge, surface)
}

#[test]
fn status_releases_bridge_locks_before_desktop_focus_query() {
    let (bridge, surface) = bridge();
    assert!(bridge.status().board_focused);
    assert_eq!(surface.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn observer_provider_releases_bridge_locks_before_desktop_focus_query() {
    let (bridge, surface) = bridge();
    let status = bridge.set_observer_provider("claude").unwrap();
    assert_eq!(status.provider, "claude");
    assert_eq!(surface.calls.load(Ordering::SeqCst), 1);
}

fn snapshot() -> CheckpointRequest {
    CheckpointRequest {
        source_id: "isolated-focus-probe".into(),
        snapshot: Some(ProjectSnapshot {
            checkpoint_id: "focus-lock".into(),
            project: "isolated test".into(),
            goal: "query desktop focus without blocking the UI".into(),
            change: "concurrent UI settings update".into(),
            facts: vec![],
        }),
    }
}

#[test]
fn checkpoint_releases_bridge_locks_before_desktop_focus_query() {
    let (bridge, surface) = bridge();
    bridge.set_observer_enabled(true).unwrap();
    surface.calls.store(0, Ordering::SeqCst);
    assert_eq!(bridge.checkpoint(snapshot()).unwrap().status, "ready");
    assert_eq!(surface.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn observation_completion_releases_bridge_locks_before_desktop_focus_query() {
    let (bridge, surface) = bridge();
    bridge.set_observer_enabled(true).unwrap();
    let brief = bridge.checkpoint(snapshot()).unwrap().brief.unwrap();
    surface.calls.store(0, Ordering::SeqCst);
    let result = bridge
        .complete_observation(ObserverCompletion {
            observer_id: brief.observer_id,
            provider: Some(brief.provider),
            thought: None,
        })
        .unwrap();
    assert_eq!(result.status, "silent");
    assert_eq!(surface.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn checkpoint_cancellation_does_not_wait_for_desktop_focus() {
    let (bridge, surface) = bridge();
    let result = bridge
        .checkpoint(CheckpointRequest {
            source_id: "isolated-focus-probe".into(),
            snapshot: None,
        })
        .unwrap();
    assert_eq!(result.status, "cancelled");
    assert_eq!(surface.calls.load(Ordering::SeqCst), 0);
}

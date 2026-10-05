use crate::{codex, observer, task_target::TaskTargetRequest, Bridge, Headless};
use spellcast_core::{AgentEvent, BubbleRequest, SayRequest};

const THREAD: &str = "01a0ed4c-8ab2-7e73-a3ab-3c27522e5f71";
const SOURCE: &str = "codex:01a0ed4c-8ab2-7e73-a3ab-3c27522e5f71";
const OTHER: &str = "01a0ed4c-8ab2-7e73-a3ab-3c27522e5f72";
const THREAD_UPPER: &str = "01A0ED4C-8AB2-7E73-A3AB-3C27522E5F71";
const SOURCE_UPPER: &str = "CoDeX:01A0ED4C-8AB2-7E73-A3AB-3C27522E5F71";

fn binding(source: &str, thread: &str) -> codex::CodexBinding {
    codex::CodexBinding {
        source_id: source.into(), thread_id: thread.into(), cwd: "G:/isolated-project".into(),
        label: "Original task".into(), executable: std::path::PathBuf::from("missing-test-codex-executable"),
        protocol_agent: "codex".into(), bound_at_ms: 1,
    }
}

fn bridge_with_binding(source: &str, thread: &str) -> Bridge {
    let bridge = Bridge::new(Headless, 0);
    bridge.update(|state| { state.bindings.push(binding(source, thread)); Ok(()) }).unwrap();
    bridge
}

#[test]
fn binding_lookup_is_exact_first_and_only_same_uuid() {
    for (caller, bound) in [(THREAD, SOURCE), (SOURCE, THREAD)] {
        let bindings = vec![binding(bound, THREAD)];
        assert_eq!(codex::binding_for_source(&bindings, caller).unwrap().source_id, bound);
        assert!(codex::binding_for_source(&bindings, "arbitrary-task").is_none());
        assert!(codex::binding_for_source(&bindings, OTHER).is_none());
        assert!(codex::binding_for_source(&bindings, &format!("codex:{OTHER}")).is_none());
    }
    let mut bindings = vec![binding(SOURCE, THREAD), binding(THREAD, THREAD)];
    assert_eq!(codex::binding_for_source(&bindings, THREAD).unwrap().source_id, THREAD);
    bindings[1].thread_id = OTHER.into();
    assert!(codex::binding_for_source(&bindings, THREAD).is_none());
    assert!(codex::binding_for_source(&[binding(SOURCE, OTHER)], THREAD).is_none());
    assert!(codex::binding_for_source(&[], THREAD).is_none());
    assert!(codex::same_source("arbitrary-task", "arbitrary-task"));
    assert!(!codex::same_source("arbitrary-task", "codex:arbitrary-task"));
    for invalid in ["01a0ed4c8ab27e73a3ab3c27522e5f71", "{01a0ed4c-8ab2-7e73-a3ab-3c27522e5f71}", "codex:codex:01a0ed4c-8ab2-7e73-a3ab-3c27522e5f71"] {
        assert!(codex::source_thread_id(invalid).is_none());
    }
}

#[test]
fn source_case_variants_share_only_the_strict_uuid_identity() {
    for caller in [THREAD, SOURCE, THREAD_UPPER, SOURCE_UPPER] {
        for bound in [THREAD, SOURCE, THREAD_UPPER, SOURCE_UPPER] {
            let bindings = vec![binding(bound, THREAD)];
            assert!(codex::same_source(caller, bound));
            assert_eq!(codex::binding_for_source(&bindings, caller).unwrap().source_id, bound);
            let mut event = AgentEvent::new("say").source(Some(bound.into()));
            assert!(codex::event_for_source(&event, caller, &bindings));
            event.target_thread_id = Some(THREAD_UPPER.into());
            assert!(codex::event_for_source(&event, caller, &[]));
            if caller != bound {
                event.target_thread_id = Some(OTHER.into());
                assert!(!codex::event_for_source(&event, caller, &bindings));
            }
        }
        assert!(codex::binding_for_source(&[binding(SOURCE_UPPER, OTHER)], caller).is_none());
    }
    for invalid in [format!("CoDeX:codex:{THREAD}"), format!("CODEX:{{{THREAD}}}"), format!("CODEX:{THREAD} "), format!("codex:{THREAD}-"), "codéx:01a0ed4c-8ab2-7e73-a3ab-3c27522e5f71".into()] {
        assert!(codex::source_thread_id(&invalid).is_none());
        assert!(!codex::same_source(&invalid, THREAD));
    }
}

#[test]
fn capture_and_bubble_keep_original_source_without_creating_binding() {
    for (caller, bound) in [(THREAD, SOURCE), (SOURCE, THREAD)] {
        let bridge = bridge_with_binding(bound, THREAD);
        let brief = observer::ObserverBrief {
            observer_id: "test-only".into(), source_id: caller.into(), provider: "codex".into(),
            locale: "zh-CN".into(), expires_at_ms: u64::MAX,
            snapshot: observer::ProjectSnapshot { checkpoint_id: "test".into(), project: "project".into(),
                goal: "goal".into(), change: "change".into(), facts: vec![] },
        };
        let capture = bridge.capture_from_brief(&brief);
        assert_eq!(brief.source_id, caller);
        assert_eq!(capture.source_id, caller);
        assert_eq!(capture.thread_id.as_deref(), Some(THREAD));
        assert_eq!(capture.cwd.as_deref(), Some("G:/isolated-project"));
        let outcome = bridge.bubble_now_captured(BubbleRequest { source_id: Some(caller.into()), tease: "Test".into(), ..Default::default() }, Some(capture.clone())).unwrap();
        assert_eq!(outcome.bubble.source_id.as_deref(), Some(caller));
        assert_eq!(outcome.bubble.captured_context, Some(capture));
        assert_eq!(bridge.feedback_state(None).bindings.len(), 1);
        assert_eq!(bridge.feedback_state(None).bindings[0].source_id, bound);
    }
}

#[tokio::test]
async fn aliased_feedback_listen_read_and_ack_preserve_event_source() {
    for (caller, bound) in [(THREAD, SOURCE), (SOURCE, THREAD), (SOURCE_UPPER, THREAD), (THREAD_UPPER, SOURCE)] {
        let bridge = bridge_with_binding(bound, THREAD);
        let event = bridge.say(SayRequest { text: "Test request".into(), source_id: Some(caller.into()), target_thread_id: Some(THREAD.into()), ..Default::default() }).unwrap();
        assert_eq!(event.source_id.as_deref(), Some(caller));
        assert_eq!(event.target_thread_id.as_deref(), Some(THREAD));
        let receipt = bridge.feedback_state(Some(bound)).deliveries.remove(0);
        assert!(receipt.notice.contains("Original task"));
        assert!(receipt.notice.contains(caller));
        assert_eq!(bridge.pending_feedback(Some(bound))[0].source_id.as_deref(), Some(caller));
        let (events, _) = bridge.listen_scoped(0, 0, Some(bound)).await;
        assert!(events.iter().any(|item| item.seq == event.seq && item.source_id.as_deref() == Some(caller)));
        let read = bridge.read_feedback_request(bound, event.seq).unwrap();
        assert_eq!(read["source_id"], bound);
        assert_eq!(read["events"][0]["source_id"], caller);
        assert_eq!(bridge.feedback_state(Some(bound)).deliveries[0].phase, crate::feedback::DeliveryPhase::Received);
        bridge.unbind_codex(bound).unwrap();
        assert_eq!(bridge.acknowledge_feedback(bound, &[event.seq]).unwrap(), 1);
        assert_eq!(bridge.feedback_state(Some(bound)).deliveries[0].phase, crate::feedback::DeliveryPhase::Handled);
    }
}

#[test]
fn alias_consumption_requires_captured_thread_or_a_valid_binding() {
    let mut event = AgentEvent::new("say").source(Some(THREAD.into()));
    assert!(!codex::event_for_source(&event, SOURCE, &[]));
    assert!(codex::event_for_source(&event, SOURCE, &[binding(SOURCE, THREAD)]));
    assert!(!codex::event_for_source(&event, SOURCE, &[binding(SOURCE, OTHER)]));
    event.target_thread_id = Some(THREAD.into());
    assert!(codex::event_for_source(&event, SOURCE, &[]));
    event.target_thread_id = Some(OTHER.into());
    assert!(!codex::event_for_source(&event, SOURCE, &[binding(SOURCE, THREAD)]));
    assert!(!codex::event_for_source(&event, "arbitrary-task", &[binding("arbitrary-task", THREAD)]));
}

#[tokio::test]
async fn mismatched_binding_and_unrelated_feedback_cannot_route() {
    let bridge = bridge_with_binding(SOURCE, OTHER);
    assert!(bridge.say(SayRequest { text: "Guard".into(), source_id: Some(THREAD.into()), target_thread_id: Some(OTHER.into()), ..Default::default() }).is_err());
    assert!(bridge.say(SayRequest { text: "Guard".into(), source_id: Some(SOURCE.into()), target_thread_id: Some(OTHER.into()), ..Default::default() }).is_err());
    let status = bridge.task_target_status(TaskTargetRequest { source_id: SOURCE.into(), thread_id: None, cwd: None, host_pin: None }).await.unwrap();
    assert_eq!(status.status, "changed");
    assert_eq!(status.source_id, SOURCE);
    assert_eq!(status.thread_id.as_deref(), Some(THREAD));
    assert!(status.label.is_empty());
    let event = bridge.say(SayRequest { text: "Retain unlinked".into(), source_id: Some(THREAD.into()), ..Default::default() }).unwrap();
    assert!(event.target_thread_id.is_none());
    assert!(bridge.pending_feedback(Some(SOURCE)).is_empty());
    assert!(bridge.pending_feedback(Some("arbitrary-task")).is_empty());
    assert!(bridge.acknowledge_feedback(SOURCE, &[event.seq]).is_err());
    assert_eq!(bridge.read_feedback_request(SOURCE, event.seq).unwrap()["status"], "not_pending");
}

#[tokio::test]
async fn task_status_uses_alias_metadata_and_preserves_requested_source() {
    for (caller, bound) in [(THREAD, SOURCE), (SOURCE, THREAD), (SOURCE_UPPER, THREAD), (THREAD_UPPER, SOURCE)] {
        let bridge = bridge_with_binding(bound, THREAD);
        let status = bridge.task_target_status(TaskTargetRequest { source_id: caller.into(), thread_id: None, cwd: None, host_pin: None }).await.unwrap();
        assert_eq!(status.source_id, caller);
        assert_eq!(status.thread_id.as_deref(), Some(THREAD));
        assert_eq!(status.label, "Original task");
        // The intentionally missing executable proves metadata selected the alias
        // binding, without contacting the installed Codex or a real user task.
        assert_eq!(status.status, "unknown");
        let empty = Bridge::new(Headless, 0).task_target_status(TaskTargetRequest { source_id: caller.into(), thread_id: None, cwd: None, host_pin: None }).await.unwrap();
        assert_eq!(empty.status, "unlinked");
    }
}

#[tokio::test]
async fn task_status_conflicts_keep_encoded_target_and_hide_other_labels() {
    for caller in [THREAD, SOURCE, THREAD_UPPER, SOURCE_UPPER] {
        let expected = codex::source_thread_id(caller).unwrap();
        let bridge = bridge_with_binding(caller, OTHER);
        bridge.update(|state| { state.bindings.push(binding(if caller == THREAD { SOURCE } else { THREAD }, THREAD)); Ok(()) }).unwrap();
        let status = bridge.task_target_status(TaskTargetRequest { source_id: caller.into(), thread_id: None, cwd: None, host_pin: None }).await.unwrap();
        assert_eq!(status.status, "changed");
        assert_eq!(status.source_id, caller);
        assert_eq!(status.thread_id.as_deref(), Some(expected));
        assert!(status.label.is_empty());

        // Conflicting captured identity blocks before either an alias executable
        // or the installed Codex can be queried, including an entirely unbound source.
        for bridge in [bridge_with_binding(SOURCE, THREAD), Bridge::new(Headless, 0)] {
            let status = bridge.task_target_status(TaskTargetRequest { source_id: caller.into(), thread_id: Some(OTHER.into()), cwd: None, host_pin: None }).await.unwrap();
            assert_eq!(status.status, "changed");
            assert_eq!(status.source_id, caller);
            assert_eq!(status.thread_id.as_deref(), Some(expected));
            assert!(status.label.is_empty());
        }
    }
}

#[tokio::test]
async fn encoded_identity_cannot_be_explicitly_bound_to_another_thread() {
    let error = codex::verify_binding(SOURCE.into(), OTHER.into(), None).await.unwrap_err();
    assert!(!error.uncertain);
    assert!(error.message.contains("UUID"));
}

#[tokio::test]
async fn dispatch_and_retry_never_send_to_a_changed_thread() {
    for (caller, bound) in [(THREAD, SOURCE), (SOURCE, THREAD)] {
        let bridge = bridge_with_binding(bound, THREAD);
        let event = bridge.say(SayRequest { text: "Keep original target".into(), source_id: Some(caller.into()), ..Default::default() }).unwrap();
        bridge.update(|state| {
            state.deliveries.iter_mut().find(|receipt| receipt.event.seq == event.seq).unwrap().event.target_thread_id = Some(OTHER.into());
            Ok(())
        }).unwrap();
        bridge.dispatch_feedback(event.seq, false).await.unwrap();
        let failed = bridge.feedback_state(Some(caller)).deliveries.remove(0);
        assert_eq!(failed.phase, crate::feedback::DeliveryPhase::Failed);
        assert!(failed.desktop.is_none());
        assert!(failed.attempted_at_ms.is_none());
        assert!(failed.error.as_deref().unwrap().contains("没有改投"));
        let retry = bridge.retry_feedback(event.seq).await.unwrap();
        assert_eq!(retry.phase, crate::feedback::DeliveryPhase::Waiting);
        bridge.dispatch_feedback(event.seq, false).await.unwrap();
        assert_eq!(bridge.feedback_state(Some(caller)).deliveries[0].phase, crate::feedback::DeliveryPhase::Failed);

        let bridge = bridge_with_binding(bound, OTHER);
        let event = bridge.say(SayRequest { text: "No route".into(), source_id: Some(caller.into()), ..Default::default() }).unwrap();
        assert!(bridge.dispatch_feedback(event.seq, false).await.is_err());
        let receipt = bridge.feedback_state(Some(caller)).deliveries.remove(0);
        assert!(receipt.desktop.is_none());
        assert!(receipt.attempted_at_ms.is_none());
    }
}

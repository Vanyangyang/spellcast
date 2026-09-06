use super::*;
use spellcast_core::{ReplyBlock, ReplyOption};

fn request(id: &str, source: &str) -> ReplyRequest {
    ReplyRequest {
        id: Some(id.into()),
        source_id: source.into(),
        source_label: Some("Astra".into()),
        origin_node_id: None,
        title: "雨声解谜".into(),
        expected_revision: None,
        blocks: vec![ReplyBlock::Comparison {
            id: "choices".into(),
            title: "选一条方向".into(),
            criteria: vec!["体验".into()],
            options: vec![
                ReplyOption {
                    id: "a".into(),
                    title: "循声".into(),
                    summary: String::new(),
                    values: vec!["探索".into()],
                },
                ReplyOption {
                    id: "b".into(),
                    title: "节奏".into(),
                    summary: String::new(),
                    values: vec!["解码".into()],
                },
            ],
            selected_id: None,
        }],
    }
}

#[tokio::test]
async fn explicit_feedback_survives_event_churn_restart_and_source_acknowledgement() {
    let path = std::env::temp_dir().join(format!("spellcast-feedback-{}.sqlite3", new_id()));
    let sequence;
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bridge.write_reply(request("reply-a", "codex:a")).unwrap();
        bridge.write_reply(request("reply-b", "cursor:b")).unwrap();
        let (_, event) = bridge
            .reply_action(ReplyActionInput {
                reply_id: "reply-a".into(),
                block_id: "choices".into(),
                action: ReplyAction::Select,
                option_id: Some("b".into()),
                text: None,
            })
            .unwrap();
        sequence = event.seq;
        assert_eq!(event.source_id.as_deref(), Some("codex:a"));
        for _ in 0..270 {
            bridge.user_event(AgentEvent::new("expired")).unwrap();
        }
        let (events, _) = bridge.listen_scoped(999_999, 0, Some("codex:a")).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, sequence);
        assert!(bridge
            .listen_scoped(0, 0, Some("cursor:b"))
            .await
            .0
            .is_empty());
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        let (events, _) = bridge.listen_scoped(999_999, 0, Some("codex:a")).await;
        assert_eq!(events[0].option_id.as_deref(), Some("b"));
        assert!(bridge
            .acknowledge_feedback("cursor:b", &[sequence])
            .is_err());
        assert_eq!(
            bridge.acknowledge_feedback("codex:a", &[sequence]).unwrap(),
            1
        );
        assert_eq!(
            bridge.acknowledge_feedback("codex:a", &[sequence]).unwrap(),
            0
        );
        assert!(bridge.pending_feedback(None).is_empty());
        assert_eq!(bridge.board().replies.len(), 2);
    }
    let bridge = Bridge::open(Headless, 0, &path).unwrap();
    assert!(bridge.pending_feedback(None).is_empty());
    drop(bridge);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn agent_updates_are_not_misreported_as_user_input() {
    let bridge = Bridge::new(Headless, 0);
    let mut req = request("reply-a", "codex:a");
    req.blocks = vec![ReplyBlock::Text {
        id: "text".into(),
        title: String::new(),
        text: "initial".into(),
    }];
    bridge.write_reply(req).unwrap();
    let block = ReplyBlock::Text {
        id: "text".into(),
        title: String::new(),
        text: "agent update".into(),
    };
    assert!(bridge
        .patch_reply_from_source(
            "cursor:b",
            ReplyPatchRequest {
                reply_id: "reply-a".into(),
                expected_revision: 1,
                block: block.clone(),
                layout_only: false,
            }
        )
        .is_err());
    bridge
        .patch_reply_from_source(
            "codex:a",
            ReplyPatchRequest {
                reply_id: "reply-a".into(),
                expected_revision: 1,
                block: block.clone(),
                layout_only: false,
            },
        )
        .unwrap();
    assert!(bridge.pending_feedback(None).is_empty());
    bridge
        .patch_reply(ReplyPatchRequest {
            reply_id: "reply-a".into(),
            expected_revision: 2,
            block: ReplyBlock::Text {
                id: "text".into(),
                title: String::new(),
                text: "user edit".into(),
            },
            layout_only: false,
        })
        .unwrap();
    let pending = bridge.pending_feedback(Some("codex:a"));
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, "reply_edit");
    assert_eq!(pending[0].block_id.as_deref(), Some("text"));
}

#[tokio::test]
async fn adopted_bubble_keeps_its_source_and_free_nodes_do_not_inherit_an_unrelated_owner() {
    let bridge = Bridge::new(Headless, 0);
    let bubble = bridge
        .bubble(BubbleRequest {
            source_id: Some("codex:a".into()),
            tease: "让雨声成为线索".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .bubble;
    let (node, event) = bridge.keep(&bubble).unwrap();
    assert_eq!(node.source_id.as_deref(), Some("codex:a"));
    assert_eq!(event.source_id.as_deref(), Some("codex:a"));
    let reply = bridge
        .say(SayRequest {
            text: "展开这个想法".into(),
            node_id: Some(node.id),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(reply.source_id.as_deref(), Some("codex:a"));
    let free = bridge
        .add_node(NodeDraft {
            title: "无关的想法".into(),
            ..Default::default()
        })
        .unwrap();
    assert!(free.source_id.is_none());
}

#[test]
fn legacy_board_snapshots_gain_an_empty_reply_collection() {
    let board: BoardSnapshot = serde_json::from_value(serde_json::json!({
        "topic":"保留旧板","form":"constellation","form_reason":"","nodes":[],"edges":[],"messages":[]
    })).unwrap();
    assert_eq!(board.topic, "保留旧板");
    assert!(board.replies.is_empty());
}

#[tokio::test]
async fn ambient_admission_respects_focus_pause_duplicates_and_active_limit() {
    let (bridge, surface) = crate::tests::bridge();
    async fn send(bridge: &Bridge, tease: &str) -> BubbleOutcome {
        bridge
            .bubble(BubbleRequest {
                tease: tease.into(),
                ..Default::default()
            })
            .await
            .unwrap()
    }
    let first = send(&bridge, "One thought").await;
    assert_eq!(first.outcome, "accepted");
    assert_eq!(send(&bridge, "one   thought").await.outcome, "not_shown");
    let second = send(&bridge, "A second thought").await;
    assert_eq!(second.outcome, "accepted");
    assert_eq!(send(&bridge, "A third thought").await.outcome, "not_shown");
    bridge.expired(&first.bubble.id).unwrap();
    assert_eq!(send(&bridge, "A third thought").await.outcome, "accepted");
    surface
        .board_focused
        .store(true, std::sync::atomic::Ordering::SeqCst);
    bridge.set_surface("focus");
    assert_eq!(
        send(&bridge, "Focus blocks this").await.outcome,
        "not_shown"
    );
    bridge.set_surface("ambient");
    bridge.set_paused(true).unwrap();
    assert_eq!(
        send(&bridge, "Pause blocks this").await.outcome,
        "not_shown"
    );
    bridge.set_paused(false).unwrap();
    assert_eq!(send(&bridge, "Available again").await.outcome, "accepted");
    assert_eq!(surface.thrown.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn switching_to_another_app_resumes_bubbles_without_leaving_board_mode() {
    use std::sync::atomic::Ordering;
    let (bridge, surface) = crate::tests::bridge();
    bridge
        .add_node(NodeDraft {
            title: "Keep this thought".into(),
            ..Default::default()
        })
        .unwrap();
    let before = serde_json::to_value(bridge.board()).unwrap();
    surface.board_focused.store(true, Ordering::SeqCst);
    bridge.set_surface("focus");
    let send = || BubbleRequest {
        tease: "A task-related thought".into(),
        ..Default::default()
    };
    assert_eq!(bridge.bubble(send()).await.unwrap().outcome, "not_shown");

    // Alt-Tab does not change the user's selected board layout or content.
    surface.board_focused.store(false, Ordering::SeqCst);
    let status = bridge.status();
    assert_eq!(status.surface, "focus");
    assert!(!status.board_focused);
    assert_eq!(bridge.bubble(send()).await.unwrap().outcome, "accepted");
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);

    surface.board_focused.store(true, Ordering::SeqCst);
    assert!(bridge.board_in_focus());
    assert_eq!(
        bridge
            .bubble(BubbleRequest {
                tease: "Another thought".into(),
                ..Default::default()
            })
            .await
            .unwrap()
            .outcome,
        "not_shown"
    );
}

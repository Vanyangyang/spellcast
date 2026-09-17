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
                ReplyOption { image: None, artifact: None,
                    id: "a".into(),
                    title: "循声".into(),
                    summary: String::new(),
                    values: vec!["探索".into()],
                },
                ReplyOption { image: None, artifact: None,
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
            .reply_action(ReplyActionInput { anchors: vec![],
                object_id: None,
                request_id: None,
                reply_id: "reply-a".into(),
                block_id: "choices".into(),
                action: ReplyAction::Select,
                option_id: Some("b".into()),
                text: None,
                artifact_context: None,
            })
            .unwrap();
        assert_eq!(event.kind, "canvas_state");
        assert!(bridge.pending_feedback(None).is_empty());
        let object = bridge.board().canvas.objects.into_iter().find(|object| matches!(&object.content, spellcast_core::CanvasContent::Reply { id } if id == "reply-a")).unwrap();
        sequence = bridge.say(SayRequest { text: "按最终选择继续。".into(), source_id: Some("codex:a".into()),
            anchors: vec![spellcast_core::inbox::CanvasAnchor { target: None, image: None, artifact_reference: None, annotations: vec![], object_id: object.id, content_revision: object.content_revision, compositions: vec![], block_id: Some("choices".into()), selection: None, region: None, artifact: None, inputs: None }], ..Default::default() }).unwrap().seq;
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
        assert_eq!(events[0].text.as_deref(), Some("按最终选择继续。"));
        assert_eq!(events[0].anchors[0].content_revision, 2);
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
                object_id: None,
                request_id: None,
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
                object_id: None,
                request_id: None,
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
            object_id: None,
            request_id: None,
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
    assert!(pending.is_empty(), "Saving a user edit must not submit it to the task.");
    assert!(bridge.feedback_state(None).deliveries.is_empty());
    assert_eq!(bridge.board().replies[0].revision, 3);
}

#[tokio::test]
async fn choices_and_edits_stay_local_across_restart_until_final_send() {
    let path = std::env::temp_dir().join(format!("spellcast-final-send-{}.sqlite3", new_id()));
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bridge.write_reply(request("reply-a", "codex:a")).unwrap();
        let messages = bridge.board().messages.len();
        for (request_id, option, revision) in [("choose-a", "a", 2), ("same-choice", "a", 2), ("choose-b", "b", 3)] {
            let (reply, event) = bridge.reply_action(ReplyActionInput { anchors: vec![], object_id: None, request_id: Some(request_id.into()), reply_id: "reply-a".into(), block_id: "choices".into(), action: ReplyAction::Select, option_id: Some(option.into()), text: None, artifact_context: None }).unwrap();
            assert_eq!(reply.revision, revision); assert_eq!(event.kind, "canvas_state");
        }
        let mut changed = bridge.board().replies[0].blocks[0].clone();
        if let ReplyBlock::Comparison { title, .. } = &mut changed { *title = "最终选择".into(); }
        bridge.patch_reply(ReplyPatchRequest { object_id: None, request_id: Some("edit-final".into()), reply_id: "reply-a".into(), expected_revision: 3, block: changed, layout_only: false }).unwrap();
        assert_eq!(bridge.board().messages.len(), messages);
        assert!(bridge.pending_feedback(None).is_empty()); assert!(bridge.feedback_state(None).deliveries.is_empty());
        assert!(bridge.listen_scoped(0, 0, Some("codex:a")).await.0.is_empty());
        assert!(bridge.listen(0, 0).await.0.is_empty());
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        let board = bridge.board(); let object = board.canvas.objects.iter().find(|o| matches!(&o.content, spellcast_core::CanvasContent::Reply { id } if id == "reply-a")).unwrap();
        assert_eq!(object.content_revision, 4);
        assert!(matches!(&board.replies[0].blocks[0], ReplyBlock::Comparison { selected_id: Some(id), title, .. } if id == "b" && title == "最终选择"));
        assert!(bridge.listen_scoped(0, 0, Some("codex:a")).await.0.is_empty());
        let event = bridge.say(SayRequest { text: "提交最终状态。".into(), source_id: Some("codex:a".into()),
            anchors: vec![spellcast_core::inbox::CanvasAnchor { target: None, image: None, artifact_reference: None, annotations: vec![], object_id: object.id.clone(), content_revision: 4, compositions: vec![], block_id: Some("choices".into()), selection: None, region: None, artifact: None, inputs: None }], ..Default::default() }).unwrap();
        let heard = bridge.listen_scoped(0, 0, Some("codex:a")).await.0;
        assert_eq!(heard.len(), 1); assert_eq!(heard[0].seq, event.seq); assert_eq!(heard[0].anchors[0].content_revision, 4);
        assert_eq!(bridge.feedback_state(None).deliveries.len(), 1);
    }
    std::fs::remove_file(path).unwrap();
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

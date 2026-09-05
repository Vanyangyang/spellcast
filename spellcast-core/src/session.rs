use serde::{Deserialize, Serialize};

use crate::layout::place_nodes;
use crate::types::{
    new_id, BoardNode, BoardSnapshot, BubbleRequest, BubbleShape, BubbleSize, ChatMessage,
    FragmentWeight, NodeDraft, NodeKind, NodePatch, PokeAction, PresentPayload, PresentResult,
    ProposedNode, ProposedThrow, ScreenAim, SpellcastError, StageForm, ThrownBubble,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub board: BoardSnapshot,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            board: BoardSnapshot::default(),
        }
    }
}

impl Session {
    pub fn snapshot(&self) -> BoardSnapshot {
        self.board.clone()
    }

    pub fn set_form(&mut self, form: StageForm) {
        self.board.form = form;
        self.board.form_reason =
            format!("你改成了{}。碎片还在，只是换了一种看的方式。", form.label());
    }

    pub fn reset(&mut self) {
        self.board = BoardSnapshot::default();
    }

    pub fn add_node(&mut self, draft: NodeDraft) -> BoardNode {
        let title = draft.title.trim();
        let title = if title.is_empty() {
            "未命名碎片"
        } else {
            title
        };
        let proposal = ProposedNode {
            source_id: draft.source_id,
            title: title.into(),
            body: draft.body,
            kind: draft.kind,
            weight: draft.weight.or_else(|| Some("note".into())),
            ..Default::default()
        };
        let (mut nodes, edges) = place_nodes(&self.board.nodes, &[proposal], None);
        let mut node = nodes
            .pop()
            .expect("place_nodes always returns the new fragment");
        if let Some(x) = draft.x {
            node.x = x;
        }
        if let Some(y) = draft.y {
            node.y = y;
        }
        if let Some(z) = draft.z {
            node.z = z;
        }
        self.board.nodes.push(node.clone());
        self.board.edges.extend(edges);
        if self.board.topic.is_empty() {
            self.board.topic = node.title.clone();
        }
        node
    }

    pub fn patch_node(&mut self, id: &str, patch: NodePatch) -> Result<BoardNode, SpellcastError> {
        let node = self
            .board
            .nodes
            .iter_mut()
            .find(|n| n.id == id)
            .ok_or_else(|| SpellcastError::user("这块碎片不在板上。"))?;
        if let Some(title) = patch.title {
            let title = title.trim();
            if !title.is_empty() {
                node.title = crate::layout::clip(title, 160);
            }
        }
        if let Some(body) = patch.body {
            node.body = crate::layout::clip(&body, 64_000);
        }
        if let Some(kind) = patch.kind {
            node.kind = NodeKind::parse(&kind);
        }
        if let Some(weight) = patch.weight {
            node.weight = FragmentWeight::parse(&weight);
        }
        if let Some(x) = patch.x {
            node.x = x;
        }
        if let Some(y) = patch.y {
            node.y = y;
        }
        if let Some(z) = patch.z {
            node.z = z;
        }
        Ok(node.clone())
    }

    pub fn remove_node(&mut self, id: &str) -> Result<(), SpellcastError> {
        let before = self.board.nodes.len();
        self.board.nodes.retain(|n| n.id != id);
        if self.board.nodes.len() == before {
            return Err(SpellcastError::user("这块碎片不在板上。"));
        }
        self.board.edges.retain(|e| e.from != id && e.to != id);
        Ok(())
    }

    /// The agent's reply, in the shape it chose. `surface` is where the user is looking
    /// right now: bubbles are only resolved when the board is not already in front of them.
    pub fn present(
        &mut self,
        mut payload: PresentPayload,
        surface: &str,
    ) -> Result<PresentResult, SpellcastError> {
        if payload.nodes.is_empty() && payload.throws.as_ref().map_or(true, |t| t.is_empty()) {
            return Err(SpellcastError::user(
                "present 需要至少一粒 node，或至少一粒 throw。",
            ));
        }
        if payload.replace {
            self.board = BoardSnapshot::default();
        }
        for node in &mut payload.nodes {
            if node.source_id.is_none() {
                node.source_id = payload.source_id.clone();
            }
        }

        let focus = payload
            .focus_node_id
            .as_deref()
            .filter(|id| self.board.nodes.iter().any(|n| n.id == *id));

        let form = payload
            .form
            .as_deref()
            .map(StageForm::parse)
            .unwrap_or_else(|| {
                let sample = payload
                    .nodes
                    .iter()
                    .map(|n| format!("{} {}", n.title, n.body))
                    .collect::<Vec<_>>()
                    .join(" ");
                if sample.trim().is_empty() {
                    self.board.form
                } else {
                    StageForm::infer(&sample)
                }
            });

        let (nodes, edges) = place_nodes(&self.board.nodes, &payload.nodes, focus);
        self.board.nodes.extend(nodes.clone());
        self.board.edges.extend(edges.clone());
        if let Some(topic) = payload.topic.clone().filter(|t| !t.trim().is_empty()) {
            self.board.topic = topic;
        } else if self.board.topic.is_empty() {
            if let Some(first) = self.board.nodes.first() {
                self.board.topic = first.title.clone();
            }
        }
        self.board.form = form;
        self.board.form_reason = form.reason().to_string();
        if !payload.reply.trim().is_empty() {
            self.board.messages.push(ChatMessage {
                role: "assistant".into(),
                content: payload.reply.clone(),
            });
        }

        let throws = resolve_throws(&payload.throws, &nodes, surface);

        Ok(PresentResult {
            reply: payload.reply,
            topic: payload.topic,
            form,
            form_reason: self.board.form_reason.clone(),
            nodes,
            edges,
            throws,
            open: payload.open,
        })
    }

    /// One bubble on its own, thrown while the agent is busy with something else.
    pub fn bubble(&self, req: BubbleRequest) -> Result<ThrownBubble, SpellcastError> {
        if req.tease.trim().is_empty() {
            return Err(SpellcastError::user("气泡上得露出几个字：tease 不能为空。"));
        }
        let node = req
            .node_id
            .as_deref()
            .and_then(|id| self.board.nodes.iter().find(|n| n.id == id));
        let proposed = ProposedThrow {
            node: None,
            title: req.title.clone().or_else(|| node.map(|n| n.title.clone())),
            tease: req.tease.clone(),
            size: req.size.clone(),
            shape: req.shape.clone(),
            on_poke: req.on_poke.clone(),
            linger: req.linger,
            kind: req.kind.clone(),
            delay: Some(0),
            screen: req.screen.clone(),
        };
        let mut thrown = bind_throw(&proposed, &[], 0)
            .ok_or_else(|| SpellcastError::user("气泡上得露出几个字：tease 不能为空。"))?;
        thrown.source_id = req
            .source_id
            .clone()
            .or_else(|| node.and_then(|n| n.source_id.clone()));
        if let Some(node) = node {
            thrown.node_id = Some(node.id.clone());
            thrown.title = node.title.clone();
            if !node.body.is_empty() {
                thrown.body = crate::layout::clip(&node.body, BODY_MAX);
            }
            if req.kind.is_none() {
                thrown.kind = node.kind;
            }
        }
        if let Some(body) = req.body.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            thrown.body = crate::layout::clip(body, BODY_MAX);
        }
        // Body and kind may have changed above; an `auto` shape must see the final words.
        thrown.shape = BubbleShape::parse(req.shape.as_deref().unwrap_or("")).resolve(
            &thrown.tease,
            &thrown.title,
            &thrown.body,
            thrown.kind,
        );
        Ok(thrown)
    }

    /// The user said something for the agent. Kept on the board's aside log too.
    pub fn note_user(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.board.messages.push(ChatMessage {
            role: "user".into(),
            content: text.to_string(),
        });
    }

    pub fn import_transcript(&mut self, transcript: &str) -> Result<BoardSnapshot, SpellcastError> {
        let text = transcript.trim();
        if text.is_empty() {
            return Err(SpellcastError::user("把任何模型的对话贴进来。"));
        }
        let proposals = harvest_scraps(text);
        if proposals.is_empty() {
            return Err(SpellcastError::user("没读到可以放下的碎片。换一段再试。"));
        }
        let form = StageForm::infer(text);
        let (nodes, edges) = place_nodes(&self.board.nodes, &proposals, None);
        self.board.nodes.extend(nodes);
        self.board.edges.extend(edges);
        self.board.form = form;
        self.board.form_reason = "从已有对话里拣出碎点子，不再让它们埋在气泡里。".into();
        if self.board.topic.is_empty() {
            self.board.topic = crate::layout::clip(text, 24);
        }
        self.board.messages.push(ChatMessage {
            role: "user".into(),
            content: format!("导入对话（{} 字）", text.chars().count()),
        });
        self.board.messages.push(ChatMessage {
            role: "assistant".into(),
            content: format!(
                "拣出 {} 粒碎片，用{}看。",
                self.board.nodes.len(),
                form.label()
            ),
        });
        Ok(self.board.clone())
    }
}

const TEASE_MAX: usize = 120;
const BODY_MAX: usize = 400;

/// Only the agent's `throws` become bubbles. Nodes never imply bubbles.
fn resolve_throws(
    proposed: &Option<Vec<ProposedThrow>>,
    nodes: &[BoardNode],
    surface: &str,
) -> Vec<ThrownBubble> {
    if !surface.eq_ignore_ascii_case("ambient") {
        return vec![];
    }
    let Some(list) = proposed else {
        return vec![];
    };
    list.iter()
        .take(3)
        .enumerate()
        .filter_map(|(order, item)| bind_throw(item, nodes, order))
        .collect()
}

fn bind_throw(item: &ProposedThrow, nodes: &[BoardNode], order: usize) -> Option<ThrownBubble> {
    let node = item.node.and_then(|i| nodes.get(i)).or_else(|| {
        item.title.as_deref().and_then(|title| {
            let title = title.trim();
            nodes.iter().find(|n| n.title == title)
        })
    });
    let size = BubbleSize::parse(item.size.as_deref().unwrap_or(""));
    let on_poke = PokeAction::parse(item.on_poke.as_deref().unwrap_or(""));
    let kind = item
        .kind
        .as_deref()
        .map(NodeKind::parse)
        .or_else(|| node.map(|n| n.kind))
        .unwrap_or(NodeKind::Insight);
    let title = node
        .map(|n| n.title.clone())
        .or_else(|| item.title.clone())
        .unwrap_or_else(|| crate::layout::clip(&item.tease, TEASE_MAX));
    let title = crate::layout::clip(&title, 160);
    let body = node
        .map(|n| n.body.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| item.tease.clone());
    // The bubble grows to fit its words; these caps only stop a whole essay landing on the desk.
    let tease = if item.tease.trim().is_empty() {
        crate::layout::clip(&title, TEASE_MAX)
    } else {
        crate::layout::clip(item.tease.trim(), TEASE_MAX)
    };
    if tease.is_empty() {
        return None;
    }
    let body = crate::layout::clip(&body, BODY_MAX);
    let shape = BubbleShape::parse(item.shape.as_deref().unwrap_or(""))
        .resolve(&tease, &title, &body, kind);
    let linger = item.linger.unwrap_or(size.linger_secs()).clamp(8, 36);
    Some(ThrownBubble {
        id: new_id(),
        source_id: node.and_then(|n| n.source_id.clone()),
        node_id: node.map(|n| n.id.clone()),
        tease,
        title,
        body,
        kind,
        size,
        shape,
        on_poke,
        linger_ms: linger * 1000,
        delay_ms: item.delay.unwrap_or((order as u32) * 520),
        screen: ScreenAim::parse(item.screen.as_deref().unwrap_or("")),
    })
}

fn harvest_scraps(text: &str) -> Vec<ProposedNode> {
    let mut scraps = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        let line = strip_speaker(line);
        if line.chars().count() < 4 {
            continue;
        }
        for chunk in line.split(|c| "。！？!?；;\n".contains(c)) {
            let chunk = chunk.trim().trim_start_matches(['-', '•', '*', ' ']);
            let len = chunk.chars().count();
            if !(6..48).contains(&len) {
                continue;
            }
            if scraps.iter().any(|s: &ProposedNode| s.title == chunk) {
                continue;
            }
            scraps.push(ProposedNode {
                title: crate::layout::clip(chunk, 18),
                body: chunk.to_string(),
                kind: Some(guess_kind(chunk).into()),
                weight: Some("spark".into()),
                ..Default::default()
            });
            if scraps.len() >= 10 {
                return scraps;
            }
        }
    }
    if scraps.is_empty() {
        scraps.push(ProposedNode {
            id: Some(new_id()),
            title: crate::layout::clip(text, 16),
            body: crate::layout::clip(text, 120),
            kind: Some("idea".into()),
            weight: Some(FragmentWeight::Spark.as_str().into()),
            ..Default::default()
        });
    }
    scraps
}

fn strip_speaker(line: &str) -> &str {
    for prefix in [
        "User:",
        "user:",
        "Human:",
        "Assistant:",
        "AI:",
        "ChatGPT:",
        "Claude:",
        "Gemini:",
        "我：",
        "我:",
        "用户：",
        "用户:",
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    line
}

fn guess_kind(text: &str) -> &'static str {
    if text.contains('？')
        || text.contains('?')
        || text.starts_with("为什么")
        || text.starts_with("如何")
    {
        "question"
    } else if text.contains("风险") || text.contains("担心") || text.contains("怕") {
        "risk"
    } else if text.contains("应该") || text.contains("先做") || text.contains("下一步") {
        "action"
    } else {
        NodeKind::Idea.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(nodes: &[(&str, &str)]) -> PresentPayload {
        PresentPayload {
            reply: "旁白".into(),
            nodes: nodes
                .iter()
                .map(|(title, kind)| ProposedNode {
                    title: (*title).into(),
                    kind: Some((*kind).into()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn present_places_fragments_and_picks_a_form() {
        let mut session = Session::default();
        let mut p = payload(&[
            ("先做壳", "action"),
            ("再整理", "action"),
            ("然后发布", "action"),
        ]);
        p.form = Some("timeline".into());
        let res = session.present(p, "focus").unwrap();
        assert_eq!(res.nodes.len(), 3);
        assert_eq!(res.form, StageForm::Timeline);
        assert_eq!(session.board.nodes.len(), 3);
        assert!(res.throws.is_empty(), "focus never throws");
        assert_eq!(session.board.messages.len(), 1);
    }

    #[test]
    fn present_throws_only_what_the_agent_chose() {
        let mut session = Session::default();
        let mut p = payload(&[("A", "idea"), ("B", "question"), ("C", "risk")]);
        p.throws = Some(vec![ProposedThrow {
            node: Some(1),
            tease: "B?".into(),
            size: Some("whisper".into()),
            on_poke: Some("reply".into()),
            ..Default::default()
        }]);
        let res = session.present(p, "ambient").unwrap();
        assert_eq!(res.throws.len(), 1);
        assert_eq!(res.throws[0].title, "B");
        assert_eq!(res.throws[0].on_poke, PokeAction::Reply);
        assert_eq!(res.throws[0].size, BubbleSize::Whisper);
        assert!(res.throws[0].node_id.is_some());
    }

    #[test]
    fn present_without_throws_stays_quiet() {
        let mut session = Session::default();
        let res = session
            .present(payload(&[("A", "idea")]), "ambient")
            .unwrap();
        assert!(res.throws.is_empty());
    }

    #[test]
    fn present_replace_starts_over() {
        let mut session = Session::default();
        session
            .present(payload(&[("旧", "idea")]), "focus")
            .unwrap();
        let mut p = payload(&[("新", "idea")]);
        p.replace = true;
        session.present(p, "focus").unwrap();
        assert_eq!(session.board.nodes.len(), 1);
        assert_eq!(session.board.nodes[0].title, "新");
    }

    #[test]
    fn present_needs_something() {
        let mut session = Session::default();
        assert!(session.present(PresentPayload::default(), "focus").is_err());
    }

    #[test]
    fn bubble_binds_to_a_board_fragment() {
        let mut session = Session::default();
        let node = session.add_node(NodeDraft {
            title: "要不要顺手改测试".into(),
            body: "改了接口，测试还没跟。".into(),
            kind: Some("question".into()),
            ..Default::default()
        });
        let thrown = session
            .bubble(BubbleRequest {
                tease: "测试没跟".into(),
                node_id: Some(node.id.clone()),
                on_poke: Some("reply".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(thrown.node_id.as_deref(), Some(node.id.as_str()));
        assert_eq!(thrown.kind, NodeKind::Question);
        assert_eq!(thrown.body, "改了接口，测试还没跟。");
        assert_eq!(thrown.on_poke, PokeAction::Reply);
        assert_eq!(thrown.shape, BubbleShape::Speech);
    }

    #[test]
    fn bubble_keeps_its_whole_tease_and_picks_a_shape() {
        let session = Session::default();
        let long = "旧 Spellcast 卸不卸？留着的话下次开机可能又冒出来";
        let thrown = session
            .bubble(BubbleRequest {
                tease: long.into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(thrown.tease, long);
        assert_eq!(thrown.shape, BubbleShape::Pill);

        let word = session
            .bubble(BubbleRequest {
                tease: "测试没跟".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(word.shape, BubbleShape::Orb);

        let path = session
            .bubble(BubbleRequest {
                tease: "src-tauri/src/desktop.rs".into(),
                shape: Some("auto".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(path.shape, BubbleShape::Code);

        let forced = session
            .bubble(BubbleRequest {
                tease: "一个念头".into(),
                shape: Some("sticky".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(forced.shape, BubbleShape::Sticky);
    }

    #[test]
    fn bubble_needs_a_tease() {
        let session = Session::default();
        assert!(session.bubble(BubbleRequest::default()).is_err());
    }

    #[test]
    fn add_move_and_remove_fragment() {
        let mut session = Session::default();
        let node = session.add_node(NodeDraft {
            title: "自己放下的".into(),
            body: "不经过模型。".into(),
            x: Some(3.0),
            z: Some(-2.0),
            ..Default::default()
        });
        assert_eq!(session.board.nodes.len(), 1);
        assert_eq!(node.x, 3.0);
        session
            .patch_node(
                &node.id,
                NodePatch {
                    title: Some("改过了".into()),
                    x: Some(1.0),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(session.board.nodes[0].title, "改过了");
        session.remove_node(&node.id).unwrap();
        assert!(session.board.nodes.is_empty());
    }
}

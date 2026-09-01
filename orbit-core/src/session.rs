use crate::layout::place_nodes;
use crate::providers::complete;
use crate::types::{
    new_id, BoardNode, BoardSnapshot, BubbleSize, ChatMessage, ChatRequest, ChatResponse,
    FragmentWeight, NodeDraft, NodeKind, NodePatch, OrbitError, PokeAction, ProposedNode,
    ProposedThrow, ScreenAim, StageForm, ThrownBubble,
};

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
        self.board.form_reason = format!("你改成了{}。碎片还在，只是换了一种看的方式。", form.label());
    }

    pub fn reset(&mut self) {
        self.board = BoardSnapshot::default();
    }

    pub fn add_node(&mut self, draft: NodeDraft) -> BoardNode {
        let title = draft.title.trim();
        let title = if title.is_empty() { "未命名碎片" } else { title };
        let proposal = ProposedNode {
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

    pub fn patch_node(&mut self, id: &str, patch: NodePatch) -> Result<BoardNode, OrbitError> {
        let node = self
            .board
            .nodes
            .iter_mut()
            .find(|n| n.id == id)
            .ok_or_else(|| OrbitError::user("这块碎片不在板上。"))?;
        if let Some(title) = patch.title {
            let title = title.trim();
            if !title.is_empty() {
                node.title = crate::layout::clip(title, 22);
            }
        }
        if let Some(body) = patch.body {
            node.body = crate::layout::clip(&body, 180);
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

    pub fn remove_node(&mut self, id: &str) -> Result<(), OrbitError> {
        let before = self.board.nodes.len();
        self.board.nodes.retain(|n| n.id != id);
        if self.board.nodes.len() == before {
            return Err(OrbitError::user("这块碎片不在板上。"));
        }
        self.board.edges.retain(|e| e.from != id && e.to != id);
        Ok(())
    }

    pub async fn chat(&mut self, mut req: ChatRequest) -> Result<ChatResponse, OrbitError> {
        if req.messages.is_empty() {
            return Err(OrbitError::user("先说一句还没想完的话。"));
        }

        let focus_title = req.focus_node_id.as_deref().and_then(|id| {
            self.board
                .nodes
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.title.clone())
        });

        let last = req.messages.last().map(|m| m.content.clone()).unwrap_or_default();
        self.board.messages.push(ChatMessage {
            role: "user".into(),
            content: last,
        });

        if let Some(title) = &focus_title {
            if let Some(user) = req.messages.last_mut() {
                user.content = format!("围着已有碎片「{}」继续。\n\n{}", title, user.content);
            }
        }

        if !self.board.nodes.is_empty() {
            let inventory: Vec<String> = self
                .board
                .nodes
                .iter()
                .map(|n| format!("- [{}] {} ({})", n.id, n.title, n.kind.as_str()))
                .collect();
            req.messages.insert(
                0,
                ChatMessage {
                    role: "user".into(),
                    content: format!(
                        "板上已有碎片（可作 parent_id）：\n{}",
                        inventory.join("\n")
                    ),
                },
            );
        }

        let (payload, provider, model) = complete(&req, focus_title.as_deref()).await?;
        let form = payload
            .form
            .as_deref()
            .map(StageForm::parse)
            .unwrap_or_else(|| {
                StageForm::infer(
                    req.messages
                        .last()
                        .map(|m| m.content.as_str())
                        .unwrap_or(""),
                )
            });

        let focus = req.focus_node_id.as_deref();
        let (nodes, edges) = place_nodes(&self.board.nodes, &payload.nodes, focus);
        self.board.nodes.extend(nodes.clone());
        self.board.edges.extend(edges.clone());
        if let Some(topic) = payload.topic.clone() {
            self.board.topic = topic;
        } else if self.board.topic.is_empty() {
            if let Some(first) = self.board.nodes.first() {
                self.board.topic = first.title.clone();
            }
        }
        self.board.form = form;
        self.board.form_reason = form.reason().to_string();
        self.board.messages.push(ChatMessage {
            role: "assistant".into(),
            content: payload.reply.clone(),
        });

        let throws = resolve_throws(&payload.throws, &nodes, &req.surface);

        Ok(ChatResponse {
            reply: payload.reply,
            topic: payload.topic,
            form,
            form_reason: self.board.form_reason.clone(),
            nodes,
            edges,
            throws,
            provider,
            model,
        })
    }

    pub fn import_transcript(&mut self, transcript: &str) -> Result<BoardSnapshot, OrbitError> {
        let text = transcript.trim();
        if text.is_empty() {
            return Err(OrbitError::user("把别处已经在进行的对话贴进来。"));
        }
        let proposals = harvest_scraps(text);
        if proposals.is_empty() {
            return Err(OrbitError::user("没读到可以放下的碎片。换一段再试。"));
        }
        let form = StageForm::infer(text);
        let (nodes, edges) = place_nodes(&self.board.nodes, &proposals, None);
        self.board.nodes.extend(nodes);
        self.board.edges.extend(edges);
        self.board.form = form;
        self.board.form_reason = "从别处已经在进行的对话里拣出碎点子，摊到专注板上。".into();
        if self.board.topic.is_empty() {
            self.board.topic = crate::layout::clip(text, 24);
        }
        self.board.messages.push(ChatMessage {
            role: "user".into(),
            content: format!("导入对话（{} 字）", text.chars().count()),
        });
        self.board.messages.push(ChatMessage {
            role: "assistant".into(),
            content: format!("拣出 {} 粒碎片，用{}看。", self.board.nodes.len(), form.label()),
        });
        Ok(self.board.clone())
    }
}

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
    let node = item
        .node
        .and_then(|i| nodes.get(i))
        .or_else(|| {
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
        .unwrap_or_else(|| crate::layout::clip(&item.tease, 16));
    let body = node
        .map(|n| n.body.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| item.tease.clone());
    let tease = if item.tease.trim().is_empty() {
        crate::layout::clip(&title, size.tease_chars())
    } else {
        crate::layout::clip(item.tease.trim(), size.tease_chars())
    };
    if tease.is_empty() {
        return None;
    }
    let linger = item.linger.unwrap_or(size.linger_secs()).clamp(8, 36);
    Some(ThrownBubble {
        id: new_id(),
        node_id: node.map(|n| n.id.clone()),
        tease,
        title,
        body,
        kind,
        size,
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
        "User:", "user:", "Human:", "Assistant:", "AI:", "ChatGPT:", "Claude:", "Gemini:", "我：",
        "我:", "用户：", "用户:",
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    line
}

fn guess_kind(text: &str) -> &'static str {
    if text.contains('？') || text.contains('?') || text.starts_with("为什么") || text.starts_with("如何")
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

    #[tokio::test]
    async fn local_chat_scatters_fragments() {
        let mut session = Session::default();
        let res = session
            .chat(ChatRequest {
                messages: vec![ChatMessage {
                    role: "user".into(),
                    content: "做一块用空间碎片呈现的专注板".into(),
                }],
                provider: "preview".into(),
                ..empty_req()
            })
            .await
            .unwrap();
        assert!(!res.nodes.is_empty());
        assert!(!session.board.nodes.is_empty());
    }

    #[test]
    fn add_move_and_remove_fragment() {
        let mut session = Session::default();
        let node = session.add_node(NodeDraft {
            title: "自己放下的".into(),
            body: "自己放下。".into(),
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

    fn empty_req() -> ChatRequest {
        ChatRequest {
            messages: vec![],
            provider: "preview".into(),
            model: None,
            api_key: None,
            base_url: None,
            focus_node_id: None,
            locale: "zh-CN".into(),
            surface: "focus".into(),
            screen_count: None,
        }
    }

    #[tokio::test]
    async fn ambient_chat_returns_sparse_throws() {
        let mut session = Session::default();
        let res = session
            .chat(ChatRequest {
                messages: vec![ChatMessage {
                    role: "user".into(),
                    content: "做一块用空间碎片呈现的专注板".into(),
                }],
                provider: "preview".into(),
                surface: "ambient".into(),
                ..empty_req()
            })
            .await
            .unwrap();
        assert!(!res.nodes.is_empty());
        assert!(!res.throws.is_empty());
        assert!(res.throws.len() < res.nodes.len());
        assert!(res.throws.len() <= 3);
    }
}

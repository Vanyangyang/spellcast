use crate::types::{
    new_id, BoardEdge, BoardNode, EdgeRelation, FragmentWeight, NodeKind, ProposedNode,
};

const GOLDEN_ANGLE: f32 = 2.399_963_2;

pub fn place_nodes(
    existing: &[BoardNode],
    proposals: &[ProposedNode],
    focus_id: Option<&str>,
) -> (Vec<BoardNode>, Vec<BoardEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let start_index = existing.len();

    let layout_anchor = focus_id
        .and_then(|id| existing.iter().find(|n| n.id == id))
        .or_else(|| existing.last());

    for (i, proposal) in proposals.iter().enumerate() {
        if proposal.title.trim().is_empty() {
            continue;
        }
        let id = proposal
            .id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(new_id);
        if existing.iter().any(|n| n.id == id) || nodes.iter().any(|n: &BoardNode| n.id == id) {
            continue;
        }

        let explicit_parent = proposal.parent_id.as_deref().and_then(|pid| {
            existing
                .iter()
                .find(|n| n.id == pid)
                .or_else(|| nodes.iter().find(|n| n.id == pid))
        });
        let layout_parent = explicit_parent.or(layout_anchor);
        let (x, y, z) = orbit_point(layout_parent, start_index + i, existing.len() + i);
        let parent_id = explicit_parent.map(|n| n.id.clone());

        let weight = FragmentWeight::parse(proposal.weight.as_deref().unwrap_or("note"));
        let node = BoardNode {
            id: id.clone(),
            revision: 0,
            source_id: proposal.source_id.clone(),
            title: clip(&proposal.title, 160),
            body: clip(&proposal.body, 64_000),
            kind: NodeKind::parse(proposal.kind.as_deref().unwrap_or("idea")),
            weight,
            x,
            y,
            z,
            parent_id: parent_id.clone(),
            captured_context: None,
        };

        if let Some(pid) = parent_id {
            edges.push(BoardEdge {
                id: new_id(),
                from: pid,
                to: id,
                relation: EdgeRelation::Parent,
            });
        }

        nodes.push(node);
    }

    (nodes, edges)
}

fn orbit_point(parent: Option<&BoardNode>, index: usize, salt: usize) -> (f32, f32, f32) {
    let i = (index + salt * 3) as f32 + 1.0;
    let y = 1.0 - (i / (i + 8.0)) * 2.0;
    let radius_xy = (1.0 - y * y).max(0.08).sqrt();
    let theta = GOLDEN_ANGLE * i;
    let radius = 6.4 + ((index as f32) * 0.55).min(5.0);

    let (ox, oy, oz) = parent.map(|p| (p.x, p.y, p.z)).unwrap_or((0.0, 0.0, 0.0));

    let local_scale = if parent.is_some() { 0.72 } else { 1.0 };
    (
        ox + theta.cos() * radius_xy * radius * local_scale,
        oy + y * radius * 0.55 * local_scale,
        oz + theta.sin() * radius_xy * radius * local_scale,
    )
}

pub fn clip(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>()
        + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_unique_nodes_around_a_parent() {
        let parent = BoardNode {
            id: "root".into(),
            revision: 0,
            source_id: None,
            title: "主题".into(),
            body: String::new(),
            kind: NodeKind::Insight,
            weight: FragmentWeight::Anchor,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            parent_id: None,
            captured_context: None,
        };
        let proposals = vec![
            ProposedNode {
                title: "用户".into(),
                body: "谁在用".into(),
                kind: Some("question".into()),
                ..Default::default()
            },
            ProposedNode {
                title: "下一步".into(),
                body: "先做什么".into(),
                kind: Some("action".into()),
                ..Default::default()
            },
        ];
        let (nodes, edges) = place_nodes(&[parent], &proposals, Some("root"));
        assert_eq!(nodes.len(), 2);
        assert!(edges.is_empty());
        assert!(nodes.iter().all(|n| n.parent_id.is_none()));
        assert!(nodes.iter().all(|n| n.x.abs() + n.z.abs() > 0.5));
    }

    #[test]
    fn independent_keep_does_not_create_edges() {
        let existing = BoardNode {
            id: "a".into(),
            revision: 0,
            source_id: None,
            title: "已有".into(),
            body: String::new(),
            kind: NodeKind::Idea,
            weight: FragmentWeight::Note,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            parent_id: None,
            captured_context: None,
        };
        let (nodes, edges) = place_nodes(
            &[existing],
            &[ProposedNode {
                title: "独立采纳".into(),
                ..Default::default()
            }],
            None,
        );
        assert_eq!(nodes.len(), 1);
        assert!(edges.is_empty());
        assert!(nodes[0].parent_id.is_none());
    }

    #[test]
    fn explicit_parent_records_a_parent_edge() {
        let root = BoardNode {
            id: "root".into(),
            revision: 0,
            source_id: None,
            title: "根".into(),
            body: String::new(),
            kind: NodeKind::Idea,
            weight: FragmentWeight::Note,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            parent_id: None,
            captured_context: None,
        };
        let (nodes, edges) = place_nodes(
            &[root],
            &[ProposedNode {
                title: "子".into(),
                parent_id: Some("root".into()),
                ..Default::default()
            }],
            None,
        );
        assert_eq!(nodes[0].parent_id.as_deref(), Some("root"));
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from, "root");
        assert_eq!(edges[0].relation, EdgeRelation::Parent);
    }

    #[test]
    fn old_edge_json_is_unconfirmed_and_omits_the_field() {
        let edge: BoardEdge =
            serde_json::from_str(r#"{"id":"e1","from":"a","to":"b"}"#).unwrap();
        assert_eq!(edge.relation, EdgeRelation::Unconfirmed);
        let value = serde_json::to_value(&edge).unwrap();
        assert!(value.get("relation").is_none());
        let parent = BoardEdge {
            id: "e2".into(),
            from: "a".into(),
            to: "c".into(),
            relation: EdgeRelation::Parent,
        };
        assert_eq!(
            serde_json::to_value(&parent).unwrap()["relation"],
            "parent"
        );
    }
}

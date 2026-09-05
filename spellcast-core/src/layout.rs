use crate::types::{new_id, BoardEdge, BoardNode, FragmentWeight, NodeKind, ProposedNode};

const GOLDEN_ANGLE: f32 = 2.399_963_2;

pub fn place_nodes(
    existing: &[BoardNode],
    proposals: &[ProposedNode],
    focus_id: Option<&str>,
) -> (Vec<BoardNode>, Vec<BoardEdge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let start_index = existing.len();

    let parent = focus_id
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

        let parent_id = proposal
            .parent_id
            .clone()
            .or_else(|| parent.map(|p| p.id.clone()));
        let (x, y, z) = orbit_point(parent, start_index + i, existing.len() + i);

        let weight = FragmentWeight::parse(proposal.weight.as_deref().unwrap_or("note"));
        let node = BoardNode {
            id: id.clone(),
            source_id: proposal.source_id.clone(),
            title: clip(&proposal.title, 160),
            body: clip(&proposal.body, 64_000),
            kind: NodeKind::parse(proposal.kind.as_deref().unwrap_or("idea")),
            weight,
            x,
            y,
            z,
            parent_id: parent_id.clone(),
        };

        if let Some(pid) = parent_id {
            if existing.iter().any(|n| n.id == pid) || nodes.iter().any(|n| n.id == pid) {
                edges.push(BoardEdge {
                    id: new_id(),
                    from: pid,
                    to: id,
                });
            }
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
            source_id: None,
            title: "主题".into(),
            body: String::new(),
            kind: NodeKind::Insight,
            weight: FragmentWeight::Anchor,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            parent_id: None,
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
        assert_eq!(edges.len(), 2);
        assert!(nodes.iter().all(|n| n.x.abs() + n.z.abs() > 0.5));
    }
}

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Something the user did on the local Spellcast surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub seq: u64,
    pub at_ms: u64,
    /// poke | reply | kept | dismiss | expired | say | board_edit | cleared
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bubble_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Inbox {
    next: u64,
    events: VecDeque<AgentEvent>,
}

const CAP: usize = 256;

impl Inbox {
    pub fn push(&mut self, mut event: AgentEvent) -> AgentEvent {
        self.next += 1;
        event.seq = self.next;
        if event.at_ms == 0 {
            event.at_ms = now_ms();
        }
        self.events.push_back(event.clone());
        while self.events.len() > CAP {
            self.events.pop_front();
        }
        event
    }

    pub fn last_seq(&self) -> u64 {
        self.next
    }

    pub fn since(&self, seq: u64) -> Vec<AgentEvent> {
        self.events
            .iter()
            .filter(|e| e.seq > seq)
            .cloned()
            .collect()
    }

    /// Events about one bubble after `seq`. Used by a tool that waits for a reaction.
    pub fn for_bubble(&self, bubble_id: &str, seq: u64) -> Vec<AgentEvent> {
        self.events
            .iter()
            .filter(|e| e.seq > seq && e.bubble_id.as_deref() == Some(bubble_id))
            .cloned()
            .collect()
    }
}

impl AgentEvent {
    pub fn new(kind: &str) -> Self {
        Self {
            seq: 0,
            at_ms: 0,
            kind: kind.into(),
            source_id: None,
            reply_id: None,
            block_id: None,
            option_id: None,
            bubble_id: None,
            node_id: None,
            title: None,
            text: None,
        }
    }

    pub fn bubble(mut self, id: impl Into<String>) -> Self {
        self.bubble_id = Some(id.into());
        self
    }

    pub fn source(mut self, id: Option<String>) -> Self {
        self.source_id = id;
        self
    }

    pub fn node(mut self, id: Option<String>) -> Self {
        self.node_id = id;
        self
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn text(mut self, text: impl Into<String>) -> Self {
        let text = text.into();
        self.text = if text.trim().is_empty() {
            None
        } else {
            Some(text)
        };
        self
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_ordered_and_filterable() {
        let mut inbox = Inbox::default();
        inbox.push(AgentEvent::new("poke").bubble("a"));
        inbox.push(AgentEvent::new("say").text("hi"));
        inbox.push(AgentEvent::new("expired").bubble("a"));
        assert_eq!(inbox.last_seq(), 3);
        assert_eq!(inbox.since(1).len(), 2);
        assert_eq!(inbox.for_bubble("a", 0).len(), 2);
        assert_eq!(inbox.for_bubble("a", 1).len(), 1);
    }
}

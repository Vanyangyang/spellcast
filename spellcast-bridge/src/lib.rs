//! Shared application state behind the Spellcast desktop and its local REST adapter.

pub mod api;
pub mod mcp;
#[cfg(test)]
mod reply_tests;
mod store;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use spellcast_core::inbox::now_ms;
use spellcast_core::types::{
    new_id, BoardNode, BoardSnapshot, BubbleRequest, ImportRequest, MemoryItem, NodeDraft,
    NodePatch, PresentPayload, PresentResult, SayRequest, SetFormRequest, SpellcastError,
    StageForm, ThrownBubble,
};
use spellcast_core::{
    AgentEvent, BoardReply, Inbox, ReplyAction, ReplyActionInput, ReplyPatchRequest, ReplyRequest,
    Session,
};
use tokio::sync::Notify;

use store::Store;

pub const DEFAULT_PORT: u16 = 47194;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const TRUSTED_ORIGINS: [&str; 5] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://127.0.0.1:47193",
    "http://localhost:47193",
];

/// Where bubbles and the board actually appear. The desktop app implements this with
/// real OS windows; the headless preview server implements it with nothing.
pub trait Surface: Send + Sync + 'static {
    /// A client reached the bridge; update the desktop connection indicator.
    fn agent_seen(&self, client: &str);
    /// Schedule these bubbles. "ready" events confirm page readiness separately.
    fn throw(&self, bubbles: &[ThrownBubble]) -> Result<usize, String>;
    /// The agent changed the board.
    fn presented(&self, result: &PresentResult);
    /// Something changed the board (user or agent); repaint.
    fn board_changed(&self);
    fn close_bubbles(&self);
    /// Bring the board forward, in focus mode.
    fn focus(&self);
    fn screen_count(&self) -> u32 {
        1
    }
}

/// A surface for environments without a desktop (tests, `npm start` preview).
pub struct Headless;

impl Surface for Headless {
    fn agent_seen(&self, _client: &str) {}
    fn throw(&self, _bubbles: &[ThrownBubble]) -> Result<usize, String> {
        Err("Spellcast 桌面没在跑：气泡是操作系统小窗，这里没有桌面可抛。".into())
    }
    fn presented(&self, _result: &PresentResult) {}
    fn board_changed(&self) {}
    fn close_bubbles(&self) {}
    fn focus(&self) {}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentAgent {
    pub client: String,
    pub last_call_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentSource {
    pub id: String,
    pub label: String,
    pub last_call_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Status {
    /// ambient | focus — where the user is looking right now.
    pub surface: String,
    pub port: u16,
    pub client: Option<String>,
    pub last_call_ms: u64,
    pub calls: u64,
    #[serde(default)]
    pub agents: Vec<RecentAgent>,
    #[serde(default)]
    pub sources: Vec<RecentSource>,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleOutcome {
    pub bubble: ThrownBubble,
    /// accepted | poked | replied | dismissed | expired | pending | not_shown
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<AgentEvent>,
    pub last_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PersistedState {
    session: Session,
    inbox: Inbox,
    kept: HashMap<String, String>,
    #[serde(default)]
    memories: Vec<MemoryItem>,
    /// Explicit feedback is retained until its originating task acknowledges it.
    #[serde(default)]
    pending: Vec<AgentEvent>,
    #[serde(skip)]
    bubble_sources: HashMap<String, String>,
    #[serde(default)]
    paused: bool,
}

#[derive(Default)]
struct Admission {
    active: HashSet<String>,
    recent: VecDeque<(String, u64)>,
}

impl PersistedState {
    fn source_for(&self, event: &AgentEvent) -> Option<String> {
        event
            .reply_id
            .as_deref()
            .and_then(|id| self.session.board.replies.iter().find(|r| r.id == id))
            .map(|r| r.source_id.clone())
            .or_else(|| {
                event
                    .node_id
                    .as_deref()
                    .and_then(|id| self.session.board.nodes.iter().find(|n| n.id == id))
                    .and_then(|n| n.source_id.clone())
            })
            .or_else(|| {
                event
                    .bubble_id
                    .as_ref()
                    .and_then(|id| self.bubble_sources.get(id).cloned())
            })
            .or_else(|| event.source_id.clone())
    }

    fn record(&mut self, mut event: AgentEvent) -> AgentEvent {
        event.source_id = self.source_for(&event);
        let important = matches!(
            event.kind.as_str(),
            "reply" | "say" | "kept" | "unkept" | "selection" | "reply_edit"
        );
        let event = self.inbox.push(event);
        if important {
            self.pending.push(event.clone());
        }
        event
    }

    fn feedback(&self, since: u64, source_id: Option<&str>) -> Vec<AgentEvent> {
        let mut events = self.inbox.since(since);
        events.extend(self.pending.iter().cloned());
        events.retain(|e| {
            source_id.map_or(true, |id| {
                e.source_id.as_deref() == Some(id)
                    || (e.source_id.is_none()
                        && matches!(e.kind.as_str(), "cleared" | "board_edit"))
            })
        });
        events.sort_by_key(|e| e.seq);
        events.dedup_by_key(|e| e.seq);
        events.truncate(512);
        events
    }
}

pub struct Bridge {
    state: Mutex<PersistedState>,
    store: Option<Mutex<Store>>,
    status: Mutex<Status>,
    notify: Notify,
    surface: Box<dyn Surface>,
    admission: Mutex<Admission>,
}

impl Bridge {
    pub fn new(surface: impl Surface, port: u16) -> Self {
        Self::from_parts(surface, port, PersistedState::default(), None)
    }

    pub fn open(surface: impl Surface, port: u16, path: impl AsRef<Path>) -> Result<Self, String> {
        let mut store = Store::open(path.as_ref())?;
        let state: PersistedState = store.load()?.unwrap_or_default();
        store.reindex(&state.memories)?;
        Ok(Self::from_parts(surface, port, state, Some(store)))
    }

    fn from_parts(
        surface: impl Surface,
        port: u16,
        state: PersistedState,
        store: Option<Store>,
    ) -> Self {
        Self {
            state: Mutex::new(state),
            store: store.map(Mutex::new),
            status: Mutex::new(Status {
                surface: "ambient".into(),
                port,
                client: None,
                last_call_ms: 0,
                calls: 0,
                agents: Vec::new(),
                sources: Vec::new(),
                paused: false,
            }),
            notify: Notify::new(),
            surface: Box::new(surface),
            admission: Mutex::new(Admission::default()),
        }
    }

    fn update<R>(
        &self,
        change: impl FnOnce(&mut PersistedState) -> Result<R, SpellcastError>,
    ) -> Result<R, SpellcastError> {
        let mut current = self.state.lock().unwrap();
        let mut next = current.clone();
        let result = change(&mut next)?;
        if let Some(store) = &self.store {
            store
                .lock()
                .unwrap()
                .save(&next, &next.memories)
                .map_err(|err| {
                    SpellcastError::user(format!("Spellcast 没能保存这次改动：{err}"))
                })?;
        }
        *current = next;
        Ok(result)
    }

    pub fn status(&self) -> Status {
        let mut status = self.status.lock().unwrap().clone();
        status.paused = self.state.lock().unwrap().paused;
        status
    }

    pub fn set_paused(&self, paused: bool) -> Result<Status, SpellcastError> {
        self.update(|state| {
            state.paused = paused;
            Ok(())
        })?;
        if paused {
            self.close_bubbles();
        }
        Ok(self.status())
    }

    pub fn close_bubbles(&self) {
        self.admission.lock().unwrap().active.clear();
        self.surface.close_bubbles();
    }

    fn dispatch(&self, bubbles: &[ThrownBubble]) -> Result<usize, String> {
        if self.state.lock().unwrap().paused || self.status.lock().unwrap().surface == "focus" {
            return Ok(0);
        }
        let now = now_ms();
        let admitted = {
            let mut gate = self.admission.lock().unwrap();
            while gate
                .recent
                .front()
                .is_some_and(|(_, at)| now.saturating_sub(*at) > 90_000)
            {
                gate.recent.pop_front();
            }
            let mut admitted = Vec::new();
            for bubble in bubbles {
                let key = bubble
                    .tease
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase();
                if gate.active.len() >= 2 || gate.recent.iter().any(|(old, _)| old == &key) {
                    continue;
                }
                gate.active.insert(bubble.id.clone());
                gate.recent.push_back((key, now));
                admitted.push(bubble.clone());
            }
            admitted
        };
        if admitted.is_empty() {
            return Ok(0);
        }
        // This mapping is transient, unlike explicit feedback and adopted nodes.
        {
            let mut state = self.state.lock().unwrap();
            for bubble in &admitted {
                if let Some(source) = &bubble.source_id {
                    state
                        .bubble_sources
                        .insert(bubble.id.clone(), source.clone());
                }
            }
        }
        match self.surface.throw(&admitted) {
            Ok(count) => {
                let count = count.min(admitted.len());
                let mut gate = self.admission.lock().unwrap();
                let mut state = self.state.lock().unwrap();
                for bubble in admitted.iter().skip(count) {
                    gate.active.remove(&bubble.id);
                    state.bubble_sources.remove(&bubble.id);
                }
                Ok(count)
            }
            Err(error) => {
                let mut gate = self.admission.lock().unwrap();
                let mut state = self.state.lock().unwrap();
                for bubble in &admitted {
                    gate.active.remove(&bubble.id);
                    state.bubble_sources.remove(&bubble.id);
                }
                Err(error)
            }
        }
    }

    fn identify_source(&self, id: &str, label: Option<&str>) -> Result<String, SpellcastError> {
        spellcast_core::reply::validate_id(id)?;
        let mut status = self.status.lock().unwrap();
        let label = label
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                status
                    .sources
                    .iter()
                    .find(|s| s.id == id)
                    .map(|s| s.label.clone())
            })
            .or_else(|| status.client.clone())
            .unwrap_or_else(|| "Agent".into());
        if label.chars().count() > 160 {
            return Err(SpellcastError::user("来源名称太长。"));
        }
        status.sources.retain(|source| source.id != id);
        status.sources.insert(
            0,
            RecentSource {
                id: id.into(),
                label: label.clone(),
                last_call_ms: now_ms(),
            },
        );
        status.sources.truncate(16);
        Ok(label)
    }

    pub fn identify_client(&self, name: &str, version: &str) {
        let label = if version.is_empty() {
            name.to_string()
        } else {
            format!("{name} {version}")
        };
        let mut status = self.status.lock().unwrap();
        let now = now_ms();
        status.client = Some(label.clone());
        status.last_call_ms = now;
        status.agents.retain(|agent| agent.client != label);
        status.agents.insert(
            0,
            RecentAgent {
                client: label,
                last_call_ms: now,
            },
        );
        status.agents.truncate(8);
    }

    pub fn set_surface(&self, surface: &str) -> Status {
        let focus = surface.eq_ignore_ascii_case("focus");
        {
            let mut st = self.status.lock().unwrap();
            st.surface = if focus {
                "focus".into()
            } else {
                "ambient".into()
            };
        }
        if focus {
            self.close_bubbles();
        }
        self.status()
    }

    fn touch(&self, client: Option<&str>) {
        let label = {
            let mut status = self.status.lock().unwrap();
            status.last_call_ms = now_ms();
            status.calls = status.calls.saturating_add(1);
            if let Some(client) = client {
                status.client = Some(client.to_string());
            }
            status.client.clone().unwrap_or_else(|| "Agent".into())
        };
        self.surface.agent_seen(&label);
    }

    pub fn hello(&self, client: &str) {
        self.touch(Some(client));
    }

    pub fn hello_quiet(&self) {
        self.touch(None);
    }

    // ---- what the agent does -------------------------------------------------

    pub fn present(&self, payload: PresentPayload) -> Result<PresentResult, SpellcastError> {
        if let Some(source) = &payload.source_id {
            self.identify_source(source, None)?;
        }
        self.hello_quiet();
        let surface = self.status.lock().unwrap().surface.clone();
        let result = self.update(|state| {
            let replace = payload.replace;
            let result = state.session.present(payload, &surface)?;
            if replace {
                state.kept.clear();
            }
            Ok(result)
        })?;
        if !result.throws.is_empty() {
            if let Err(err) = self.dispatch(&result.throws) {
                tracing::warn!("throw failed: {err}");
            }
        }
        self.surface.presented(&result);
        if result.open {
            self.surface.focus();
        }
        Ok(result)
    }

    pub async fn bubble(&self, req: BubbleRequest) -> Result<BubbleOutcome, SpellcastError> {
        if let Some(source) = &req.source_id {
            self.identify_source(source, None)?;
        }
        self.hello_quiet();
        let wait = req.wait.unwrap_or(0).min(120);
        let (bubble, since) = {
            let state = self.state.lock().unwrap();
            (state.session.bubble(req)?, state.inbox.last_seq())
        };
        let shown = match self.dispatch(std::slice::from_ref(&bubble)) {
            Ok(n) => n > 0,
            Err(err) => {
                return Ok(BubbleOutcome {
                    bubble,
                    outcome: "not_shown".into(),
                    text: Some(err),
                    events: vec![],
                    last_seq: since,
                });
            }
        };
        if !shown || wait == 0 {
            return Ok(BubbleOutcome {
                bubble,
                outcome: if shown { "accepted" } else { "not_shown" }.into(),
                text: None,
                events: vec![],
                last_seq: since,
            });
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(u64::from(wait));
        loop {
            let notified = self.notify.notified();
            let events = self
                .state
                .lock()
                .unwrap()
                .inbox
                .for_bubble(&bubble.id, since);
            if let Some(done) = settle(&events) {
                let last_seq = events.last().map(|e| e.seq).unwrap_or(since);
                return Ok(BubbleOutcome {
                    bubble,
                    outcome: done.0,
                    text: done.1,
                    events,
                    last_seq,
                });
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let state = self.state.lock().unwrap();
                let events = state.inbox.for_bubble(&bubble.id, since);
                return Ok(BubbleOutcome {
                    bubble,
                    outcome: "pending".into(),
                    text: None,
                    events,
                    last_seq: state.inbox.last_seq(),
                });
            }
        }
    }

    pub async fn listen(&self, since: u64, wait: u32) -> (Vec<AgentEvent>, u64) {
        self.listen_scoped(since, wait, None).await
    }

    pub async fn listen_scoped(
        &self,
        since: u64,
        wait: u32,
        source_id: Option<&str>,
    ) -> (Vec<AgentEvent>, u64) {
        self.hello_quiet();
        let wait = wait.min(120);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(u64::from(wait));
        loop {
            let notified = self.notify.notified();
            let (events, last) = {
                let state = self.state.lock().unwrap();
                (state.feedback(since, source_id), state.inbox.last_seq())
            };
            if !events.is_empty() || wait == 0 {
                return (events, last);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let state = self.state.lock().unwrap();
                return (state.feedback(since, source_id), state.inbox.last_seq());
            }
        }
    }

    pub fn clear(&self) -> Result<BoardSnapshot, SpellcastError> {
        self.hello_quiet();
        let snap = self.update(|state| {
            state.session.reset();
            state.kept.clear();
            Ok(state.session.snapshot())
        })?;
        self.close_bubbles();
        self.surface.board_changed();
        Ok(snap)
    }

    pub fn focus(&self) {
        self.surface.focus();
    }

    pub fn write_reply(&self, mut req: ReplyRequest) -> Result<BoardReply, SpellcastError> {
        self.hello_quiet();
        let label = self.identify_source(&req.source_id, req.source_label.as_deref())?;
        req.source_label = Some(label);
        let reply = self.update(|state| state.session.write_reply(req))?;
        self.surface.board_changed();
        Ok(reply)
    }

    pub fn patch_reply(&self, req: ReplyPatchRequest) -> Result<BoardReply, SpellcastError> {
        self.patch_reply_inner(req, None)
    }

    pub fn patch_reply_from_source(
        &self,
        source_id: &str,
        req: ReplyPatchRequest,
    ) -> Result<BoardReply, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        self.patch_reply_inner(req, Some(source_id))
    }

    fn patch_reply_inner(
        &self,
        req: ReplyPatchRequest,
        source_id: Option<&str>,
    ) -> Result<BoardReply, SpellcastError> {
        let reply = self.update(|state| {
            if let Some(source) = source_id {
                let existing = state
                    .session
                    .board
                    .replies
                    .iter()
                    .find(|r| r.id == req.reply_id)
                    .ok_or_else(|| SpellcastError::user("这块回复已经不在板上。"))?;
                if existing.source_id != source {
                    return Err(SpellcastError::user("这块回复属于另一个任务。"));
                }
            }
            let layout_only = req.layout_only;
            let block_id = req.block.id().to_string();
            let reply = state.session.patch_reply(req)?;
            if !layout_only && source_id.is_none() {
                let mut event = AgentEvent::new("reply_edit")
                    .title(reply.title.clone())
                    .source(Some(reply.source_id.clone()))
                    .node(reply.origin_node_id.clone())
                    .text("用户修改了这段内容；请读取最新版本再继续。");
                event.reply_id = Some(reply.id.clone());
                event.block_id = Some(block_id);
                state.record(event);
            }
            Ok(reply)
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(reply)
    }

    pub fn reply_action(
        &self,
        req: ReplyActionInput,
    ) -> Result<(BoardReply, AgentEvent), SpellcastError> {
        let (reply, event) = self.update(|state| {
            let (reply, text) = state.session.act_on_reply(&req)?;
            let mut event = AgentEvent::new(if req.action == ReplyAction::Select {
                "selection"
            } else {
                "reply"
            })
            .source(Some(reply.source_id.clone()))
            .node(reply.origin_node_id.clone())
            .title(reply.title.clone())
            .text(text);
            event.reply_id = Some(reply.id.clone());
            event.block_id = Some(req.block_id);
            event.option_id = req.option_id;
            state
                .session
                .note_user(event.text.as_deref().unwrap_or_default());
            let event = state.record(event);
            Ok((reply, event))
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok((reply, event))
    }

    pub fn pending_feedback(&self, source_id: Option<&str>) -> Vec<AgentEvent> {
        self.state
            .lock()
            .unwrap()
            .pending
            .iter()
            .filter(|event| source_id.map_or(true, |id| event.source_id.as_deref() == Some(id)))
            .cloned()
            .collect()
    }

    pub fn acknowledge_feedback(
        &self,
        source_id: &str,
        sequences: &[u64],
    ) -> Result<usize, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        if sequences.len() > 512 {
            return Err(SpellcastError::user("一次最多确认 512 条反馈。"));
        }
        let removed =
            self.update(|state| {
                if state.pending.iter().any(|e| {
                    sequences.contains(&e.seq) && e.source_id.as_deref() != Some(source_id)
                }) {
                    return Err(SpellcastError::user("不能确认其他任务或尚未分配的反馈。"));
                }
                let before = state.pending.len();
                state.pending.retain(|e| {
                    !(sequences.contains(&e.seq) && e.source_id.as_deref() == Some(source_id))
                });
                Ok(before - state.pending.len())
            })?;
        self.surface.board_changed();
        Ok(removed)
    }

    // ---- what the user does --------------------------------------------------

    /// Record something the user did and wake any tool waiting on it.
    pub fn user_event(&self, event: AgentEvent) -> Result<AgentEvent, SpellcastError> {
        if matches!(
            event.kind.as_str(),
            "expired" | "dismiss" | "poke" | "not_shown"
        ) {
            if let Some(id) = &event.bubble_id {
                self.admission.lock().unwrap().active.remove(id);
            }
        }
        let stored = self.update(|state| {
            let event = state.record(event);
            if matches!(event.kind.as_str(), "expired" | "dismiss" | "not_shown") {
                if let Some(id) = &event.bubble_id {
                    state.bubble_sources.remove(id);
                }
            }
            Ok(event)
        })?;
        self.notify.notify_waiters();
        Ok(stored)
    }

    pub fn say(&self, req: SayRequest) -> Result<AgentEvent, SpellcastError> {
        let text = req.text.trim().to_string();
        if text.is_empty() {
            return Err(SpellcastError::user("先写一句。"));
        }
        let kind = if req.bubble_id.is_some() {
            "reply"
        } else {
            "say"
        };
        if text.chars().count() > 4_000 {
            return Err(SpellcastError::user("这条留言太长，请分段发送。"));
        }
        let mut event = AgentEvent::new(kind)
            .node(req.node_id)
            .text(text)
            .source(req.source_id);
        event.bubble_id = req.bubble_id;
        event.reply_id = req.reply_id;
        event.block_id = req.block_id;
        let stored = self.update(|state| {
            if let Some(reply_id) = &event.reply_id {
                let reply = state
                    .session
                    .board
                    .replies
                    .iter()
                    .find(|r| &r.id == reply_id)
                    .ok_or_else(|| SpellcastError::user("这块回复已经不在板上。"))?;
                if let Some(block_id) = &event.block_id {
                    if !reply.blocks.iter().any(|b| b.id() == block_id) {
                        return Err(SpellcastError::user("这段内容已经不在回复里。"));
                    }
                }
            }
            state
                .session
                .note_user(event.text.as_deref().unwrap_or_default());
            Ok(state.record(event))
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(stored)
    }

    pub fn poke(&self, bubble: &ThrownBubble) -> Result<AgentEvent, SpellcastError> {
        self.user_event(
            AgentEvent::new("poke")
                .source(bubble.source_id.clone())
                .bubble(bubble.id.clone())
                .node(bubble.node_id.clone())
                .title(bubble.title.clone())
                .text(format!("on_poke={}", bubble.on_poke.as_str())),
        )
    }

    pub fn dismiss(&self, bubble_id: &str) -> Result<AgentEvent, SpellcastError> {
        self.user_event(AgentEvent::new("dismiss").bubble(bubble_id.to_string()))
    }

    /// The user starred a bubble: keep its words on the board as a fragment so it can be
    /// found again after the bubble is gone. Returns the fragment and the recorded event.
    pub fn keep(&self, bubble: &ThrownBubble) -> Result<(BoardNode, AgentEvent), SpellcastError> {
        let (node, event) = self.update(|state| {
            let existing_id = bubble
                .node_id
                .clone()
                .or_else(|| state.kept.get(&bubble.id).cloned());
            let found = existing_id.as_deref().and_then(|id| {
                state
                    .session
                    .board
                    .nodes
                    .iter()
                    .find(|n| n.id == id)
                    .cloned()
            });
            let node = match found {
                Some(node) => node,
                None => {
                    let body = if bubble.body.trim().is_empty() || bubble.body == bubble.tease {
                        String::new()
                    } else {
                        bubble.body.clone()
                    };
                    let title = if bubble.title.trim().is_empty() {
                        bubble.tease.clone()
                    } else {
                        bubble.title.clone()
                    };
                    let body = if body.is_empty() && title != bubble.tease {
                        bubble.tease.clone()
                    } else {
                        body
                    };
                    state.session.add_node(NodeDraft {
                        source_id: bubble.source_id.clone(),
                        title,
                        body,
                        kind: Some(bubble.kind.as_str().to_string()),
                        weight: Some("note".into()),
                        ..Default::default()
                    })
                }
            };
            state.kept.insert(bubble.id.clone(), node.id.clone());
            let event = state.record(
                AgentEvent::new("kept")
                    .source(bubble.source_id.clone())
                    .bubble(bubble.id.clone())
                    .node(Some(node.id.clone()))
                    .title(node.title.clone()),
            );
            Ok((node, event))
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok((node, event))
    }

    /// Undo a keep. Only a fragment created by keeping this free-floating bubble is removed;
    /// a bubble that already referred to a board node never owns that node.
    pub fn unkeep(&self, bubble: &ThrownBubble) -> Result<(bool, AgentEvent), SpellcastError> {
        let (removed, event) = self.update(|state| {
            let kept_id = state.kept.remove(&bubble.id);
            let removed = if bubble.node_id.is_none() {
                kept_id
                    .as_deref()
                    .is_some_and(|id| state.session.remove_node(id).is_ok())
            } else {
                false
            };
            let event = state.record(
                AgentEvent::new("unkept")
                    .source(bubble.source_id.clone())
                    .bubble(bubble.id.clone())
                    .node(kept_id.clone())
                    .title(bubble.title.clone()),
            );
            Ok((removed, event))
        })?;
        self.notify.notify_waiters();
        if removed {
            self.surface.board_changed();
        }
        Ok((removed, event))
    }

    pub fn expired(&self, bubble_id: &str) -> Result<AgentEvent, SpellcastError> {
        self.user_event(AgentEvent::new("expired").bubble(bubble_id.to_string()))
    }

    pub fn events_since(&self, since: u64) -> (Vec<AgentEvent>, u64) {
        let state = self.state.lock().unwrap();
        (state.inbox.since(since), state.inbox.last_seq())
    }

    pub fn remember(
        &self,
        title: Option<String>,
        text: String,
    ) -> Result<MemoryItem, SpellcastError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(SpellcastError::user("记忆内容不能为空。"));
        }
        let text = spellcast_core::layout::clip(text, 4000);
        let title = title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(|title| spellcast_core::layout::clip(title, 80))
            .unwrap_or_else(|| spellcast_core::layout::clip(&text, 48));
        self.update(|state| {
            if let Some(existing) = state
                .memories
                .iter()
                .find(|memory| memory.title == title && memory.text == text)
            {
                return Ok(existing.clone());
            }
            let memory = MemoryItem {
                id: new_id(),
                title,
                text,
                created_at_ms: now_ms(),
            };
            state.memories.push(memory.clone());
            Ok(memory)
        })
    }

    pub fn recall(&self, query: &str, limit: usize) -> Result<Vec<MemoryItem>, SpellcastError> {
        let limit = limit.clamp(1, 20);
        if let Some(store) = &self.store {
            return store
                .lock()
                .unwrap()
                .recall(query, limit)
                .map_err(|err| SpellcastError::user(format!("Spellcast 没能召回记忆：{err}")));
        }
        let query = query.trim().to_lowercase();
        let state = self.state.lock().unwrap();
        Ok(state
            .memories
            .iter()
            .rev()
            .filter(|memory| {
                query.is_empty()
                    || memory.title.to_lowercase().contains(&query)
                    || memory.text.to_lowercase().contains(&query)
            })
            .take(limit)
            .cloned()
            .collect())
    }

    pub fn forget(&self, id: &str) -> Result<MemoryItem, SpellcastError> {
        self.update(|state| {
            let index = state
                .memories
                .iter()
                .position(|memory| memory.id == id)
                .ok_or_else(|| SpellcastError::user("这条记忆不存在。"))?;
            Ok(state.memories.remove(index))
        })
    }

    // ---- the board itself -----------------------------------------------------

    pub fn board(&self) -> BoardSnapshot {
        self.state.lock().unwrap().session.snapshot()
    }

    pub fn reset_by_user(&self) -> Result<BoardSnapshot, SpellcastError> {
        let snap = self.update(|state| {
            state.session.reset();
            state.kept.clear();
            state.inbox.push(AgentEvent::new("cleared"));
            Ok(state.session.snapshot())
        })?;
        self.close_bubbles();
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(snap)
    }

    pub fn set_form(&self, req: SetFormRequest) -> Result<BoardSnapshot, SpellcastError> {
        let snap = self.update(|state| {
            state.session.set_form(StageForm::parse(&req.form));
            let snap = state.session.snapshot();
            state
                .inbox
                .push(AgentEvent::new("board_edit").text(format!("form={}", snap.form.as_str())));
            Ok(snap)
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(snap)
    }

    pub fn add_node(&self, draft: NodeDraft) -> Result<BoardNode, SpellcastError> {
        let node = self.update(|state| {
            let node = state.session.add_node(draft);
            state.inbox.push(
                AgentEvent::new("board_edit")
                    .node(Some(node.id.clone()))
                    .title(node.title.clone())
                    .text("added"),
            );
            Ok(node)
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(node)
    }

    pub fn patch_node(&self, id: &str, patch: NodePatch) -> Result<BoardNode, SpellcastError> {
        let moved_only = patch.title.is_none()
            && patch.body.is_none()
            && patch.kind.is_none()
            && patch.weight.is_none();
        let node = self.update(|state| {
            let node = state.session.patch_node(id, patch)?;
            // Dragging a card around is not something the agent needs to hear about.
            if !moved_only {
                state.inbox.push(
                    AgentEvent::new("board_edit")
                        .node(Some(node.id.clone()))
                        .title(node.title.clone())
                        .text(format!("edited: {}", node.body)),
                );
            }
            Ok(node)
        })?;
        if !moved_only {
            self.notify.notify_waiters();
        }
        self.surface.board_changed();
        Ok(node)
    }

    pub fn remove_node(&self, id: &str) -> Result<BoardSnapshot, SpellcastError> {
        let snap = self.update(|state| {
            let title = state
                .session
                .board
                .nodes
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.title.clone());
            state.session.remove_node(id)?;
            state.kept.retain(|_, node_id| node_id != id);
            let snap = state.session.snapshot();
            let mut event = AgentEvent::new("board_edit")
                .node(Some(id.to_string()))
                .text("removed");
            if let Some(title) = title {
                event = event.title(title);
            }
            state.inbox.push(event);
            Ok(snap)
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(snap)
    }

    pub fn import_transcript(&self, req: ImportRequest) -> Result<BoardSnapshot, SpellcastError> {
        let snap = self.update(|state| {
            let snap = state.session.import_transcript(&req.transcript)?;
            state
                .inbox
                .push(AgentEvent::new("board_edit").text("imported transcript"));
            Ok(snap)
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(snap)
    }

    pub fn screen_count(&self) -> u32 {
        self.surface.screen_count().max(1)
    }
}

/// Which single event ends a wait on a bubble.
fn settle(events: &[AgentEvent]) -> Option<(String, Option<String>)> {
    if let Some(failed) = events.iter().rev().find(|e| e.kind == "not_shown") {
        return Some(("not_shown".into(), failed.text.clone()));
    }
    if let Some(reply) = events.iter().rev().find(|e| e.kind == "reply") {
        return Some(("replied".into(), reply.text.clone()));
    }
    if events.iter().any(|e| e.kind == "poke") {
        let last = events.last().map(|e| e.kind.as_str()).unwrap_or("poke");
        // A peek that was then closed without a word still counts as interest.
        if last == "dismiss" {
            return Some(("poked".into(), None));
        }
        let poked = events.iter().find(|e| e.kind == "poke");
        // Still open: keep waiting only if the agent asked for a reply.
        let wants_reply = poked.and_then(|e| e.text.as_deref()).map_or(false, |t| {
            t.contains("on_poke=reply") || t.contains("on_poke=peek")
        });
        if wants_reply {
            return None;
        }
        return Some(("poked".into(), None));
    }
    if events.iter().any(|e| e.kind == "dismiss") {
        return Some(("dismissed".into(), None));
    }
    if events.iter().any(|e| e.kind == "expired") {
        return Some(("expired".into(), None));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use spellcast_core::types::{ProposedNode, ProposedThrow};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    static NEXT_DB: AtomicUsize = AtomicUsize::new(0);

    fn temp_db() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "spellcast-state-test-{}-{}.sqlite3",
            std::process::id(),
            NEXT_DB.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[derive(Default)]
    pub(super) struct Recording {
        pub(super) thrown: Mutex<Vec<ThrownBubble>>,
        focused: AtomicUsize,
    }

    impl Surface for Arc<Recording> {
        fn agent_seen(&self, _client: &str) {}
        fn throw(&self, bubbles: &[ThrownBubble]) -> Result<usize, String> {
            self.thrown.lock().unwrap().extend_from_slice(bubbles);
            Ok(bubbles.len())
        }
        fn presented(&self, _r: &PresentResult) {}
        fn board_changed(&self) {}
        fn close_bubbles(&self) {}
        fn focus(&self) {
            self.focused.fetch_add(1, Ordering::SeqCst);
        }
    }

    pub(super) fn bridge() -> (Arc<Bridge>, Arc<Recording>) {
        let rec = Arc::new(Recording::default());
        (Arc::new(Bridge::new(rec.clone(), 0)), rec)
    }

    async fn last_thrown(rec: &Recording) -> ThrownBubble {
        for _ in 0..50 {
            if let Some(b) = rec.thrown.lock().unwrap().last().cloned() {
                return b;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("nothing was thrown");
    }

    fn throw_and_wait(
        bridge: &Arc<Bridge>,
        on_poke: &str,
    ) -> tokio::task::JoinHandle<BubbleOutcome> {
        let b = bridge.clone();
        let on_poke = on_poke.to_string();
        tokio::spawn(async move {
            b.bubble(BubbleRequest {
                tease: "要不要也改测试".into(),
                on_poke: Some(on_poke),
                wait: Some(5),
                ..Default::default()
            })
            .await
            .unwrap()
        })
    }

    #[test]
    fn unkeep_removes_only_the_fragment_created_by_that_keep() {
        let (bridge, _) = bridge();
        let free = bridge
            .state
            .lock()
            .unwrap()
            .session
            .bubble(BubbleRequest {
                tease: "free".into(),
                ..Default::default()
            })
            .unwrap();
        let (created, _) = bridge.keep(&free).unwrap();
        let (removed, event) = bridge.unkeep(&free).unwrap();
        assert!(removed);
        assert_eq!(event.kind, "unkept");
        assert!(!bridge
            .board()
            .nodes
            .iter()
            .any(|node| node.id == created.id));

        let original = bridge
            .add_node(NodeDraft {
                title: "already on board".into(),
                ..Default::default()
            })
            .unwrap();
        let linked = bridge
            .state
            .lock()
            .unwrap()
            .session
            .bubble(BubbleRequest {
                tease: "linked".into(),
                node_id: Some(original.id.clone()),
                ..Default::default()
            })
            .unwrap();
        bridge.keep(&linked).unwrap();
        assert!(!bridge.unkeep(&linked).unwrap().0);
        assert!(bridge
            .board()
            .nodes
            .iter()
            .any(|node| node.id == original.id));
    }

    #[tokio::test]
    async fn reply_bubble_waits_for_the_words() {
        let (bridge, rec) = bridge();
        let waiter = throw_and_wait(&bridge, "reply");
        let bubble = last_thrown(&rec).await;
        bridge.poke(&bubble).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !waiter.is_finished(),
            "a poke on a reply bubble keeps waiting for the reply"
        );
        bridge
            .say(SayRequest {
                text: "改".into(),
                bubble_id: Some(bubble.id.clone()),
                node_id: None,
                ..Default::default()
            })
            .unwrap();
        let out = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(out.outcome, "replied");
        assert_eq!(out.text.as_deref(), Some("改"));
        assert_eq!(out.events.len(), 2);
    }

    #[tokio::test]
    async fn focus_bubble_settles_on_the_poke() {
        let (bridge, rec) = bridge();
        let waiter = throw_and_wait(&bridge, "focus");
        let bubble = last_thrown(&rec).await;
        bridge.poke(&bubble).unwrap();
        let out = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(out.outcome, "poked");
    }

    #[tokio::test]
    async fn ignored_bubble_reports_expiry() {
        let (bridge, rec) = bridge();
        let waiter = throw_and_wait(&bridge, "peek");
        let bubble = last_thrown(&rec).await;
        bridge.expired(&bubble.id).unwrap();
        let out = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(out.outcome, "expired");
    }

    #[tokio::test]
    async fn zero_wait_returns_at_once() {
        let (bridge, _) = bridge();
        let out = bridge
            .bubble(BubbleRequest {
                tease: "嗨".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(out.outcome, "accepted");
    }

    #[tokio::test]
    async fn headless_reports_not_shown() {
        let bridge = Bridge::new(Headless, 0);
        let out = bridge
            .bubble(BubbleRequest {
                tease: "嗨".into(),
                wait: Some(3),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(out.outcome, "not_shown");
    }

    #[tokio::test]
    async fn board_keep_mapping_and_event_sequence_survive_reopen() {
        let path = temp_db();
        let bubble = {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            let bubble = bridge
                .bubble(BubbleRequest {
                    tease: "下次还要看到".into(),
                    ..Default::default()
                })
                .await
                .unwrap()
                .bubble;
            bridge.keep(&bubble).unwrap();
            bridge
                .say(SayRequest {
                    text: "收到".into(),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(bridge.events_since(0).1, 2);
            bubble
        };

        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            assert_eq!(bridge.board().nodes.len(), 1);
            assert_eq!(bridge.board().messages.len(), 1);
            assert_eq!(bridge.events_since(0).1, 2);
            assert!(bridge.unkeep(&bubble).unwrap().0);
        }

        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            assert!(bridge.board().nodes.is_empty());
            let (events, last) = bridge.events_since(2);
            assert_eq!(last, 3);
            assert_eq!(events[0].kind, "unkept");
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn explicit_memory_is_searchable_and_forget_survives_reopen() {
        let path = temp_db();
        let memory = {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            bridge
                .remember(Some("偏好".into()), "UI 要留一点呼吸感".into())
                .unwrap()
        };

        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            let found = bridge.recall("呼吸感", 8).unwrap();
            assert_eq!(found[0].id, memory.id);
            bridge.forget(&memory.id).unwrap();
        }

        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            assert!(bridge.recall("", 8).unwrap().is_empty());
        }

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn present_opens_when_asked_and_throws_only_in_ambient() {
        let (bridge, rec) = bridge();
        let mut payload = PresentPayload {
            nodes: vec![ProposedNode {
                title: "A".into(),
                ..Default::default()
            }],
            throws: Some(vec![ProposedThrow {
                node: Some(0),
                tease: "A".into(),
                ..Default::default()
            }]),
            open: true,
            ..Default::default()
        };
        let res = bridge.present(payload.clone()).unwrap();
        assert_eq!(res.throws.len(), 1);
        assert_eq!(rec.thrown.lock().unwrap().len(), 1);
        assert_eq!(rec.focused.load(Ordering::SeqCst), 1);

        bridge.set_surface("focus");
        payload.open = false;
        let res = bridge.present(payload).unwrap();
        assert!(
            res.throws.is_empty(),
            "the board is already in front of the user"
        );
        assert_eq!(rec.thrown.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn listen_wakes_on_user_events() {
        let (bridge, _) = bridge();
        let b2 = bridge.clone();
        let waiter = tokio::spawn(async move { b2.listen(0, 5).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        bridge
            .say(SayRequest {
                text: "先别发布".into(),
                ..Default::default()
            })
            .unwrap();
        let (events, last) = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "say");
        assert_eq!(last, 1);
    }

    #[tokio::test]
    async fn dragging_a_card_is_not_news_but_editing_is() {
        let (bridge, _) = bridge();
        let node = bridge
            .add_node(NodeDraft {
                title: "x".into(),
                ..Default::default()
            })
            .unwrap();
        let (_, after_add) = bridge.events_since(0);
        bridge
            .patch_node(
                &node.id,
                NodePatch {
                    x: Some(2.0),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(bridge.events_since(after_add).0.len(), 0);
        bridge
            .patch_node(
                &node.id,
                NodePatch {
                    title: Some("y".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(bridge.events_since(after_add).0.len(), 1);
    }
}

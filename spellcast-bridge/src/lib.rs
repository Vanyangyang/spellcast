//! Shared application state behind the Spellcast desktop and its local REST adapter.

pub mod api;
pub mod artifacts;
pub mod canvas;
pub mod canvas_blocks;
pub mod task_target;
pub mod desktop_delivery;
mod canvas_data;
pub mod codex;
pub mod feedback;
pub mod mcp;
pub mod observer;
#[cfg(test)]
mod annotation_tests;
#[cfg(test)]
mod reply_tests;
mod store;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use spellcast_core::inbox::now_ms;
use spellcast_core::types::{
    new_id, BoardNode, BoardSnapshot, BubbleRequest, CapturedContext, ImportRequest, MemoryItem,
    NodeDraft, NodePatch, PresentPayload, PresentResult, SayRequest, SetFormRequest, SpellcastError,
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
    /// Whether the board window currently receives keyboard input. This is
    /// separate from the selected board/ambient presentation mode.
    fn board_is_focused(&self) -> bool {
        false
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
    /// ambient | focus — the user's selected presentation mode.
    pub surface: String,
    #[serde(default)]
    pub board_focused: bool,
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
    /// Product aside switch. Missing in old databases means off.
    #[serde(default)]
    pub observer_enabled: bool,
    #[serde(default)]
    pub observer_policy_revision: u64,
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
    #[serde(default)]
    bindings: Vec<codex::CodexBinding>,
    #[serde(default)]
    deliveries: Vec<feedback::DeliveryReceipt>,
    #[serde(skip)]
    bubble_sources: HashMap<String, String>,
    /// Canonical captured_context for bubbles this process admitted/dispatched.
    /// Same lifetime as bubble_sources; not persisted.
    #[serde(skip)]
    bubble_captures: HashMap<String, CapturedContext>,
    #[serde(default)]
    paused: bool,
    /// Independent observer asides. Absent field in an old store is off.
    #[serde(default)]
    observer_enabled: bool,
    /// Bumps only when the aside switch or observation-relevant pause actually changes.
    #[serde(default)]
    observer_policy_revision: u64,
}

#[derive(Default)]
struct Admission {
    active: HashSet<String>,
    recent: VecDeque<(String, u64)>,
}

impl PersistedState {
    fn forget_bubble(&mut self, id: &str) {
        self.bubble_sources.remove(id);
        self.bubble_captures.remove(id);
    }

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
        self.session.sync_canvas();
        let content = event.reply_id.as_ref().map(|id| spellcast_core::CanvasContent::Reply { id: id.clone() })
            .or_else(|| event.node_id.as_ref().map(|id| spellcast_core::CanvasContent::Node { id: id.clone() }));
        if let Some(object) = content.as_ref().and_then(|content| self.session.board.canvas.object_for(content)) {
            event.object_id = Some(object.id.clone());
            event.object_revision = Some(object.content_revision);
        }
        event.source_id = self.source_for(&event);
        if event.target_thread_id.is_none() {
            event.target_thread_id = self.bindings.iter().find(|binding| Some(binding.source_id.as_str()) == event.source_id.as_deref()).map(|binding| binding.thread_id.clone());
        }
        let important = matches!(
            event.kind.as_str(),
            "reply" | "say" | "kept" | "unkept" | "selection" | "reply_edit"
        );
        let event = self.inbox.push(event);
        if important {
            self.pending.push(event.clone());
        }
        self.record_delivery(&event);
        event
    }

    fn feedback(&self, since: u64, source_id: Option<&str>) -> Vec<AgentEvent> {
        let mut events = self.inbox.since(since);
        events.extend(self.pending.iter().cloned());
        events.retain(|e| {
            !matches!(e.kind.as_str(), "canvas_state" | "board_edit") && source_id.map_or(true, |id| {
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
    observers: Mutex<observer::Observers>,
    delivery_gate: tokio::sync::Mutex<()>,
    delivery_started: AtomicBool,
}

impl Bridge {
    pub fn new(surface: impl Surface, port: u16) -> Self {
        Self::from_parts(surface, port, PersistedState::default(), None)
    }

    #[cfg(test)]
    fn test_bubble_maps(&self, id: &str) -> (Option<String>, Option<CapturedContext>) {
        let state = self.state.lock().unwrap();
        (
            state.bubble_sources.get(id).cloned(),
            state.bubble_captures.get(id).cloned(),
        )
    }

    pub fn open(surface: impl Surface, port: u16, path: impl AsRef<Path>) -> Result<Self, String> {
        let mut store = Store::open(path.as_ref())?;
        let mut state: PersistedState = store.load()?.unwrap_or_default();
        let mut recovered = state.session.sync_canvas();
        for receipt in &mut state.deliveries {
            if receipt.phase == feedback::DeliveryPhase::Dispatching {
                receipt.phase = feedback::DeliveryPhase::Unknown;
                receipt.error = Some("应用在收到投递确认前退出，请先核对原任务；没有自动重发。".into());
                recovered = true;
            }
        }
        if recovered || !state.deliveries.is_empty() {
            store.save_with_requests(&state, &state.memories, &state.deliveries)?;
        } else {
            store.reindex(&state.memories)?;
        }
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
                board_focused: false,
                port,
                client: None,
                last_call_ms: 0,
                calls: 0,
                agents: Vec::new(),
                sources: Vec::new(),
                paused: false,
                observer_enabled: false,
                observer_policy_revision: 0,
            }),
            notify: Notify::new(),
            surface: Box::new(surface),
            admission: Mutex::new(Admission::default()),
            observers: Mutex::new(observer::Observers::default()),
            delivery_gate: tokio::sync::Mutex::new(()),
            delivery_started: AtomicBool::new(false),
        }
    }

    fn update<R>(
        &self,
        change: impl FnOnce(&mut PersistedState) -> Result<R, SpellcastError>,
    ) -> Result<R, SpellcastError> {
        let mut current = self.state.lock().unwrap();
        let previous_sequence = current.inbox.last_seq();
        let mut next = current.clone();
        let result = change(&mut next)?;
        next.session.sync_canvas();
        if let Some(store) = &self.store {
            let requests: Vec<_> = next
                .deliveries
                .iter()
                .filter(|r| r.event.seq > previous_sequence && r.event.request_id.is_some())
                .cloned()
                .collect();
            next.prune_completed_receipts();
            store
                .lock()
                .unwrap()
                .save_with_requests(&next, &next.memories, &requests)
                .map_err(|err| {
                    SpellcastError::user(format!("Spellcast 没能保存这次改动：{err}"))
                })?;
        }
        *current = next;
        Ok(result)
    }

    pub fn patch_canvas(
        &self,
        patch: spellcast_core::CanvasPatch,
    ) -> Result<spellcast_core::CanvasLayout, SpellcastError> {
        let canvas = self.update(|state| state.session.patch_canvas(patch))?;
        self.surface.board_changed();
        Ok(canvas)
    }

    pub fn remove_canvas_item(
        &self,
        item_id: &str,
        expected_revision: u64,
    ) -> Result<BoardSnapshot, SpellcastError> {
        let snapshot = self.update(|state| {
            state
                .session
                .remove_canvas_item(item_id, expected_revision)?;
            Ok(state.session.snapshot())
        })?;
        self.surface.board_changed();
        Ok(snapshot)
    }

    pub fn restore_canvas_item(&self, item_id: &str, expected_revision: u64) -> Result<BoardSnapshot, SpellcastError> {
        let snapshot = self.update(|state| {
            state.session.set_canvas_removed(item_id, expected_revision, false)?;
            Ok(state.session.snapshot())
        })?;
        self.surface.board_changed();
        Ok(snapshot)
    }

    pub fn delete_canvas_content(&self, object_id: &str, expected_revision: u64, current: Vec<spellcast_core::CanvasRead>) -> Result<BoardSnapshot, SpellcastError> {
        let snapshot = self.update(|state| {
            let content = state.session.canvas_target(object_id, None, None)?;
            state.session.delete_canvas_content(object_id, expected_revision, &current)?;
            if let spellcast_core::CanvasContent::Node { id } = content { state.kept.retain(|_, node_id| node_id != &id); }
            Ok(state.session.snapshot())
        })?;
        self.surface.board_changed();
        Ok(snapshot)
    }

    pub fn status(&self) -> Status {
        let mut status = self.status.lock().unwrap().clone();
        let state = self.state.lock().unwrap();
        status.paused = state.paused;
        status.observer_enabled = state.observer_enabled;
        status.observer_policy_revision = state.observer_policy_revision;
        for binding in &state.bindings {
            if !status.sources.iter().any(|s| s.id == binding.source_id) {
                status.sources.push(RecentSource {
                    id: binding.source_id.clone(),
                    label: binding.label.clone(),
                    last_call_ms: binding.bound_at_ms,
                });
            }
        }
        status.board_focused = self.surface.board_is_focused();
        status
    }

    pub fn board_in_focus(&self) -> bool {
        let board_mode = self.status.lock().unwrap().surface == "focus";
        board_mode && self.surface.board_is_focused()
    }

    pub fn set_paused(&self, paused: bool) -> Result<Status, SpellcastError> {
        {
            let mut observers = self.observers.lock().unwrap();
            self.update(|state| {
                if state.paused != paused {
                    state.paused = paused;
                    state.observer_policy_revision = state.observer_policy_revision.saturating_add(1);
                }
                Ok(())
            })?;
            if paused {
                observers.invalidate_all();
            }
        }
        if paused {
            self.close_bubbles();
        }
        Ok(self.status())
    }

    pub fn set_observer_enabled(&self, enabled: bool) -> Result<observer::ObserverStatus, SpellcastError> {
        {
            let mut observers = self.observers.lock().unwrap();
            self.update(|state| {
                if state.observer_enabled != enabled {
                    state.observer_enabled = enabled;
                    state.observer_policy_revision =
                        state.observer_policy_revision.saturating_add(1);
                }
                Ok(())
            })?;
            if !enabled {
                observers.invalidate_all();
            }
        }
        Ok(self.observer_status())
    }

    pub fn observer_status(&self) -> observer::ObserverStatus {
        self.observer_gate()
    }

    fn observer_gate(&self) -> observer::ObserverStatus {
        let surface = self.status.lock().unwrap().surface.clone();
        let actual_focus = self.surface.board_is_focused();
        let state = self.state.lock().unwrap();
        let board_focused = surface == "focus" && actual_focus;
        observer::ObserverStatus::from_flags(
            state.observer_enabled,
            state.paused,
            board_focused,
            state.observer_policy_revision,
        )
    }

    pub fn close_bubbles(&self) {
        self.admission.lock().unwrap().active.clear();
        self.surface.close_bubbles();
    }

    fn dispatch(&self, bubbles: &[ThrownBubble]) -> Result<usize, String> {
        if self.state.lock().unwrap().paused || self.board_in_focus() {
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
                if let Some(captured) = &bubble.captured_context {
                    state
                        .bubble_captures
                        .insert(bubble.id.clone(), captured.clone());
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
                    state.forget_bubble(&bubble.id);
                }
                Ok(count)
            }
            Err(error) => {
                let mut gate = self.admission.lock().unwrap();
                let mut state = self.state.lock().unwrap();
                for bubble in &admitted {
                    gate.active.remove(&bubble.id);
                    state.forget_bubble(&bubble.id);
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
        if focus && self.surface.board_is_focused() {
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
        let surface = if self.board_in_focus() {
            "focus"
        } else {
            "ambient"
        };
        let result = self.update(|state| {
            let replace = payload.replace;
            let result = state.session.present(payload, surface)?;
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
        let wait = req.wait.unwrap_or(0).min(120);
        let result = self.bubble_now(req)?;
        if result.outcome != "accepted" || wait == 0 {
            return Ok(result);
        }
        let bubble = result.bubble;
        let since = result.last_seq;
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

    fn bubble_now(&self, req: BubbleRequest) -> Result<BubbleOutcome, SpellcastError> {
        self.bubble_now_captured(req, None)
    }

    pub(crate) fn capture_from_brief(
        &self,
        brief: &observer::ObserverBrief,
    ) -> spellcast_core::CapturedContext {
        let binding = {
            let state = self.state.lock().unwrap();
            state
                .bindings
                .iter()
                .find(|binding| binding.source_id == brief.source_id)
                .cloned()
        };
        spellcast_core::CapturedContext {
            project: brief.snapshot.project.clone(),
            goal: brief.snapshot.goal.clone(),
            change: brief.snapshot.change.clone(),
            source_id: brief.source_id.clone(),
            captured_at_ms: now_ms(),
            thread_id: binding.as_ref().map(|b| b.thread_id.clone()),
            cwd: binding.as_ref().map(|b| b.cwd.clone()),
        }
    }

    pub(crate) fn bubble_now_captured(
        &self,
        req: BubbleRequest,
        captured: Option<spellcast_core::CapturedContext>,
    ) -> Result<BubbleOutcome, SpellcastError> {
        if let Some(source) = &req.source_id {
            self.identify_source(source, None)?;
        }
        self.hello_quiet();
        let (mut bubble, since) = {
            let state = self.state.lock().unwrap();
            (state.session.bubble(req)?, state.inbox.last_seq())
        };
        bubble.captured_context = captured;
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
        Ok(BubbleOutcome {
            bubble,
            outcome: if shown { "accepted" } else { "not_shown" }.into(),
            text: None,
            events: vec![],
            last_seq: since,
        })
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
                if let Err(error) = self.mark_received(source_id, &events) {
                    tracing::warn!(%error, "could not persist feedback read receipt");
                }
                return (events, last);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let (events, last) = {
                    let state = self.state.lock().unwrap();
                    (state.feedback(since, source_id), state.inbox.last_seq())
                };
                if let Err(error) = self.mark_received(source_id, &events) {
                    tracing::warn!(%error, "could not persist feedback read receipt");
                }
                return (events, last);
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

    pub fn write_reply(&self, req: ReplyRequest) -> Result<BoardReply, SpellcastError> {
        self.write_reply_for_feedback(req, &[])
    }

    pub fn write_reply_for_feedback(
        &self,
        mut req: ReplyRequest,
        sequences: &[u64],
    ) -> Result<BoardReply, SpellcastError> {
        self.validate_artifacts(&req.source_id, &req.blocks)?;
        self.hello_quiet();
        let label = self.identify_source(&req.source_id, req.source_label.as_deref())?;
        req.source_label = Some(label);
        let reply = self.update(|state| {
            if let Some(id) = &req.id {
                if state.session.board.canvas.objects.iter().any(|object| object.user_edited && matches!(&object.content, spellcast_core::CanvasContent::Reply { id: existing } if existing == id)) {
                    return Err(SpellcastError::user("用户已修改这个对象；请通过 spellcast_canvas_batch 提交局部修改提案。"));
                }
            }
            let previous = state.session.clone();
            let reply = state.session.write_reply(req)?;
            state.session.sync_canvas();
            spellcast_core::validate_image_references(&previous, &state.session)?;
            spellcast_core::validate_artifact_references(&previous, &state.session)?;
            state.mark_response(
                &reply.source_id,
                &reply.id,
                reply.origin_node_id.as_deref(),
                sequences,
            )?;
            Ok(reply)
        })?;
        self.surface.board_changed();
        Ok(reply)
    }

    pub fn patch_reply(&self, req: ReplyPatchRequest) -> Result<BoardReply, SpellcastError> {
        self.patch_reply_inner(req, None, &[], None)
    }

    pub fn patch_reply_from_source(
        &self,
        source_id: &str,
        req: ReplyPatchRequest,
    ) -> Result<BoardReply, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        self.patch_reply_inner(req, Some(source_id), &[], None)
    }

    pub fn patch_reply_for_feedback(
        &self,
        source_id: &str,
        req: ReplyPatchRequest,
        sequences: &[u64],
    ) -> Result<BoardReply, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        self.patch_reply_inner(req, Some(source_id), sequences, None)
    }

    fn patch_reply_inner(
        &self,
        mut req: ReplyPatchRequest,
        source_id: Option<&str>,
        sequences: &[u64],
        request_hash: Option<String>,
    ) -> Result<BoardReply, SpellcastError> {
        let request_hash = request_hash
            .map(Ok)
            .unwrap_or_else(|| feedback::fingerprint("patch", &req))?;
        let reply = self.update(|state| {
            req.reply_id = state.session.canvas_reply_id(req.object_id.as_deref(), &req.reply_id)?;
            if source_id.is_none()
                && !req.layout_only
                && self
                    .replay_request(state, req.request_id.as_deref(), &request_hash)?
                    .is_some()
            {
                return state
                    .session
                    .board
                    .replies
                    .iter()
                    .find(|r| r.id == req.reply_id)
                    .cloned()
                    .ok_or_else(|| SpellcastError::user("请求已保存，但原回复已被删除。"));
            }
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
                if let Some(previous) = existing
                    .blocks
                    .iter()
                    .find(|old| old.id() == req.block.id())
                {
                    req.block.preserve_user_state_from(previous);
                }
            }
            let owner = state
                .session
                .board
                .replies
                .iter()
                .find(|r| r.id == req.reply_id)
                .ok_or_else(|| SpellcastError::user("这块回复已经不在板上。"))?;
            self.validate_artifacts(&owner.source_id, std::slice::from_ref(&req.block))?;
            let layout_only = req.layout_only;
            let content_changed = state
                .session
                .board
                .replies
                .iter()
                .find(|r| r.id == req.reply_id)
                .and_then(|r| r.blocks.iter().find(|b| b.id() == req.block.id()))
                .is_some_and(|before| !before.same_content(&req.block));
            if source_id.is_some() && content_changed && state.session.board.canvas.objects.iter().any(|object| object.user_edited && matches!(&object.content, spellcast_core::CanvasContent::Reply { id } if id == &req.reply_id)) {
                return Err(SpellcastError::user("用户已修改这个对象；请通过 spellcast_canvas_batch 提交局部修改提案。"));
            }
            let request_id = req.request_id.clone();
            let block_id = req.block.id().to_string();
            let previous = state.session.clone();
            let reply = state.session.patch_reply(req)?;
            state.session.sync_canvas();
            spellcast_core::validate_image_references(&previous, &state.session)?;
            spellcast_core::validate_artifact_references(&previous, &state.session)?;
            if !layout_only && source_id.is_none() && content_changed {
                state.session.sync_canvas();
                if let Some(object) = state.session.board.canvas.objects.iter_mut().find(|o| matches!(&o.content, spellcast_core::CanvasContent::Reply { id } if id == &reply.id)) {
                    object.user_edited = true;
                }
                let mut event = AgentEvent::new("canvas_state")
                    .title(reply.title.clone())
                    .source(Some(reply.source_id.clone()))
                    .node(reply.origin_node_id.clone())
                    .text("已在画布保存内容修改，尚未发送。");
                event.reply_id = Some(reply.id.clone());
                event.block_id = Some(block_id);
                event.request_id = request_id;
                let event = state.record(event);
                state.stamp_request(event.seq, request_hash);
            }
            if let Some(source) = source_id {
                state.mark_response(
                    source,
                    &reply.id,
                    reply.origin_node_id.as_deref(),
                    sequences,
                )?;
            }
            Ok(reply)
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(reply)
    }

    pub fn reply_action(
        &self,
        mut req: ReplyActionInput,
    ) -> Result<(BoardReply, AgentEvent), SpellcastError> {
        let request_hash = feedback::fingerprint("action", &req)?;
        let (reply, event) = self.update(|state| {
            req.reply_id = state.session.canvas_reply_id(req.object_id.as_deref(), &req.reply_id)?;
            if let Some(event) =
                self.replay_request(state, req.request_id.as_deref(), &request_hash)?
            {
                let reply = state
                    .session
                    .board
                    .replies
                    .iter()
                    .find(|r| r.id == req.reply_id)
                    .cloned()
                    .ok_or_else(|| SpellcastError::user("请求已保存，但原回复已被删除。"))?;
                return Ok((reply, event));
            }
            if req.action == ReplyAction::Ask && !req.anchors.is_empty() {
                let object_id = state.session.board.canvas.objects.iter().find(|object| matches!(&object.content, spellcast_core::CanvasContent::Reply { id } if id == &req.reply_id)).map(|object| &object.id);
                if req.anchors.iter().any(|anchor| Some(&anchor.object_id) != object_id || anchor.block_id.as_deref() != Some(&req.block_id)) { return Err(SpellcastError::user("所选位置与讨论的回复不一致。")); }
                canvas::validate_anchors(&state.session, &req.anchors)?;
                for anchor in &req.anchors { self.validate_input_anchor(&state.session, anchor)?; }
            }
            let annotation_context = if req.action == ReplyAction::Ask {
                canvas::annotation_context(&state.session, &req.anchors)?
            } else {
                Vec::new()
            };
            let (reply, text) = state.session.act_on_reply(&req)?;
            canvas::validate_annotation_route(&state.session, &annotation_context, &reply.source_id)?;
            let mut connected_anchor = None;
            if let Some(context) = &req.artifact_context {
                if self.artifact(&context.bundle_id)?.source_id != reply.source_id {
                    return Err(SpellcastError::user("反馈的作品版本属于另一个任务。"));
                }
                if context.inputs.is_some() {
                    let object = state.session.board.canvas.objects.iter().find(|object| matches!(&object.content, spellcast_core::CanvasContent::Reply { id } if id == &reply.id))
                        .ok_or_else(|| SpellcastError::user("作品的画布身份不存在。"))?;
                    let anchor = spellcast_core::inbox::CanvasAnchor {
                        target: None, image: None, artifact_reference: None, annotations: vec![],
                        compositions: vec![],
                        object_id: object.id.clone(), content_revision: object.content_revision, block_id: Some(req.block_id.clone()), selection: None, region: None,
                        artifact: Some(spellcast_core::inbox::CanvasArtifactAnchor { bundle_id: context.bundle_id.clone(), state_revision: context.state_revision.ok_or_else(|| SpellcastError::user("连接反馈需要确切的参数版本。"))?, state: context.state.clone(), selection: context.state.get("selection").cloned() }),
                        inputs: context.inputs.clone(),
                    };
                    canvas::validate_anchors(&state.session, std::slice::from_ref(&anchor))?;
                    self.validate_input_anchor(&state.session, &anchor)?;
                    connected_anchor = Some(anchor);
                }
            }
            if req.action == ReplyAction::Ask && connected_anchor.is_none() {
                if let Some(spellcast_core::ReplyBlock::Artifact { bundle_id, .. }) = reply.blocks.iter().find(|block| block.id() == req.block_id) {
                    if !self.artifact(bundle_id)?.io.inputs.is_empty() { return Err(SpellcastError::user("反馈需要当前连接输入，请重新选择作品后发送。")); }
                }
            }
            let mut event = AgentEvent::new(if req.action == ReplyAction::Select {
                "canvas_state"
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
            event.request_id = req.request_id;
            if req.action == ReplyAction::Ask { event.anchors = req.anchors; }
            event.annotation_context = annotation_context;
            if let Some(anchor) = connected_anchor { event.object_id = Some(anchor.object_id.clone()); event.object_revision = Some(anchor.content_revision); event.anchors.push(anchor); }
            if let Some(context) = req.artifact_context {
                event.artifact_context = Some(serde_json::to_value(context)?);
            } else if let Some(spellcast_core::ReplyBlock::Artifact { bundle_id, state: view_state, state_revision, .. }) = reply.blocks.iter().find(|b| Some(b.id()) == event.block_id.as_deref()) {
                event.artifact_context = Some(serde_json::json!({ "bundle_id": bundle_id, "state": view_state, "state_revision": state_revision }));
            }
            if req.action == ReplyAction::Ask {
                state.session.note_user(event.text.as_deref().unwrap_or_default());
            }
            let event = state.record(event);
            state.stamp_request(event.seq, request_hash);
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
                for receipt in &mut state.deliveries {
                    if receipt.event.source_id.as_deref() == Some(source_id)
                        && sequences.contains(&receipt.event.seq)
                    {
                        receipt.phase = feedback::DeliveryPhase::Handled;
                        receipt.handled_at_ms.get_or_insert_with(now_ms);
                        receipt.error = None;
                    }
                }
                Ok(before - state.pending.len())
            })?;
        self.surface.board_changed();
        Ok(removed)
    }

    // ---- what the user does --------------------------------------------------

    /// Record something the user did and wake any tool waiting on it.
    pub fn user_event(&self, event: AgentEvent) -> Result<AgentEvent, SpellcastError> {
        if !event.annotation_context.is_empty() {
            return Err(SpellcastError::user(
                "annotation_context 只能由后端从已校验的注释引用生成。",
            ));
        }
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
                    state.forget_bubble(id);
                }
            }
            Ok(event)
        })?;
        self.notify.notify_waiters();
        Ok(stored)
    }

    pub fn say(&self, req: SayRequest) -> Result<AgentEvent, SpellcastError> {
        let request_hash = feedback::fingerprint("say", &req)?;
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
        event.request_id = req.request_id;
        event.object_id = req.object_id;
        event.anchors = req.anchors;
        event.target_thread_id = req.target_thread_id;
        let stored = self.update(|state| {
            if let Some(replay) =
                self.replay_request(state, event.request_id.as_deref(), &request_hash)?
            {
                return Ok(replay);
            }
            if let Some(expected) = &event.target_thread_id {
                if !state.bindings.iter().any(|binding| Some(binding.source_id.as_str()) == event.source_id.as_deref() && &binding.thread_id == expected) {
                    return Err(SpellcastError::user("接收任务关联已变化，没有发送；请重新确认原任务。"));
                }
            }
            if !event.anchors.is_empty() {
                let source = event.source_id.as_deref().ok_or_else(|| SpellcastError::user("请选择一个接收请求的任务。"))?;
                spellcast_core::reply::validate_id(source)?;
                let known = state.bindings.iter().any(|b| b.source_id == source)
                    || state.session.board.replies.iter().any(|r| r.source_id == source)
                    || state.session.board.nodes.iter().any(|n| n.source_id.as_deref() == Some(source))
                    || state.session.board.canvas.objects.iter().any(|o| o.source_id.as_deref() == Some(source))
                    || self.status.lock().unwrap().sources.iter().any(|s| s.id == source);
                if !known { return Err(SpellcastError::user("接收任务已经不存在，请重新选择。")); }
                canvas::validate_anchors(&state.session, &event.anchors)?;
                for anchor in &event.anchors { self.validate_input_anchor(&state.session, anchor)?; }
                event.annotation_context = canvas::annotation_context(&state.session, &event.anchors)?;
                canvas::validate_annotation_route(&state.session, &event.annotation_context, source)?;
                // Multiple sources are reference context; only source_id receives this request.
                if event.object_id.is_some() || event.reply_id.is_some() || event.node_id.is_some() || event.block_id.is_some() || event.bubble_id.is_some() {
                    return Err(SpellcastError::user("多位置反馈请只使用 anchors，避免与旧引用混淆。"));
                }
            }
            if let Some(object_id) = &event.object_id {
                match state.session.canvas_target(object_id, event.reply_id.as_deref(), event.node_id.as_deref())? {
                    spellcast_core::CanvasContent::Reply { id } => event.reply_id = Some(id),
                    spellcast_core::CanvasContent::Node { id } => event.node_id = Some(id),
                    _ => {
                        let object = state.session.board.canvas.object(object_id).unwrap();
                        if event.source_id.as_deref() != object.source_id.as_deref() {
                            return Err(SpellcastError::user("请选择该对象的原任务，或将它添加为多位置引用。"));
                        }
                    }
                }
            }
            if let Some(reply_id) = &event.reply_id {
                let reply = state
                    .session
                    .board
                    .replies
                    .iter()
                    .find(|r| &r.id == reply_id)
                    .ok_or_else(|| SpellcastError::user("这块回复已经不在板上。"))?;
                if event
                    .source_id
                    .as_deref()
                    .is_some_and(|source| source != reply.source_id)
                {
                    return Err(SpellcastError::user(
                        "这块回复属于另一个任务；没有把输入转交给其他来源。",
                    ));
                }
                if let Some(block_id) = &event.block_id {
                    if !reply.blocks.iter().any(|b| b.id() == block_id) {
                        return Err(SpellcastError::user("这段内容已经不在回复里。"));
                    }
                }
            } else if let Some(node_id) = &event.node_id {
                let node = state
                    .session
                    .board
                    .nodes
                    .iter_mut()
                    .find(|node| &node.id == node_id)
                    .ok_or_else(|| SpellcastError::user("这块想法已经不在画布上。"))?;
                if let Some(source) = &event.source_id {
                    if node
                        .source_id
                        .as_ref()
                        .is_some_and(|existing| existing != source)
                    {
                        return Err(SpellcastError::user("这块想法属于另一个任务。"));
                    }
                    if node.source_id.is_none() {
                        node.source_id = Some(source.clone());
                    }
                }
            }
            state
                .session
                .note_user(event.text.as_deref().unwrap_or_default());
            let event = state.record(event);
            state.stamp_request(event.seq, request_hash);
            Ok(event)
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
                    let known = state.bubble_sources.contains_key(&bubble.id)
                        || state.bubble_captures.contains_key(&bubble.id);
                    let source_id = if known {
                        state.bubble_sources.get(&bubble.id).cloned()
                    } else {
                        bubble.source_id.clone()
                    };
                    let captured = state.bubble_captures.get(&bubble.id).cloned();
                    state.session.add_node_captured(
                        NodeDraft {
                            source_id,
                            title,
                            body,
                            kind: Some(bubble.kind.as_str().to_string()),
                            weight: Some("note".into()),
                            ..Default::default()
                        },
                        captured,
                    )
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
        let request_hash = feedback::fingerprint("node", &(id, &patch))?;
        let request_id = patch.request_id.clone();
        let moved_only = patch.title.is_none()
            && patch.body.is_none()
            && patch.kind.is_none()
            && patch.weight.is_none();
        let node = self.update(|state| {
            if self
                .replay_request(state, request_id.as_deref(), &request_hash)?
                .is_some()
            {
                return state
                    .session
                    .board
                    .nodes
                    .iter()
                    .find(|n| n.id == id)
                    .cloned()
                    .ok_or_else(|| SpellcastError::user("请求已保存，但原想法已被删除。"));
            }
            let old_revision = state
                .session
                .board
                .nodes
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.revision);
            let node = state.session.patch_node(id, patch)?;
            if !moved_only && old_revision != Some(node.revision) {
                state.session.sync_canvas();
                if let Some(object) = state.session.board.canvas.objects.iter_mut().find(|o| matches!(&o.content, spellcast_core::CanvasContent::Node { id: content_id } if content_id == id)) {
                    object.user_edited = true;
                }
            }
            let delivered_edit = old_revision != Some(node.revision) && node.source_id.is_some();
            if delivered_edit {
                let mut event = AgentEvent::new("canvas_state")
                    .source(node.source_id.clone())
                    .node(Some(node.id.clone()))
                    .title(node.title.clone())
                    .text("已在画布保存想法修改，尚未发送。");
                event.request_id = request_id;
                let event = state.record(event);
                state.stamp_request(event.seq, request_hash);
            }
            // Dragging a card around is not something the agent needs to hear about.
            if !moved_only && !delivered_edit {
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    static NEXT_DB: AtomicUsize = AtomicUsize::new(0);

    pub(super) fn temp_db() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "spellcast-state-test-{}-{}.sqlite3",
            std::process::id(),
            NEXT_DB.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[derive(Default)]
    pub(super) struct Recording {
        pub(super) thrown: Mutex<Vec<ThrownBubble>>,
        pub(super) board_focused: AtomicBool,
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
            self.board_focused.store(true, Ordering::SeqCst);
        }
        fn board_is_focused(&self) -> bool {
            self.board_focused.load(Ordering::SeqCst)
        }
    }

    pub(super) fn bridge() -> (Arc<Bridge>, Arc<Recording>) {
        let rec = Arc::new(Recording::default());
        (Arc::new(Bridge::new(rec.clone(), 0)), rec)
    }

    #[test]
    fn observer_fields_missing_from_old_state_are_off() {
        let value = serde_json::to_value(PersistedState::default()).unwrap();
        let mut obj = value.as_object().unwrap().clone();
        obj.remove("observer_enabled");
        obj.remove("observer_policy_revision");
        let restored: PersistedState =
            serde_json::from_value(serde_json::Value::Object(obj)).unwrap();
        assert!(!restored.observer_enabled);
        assert_eq!(restored.observer_policy_revision, 0);
        assert!(!restored.paused);
        assert!(value.get("bubble_sources").is_none());
        assert!(value.get("bubble_captures").is_none());
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
        assert!(bridge
            .patch_node(
                &node.id,
                NodePatch {
                    expected_revision: Some(0),
                    body: Some("stale".into()),
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(bridge.board().nodes[0].title, "y");
        assert_eq!(bridge.board().nodes[0].revision, 1);
        assert!(bridge
            .patch_node(
                &node.id,
                NodePatch {
                    expected_revision: Some(1),
                    body: Some("x".repeat(64_001)),
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(bridge.board().nodes[0].revision, 1);
    }

    fn observer_snapshot(source: &str, change: &str) -> crate::observer::CheckpointRequest {
        crate::observer::CheckpointRequest {
            source_id: source.into(),
            snapshot: Some(crate::observer::ProjectSnapshot {
                checkpoint_id: change.into(),
                project: "calendar".into(),
                goal: "A realistic week".into(),
                change: change.into(),
                facts: vec!["Friday demo at 15:00".into()],
            }),
        }
    }

    fn sample_binding(source: &str, thread: &str) -> crate::codex::CodexBinding {
        crate::codex::CodexBinding {
            source_id: source.into(),
            thread_id: thread.into(),
            cwd: "/tmp/isolated-proj".into(),
            label: "codex".into(),
            executable: std::path::PathBuf::from("/bin/true"),
            protocol_agent: "codex".into(),
            bound_at_ms: 1,
        }
    }

    #[test]
    fn observer_capture_roundtrip_keep_persist_and_guards() {
        let path = temp_db();
        let rec = Arc::new(Recording::default());
        let expected = {
            let bridge = Bridge::open(rec.clone(), 0, &path).unwrap();
            bridge.set_observer_enabled(true).unwrap();
            bridge
                .update(|state| {
                    state.bindings.push(sample_binding("other-source", "wrong-thread"));
                    Ok(())
                })
                .unwrap();
            let brief = bridge
                .checkpoint(observer_snapshot("calendar-task", "Lunch resolved"))
                .unwrap()
                .brief
                .unwrap();
            let result = bridge
                .complete_observation(crate::observer::ObserverCompletion {
                    observer_id: brief.observer_id,
                    thought: Some(crate::observer::ObserverThought {
                        tease: "Leave Friday afternoon empty.".into(),
                        body: "The demo is 15:00; a free hour can stay free.".into(),
                        kind: None,
                        shape: None,
                    }),
                })
                .unwrap();
            assert_eq!(result.status, "accepted");
            let thrown = rec.thrown.lock().unwrap()[0].clone();
            let encoded = serde_json::to_string(&thrown).unwrap();
            let restored: ThrownBubble = serde_json::from_str(&encoded).unwrap();
            assert_eq!(
                restored.captured_context.as_ref().map(|c| c.source_id.as_str()),
                Some("calendar-task")
            );
            assert_eq!(
                restored.captured_context.as_ref().map(|c| c.project.as_str()),
                Some("calendar")
            );
            assert_eq!(
                restored.captured_context.as_ref().map(|c| c.change.as_str()),
                Some("Lunch resolved")
            );
            assert!(restored
                .captured_context
                .as_ref()
                .unwrap()
                .thread_id
                .is_none());
            assert!(restored.captured_context.as_ref().unwrap().cwd.is_none());
            let value = serde_json::to_value(&restored).unwrap();
            assert!(value["captured_context"].get("facts").is_none());
            let (node, _) = bridge.keep(&restored).unwrap();
            assert_eq!(node.captured_context, restored.captured_context);
            node.captured_context
        };

        {
            let restored = Bridge::open(Headless, 0, &path).unwrap();
            assert_eq!(restored.board().nodes.len(), 1);
            assert_eq!(restored.board().nodes[0].captured_context, expected);
            assert_eq!(restored.board().nodes[0].title, "Leave Friday afternoon empty.");
        }

        let rec2 = Arc::new(Recording::default());
        let bridge = Bridge::open(rec2.clone(), 0, &path).unwrap();
        bridge.set_observer_enabled(true).unwrap();
        bridge
            .update(|state| {
                state.bindings.push(sample_binding("calendar-task", "thread-real"));
                Ok(())
            })
            .unwrap();
        let brief = bridge
            .checkpoint(observer_snapshot("calendar-task", "Open buffer"))
            .unwrap()
            .brief
            .unwrap();
        bridge
            .complete_observation(crate::observer::ObserverCompletion {
                observer_id: brief.observer_id,
                thought: Some(crate::observer::ObserverThought {
                    tease: "Keep the buffer.".into(),
                    body: String::new(),
                    kind: None,
                    shape: None,
                }),
            })
            .unwrap();
        let matched = rec2.thrown.lock().unwrap().last().cloned().unwrap();
        assert_eq!(
            matched.captured_context.as_ref().and_then(|c| c.thread_id.as_deref()),
            Some("thread-real")
        );
        assert_eq!(
            matched.captured_context.as_ref().and_then(|c| c.cwd.as_deref()),
            Some("/tmp/isolated-proj")
        );

        let existing_id = bridge.board().nodes[0].id.clone();
        let original_context = bridge.board().nodes[0].captured_context.clone();
        bridge
            .patch_node(
                &existing_id,
                NodePatch {
                    title: Some("用户改过的标题".into()),
                    body: Some("用户改过的正文".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut hijack = matched.clone();
        hijack.node_id = Some(existing_id.clone());
        hijack.title = "旁念想覆盖".into();
        hijack.body = "旁念想覆盖正文".into();
        hijack.captured_context = Some(spellcast_core::CapturedContext {
            project: "other".into(),
            goal: "no".into(),
            change: "no".into(),
            source_id: "other-source".into(),
            captured_at_ms: 9,
            thread_id: Some("wrong-thread".into()),
            cwd: Some("/tmp/wrong".into()),
        });
        let kept = bridge.keep(&hijack).unwrap().0;
        assert_eq!(kept.id, existing_id);
        assert_eq!(kept.title, "用户改过的标题");
        assert_eq!(kept.body, "用户改过的正文");
        assert_eq!(kept.captured_context, original_context);

        let after_patch = bridge
            .patch_node(
                &existing_id,
                NodePatch {
                    title: Some("再次改标题".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(after_patch.title, "再次改标题");
        assert_eq!(after_patch.captured_context, original_context);

        let ordinary = bridge
            .bubble_now(BubbleRequest {
                tease: "普通气泡".into(),
                ..Default::default()
            })
            .unwrap();
        assert!(ordinary.bubble.captured_context.is_none());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn null_stale_and_off_do_not_create_captured_nodes() {
        let (bridge, surface) = bridge();
        bridge.set_observer_enabled(true).unwrap();
        let silent = bridge
            .checkpoint(observer_snapshot("a", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        assert_eq!(
            bridge
                .complete_observation(crate::observer::ObserverCompletion {
                    observer_id: silent.observer_id,
                    thought: None,
                })
                .unwrap()
                .status,
            "silent"
        );
        assert!(surface.thrown.lock().unwrap().is_empty());
        assert!(bridge.board().nodes.is_empty());

        assert_eq!(
            bridge
                .complete_observation(crate::observer::ObserverCompletion {
                    observer_id: "missing".into(),
                    thought: Some(crate::observer::ObserverThought {
                        tease: "no".into(),
                        body: String::new(),
                        kind: None,
                        shape: None,
                    }),
                })
                .unwrap()
                .status,
            "stale"
        );
        assert!(bridge.board().nodes.is_empty());

        let brief = bridge
            .checkpoint(observer_snapshot("b", "Open buffer"))
            .unwrap()
            .brief
            .unwrap();
        bridge.set_observer_enabled(false).unwrap();
        assert_eq!(
            bridge
                .complete_observation(crate::observer::ObserverCompletion {
                    observer_id: brief.observer_id,
                    thought: Some(crate::observer::ObserverThought {
                        tease: "should not land".into(),
                        body: String::new(),
                        kind: None,
                        shape: None,
                    }),
                })
                .unwrap()
                .status,
            "stale"
        );
        assert!(surface.thrown.lock().unwrap().is_empty());
        assert!(bridge.board().nodes.is_empty());
    }

    #[test]
    fn persisted_nodes_without_context_are_not_backfilled() {
        let json = serde_json::json!({
            "id": "old",
            "title": "旧点子",
            "body": "用户原文",
            "kind": "idea",
            "weight": "note",
            "x": 0,
            "y": 0,
            "z": 0
        });
        let node: BoardNode = serde_json::from_value(json).unwrap();
        assert!(node.captured_context.is_none());
        let encoded = serde_json::to_value(&node).unwrap();
        assert!(encoded.get("captured_context").is_none());
    }

    fn evil_context() -> spellcast_core::CapturedContext {
        spellcast_core::CapturedContext {
            project: "forged".into(),
            goal: "no".into(),
            change: "no".into(),
            source_id: "forged-source".into(),
            captured_at_ms: 9,
            thread_id: Some("wrong-thread".into()),
            cwd: Some("/tmp/wrong".into()),
        }
    }

    fn throw_observer(bridge: &Bridge, source: &str, change: &str, tease: &str) -> String {
        bridge.set_observer_enabled(true).unwrap();
        let brief = bridge
            .checkpoint(observer_snapshot(source, change))
            .unwrap()
            .brief
            .unwrap();
        let result = bridge
            .complete_observation(crate::observer::ObserverCompletion {
                observer_id: brief.observer_id,
                thought: Some(crate::observer::ObserverThought {
                    tease: tease.into(),
                    body: format!("{tease} body"),
                    kind: None,
                    shape: None,
                }),
            })
            .unwrap();
        assert_eq!(result.status, "accepted");
        result.bubble_id.expect("dispatched bubble")
    }

    struct ThrowCount(usize);
    impl Surface for ThrowCount {
        fn agent_seen(&self, _: &str) {}
        fn throw(&self, bubbles: &[ThrownBubble]) -> Result<usize, String> {
            Ok(self.0.min(bubbles.len()))
        }
        fn presented(&self, _: &PresentResult) {}
        fn board_changed(&self) {}
        fn close_bubbles(&self) {}
        fn focus(&self) {}
    }

    #[test]
    fn keep_uses_server_capture_map_and_cleans_failures() {
        let (host, rec) = bridge();
        let id_a = throw_observer(&host, "calendar-task", "Lunch resolved", "Keep Friday free");
        let thrown_a = rec
            .thrown
            .lock()
            .unwrap()
            .iter()
            .find(|bubble| bubble.id == id_a)
            .cloned()
            .unwrap();
        let (source, captured) = host.test_bubble_maps(&thrown_a.id);
        assert_eq!(source.as_deref(), thrown_a.source_id.as_deref());
        assert_eq!(captured, thrown_a.captured_context);
        assert_eq!(
            captured.as_ref().map(|item| item.project.as_str()),
            Some("calendar")
        );

        let kept_legal = host.keep(&thrown_a).unwrap().0;
        assert_eq!(kept_legal.captured_context, thrown_a.captured_context);
        assert_eq!(kept_legal.source_id, thrown_a.source_id);
        let original = kept_legal.captured_context.clone();

        let mut repeat = thrown_a.clone();
        repeat.title = "overwrite".into();
        repeat.body = "overwrite".into();
        repeat.captured_context = Some(evil_context());
        repeat.source_id = Some("forged-source".into());
        let kept_repeat = host.keep(&repeat).unwrap().0;
        assert_eq!(kept_repeat.id, kept_legal.id);
        assert_eq!(kept_repeat.title, kept_legal.title);
        assert_eq!(kept_repeat.body, kept_legal.body);
        assert_eq!(kept_repeat.captured_context, original);

        let id_b = throw_observer(&host, "other-source", "Other change", "Other tease");
        let thrown_b = rec
            .thrown
            .lock()
            .unwrap()
            .iter()
            .find(|bubble| bubble.id == id_b)
            .cloned()
            .unwrap();
        let mut cross = thrown_b.clone();
        cross.captured_context = thrown_a.captured_context.clone();
        cross.source_id = thrown_a.source_id.clone();
        let kept_cross = host.keep(&cross).unwrap().0;
        assert_eq!(kept_cross.captured_context, thrown_b.captured_context);
        assert_eq!(kept_cross.source_id, thrown_b.source_id);
        assert_eq!(
            kept_cross.captured_context.as_ref().map(|item| item.source_id.as_str()),
            Some("other-source")
        );
        assert_ne!(kept_cross.source_id, thrown_a.source_id);

        let mut forged_known = thrown_b.clone();
        forged_known.id = "fresh-known-clone".into();
        // unknown id: client capture must not persist
        forged_known.node_id = None;
        forged_known.captured_context = Some(evil_context());
        let unknown = host.keep(&forged_known).unwrap().0;
        assert!(unknown.captured_context.is_none());
        assert_eq!(unknown.title, forged_known.title);

        let mut tamper = thrown_a.clone();
        tamper.node_id = None;
        // already kept via bubble id map — existing node path
        tamper.captured_context = Some(evil_context());
        tamper.source_id = Some("forged-source".into());
        assert_eq!(host.keep(&tamper).unwrap().0.captured_context, original);

        let headless = Bridge::new(Headless, 0);
        headless.set_observer_enabled(true).unwrap();
        let brief = headless
            .checkpoint(observer_snapshot("calendar-task", "Headless fail"))
            .unwrap()
            .brief
            .unwrap();
        let failed = headless
            .complete_observation(crate::observer::ObserverCompletion {
                observer_id: brief.observer_id,
                thought: Some(crate::observer::ObserverThought {
                    tease: "failed throw".into(),
                    body: "failed throw body".into(),
                    kind: None,
                    shape: None,
                }),
            })
            .unwrap();
        assert_eq!(failed.status, "not_shown");
        let failed_id = failed.bubble_id.unwrap();
        assert!(headless.test_bubble_maps(&failed_id).1.is_none());
        let outcome = headless
            .bubble_now_captured(
                BubbleRequest {
                    tease: "direct fail".into(),
                    body: Some("direct fail body".into()),
                    source_id: Some("calendar-task".into()),
                    wait: Some(0),
                    ..Default::default()
                },
                Some(evil_context()),
            )
            .unwrap();
        assert_eq!(outcome.outcome, "not_shown");
        assert!(headless.test_bubble_maps(&outcome.bubble.id).1.is_none());
        let mut forged_fail = outcome.bubble.clone();
        forged_fail.captured_context = Some(evil_context());
        assert!(headless.keep(&forged_fail).unwrap().0.captured_context.is_none());

        let partial = Bridge::new(ThrowCount(0), 0);
        partial.set_observer_enabled(true).unwrap();
        let brief = partial
            .checkpoint(observer_snapshot("calendar-task", "Partial skip"))
            .unwrap()
            .brief
            .unwrap();
        let skipped = partial
            .complete_observation(crate::observer::ObserverCompletion {
                observer_id: brief.observer_id,
                thought: Some(crate::observer::ObserverThought {
                    tease: "partial".into(),
                    body: "partial body".into(),
                    kind: None,
                    shape: None,
                }),
            })
            .unwrap();
        assert_eq!(skipped.status, "not_shown");
        let skipped_id = skipped.bubble_id.unwrap();
        assert!(partial.test_bubble_maps(&skipped_id).0.is_none());
        assert!(partial.test_bubble_maps(&skipped_id).1.is_none());

        let (live, rec_live) = bridge();
        let live_id = throw_observer(&live, "calendar-task", "Dismiss me", "dismiss tease");
        let live_bubble = rec_live
            .thrown
            .lock()
            .unwrap()
            .iter()
            .find(|bubble| bubble.id == live_id)
            .cloned()
            .unwrap();
        assert!(live.test_bubble_maps(&live_id).1.is_some());
        live.dismiss(&live_id).unwrap();
        assert!(live.test_bubble_maps(&live_id).1.is_none());
        let mut after_dismiss = live_bubble.clone();
        after_dismiss.node_id = None;
        after_dismiss.captured_context = Some(evil_context());
        assert!(live.keep(&after_dismiss).unwrap().0.captured_context.is_none());

        let (exp, rec_exp) = bridge();
        let exp_id = throw_observer(&exp, "calendar-task", "Expire me", "expire tease");
        let exp_bubble = rec_exp
            .thrown
            .lock()
            .unwrap()
            .iter()
            .find(|bubble| bubble.id == exp_id)
            .cloned()
            .unwrap();
        exp.user_event(AgentEvent::new("expired").bubble(exp_id.clone()))
            .unwrap();
        assert!(exp.test_bubble_maps(&exp_id).1.is_none());
        let mut after_exp = exp_bubble.clone();
        after_exp.node_id = None;
        after_exp.captured_context = Some(evil_context());
        assert!(exp.keep(&after_exp).unwrap().0.captured_context.is_none());

        let (hidden, rec_hidden) = bridge();
        let hidden_id = throw_observer(&hidden, "calendar-task", "Hide me", "hide tease");
        let hidden_bubble = rec_hidden
            .thrown
            .lock()
            .unwrap()
            .iter()
            .find(|bubble| bubble.id == hidden_id)
            .cloned()
            .unwrap();
        hidden
            .user_event(AgentEvent::new("not_shown").bubble(hidden_id.clone()))
            .unwrap();
        assert!(hidden.test_bubble_maps(&hidden_id).1.is_none());
        let mut after_hidden = hidden_bubble.clone();
        after_hidden.node_id = None;
        after_hidden.captured_context = Some(evil_context());
        assert!(hidden
            .keep(&after_hidden)
            .unwrap()
            .0
            .captured_context
            .is_none());
    }
}
#[cfg(test)]
mod image_reference_tests;

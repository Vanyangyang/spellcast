//! Explicit, leased non-Codex hosts. Credentials live only in this volatile registry.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spellcast_core::{AgentEvent, HostRoutePin, ReplyBlock, ReplyRequest, SpellcastError};

use crate::feedback::{DeliveryPhase, DeliveryReceipt};
use crate::Bridge;

const LEASE_MS: u64 = 30_000;
const MAX_HOSTS: usize = 256;
const MAX_RESPONSE_CHARS: usize = 16_000;
/// A focus request is a click that just happened; one that waits longer must not yank the window later.
const FOCUS_MS: u64 = 8_000;

fn truncation_note() -> &'static str {
    "这份画布回复已截断（最多 16,000 个字符）；完整结果保存在原 GUI 会话。"
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostRegistration {
    pub source_id: String,
    pub client: String,
    pub engine: String,
    pub native_session_id: String,
    pub gui_session_id: String,
    pub cwd: String,
    pub client_instance_id: String,
    pub window_id: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostStatus {
    pub host_pin: HostRoutePin,
    pub label: String,
    pub capabilities: Vec<String>,
    pub active: bool,
    pub reachable: bool,
    pub last_seen_ms: u64,
    pub expires_at_ms: u64,
    /// When the host last attested explicit attention (chat selected, or its window focused); 0 = never.
    pub attention_at_ms: u64,
}

// Deliberately not Debug. This is the sole response that exposes a new credential.
#[derive(Serialize)]
pub struct RegisteredHost {
    pub host_pin: HostRoutePin,
    pub lease_token: String,
    pub expires_at_ms: u64,
    pub heartbeat_interval_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostHeartbeat {
    pub host_pin: HostRoutePin,
    /// True attests an explicit host attention event; false is liveness only.
    pub active: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostReceipt {
    pub receipt_seq: u64,
    pub request_id: String,
    pub event_seq: u64,
    pub host_pin: HostRoutePin,
    pub phase: DeliveryPhase,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Serialize)]
pub struct HostRequest {
    pub event: AgentEvent,
    pub phase: DeliveryPhase,
    pub notice: String,
}

/// Ask the host to bring this lease's conversation to the front. Delivered with the request poll.
#[derive(Clone, Serialize)]
pub struct HostFocus {
    pub id: String,
}

#[derive(Clone)]
struct FocusRequest {
    id: String,
    requested: Instant,
    requested_ms: u64,
}

/// What a caller needs to follow one focus request to its end.
#[derive(Debug, Clone)]
pub struct FocusTicket {
    lease_id: String,
    requested_ms: u64,
}

#[derive(Serialize)]
pub struct HostRequests {
    pub requests: Vec<HostRequest>,
    pub last_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<HostFocus>,
}

#[derive(Clone)]
struct Lease {
    status: HostStatus,
    token_hash: [u8; 32],
    expires: Instant,
    closed: bool,
    focus: Option<FocusRequest>,
}

#[derive(Clone)]
pub(crate) struct HostRegistry {
    bootstrap_hash: Option<[u8; 32]>,
    leases: HashMap<String, Lease>,
    generation: u64,
    ttl_ms: u64,
    #[cfg(test)]
    pub(crate) clock_offset: Duration,
}

impl Default for HostRegistry {
    fn default() -> Self {
        Self {
            bootstrap_hash: None,
            leases: HashMap::new(),
            generation: 0,
            ttl_ms: LEASE_MS,
            #[cfg(test)]
            clock_offset: Duration::ZERO,
        }
    }
}

fn hash(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}
fn matches_secret(expected: &[u8; 32], actual: &str) -> bool {
    let actual = hash(actual);
    expected
        .iter()
        .zip(actual.iter())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
fn auth_error() -> SpellcastError {
    SpellcastError::user("宿主认证无效或租约已过期。")
}
fn identity(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}

fn expired_delivery(hosts: &HostRegistry, receipt: &DeliveryReceipt) -> bool {
    receipt.event.host_pin.as_ref().is_some_and(|pin| {
        hosts
            .validate_pin(pin, receipt.event.source_id.as_deref())
            .is_err()
    }) && matches!(
        receipt.phase,
        DeliveryPhase::Waiting
            | DeliveryPhase::Queued
            | DeliveryPhase::Received
            | DeliveryPhase::Executing
            | DeliveryPhase::AwaitingPermission
    )
}

impl HostRegistry {
    pub(crate) fn with_generation(generation: u64) -> Self {
        Self {
            generation,
            ..Self::default()
        }
    }
    fn now(&self) -> Instant {
        #[cfg(test)]
        {
            Instant::now() + self.clock_offset
        }
        #[cfg(not(test))]
        {
            Instant::now()
        }
    }
    fn live(&self, lease: &Lease) -> bool {
        !lease.closed && self.now() < lease.expires
    }
    fn authenticate(&self, token: &str, lease_id: &str) -> Result<&Lease, SpellcastError> {
        self.leases
            .get(lease_id)
            .filter(|lease| self.live(lease) && matches_secret(&lease.token_hash, token))
            .ok_or_else(auth_error)
    }
    fn bootstrap(&self, token: &str) -> bool {
        self.bootstrap_hash
            .as_ref()
            .is_some_and(|secret| matches_secret(secret, token))
    }
    pub(crate) fn validate_pin(
        &self,
        pin: &HostRoutePin,
        source: Option<&str>,
    ) -> Result<(), SpellcastError> {
        if source != Some(pin.source_id.as_str())
            || !self
                .leases
                .get(&pin.lease_id)
                .is_some_and(|lease| self.live(lease) && &lease.status.host_pin == pin)
        {
            return Err(SpellcastError::user(
                "宿主目标与原来源或有效租约不一致，没有发送。",
            ));
        }
        Ok(())
    }
    fn status(&self, lease: &Lease) -> HostStatus {
        let mut status = lease.status.clone();
        status.reachable = self.live(lease);
        status.active &= status.reachable;
        status
    }
    fn focus_for(&self, lease: &Lease) -> Option<HostFocus> {
        lease
            .focus
            .as_ref()
            .filter(|focus| {
                self.now().saturating_duration_since(focus.requested)
                    < Duration::from_millis(FOCUS_MS)
            })
            .map(|focus| HostFocus {
                id: focus.id.clone(),
            })
    }
    pub(crate) fn statuses_for(&self, source: &str) -> Vec<HostStatus> {
        let mut result: Vec<_> = self
            .leases
            .values()
            .filter(|lease| lease.status.host_pin.source_id == source)
            .map(|lease| self.status(lease))
            .collect();
        result.sort_by_key(|status| status.host_pin.generation);
        result
    }
    fn active(&mut self, pin: &HostRoutePin, active: bool) {
        // Timed liveness reports cannot clear or steal explicit host attention.
        if !active {
            return;
        }
        if active {
            for lease in self.leases.values_mut() {
                let other = &lease.status.host_pin;
                if other.client == pin.client
                    && other.client_instance_id == pin.client_instance_id
                    && other.window_id == pin.window_id
                {
                    lease.status.active = false;
                }
            }
        }
        if let Some(lease) = self.leases.get_mut(&pin.lease_id) {
            lease.status.active = active;
            // Attention on the chat is the answer to a pending focus request.
            lease.status.attention_at_ms = spellcast_core::inbox::now_ms();
            lease.focus = None;
        }
    }
}

impl Bridge {
    /// Native bootstrap config only. Never persisted or exposed by generic status APIs.
    pub fn configure_host_bootstrap_secret(&self, secret: &str) -> Result<(), SpellcastError> {
        if secret.len() < 32 || secret.len() > 512 || secret.chars().any(char::is_control) {
            return Err(SpellcastError::user(
                "宿主 bootstrap secret 必须是 32–512 字节随机凭据。",
            ));
        }
        self.hosts.lock().unwrap().bootstrap_hash = Some(hash(secret));
        Ok(())
    }

    pub fn register_host(
        &self,
        token: &str,
        request: HostRegistration,
    ) -> Result<RegisteredHost, SpellcastError> {
        let mut hosts = self.hosts.lock().unwrap();
        if !hosts.bootstrap(token) {
            return Err(auth_error());
        }
        if request.engine != "claude"
            || !canonical_uuid(&request.native_session_id)
            || request.source_id != format!("claude:{}", request.native_session_id)
            || !canonical_uuid(&request.gui_session_id)
            || request.client.is_empty()
            || request.client.len() > 64
            || !request
                .client
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
            || !identity(&request.cwd, 4096)
            || !identity(&request.client_instance_id, 160)
            || !identity(&request.window_id, 160)
            || request.label.len() > 160
            || request.label.chars().any(char::is_control)
            || request.capabilities.len() != 2
            || !request.capabilities.iter().any(|c| c == "canvas_requests")
            || !request.capabilities.iter().any(|c| c == "durable_receipts")
        {
            return Err(SpellcastError::user(
                "宿主会话描述或能力无效；需要精确 Claude/GUI UUID 与 durable_receipts。",
            ));
        }
        let generation = hosts
            .generation
            .checked_add(1)
            .ok_or_else(|| SpellcastError::user("宿主代数已达上限。"))?;
        let pin = HostRoutePin {
            source_id: request.source_id,
            client: request.client,
            engine: request.engine,
            native_session_id: request.native_session_id,
            gui_session_id: request.gui_session_id,
            cwd: request.cwd,
            client_instance_id: request.client_instance_id,
            window_id: request.window_id,
            lease_id: uuid::Uuid::new_v4().to_string(),
            generation,
        };
        let lease_token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let now = spellcast_core::inbox::now_ms();
        let expires_at_ms = now.saturating_add(hosts.ttl_ms);
        let expires = hosts.now() + Duration::from_millis(hosts.ttl_ms);
        let mut candidate = hosts.clone();
        // Reconnect closes only the same GUI identity, without migrating its frozen requests.
        for lease in candidate.leases.values_mut() {
            let old = &lease.status.host_pin;
            if old.client == pin.client
                && old.client_instance_id == pin.client_instance_id
                && old.window_id == pin.window_id
                && old.gui_session_id == pin.gui_session_id
            {
                lease.closed = true;
                lease.status.active = false;
            }
        }
        // Historical route pins live in the durable ledger. Closed/expired runtime
        // credentials must not consume capacity or become eligible for rerouting.
        let current_instant = candidate.now();
        candidate
            .leases
            .retain(|_, lease| !lease.closed && current_instant < lease.expires);
        if candidate.leases.len() >= MAX_HOSTS {
            return Err(SpellcastError::user("有效宿主租约数量已达上限。"));
        }
        candidate.generation = generation;
        candidate.leases.insert(
            pin.lease_id.clone(),
            Lease {
                status: HostStatus {
                    host_pin: pin.clone(),
                    label: request.label,
                    capabilities: request.capabilities,
                    active: false,
                    reachable: true,
                    last_seen_ms: now,
                    expires_at_ms,
                    attention_at_ms: 0,
                },
                token_hash: hash(&lease_token),
                expires,
                closed: false,
                focus: None,
            },
        );
        candidate.active(&pin, request.active);
        self.update(|state| {
            state.host_generation = generation;
            for receipt in &mut state.deliveries {
                if expired_delivery(&candidate, receipt) {
                    receipt.phase = DeliveryPhase::Unknown;
                    receipt.error =
                        Some("原宿主租约已失联或关闭；请求与原路由已保留，没有自动重发。".into());
                }
            }
            Ok(())
        })?;
        *hosts = candidate;
        drop(hosts);
        self.surface.board_changed();
        self.notify.notify_waiters();
        Ok(RegisteredHost {
            host_pin: pin,
            lease_token,
            expires_at_ms,
            heartbeat_interval_ms: 10_000,
        })
    }

    pub fn heartbeat_host(
        &self,
        token: &str,
        request: HostHeartbeat,
    ) -> Result<HostStatus, SpellcastError> {
        let mut hosts = self.hosts.lock().unwrap();
        hosts.authenticate(token, &request.host_pin.lease_id)?;
        hosts.validate_pin(&request.host_pin, Some(&request.host_pin.source_id))?;
        let expires = hosts.now() + Duration::from_millis(hosts.ttl_ms);
        let expires_at_ms = spellcast_core::inbox::now_ms().saturating_add(hosts.ttl_ms);
        let lease = hosts.leases.get_mut(&request.host_pin.lease_id).unwrap();
        lease.expires = expires;
        lease.status.expires_at_ms = expires_at_ms;
        lease.status.last_seen_ms = spellcast_core::inbox::now_ms();
        hosts.active(&request.host_pin, request.active);
        self.refresh_host_deliveries_locked(&hosts)?;
        Ok(hosts.status(hosts.leases.get(&request.host_pin.lease_id).unwrap()))
    }

    /// The latest explicit attention among live hosts of `source`; `None` when no live host reports for it.
    /// Opening the chat or focusing its window after a task finished means the result was seen.
    pub fn host_attention(&self, source: &str) -> Option<u64> {
        let hosts = self.hosts.lock().unwrap();
        hosts
            .leases
            .values()
            .filter(|lease| hosts.live(lease) && lease.status.host_pin.source_id == source)
            .map(|lease| lease.status.attention_at_ms)
            .max()
    }

    /// Ask the live host of `source` to bring its conversation forward. With several live leases the one
    /// with the latest attention wins, then the newest registration.
    pub fn request_host_focus(&self, source: &str) -> Result<FocusTicket, SpellcastError> {
        let mut hosts = self.hosts.lock().unwrap();
        let now = hosts.now();
        let lease_id = hosts
            .leases
            .values()
            .filter(|lease| hosts.live(lease) && lease.status.host_pin.source_id == source)
            .max_by_key(|lease| (lease.status.attention_at_ms, lease.status.host_pin.generation))
            .map(|lease| lease.status.host_pin.lease_id.clone())
            .ok_or_else(|| SpellcastError::user("没有已连接的 CC GUI 会话。"))?;
        let requested_ms = spellcast_core::inbox::now_ms();
        hosts.leases.get_mut(&lease_id).unwrap().focus = Some(FocusRequest {
            id: uuid::Uuid::new_v4().to_string(),
            requested: now,
            requested_ms,
        });
        drop(hosts);
        self.notify.notify_waiters();
        Ok(FocusTicket {
            lease_id,
            requested_ms,
        })
    }

    /// True once the host attested attention on that conversation after the request was made.
    pub fn host_focus_acked(&self, ticket: &FocusTicket) -> bool {
        let hosts = self.hosts.lock().unwrap();
        hosts.leases.get(&ticket.lease_id).is_some_and(|lease| {
            hosts.live(lease) && lease.status.attention_at_ms > ticket.requested_ms
        })
    }

    pub fn host_status(&self, token: &str) -> Result<Vec<HostStatus>, SpellcastError> {
        let hosts = self.hosts.lock().unwrap();
        if !hosts.bootstrap(token)
            && !hosts
                .leases
                .values()
                .any(|lease| hosts.live(lease) && matches_secret(&lease.token_hash, token))
        {
            return Err(auth_error());
        }
        self.refresh_host_deliveries_locked(&hosts)?;
        let mut result: Vec<_> = hosts
            .leases
            .values()
            .map(|lease| hosts.status(lease))
            .collect();
        result.sort_by_key(|status| status.host_pin.generation);
        Ok(result)
    }

    fn refresh_host_deliveries_locked(&self, hosts: &HostRegistry) -> Result<(), SpellcastError> {
        let expired = |receipt: &DeliveryReceipt| expired_delivery(hosts, receipt);
        if !self.state.lock().unwrap().deliveries.iter().any(expired) {
            return Ok(());
        }
        self.update(|state| {
            for receipt in &mut state.deliveries {
                if expired(receipt) {
                    receipt.phase = DeliveryPhase::Unknown;
                    receipt.error =
                        Some("原宿主租约已失联或关闭；请求与原路由已保留，没有自动重发。".into());
                }
            }
            Ok(())
        })?;
        self.surface.board_changed();
        Ok(())
    }

    pub(crate) fn refresh_host_deliveries(&self) -> Result<(), SpellcastError> {
        self.refresh_host_deliveries_locked(&self.hosts.lock().unwrap())
    }

    pub async fn host_requests(
        &self,
        token: &str,
        lease_id: &str,
        since: u64,
        wait_ms: u64,
    ) -> Result<HostRequests, SpellcastError> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms.min(25_000));
        loop {
            let notified = self.notify.notified();
            let result = {
                let hosts = self.hosts.lock().unwrap();
                let lease = hosts.authenticate(token, lease_id)?;
                self.refresh_host_deliveries_locked(&hosts)?;
                let state = self.state.lock().unwrap();
                let requests: Vec<_> = state
                    .deliveries
                    .iter()
                    .filter(|receipt| {
                        receipt.event.seq > since
                            && receipt.event.host_pin.as_ref() == Some(&lease.status.host_pin)
                            && receipt.phase == DeliveryPhase::Queued
                    })
                    .take(64)
                    .map(|receipt| HostRequest {
                        event: receipt.event.clone(),
                        phase: receipt.phase,
                        notice: receipt.notice.clone(),
                    })
                    .collect();
                let last_seq = requests
                    .last()
                    .map_or(state.inbox.last_seq(), |request| request.event.seq);
                HostRequests {
                    requests,
                    last_seq,
                    focus: hosts.focus_for(lease),
                }
            };
            if !result.requests.is_empty()
                || result.focus.is_some()
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(result);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                // One final authenticated read also checks TTL after a bounded wait.
                return self.host_requests_now(token, lease_id, since);
            }
        }
    }

    fn host_requests_now(
        &self,
        token: &str,
        lease_id: &str,
        since: u64,
    ) -> Result<HostRequests, SpellcastError> {
        let hosts = self.hosts.lock().unwrap();
        let lease = hosts.authenticate(token, lease_id)?;
        self.refresh_host_deliveries_locked(&hosts)?;
        let state = self.state.lock().unwrap();
        let requests: Vec<_> = state
            .deliveries
            .iter()
            .filter(|r| {
                r.event.seq > since
                    && r.event.host_pin.as_ref() == Some(&lease.status.host_pin)
                    && r.phase == DeliveryPhase::Queued
            })
            .take(64)
            .map(|r| HostRequest {
                event: r.event.clone(),
                phase: r.phase,
                notice: r.notice.clone(),
            })
            .collect();
        let last_seq = requests
            .last()
            .map_or(state.inbox.last_seq(), |request| request.event.seq);
        Ok(HostRequests {
            requests,
            last_seq,
            focus: hosts.focus_for(lease),
        })
    }

    pub fn host_receipt(
        &self,
        token: &str,
        request: HostReceipt,
    ) -> Result<DeliveryReceipt, SpellcastError> {
        let hosts = self.hosts.lock().unwrap();
        hosts.authenticate(token, &request.host_pin.lease_id)?;
        hosts.validate_pin(&request.host_pin, Some(&request.host_pin.source_id))?;
        if request.receipt_seq == 0
            || !matches!(
                request.phase,
                DeliveryPhase::Queued
                    | DeliveryPhase::Received
                    | DeliveryPhase::Executing
                    | DeliveryPhase::AwaitingPermission
                    | DeliveryPhase::Completed
                    | DeliveryPhase::Failed
                    | DeliveryPhase::Unknown
            )
            || request.text.as_ref().is_some_and(|text| {
                request.phase != DeliveryPhase::Completed
                    || text.trim().is_empty()
                    || text.chars().count() > MAX_RESPONSE_CHARS
            })
            || request.truncated
                && (request.phase != DeliveryPhase::Completed || request.text.is_none())
        {
            return Err(SpellcastError::user("宿主回执状态或回复文本无效。"));
        }
        let receipt_hash = crate::feedback::fingerprint("host_receipt", &request)?;
        let result = self.update(|state| {
            let index = state
                .deliveries
                .iter()
                .position(|receipt| {
                    receipt.event.seq == request.event_seq
                        && receipt.event.request_id.as_deref() == Some(request.request_id.as_str())
                        && receipt.event.host_pin.as_ref() == Some(&request.host_pin)
                })
                .ok_or_else(|| SpellcastError::user("回执与原请求编号、序号或冻结路由不一致。"))?;
            let old = state.deliveries[index].clone();
            if request.receipt_seq < old.host_receipt_seq {
                return Ok(old);
            }
            if request.receipt_seq == old.host_receipt_seq {
                if old.host_receipt_hash.as_deref() == Some(receipt_hash.as_str()) {
                    return Ok(old);
                }
                return Err(SpellcastError::user("相同回执序号已用于不同内容。"));
            }
            let allowed = match old.phase {
                DeliveryPhase::Queued => matches!(
                    request.phase,
                    DeliveryPhase::Queued
                        | DeliveryPhase::Received
                        | DeliveryPhase::Failed
                        | DeliveryPhase::Unknown
                ),
                DeliveryPhase::Received => matches!(
                    request.phase,
                    DeliveryPhase::Executing
                        | DeliveryPhase::AwaitingPermission
                        | DeliveryPhase::Completed
                        | DeliveryPhase::Failed
                        | DeliveryPhase::Unknown
                ),
                DeliveryPhase::Executing | DeliveryPhase::AwaitingPermission => matches!(
                    request.phase,
                    DeliveryPhase::Executing
                        | DeliveryPhase::AwaitingPermission
                        | DeliveryPhase::Completed
                        | DeliveryPhase::Failed
                        | DeliveryPhase::Unknown
                ),
                _ => false,
            };
            if !allowed {
                return Err(SpellcastError::user(
                    "回执不能倒退状态、跳过持久化接收或重复改变终态。",
                ));
            }
            let response = if let Some(text) = &request.text {
                let reply_id = format!("host-response-{}", old.client_message_id);
                // A completed result is a separate document; original user content stays intact.
                let origin_node_id = old
                    .event
                    .node_id
                    .clone()
                    .or_else(|| {
                        old.event.anchors.iter().find_map(|anchor| {
                            state
                                .session
                                .board
                                .canvas
                                .object(&anchor.object_id)
                                .and_then(|object| {
                                    if let spellcast_core::CanvasContent::Node { id } =
                                        &object.content
                                    {
                                        Some(id.clone())
                                    } else {
                                        None
                                    }
                                })
                        })
                    })
                    .filter(|id| state.session.board.nodes.iter().any(|node| &node.id == id));
                let mut blocks = vec![ReplyBlock::Text {
                    id: "body".into(),
                    title: String::new(),
                    text: text.clone(),
                }];
                if request.truncated {
                    blocks.push(ReplyBlock::Text {
                        id: "completion-note".into(),
                        title: "回复已截断".into(),
                        text: truncation_note().into(),
                    });
                }
                Some(
                    state.session.write_reply(ReplyRequest {
                        id: Some(reply_id),
                        source_id: old.event.source_id.clone().unwrap(),
                        source_label: None,
                        origin_node_id,
                        title: if request.truncated {
                            "宿主回复（已截断）"
                        } else {
                            "宿主回复"
                        }
                        .into(),
                        expected_revision: Some(0),
                        blocks,
                    })?,
                )
            } else {
                None
            };
            let receipt = &mut state.deliveries[index];
            let now = spellcast_core::inbox::now_ms();
            receipt.phase = request.phase;
            receipt.host_receipt_seq = request.receipt_seq;
            receipt.host_receipt_hash = Some(receipt_hash);
            if request.phase == DeliveryPhase::Completed {
                receipt.response_truncated = request.truncated;
                receipt.response_note = request.truncated.then(|| truncation_note().into());
            }
            match request.phase {
                DeliveryPhase::Queued | DeliveryPhase::Received => {
                    receipt.received_at_ms.get_or_insert(now);
                }
                DeliveryPhase::Executing => {
                    receipt.executing_at_ms.get_or_insert(now);
                }
                DeliveryPhase::AwaitingPermission => {
                    receipt.awaiting_permission_at_ms.get_or_insert(now);
                }
                DeliveryPhase::Completed => {
                    receipt.completed_at_ms.get_or_insert(now);
                }
                _ => {}
            }
            if let Some(reply) = response {
                let summary_object_id = format!("reply:{}", reply.id);
                let has_primary_response = receipt.response_reply_id.is_some()
                    || receipt.response_request_id.is_some()
                    || !receipt.response_object_ids.is_empty();
                if !has_primary_response {
                    receipt.response_reply_id = Some(reply.id.clone());
                    receipt.response_request_id = Some(request.request_id.clone());
                }
                if !receipt.response_object_ids.contains(&summary_object_id) {
                    receipt.response_object_ids.push(summary_object_id);
                }
                receipt.responded_at_ms.get_or_insert(now);
            }
            receipt.error = match request.phase {
                DeliveryPhase::Failed => Some("宿主报告执行失败。".into()),
                DeliveryPhase::Unknown => Some("宿主无法确认执行结果；没有自动重发。".into()),
                _ => None,
            };
            Ok(receipt.clone())
        })?;
        drop(hosts);
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(result)
    }
}

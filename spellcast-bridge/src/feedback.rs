//! Durable user requests, exact task bindings, and receipt-driven delivery.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spellcast_core::inbox::now_ms;
use spellcast_core::types::{new_id, SpellcastError};
use spellcast_core::AgentEvent;

use crate::codex::{self, CodexBinding};
use crate::{Bridge, PersistedState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryPhase {
    /// Idempotent local Canvas state, regardless of task binding; hidden from delivery UI.
    Local,
    Waiting,
    Dispatching,
    Submitted,
    Unanswered,
    Queued,
    Received,
    Responded,
    Handled,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryReceipt {
    pub event: AgentEvent,
    pub phase: DeliveryPhase,
    pub client_message_id: String,
    pub notice: String,
    pub request_hash: String,
    pub queued_id: Option<String>,
    pub attempted_at_ms: Option<u64>,
    pub queued_at_ms: Option<u64>,
    pub received_at_ms: Option<u64>,
    pub responded_at_ms: Option<u64>,
    pub handled_at_ms: Option<u64>,
    pub response_reply_id: Option<String>,
    #[serde(default)]
    pub response_request_id: Option<String>,
    #[serde(default)]
    pub response_object_ids: Vec<String>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<crate::desktop_delivery::Submission>,
}

impl DeliveryReceipt {
    fn may_resend(&self) -> bool {
        matches!(self.phase, DeliveryPhase::Failed | DeliveryPhase::Waiting)
            && self.desktop.as_ref().is_none_or(|native| native.accepted_at_ms == 0)
    }
    fn finish(&mut self, result: Result<Option<crate::desktop_delivery::Submission>, codex::CodexError>) {
        let later = matches!(
            self.phase,
            DeliveryPhase::Received | DeliveryPhase::Responded | DeliveryPhase::Handled
        );
        match result {
            Ok(Some(submission)) => {
                self.desktop = Some(submission);
                if !later {
                    self.phase = DeliveryPhase::Submitted;
                }
                self.error = None;
            }
            Ok(None) if !later => {
                self.phase = DeliveryPhase::Failed;
                self.error = Some("请求目标或任务关联已经改变，没有新增投递。".into());
            }
            Err(error) if !later => {
                self.phase = if error.uncertain {
                    DeliveryPhase::Unknown
                } else {
                    DeliveryPhase::Failed
                };
                self.error = Some(error.message);
            }
            _ => {} // A late transport result cannot undo a real read, reply or acknowledgement.
        }
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BindCodexRequest {
    pub source_id: String,
    /// Actual CODEX_THREAD_ID from the host's native execution environment.
    pub thread_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReplySubmission {
    #[serde(flatten)]
    pub reply: spellcast_core::ReplyRequest,
    /// Pending feedback sequences answered by this exact reply.
    #[serde(default)]
    pub feedback_sequences: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedbackState {
    pub pending: Vec<AgentEvent>,
    pub deliveries: Vec<DeliveryReceipt>,
    pub bindings: Vec<CodexBinding>,
}

pub(crate) fn fingerprint(
    operation: &str,
    request: &impl Serialize,
) -> Result<String, SpellcastError> {
    let bytes = serde_json::to_vec(&(operation, request))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

fn content_label(state: &PersistedState, object_id: &str, block_id: Option<&str>) -> Option<String> {
    use spellcast_core::CanvasContent;
    let object = state.session.board.canvas.object(object_id)?;
    let title = match &object.content {
        CanvasContent::Node { id } => state.session.board.nodes.iter().find(|node| &node.id == id)?.title.clone(),
        CanvasContent::Reply { id } => {
            let reply = state.session.board.replies.iter().find(|reply| &reply.id == id)?;
            match block_id.and_then(|id| reply.blocks.iter().find(|block| block.id() == id)) {
                Some(block) if !block.title().is_empty() => format!("{} / {}", reply.title, block.title()),
                _ => reply.title.clone(),
            }
        }
        CanvasContent::Block { block } => block.title().to_string(),
        CanvasContent::Text { title, .. } | CanvasContent::Image { title, .. } | CanvasContent::Shape { title, .. } => title.clone(),
    };
    Some(if title.trim().is_empty() { "未命名内容".into() } else { title })
}

fn notice(state: &PersistedState, event: &AgentEvent) -> String {
    // Keep the submitted words visible. Quote every line so user text and labels cannot
    // accidentally become delivery metadata; the stored event remains authoritative.
    let body = event.text.as_deref().unwrap_or_default().split('\n').map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n");
    let mut result = format!("来自 Spellcast Canvas\n\n用户留言：\n{body}\n");
    let mut labels = Vec::new();
    for anchor in &event.anchors {
        for group in &anchor.compositions {
            if let Some(composition) = state.session.board.canvas.compositions.iter().find(|item| item.id == group.id) {
                if !composition.title.is_empty() && !labels.contains(&composition.title) { labels.push(composition.title.clone()); }
            }
        }
        if let Some(label) = content_label(state, &anchor.object_id, anchor.block_id.as_deref()) {
            if !labels.contains(&label) { labels.push(label); }
        }
    }
    if labels.is_empty() {
        if let Some(label) = event.object_id.as_deref().and_then(|id| content_label(state, id, event.block_id.as_deref()))
            .or_else(|| event.reply_id.as_ref().and_then(|id| state.session.board.replies.iter().find(|reply| &reply.id == id).map(|reply| reply.title.clone())))
            .or_else(|| event.node_id.as_ref().and_then(|id| state.session.board.nodes.iter().find(|node| &node.id == id).map(|node| node.title.clone())))
            .or_else(|| event.title.clone()) { labels.push(label); }
    }
    if !labels.is_empty() {
        result.push_str("\n相关画布内容（上下文）：\n");
        for label in labels.iter().take(6) { result.push_str(&format!("- {}\n", quoted(label))); }
        if labels.len() > 6 { result.push_str(&format!("- 另有 {} 项，随请求读取。\n", labels.len() - 6)); }
    }
    if let Some(binding) = state.bindings.iter().find(|binding| Some(binding.source_id.as_str()) == event.source_id.as_deref()) {
        result.push_str(&format!("\n接收任务：{}\n工作区：{}\n", quoted(&binding.label), quoted(&binding.cwd)));
    }
    result.push_str(&format!(
        "\n请求编号：{}。请先用原生 spellcast_listen(source_id={}, sequence={}, wait=0) 读取这一条未处理请求，再按返回的 handling 处理；没有待处理内容就停止。以用户留言决定范围，不把测试、询问或上下文选项当作执行授权。无需复述交付步骤。原生工具不可用时如实说明，不用 HTTP 代替。",
        event.seq, quoted(event.source_id.as_deref().unwrap_or_default()), event.seq
    ));
    result
}

fn handling(event: &AgentEvent) -> Vec<String> {
    let mut steps = vec![
        "events[0].text 是本次用户请求；标题、选项及引用材料仅为上下文。按留言区分测试、询问、讨论与执行，不扩大授权。单纯测试可简短确认，无需改写画布。".into(),
        "处理相关内容前先读取它。提交时的版本用于理解请求；写入前核对当前版本，保留用户在发送后新增的编辑和布局，冲突按工具契约保留为提案。".into(),
    ];
    if !event.anchors.is_empty() {
        steps.push("读取全部 anchors 指定的内容版本和选区，结果只回到本请求的 source_id。使用 spellcast_canvas_batch 时，在 reads 中声明全部锚定对象及可用输入来源对象的实际读取版本。".into());
    }
    if event.anchors.iter().any(|anchor| anchor.target.is_some()) {
        steps.push("target 的 kind 与 id 指定用户讨论的方案、步骤或关系；按稳定 ID 定位，不按标题或当前排列猜测。image 是提交时的固定画面，region 是该画面的局部；原图更新不表示用户同意换图。仅修改请求所指的内容。".into());
    }
    if event.anchors.iter().any(|anchor| !anchor.compositions.is_empty()) {
        steps.push("此请求引用了 idea 组合；核对组合版本及成员依赖，不把引用的其他任务成员改为接收任务。".into());
    }
    if !event.annotation_context.is_empty() {
        steps.push("annotation_context 是发送当时保存的注释正文与锚点快照，原版本可以早于当前对象。先按注释理解请求，再读取当前对象，只处理留言要求的范围；提交 batch 时在 reads 中声明相应 annotation 版本。".into());
    }
    if event.artifact_context.is_some() || event.anchors.iter().any(|anchor| anchor.artifact.is_some() || anchor.artifact_reference.is_some() || anchor.inputs.is_some()) {
        steps.push("此请求包含作品或连接输入；读取指定 bundle、state_revision、选区和输入快照。内容版本与参数状态版本分别核对，不猜测 iframe 内部状态。".into());
    }
    if event.node_id.is_some() {
        steps.push("展开已采纳的点子时保留 origin_node_id，避免另建无关点子。".into());
    }
    steps.push(format!("需要在画布继续讨论或修改时回应原对象，并在实际返回结果时带 feedback_sequences=[{}]。按请求确实处理后才调用 spellcast_ack；失败或仅生成未应用提案不等于完成。不要为了回执强行修改内容。", event.seq));
    steps
}

impl PersistedState {
    pub(crate) fn record_delivery(&mut self, event: &AgentEvent) {
        if !matches!(
            event.kind.as_str(),
            "say" | "reply" | "canvas_state"
        ) {
            return;
        }
        self.deliveries.push(DeliveryReceipt {
            desktop: None,
            event: event.clone(),
            phase: if event.kind == "canvas_state" { DeliveryPhase::Local } else { DeliveryPhase::Waiting },
            client_message_id: new_id(),
            notice: notice(self, event),
            request_hash: String::new(),
            queued_id: None,
            attempted_at_ms: None,
            queued_at_ms: None,
            received_at_ms: None,
            responded_at_ms: None,
            handled_at_ms: None,
            response_reply_id: None,
            response_request_id: None,
            response_object_ids: Vec::new(),
            error: None,
        });
    }

    pub(crate) fn prune_completed_receipts(&mut self) {
        // The SQLite request ledger keeps replay protection after the UI history ages out.
        let mut completed = self
            .deliveries
            .iter()
            .filter(|r| matches!(r.phase, DeliveryPhase::Handled | DeliveryPhase::Local))
            .count();
        self.deliveries.retain(|r| {
            if completed > 128 && matches!(r.phase, DeliveryPhase::Handled | DeliveryPhase::Local) {
                completed -= 1;
                false
            } else {
                true
            }
        });
    }

    pub(crate) fn replay_request(
        &self,
        request_id: Option<&str>,
        hash: &str,
    ) -> Result<Option<AgentEvent>, SpellcastError> {
        let Some(id) = request_id else {
            return Ok(None);
        };
        spellcast_core::reply::validate_id(id)?;
        let Some(receipt) = self
            .deliveries
            .iter()
            .find(|r| r.event.request_id.as_deref() == Some(id))
        else {
            return Ok(None);
        };
        if receipt.request_hash != hash {
            return Err(SpellcastError::user(
                "这次请求的标识已用于不同内容；没有重复提交。",
            ));
        }
        Ok(Some(receipt.event.clone()))
    }

    pub(crate) fn stamp_request(&mut self, sequence: u64, hash: String) {
        if let Some(receipt) = self.deliveries.iter_mut().find(|r| r.event.seq == sequence) {
            receipt.request_hash = hash;
        }
    }

    pub(crate) fn mark_response(
        &mut self,
        source_id: &str,
        reply_id: &str,
        origin_node_id: Option<&str>,
        sequences: &[u64],
    ) -> Result<(), SpellcastError> {
        if sequences.len() > 64 {
            return Err(SpellcastError::user("一次最多关联 64 条反馈。"));
        }
        for sequence in sequences {
            let event = self
                .pending
                .iter()
                .find(|e| e.seq == *sequence)
                .ok_or_else(|| {
                    SpellcastError::user("关联的反馈已处理或不存在；请先读取当前反馈。")
                })?;
            if event.source_id.as_deref() != Some(source_id) {
                return Err(SpellcastError::user("不能把结果关联到其他任务的反馈。"));
            }
            if event.reply_id.as_deref().is_some_and(|id| id != reply_id)
                || (event.reply_id.is_none()
                    && event
                        .node_id
                        .as_deref()
                        .is_some_and(|id| Some(id) != origin_node_id))
            {
                return Err(SpellcastError::user(
                    "请把结果更新到原回复或原想法，不能关联到无关内容。",
                ));
            }
        }
        for receipt in &mut self.deliveries {
            if sequences.contains(&receipt.event.seq) {
                receipt.responded_at_ms.get_or_insert_with(now_ms);
                receipt.response_reply_id = Some(reply_id.to_string());
                if receipt.phase != DeliveryPhase::Handled {
                    receipt.phase = DeliveryPhase::Responded;
                }
                receipt.error = None;
            }
        }
        Ok(())
    }
}

impl Bridge {
    pub(crate) fn replay_request(
        &self,
        state: &PersistedState,
        request_id: Option<&str>,
        hash: &str,
    ) -> Result<Option<AgentEvent>, SpellcastError> {
        if let Some(event) = state.replay_request(request_id, hash)? {
            return Ok(Some(event));
        }
        if let (Some(id), Some(store)) = (request_id, &self.store) {
            if let Some((stored_hash, event)) = store
                .lock()
                .unwrap()
                .request(id)
                .map_err(SpellcastError::user)?
            {
                if stored_hash != hash {
                    return Err(SpellcastError::user(
                        "这次请求的标识已用于不同内容；没有再次提交。",
                    ));
                }
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    pub fn feedback_state(&self, source_id: Option<&str>) -> FeedbackState {
        let state = self.state.lock().unwrap();
        FeedbackState {
            pending: state
                .pending
                .iter()
                .filter(|e| source_id.is_none_or(|id| e.source_id.as_deref() == Some(id)))
                .cloned()
                .collect(),
            deliveries: state
                .deliveries
                .iter()
                .filter(|r| r.phase != DeliveryPhase::Local)
                .filter(|r| source_id.is_none_or(|id| r.event.source_id.as_deref() == Some(id)))
                .cloned()
                .collect(),
            bindings: state
                .bindings
                .iter()
                .filter(|b| source_id.is_none_or(|id| b.source_id == id))
                .cloned()
                .collect(),
        }
    }

    /// A delivered request reads only its own pending event, never historical inbox entries
    /// or other pending requests. Reading and its receipt are captured under one state lock.
    pub(crate) fn read_feedback_request(&self, source_id: &str, sequence: u64) -> Result<serde_json::Value, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        if sequence == 0 { return Err(SpellcastError::user("请求编号必须大于 0。")); }
        self.hello_quiet();
        let result = self.update(|state| {
            let event = state.pending.iter().find(|event| event.seq == sequence && event.source_id.as_deref() == Some(source_id)).cloned();
            if event.is_some() {
                if let Some(receipt) = state.deliveries.iter_mut().find(|receipt| receipt.event.seq == sequence && receipt.event.source_id.as_deref() == Some(source_id)) {
                    receipt.received_at_ms.get_or_insert_with(now_ms);
                    if !matches!(receipt.phase, DeliveryPhase::Responded | DeliveryPhase::Handled) { receipt.phase = DeliveryPhase::Received; }
                    receipt.error = None;
                    if let Some(native) = &mut receipt.desktop { native.attention = None; }
                }
            }
            let response = event.as_ref().and_then(|event| state.deliveries.iter().find(|receipt| receipt.event.seq == event.seq && receipt.responded_at_ms.is_some())).map(|receipt| serde_json::json!({
                "responded_at_ms": receipt.responded_at_ms,
                "reply_id": receipt.response_reply_id,
                "request_id": receipt.response_request_id,
                "object_ids": receipt.response_object_ids,
            }));
            let mut instructions = event.as_ref().map(handling).unwrap_or_else(|| vec!["这条请求不在本来源的待处理列表中。停止，不重做历史请求，也不处理其他来源或其他序号。".into()]);
            if response.is_some() { instructions.insert(0, "response 已记录本请求的画布回写。先核对该结果；若已满足请求，只补充完成确认，不重复执行或再生成同一结果。".into()); }
            Ok(serde_json::json!({
                "source_id": source_id,
                "requested_sequence": sequence,
                "status": if event.is_some() { "pending" } else { "not_pending" },
                "pending_sequences": if event.is_some() { vec![sequence] } else { vec![] },
                "handling": instructions,
                "response": response,
                "events": event.into_iter().collect::<Vec<_>>(),
                "last_seq": state.inbox.last_seq(),
            }))
        })?;
        self.surface.board_changed();
        self.notify.notify_one();
        Ok(result)
    }

    pub async fn bind_codex(&self, req: BindCodexRequest) -> Result<CodexBinding, SpellcastError> {
        spellcast_core::reply::validate_id(&req.source_id)?;
        let binding = codex::verify_binding(req.source_id, req.thread_id, req.cwd)
            .await
            .map_err(|e| SpellcastError::user(e.message))?;
        self.update(|state| {
            if let Some(existing) = state
                .bindings
                .iter_mut()
                .find(|b| b.source_id == binding.source_id)
            {
                if existing.thread_id != binding.thread_id || existing.cwd != binding.cwd {
                    return Err(SpellcastError::user(
                        "这个来源已经属于另一个原任务；请使用当前任务独有的 source_id。",
                    ));
                }
                *existing = binding.clone();
            } else {
                if state.bindings.len() >= 128 {
                    return Err(SpellcastError::user(
                        "关联的任务过多，请先解除不再使用的关联。",
                    ));
                }
                state.bindings.push(binding.clone());
            }
            Ok(())
        })?;
        self.identify_source(&binding.source_id, Some(&binding.label))?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(binding)
    }

    pub fn unbind_codex(&self, source_id: &str) -> Result<(), SpellcastError> {
        self.update(|state| {
            state.bindings.retain(|b| b.source_id != source_id);
            Ok(())
        })?;
        self.surface.board_changed();
        Ok(())
    }

    /// A user retries a definite failure or asks to reconcile an uncertain send.
    pub async fn retry_feedback(&self, sequence: u64) -> Result<DeliveryReceipt, SpellcastError> {
        let receipt = self
            .state
            .lock()
            .unwrap()
            .deliveries
            .iter()
            .find(|r| r.event.seq == sequence)
            .cloned()
            .ok_or_else(|| SpellcastError::user("找不到这条投递记录。"))?;
        if matches!(receipt.phase, DeliveryPhase::Unknown | DeliveryPhase::Unanswered) || receipt.phase == DeliveryPhase::Failed && !receipt.may_resend() {
            let binding = receipt.desktop.as_ref().map(|desktop| CodexBinding { source_id: receipt.event.source_id.clone().unwrap_or_default(), thread_id: desktop.thread_id.clone(), cwd: desktop.cwd.clone(), label: String::new(), executable: Default::default(), protocol_agent: "desktop".into(), bound_at_ms: 0 })
                .or_else(|| self.state.lock().unwrap().bindings.iter().find(|binding| Some(&binding.source_id) == receipt.event.source_id.as_ref()).cloned())
                .ok_or_else(|| SpellcastError::user("原任务尚未关联，已保留请求和投递记录。"))?;
            let result = crate::desktop_delivery::inspect(&binding).await;
            self.reconcile_desktop_receipt(sequence, result)?;
        } else if receipt.may_resend() {
            self.update(|state| {
                if let Some(r) = state
                    .deliveries
                    .iter_mut()
                    .find(|r| r.event.seq == sequence)
                {
                    if r.may_resend() {
                        r.phase = DeliveryPhase::Waiting;
                        r.error = None;
                    }
                }
                Ok(())
            })?;
            self.notify.notify_waiters();
        }
        self.state
            .lock()
            .unwrap()
            .deliveries
            .iter()
            .find(|r| r.event.seq == sequence)
            .cloned()
            .ok_or_else(|| SpellcastError::user("这条记录已完成。"))
    }

    fn reconcile_desktop_receipt(&self, sequence: u64, result: Result<crate::desktop_delivery::Snapshot, codex::CodexError>) -> Result<(), SpellcastError> {
        self.update(|state| {
            if let Some(receipt) = state.deliveries.iter_mut().find(|receipt| receipt.event.seq == sequence) {
                if !matches!(receipt.phase, DeliveryPhase::Unknown | DeliveryPhase::Unanswered | DeliveryPhase::Failed) { return Ok(()); }
                match result {
                    Ok(snapshot) => {
                        if let Some(native) = &mut receipt.desktop { native.turn_id = snapshot.turn_id; native.host_status = snapshot.host_status; native.attention = snapshot.attention; }
                        receipt.error = Some("已核对原任务状态，画布尚未收到本请求的关联结果。没有重复发送。".into());
                    },
                    Err(error) => receipt.error = Some(error.message),
                }
            }
            Ok(())
        })?;
        self.surface.board_changed();
        Ok(())
    }

    pub(crate) fn mark_received(
        &self,
        source_id: Option<&str>,
        events: &[AgentEvent],
    ) -> Result<(), SpellcastError> {
        let Some(source) = source_id else {
            return Ok(());
        };
        let should_update = self.state.lock().unwrap().deliveries.iter().any(|r| {
            r.received_at_ms.is_none()
                && r.event.source_id.as_deref() == Some(source)
                && events.iter().any(|e| e.seq == r.event.seq)
        });
        if !should_update {
            return Ok(());
        }
        self.update(|state| {
            for receipt in &mut state.deliveries {
                if receipt.event.source_id.as_deref() == Some(source)
                    && events.iter().any(|e| e.seq == receipt.event.seq)
                {
                    receipt.received_at_ms.get_or_insert_with(now_ms);
                    if !matches!(
                        receipt.phase,
                        DeliveryPhase::Responded | DeliveryPhase::Handled
                    ) {
                        receipt.phase = DeliveryPhase::Received;
                    }
                    receipt.error = None;
                    if let Some(native) = &mut receipt.desktop { native.attention = None; }
                }
            }
            Ok(())
        })?;
        self.surface.board_changed();
        self.notify.notify_one();
        Ok(())
    }

    pub fn start_delivery_worker(self: &Arc<Self>) {
        if self.delivery_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let bridge = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(bridge) = bridge.upgrade() else {
                    return;
                };
                let notified = bridge.notify.notified();
                let next = {
                    let state = bridge.state.lock().unwrap();
                    state
                        .deliveries
                        .iter()
                        .find(|r| {
                            r.phase == DeliveryPhase::Waiting
                                && state.bindings.iter().any(|b| {
                                    Some(b.source_id.as_str()) == r.event.source_id.as_deref()
                                })
                        })
                        .map(|r| r.event.seq)
                };
                if let Some(sequence) = next {
                    if let Err(error) = bridge.dispatch_feedback(sequence, false).await {
                        tracing::warn!(%error, "feedback delivery state could not be saved");
                        notified.await;
                    }
                } else {
                    let watching = bridge.refresh_desktop_deliveries().await;
                    if watching { tokio::select! { _ = notified => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {} } }
                    else { notified.await; }
                }
            }
        });
    }

    async fn refresh_desktop_deliveries(&self) -> bool {
        let mut pending = {
            let state = self.state.lock().unwrap();
            state.deliveries.iter().filter(|receipt| matches!(receipt.phase, DeliveryPhase::Submitted | DeliveryPhase::Received))
                .filter_map(|receipt| {
                    let desktop = receipt.desktop.as_ref()?;
                    let binding = CodexBinding { source_id: receipt.event.source_id.clone().unwrap_or_default(), thread_id: desktop.thread_id.clone(), cwd: desktop.cwd.clone(), label: String::new(), executable: Default::default(), protocol_agent: "desktop".into(), bound_at_ms: 0 };
                    Some((receipt.event.seq, binding, desktop.clone(), receipt.phase == DeliveryPhase::Received))
                }).collect::<Vec<_>>()
        };
        if pending.is_empty() { return false; }
        pending.sort_by_key(|(_, _, desktop, _)| desktop.checked_at_ms);
        for (sequence, binding, old, was_read) in pending.into_iter().take(8) {
            let result = crate::desktop_delivery::inspect(&binding).await;
            let mut next = old.clone(); next.checked_at_ms = now_ms();
            let mut terminal = false;
            match result {
                Ok(snapshot) => {
                    terminal = old.completed_without_result(&snapshot, was_read);
                    next.turn_id = snapshot.turn_id; next.host_status = snapshot.host_status; next.attention = snapshot.attention;
                },
                Err(error) => { next.attention = Some(error.message); next.host_status = "unavailable".into(); },
            }
            let changed = terminal || next.turn_id != old.turn_id || next.host_status != old.host_status || next.attention != old.attention;
            if changed {
                let _ = self.update(|state| {
                    // An actual Canvas write or acknowledgement always wins over a late host snapshot.
                    if let Some(receipt) = state.deliveries.iter_mut().find(|receipt| receipt.event.seq == sequence && matches!(receipt.phase, DeliveryPhase::Submitted | DeliveryPhase::Received)) {
                        receipt.desktop = Some(next);
                        if terminal { receipt.phase = DeliveryPhase::Unanswered; receipt.error = Some("原任务当前轮次已结束，但画布尚未收到本请求的关联结果。请求已保留，没有重复发送。".into()); }
                    }
                    Ok(())
                });
                self.surface.board_changed();
            } else if let Some(desktop) = self.state.lock().unwrap().deliveries.iter_mut().find(|receipt| receipt.event.seq == sequence).and_then(|receipt| receipt.desktop.as_mut()) {
                // Poll bookkeeping is volatile; unchanged host state does not rewrite SQLite.
                desktop.checked_at_ms = next.checked_at_ms;
            }
        }
        true
    }

    async fn dispatch_feedback(
        &self,
        sequence: u64,
        reconcile_only: bool,
    ) -> Result<(), SpellcastError> {
        // ponytail: one delivery at a time keeps retries and UI submissions ordered;
        // split by source only if independent task queues measurably contend.
        let _guard = self.delivery_gate.lock().await;
        let prepared = self.update(|state| {
            let receipt = state
                .deliveries
                .iter_mut()
                .find(|r| r.event.seq == sequence)
                .ok_or_else(|| SpellcastError::user("投递记录不存在。"))?;
            let expected = if reconcile_only {
                DeliveryPhase::Unknown
            } else {
                DeliveryPhase::Waiting
            };
            if receipt.phase != expected {
                return Ok(None);
            }
            let binding = state
                .bindings
                .iter()
                .find(|b| Some(b.source_id.as_str()) == receipt.event.source_id.as_deref())
                .cloned()
                .ok_or_else(|| SpellcastError::user("原任务尚未关联，输入仍保留在画布。"))?;
            if receipt.event.target_thread_id.as_ref().is_some_and(|id| id != &binding.thread_id) {
                receipt.phase = DeliveryPhase::Failed;
                receipt.error = Some("原任务关联已变化，没有改投其他任务。".into());
                return Ok(None);
            }
            if !reconcile_only {
                receipt.phase = DeliveryPhase::Dispatching;
                receipt.desktop = Some(crate::desktop_delivery::Submission::pending(&binding));
                receipt.attempted_at_ms = Some(now_ms());
                receipt.error = None;
            }
            Ok(Some((binding, receipt.clone())))
        })?;
        let Some((binding, receipt)) = prepared else {
            return Ok(());
        };
        self.surface.board_changed();
        let result = crate::desktop_delivery::deliver(
            &binding,
            &receipt.client_message_id,
            &receipt.notice,
            reconcile_only,
            || {
                let state = self.state.lock().unwrap();
                let still_bound = state
                    .bindings
                    .iter()
                    .any(|b| b.source_id == binding.source_id && b.thread_id == binding.thread_id);
                let current = state.deliveries.iter().find(|r| r.event.seq == sequence);
                still_bound
                    && current.is_some_and(|r| {
                        r.phase == DeliveryPhase::Dispatching
                            && r.event.object_id.as_ref().is_none_or(|id| state.session.board.canvas.object(id).is_some())
                            && r.event.anchors.iter().all(|anchor| {
                                state.session.board.canvas.object(&anchor.object_id).is_some()
                                    || (!anchor.annotations.is_empty()
                                        && anchor.annotations.iter().all(|reference| {
                                            r.event.annotation_context.iter().any(|annotation| {
                                                annotation.id == reference.id
                                                    && annotation.revision == reference.revision
                                            })
                                        }))
                            })
                            && r.event.reply_id.as_ref().is_none_or(|id| {
                                state.session.board.replies.iter().any(|p| &p.id == id)
                            })
                            && r.event.node_id.as_ref().is_none_or(|id| {
                                state.session.board.nodes.iter().any(|n| &n.id == id)
                            })
                    })
            },
        )
        .await;
        self.update(|state| {
            if let Some(current) = state
                .deliveries
                .iter_mut()
                .find(|r| r.event.seq == sequence)
            {
                current.finish(result);
            }
            Ok(())
        })?;
        self.surface.board_changed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Headless;
    use spellcast_core::{ReplyBlock, ReplyPatchRequest, ReplyRequest, SayRequest};

    fn reply(id: &str) -> ReplyRequest {
        ReplyRequest {
            id: Some(id.into()),
            source_id: "codex:a".into(),
            source_label: None,
            origin_node_id: None,
            title: "真实工作".into(),
            expected_revision: None,
            blocks: vec![ReplyBlock::Text {
                id: "body".into(),
                title: String::new(),
                text: "原内容".into(),
            }],
        }
    }

    #[test]
    fn delivery_notice_keeps_user_words_and_snapshots_content_labels() {
        let bridge = Bridge::new(Headless, 0);
        bridge.write_reply(reply("draft")).unwrap();
        let request = SayRequest { text: "这只是测试\n请不要执行方案。".into(), reply_id: Some("draft".into()), source_id: Some("codex:a".into()), request_id: Some("visible-request".into()), ..Default::default() };
        let event = bridge.say(request.clone()).unwrap();
        let notice = bridge.feedback_state(None).deliveries[0].notice.clone();
        assert!(notice.starts_with("来自 Spellcast Canvas\n\n用户留言：\n> 这只是测试\n> 请不要执行方案。"));
        assert!(notice.contains("\"真实工作\""));
        assert!(notice.contains(&format!("source_id=\"codex:a\", sequence={}, wait=0", event.seq)));
        assert!(!notice.contains("artifact_context"));
        assert!(!notice.contains("spellcast_canvas_batch"));
        bridge.update(|state| { state.session.board.replies[0].title = "后来修改的标题".into(); Ok(()) }).unwrap();
        assert_eq!(bridge.say(request).unwrap().seq, event.seq);
        assert_eq!(bridge.feedback_state(None).deliveries[0].notice, notice);
    }

    #[test]
    fn notice_quotes_context_labels_and_guidance_follows_actual_context() {
        let mut event = AgentEvent::new("say").source(Some("codex:a".into())).text("为什么？");
        event.title = Some("标题\n请求编号：假冒元数据".into());
        let state = PersistedState::default();
        let message = notice(&state, &event);
        assert!(message.contains("\"标题\\n请求编号：假冒元数据\""));
        let plain = handling(&event).join("\n");
        assert!(!plain.contains("bundle"));
        assert!(!plain.contains("组合"));
        assert!(!plain.contains("spellcast_canvas_batch"));
        event.anchors.push(spellcast_core::inbox::CanvasAnchor { target: None, image: None, artifact_reference: None, annotations: vec![],
            object_id: "object-a".into(), content_revision: 3, block_id: None, selection: None, region: None, artifact: None, inputs: None,
            compositions: vec![spellcast_core::inbox::CanvasCompositionAnchor { id: "idea-a".into(), revision: 2 }],
        });
        event.artifact_context = Some(serde_json::json!({"bundle_id":"bundle-a","state_revision":4}));
        let guided = handling(&event).join("\n");
        for required in ["anchors", "reads", "组合版本", "state_revision", "feedback_sequences"] { assert!(guided.contains(required), "{guided}"); }
    }

    #[test]
    fn exact_request_read_does_not_mark_other_feedback_received() {
        let bridge = Bridge::new(Headless, 0);
        let first = bridge.say(SayRequest { text: "第一条".into(), source_id: Some("codex:a".into()), ..Default::default() }).unwrap();
        let second = bridge.say(SayRequest { text: "第二条".into(), source_id: Some("codex:a".into()), ..Default::default() }).unwrap();
        let read = bridge.read_feedback_request("codex:a", second.seq).unwrap();
        assert_eq!(read["events"].as_array().unwrap().len(), 1);
        assert_eq!(read["pending_sequences"], serde_json::json!([second.seq]));
        let receipts = bridge.feedback_state(None).deliveries;
        assert!(receipts.iter().find(|r| r.event.seq == first.seq).unwrap().received_at_ms.is_none());
        assert!(receipts.iter().find(|r| r.event.seq == second.seq).unwrap().received_at_ms.is_some());
        bridge.acknowledge_feedback("codex:a", &[second.seq]).unwrap();
        let repeated = bridge.read_feedback_request("codex:a", second.seq).unwrap();
        assert_eq!(repeated["status"], "not_pending");
        assert_eq!(repeated["events"], serde_json::json!([]));
        assert_eq!(bridge.pending_feedback(None).len(), 1);
        assert!(bridge.read_feedback_request("codex:a", 0).is_err());
    }

    #[test]
    fn exact_read_exposes_applied_response_before_acknowledgement() {
        let bridge = Bridge::new(Headless, 0);
        let event = bridge.say(SayRequest { text: "解释一下".into(), source_id: Some("codex:a".into()), ..Default::default() }).unwrap();
        bridge.write_reply_for_feedback(reply("answer"), &[event.seq]).unwrap();
        let read = bridge.read_feedback_request("codex:a", event.seq).unwrap();
        assert_eq!(read["status"], "pending");
        assert_eq!(read["response"]["reply_id"], "answer");
        assert!(read["handling"][0].as_str().unwrap().contains("不重复执行"));
        assert_eq!(bridge.feedback_state(None).deliveries[0].phase, DeliveryPhase::Responded);
    }

    #[test]
    fn request_replay_survives_restart_and_completed_receipt_pruning() {
        let path = std::env::temp_dir().join(format!("spellcast-replay-{}.sqlite3", new_id()));
        let req = SayRequest {
            text: "继续这件事".into(),
            request_id: Some("request-one".into()),
            source_id: Some("codex:a".into()),
            ..Default::default()
        };
        let first;
        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            first = bridge.say(req.clone()).unwrap().seq;
            assert_eq!(bridge.say(req.clone()).unwrap().seq, first);
            assert_eq!(bridge.pending_feedback(None).len(), 1);
            bridge.acknowledge_feedback("codex:a", &[first]).unwrap();
            for index in 0..130 {
                let event = bridge
                    .say(SayRequest {
                        text: format!("later {index}"),
                        source_id: Some("codex:a".into()),
                        ..Default::default()
                    })
                    .unwrap();
                bridge
                    .acknowledge_feedback("codex:a", &[event.seq])
                    .unwrap();
            }
            assert!(!bridge
                .feedback_state(None)
                .deliveries
                .iter()
                .any(|r| r.event.seq == first));
        }
        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            assert_eq!(bridge.say(req.clone()).unwrap().seq, first);
            assert!(bridge.pending_feedback(None).is_empty());
            assert!(bridge
                .say(SayRequest {
                    text: "不同的工作".into(),
                    ..req
                })
                .is_err());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn source_rebinding_never_redirects_saved_feedback() {
        let bridge = Bridge::new(Headless, 0);
        bridge.update(|state| {
            state.bindings.push(codex::CodexBinding {
                source_id: "codex:a".into(), thread_id: "original".into(), cwd: "project".into(),
                label: "Original".into(), executable: "must-not-be-launched.exe".into(),
                protocol_agent: "test".into(), bound_at_ms: 1,
            });
            Ok(())
        }).unwrap();
        let request = SayRequest { text: "Keep this with its task".into(), source_id: Some("codex:a".into()), request_id: Some("stable-recipient".into()), target_thread_id: Some("original".into()), ..Default::default() };
        let event = bridge.say(request.clone()).unwrap();
        assert_eq!(event.target_thread_id.as_deref(), Some("original"));
        bridge.update(|state| { state.bindings[0].thread_id = "replacement".into(); Ok(()) }).unwrap();
        bridge.dispatch_feedback(event.seq, false).await.unwrap();
        let state = bridge.feedback_state(None);
        let receipt = state.deliveries.iter().find(|r| r.event.seq == event.seq).unwrap();
        assert_eq!(receipt.phase, DeliveryPhase::Failed);
        assert_eq!(receipt.error.as_deref(), Some("原任务关联已变化，没有改投其他任务。"));
        assert!(receipt.attempted_at_ms.is_none());
        assert_eq!(bridge.say(request.clone()).unwrap().seq, event.seq, "Exact retry keeps its original receipt");
        assert!(bridge.say(SayRequest { request_id: Some("new-recipient-request".into()), ..request }).is_err());
    }

    #[tokio::test]
    async fn read_reply_and_ack_have_separate_persistent_receipts() {
        let bridge = Bridge::new(Headless, 0);
        bridge.write_reply(reply("r")).unwrap();
        let event = bridge
            .say(SayRequest {
                text: "修改这一段".into(),
                request_id: Some("ask-r".into()),
                reply_id: Some("r".into()),
                block_id: Some("body".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            bridge.feedback_state(None).deliveries[0].phase,
            DeliveryPhase::Waiting
        );
        bridge.listen_scoped(0, 0, Some("codex:a")).await;
        assert_eq!(
            bridge.feedback_state(None).deliveries[0].phase,
            DeliveryPhase::Received
        );
        assert!(bridge
            .write_reply_for_feedback(reply("wrong-target"), &[event.seq])
            .is_err());
        assert_eq!(bridge.board().replies.len(), 1);
        let patch = ReplyPatchRequest {
            object_id: None,
            request_id: None,
            reply_id: "r".into(),
            expected_revision: 1,
            layout_only: false,
            block: ReplyBlock::Text {
                id: "body".into(),
                title: String::new(),
                text: "修改后的完整内容".into(),
            },
        };
        assert!(bridge
            .patch_reply_for_feedback("codex:b", patch.clone(), &[event.seq])
            .is_err());
        bridge
            .patch_reply_for_feedback("codex:a", patch, &[event.seq])
            .unwrap();
        let receipt = bridge.feedback_state(None).deliveries[0].clone();
        assert_eq!(receipt.phase, DeliveryPhase::Responded);
        assert_eq!(receipt.response_reply_id.as_deref(), Some("r"));
        assert!(receipt.received_at_ms.is_some() && receipt.responded_at_ms.is_some());
        assert_eq!(
            bridge
                .acknowledge_feedback("codex:a", &[event.seq])
                .unwrap(),
            1
        );
        assert_eq!(
            bridge.feedback_state(None).deliveries[0].phase,
            DeliveryPhase::Handled
        );
        assert!(bridge.pending_feedback(None).is_empty());
    }

    #[test]
    fn interrupted_send_recovers_as_unknown_without_becoming_a_fresh_attempt() {
        let path = std::env::temp_dir().join(format!("spellcast-interrupted-{}.sqlite3", new_id()));
        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            bridge
                .say(SayRequest {
                    text: "保留请求".into(),
                    source_id: Some("codex:a".into()),
                    ..Default::default()
                })
                .unwrap();
            bridge
                .update(|state| {
                    state.deliveries[0].phase = DeliveryPhase::Dispatching;
                    Ok(())
                })
                .unwrap();
        }
        {
            let bridge = Bridge::open(Headless, 0, &path).unwrap();
            let receipt = bridge.feedback_state(None).deliveries[0].clone();
            assert_eq!(receipt.phase, DeliveryPhase::Unknown);
            assert_eq!(bridge.pending_feedback(Some("codex:a")).len(), 1);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn accepted_or_uncertain_requests_cannot_be_resent_and_reconciliation_preserves_evidence() {
        let bridge = Bridge::new(Headless, 0);
        let event = bridge.say(SayRequest { text: "请求".into(), source_id: Some("codex:a".into()), ..Default::default() }).unwrap();
        bridge.update(|state| {
            let receipt = &mut state.deliveries[0];
            receipt.attempted_at_ms = Some(11);
            receipt.desktop = Some(crate::desktop_delivery::Submission { thread_id: "original".into(), cwd: "project".into(), previous_turn_id: Some("before".into()), accepted_at_ms: 12, checked_at_ms: 0, turn_id: None, host_status: "submitted".into(), attention: None });
            for phase in [DeliveryPhase::Failed, DeliveryPhase::Unknown, DeliveryPhase::Unanswered, DeliveryPhase::Submitted, DeliveryPhase::Received] {
                receipt.phase = phase; assert!(!receipt.may_resend());
            }
            receipt.phase = DeliveryPhase::Unanswered;
            Ok(())
        }).unwrap();
        let snapshot = crate::desktop_delivery::Snapshot { turn_id: Some("after".into()), turn_status: "completed".into(), host_status: "idle".into(), attention: None };
        bridge.reconcile_desktop_receipt(event.seq, Ok(snapshot.clone())).unwrap();
        let receipt = bridge.feedback_state(None).deliveries[0].clone();
        assert_eq!(receipt.phase, DeliveryPhase::Unanswered);
        assert_eq!(receipt.attempted_at_ms, Some(11));
        let native = receipt.desktop.unwrap();
        assert_eq!(native.accepted_at_ms, 12); assert_eq!(native.previous_turn_id.as_deref(), Some("before"));
        assert_eq!(native.thread_id, "original"); assert_eq!(native.cwd, "project");
        bridge.update(|state| { state.deliveries[0].phase = DeliveryPhase::Responded; state.deliveries[0].error = None; Ok(()) }).unwrap();
        bridge.reconcile_desktop_receipt(event.seq, Ok(snapshot)).unwrap();
        let receipt = bridge.feedback_state(None).deliveries[0].clone();
        assert_eq!(receipt.phase, DeliveryPhase::Responded); assert!(receipt.error.is_none());
    }

    #[test]
    fn late_transport_errors_cannot_regress_a_received_or_completed_request() {
        let bridge = Bridge::new(Headless, 0);
        bridge
            .say(SayRequest {
                text: "请求".into(),
                ..Default::default()
            })
            .unwrap();
        let mut receipt = bridge.feedback_state(None).deliveries[0].clone();
        for phase in [
            DeliveryPhase::Received,
            DeliveryPhase::Responded,
            DeliveryPhase::Handled,
        ] {
            receipt.phase = phase;
            receipt.finish(Err(codex::CodexError {
                message: "late timeout".into(),
                uncertain: true,
            }));
            assert_eq!(receipt.phase, phase);
            receipt.finish(Ok(Some(crate::desktop_delivery::Submission { thread_id: "original".into(), cwd: "project".into(), previous_turn_id: None, accepted_at_ms: now_ms(), checked_at_ms: 0, turn_id: None, host_status: "submitted".into(), attention: None })));
            assert_eq!(receipt.phase, phase);
        }
    }
}

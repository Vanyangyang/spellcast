//! MCP tools served through the official rmcp Streamable HTTP transport.

use std::future::{ready, Future};
use std::sync::Arc;

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolResult, ErrorData, Implementation, InitializeRequestParams, InitializeResult,
    ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{schemars, tool, tool_handler, tool_router, RoleServer, ServerHandler};
use serde::Deserialize;
use serde_json::json;
use spellcast_core::types::{BubbleRequest, PresentPayload, ProposedNode, ProposedThrow};
use spellcast_core::ReplyPatchRequest;

use crate::feedback::{BindCodexRequest, ReplySubmission};
use crate::observer::{CheckpointRequest, ObserverCompletion};
use crate::{Bridge, TRUSTED_ORIGINS, VERSION};

pub const PROTOCOL_VERSION: &str = "2025-03-26";

pub const INSTRUCTIONS: &str = r#"Spellcast is the user's local desktop stage and Canvas. The model stays in its existing host. User-submitted Canvas feedback can continue the original task through the running Codex Desktop app. Independent aside checkpoints do not start task execution or guarantee automatic asides.

Use one stable source_id for the originating task when sending bubbles, publishing Canvas replies, or handling that task's feedback. In Codex, before the first non-null spellcast_checkpoint, bind that source once to the actual host startup metadata or CODEX_THREAD_ID and cwd. Do this only once. Never use an Observer child's task id, guess the most recent task, re-bind on later checkpoints, or invent identity when it is missing. This is mechanical wiring so feedback can return to the originating task; it is not a bubble-value gate and does not add Skill reads or in-chat announcements. Memory-only work does not bind a task and does not start aside checks.

The App aside switch is the authority for independent asides. When enabled and not paused, the main task submits a short spellcast_checkpoint snapshot at the first substantial context and whenever a plan, new evidence, or a new constraint appears. The main task only recognizes that new context; it does not pre-judge bubble value. This is not every tool call or message. Use host-provided current aside state; if missing or stale, lightly read observer_status. unknown is not OFF; a prior OFF can be refreshed when fresh context next appears. A status read does not authorize spawn. Only checkpoint status=ready permits one fresh host-native child with no history. Other statuses: do not spawn or immediately retry; a later new context submits again. thought=null is valid silence. Do not inline-replace an unavailable child, force a quota, or poll on a timer.

When modifying existing Canvas content, read current board and object versions first. User-edited content and layout stay protected; conflicts remain reviewable proposals. Handle only this source's feedback; include feedback_sequences in the response; ack only after actually handling it. Queued, read, replied, and handled are different. Call spellcast_remember only with explicit user permission; a kept bubble is not memory."#;

fn nullable_schema<T: schemars::JsonSchema>(
    generator: &mut schemars::SchemaGenerator,
) -> schemars::Schema {
    schemars::json_schema!({
        "anyOf": [
            generator.subschema_for::<T>(),
            { "type": "null" }
        ]
    })
}

fn nullable_string_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    nullable_schema::<String>(generator)
}

fn nullable_u32_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    nullable_schema::<u32>(generator)
}

fn nullable_usize_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    nullable_schema::<usize>(generator)
}

fn nullable_throws_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    nullable_schema::<Vec<PresentThrowParams>>(generator)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct BubbleParams {
    /// Stable originating task id, reused when listening for this task's feedback.
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    source_id: Option<String>,
    /// Complete words shown on the bubble, at most 120 characters.
    tease: String,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    title: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    body: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    kind: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    shape: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    size: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    on_poke: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    screen: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_u32_schema")]
    linger: Option<u32>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    node_id: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_u32_schema")]
    wait: Option<u32>,
}

impl From<BubbleParams> for BubbleRequest {
    fn from(value: BubbleParams) -> Self {
        Self {
            source_id: value.source_id,
            tease: value.tease,
            title: value.title,
            body: value.body,
            kind: value.kind,
            shape: value.shape,
            size: value.size,
            on_poke: value.on_poke,
            screen: value.screen,
            linger: value.linger,
            node_id: value.node_id,
            wait: value.wait,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ArtifactReadParams {
    bundle_id: String,
    /// Omit for the manifest and runtime contract. Name one text file to inspect its source.
    #[serde(default)]
    file: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PresentNodeParams {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    kind: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    weight: Option<String>,
    /// Existing fragment this one belongs to. Creates a parent relationship. Omit for an independent fragment.
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    parent_id: Option<String>,
}

impl From<PresentNodeParams> for ProposedNode {
    fn from(value: PresentNodeParams) -> Self {
        Self {
            id: None,
            source_id: None,
            title: value.title,
            body: value.body,
            kind: value.kind,
            weight: value.weight,
            parent_id: value.parent_id,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PresentThrowParams {
    #[serde(default)]
    #[schemars(schema_with = "nullable_usize_schema")]
    node: Option<usize>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    title: Option<String>,
    tease: String,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    size: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    shape: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    on_poke: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_u32_schema")]
    linger: Option<u32>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    kind: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_u32_schema")]
    delay: Option<u32>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    screen: Option<String>,
}

impl From<PresentThrowParams> for ProposedThrow {
    fn from(value: PresentThrowParams) -> Self {
        Self {
            node: value.node,
            title: value.title,
            tease: value.tease,
            size: value.size,
            shape: value.shape,
            on_poke: value.on_poke,
            linger: value.linger,
            kind: value.kind,
            delay: value.delay,
            screen: value.screen,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PresentParams {
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    source_id: Option<String>,
    #[serde(default)]
    reply: String,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    topic: Option<String>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    form: Option<String>,
    #[serde(default)]
    nodes: Vec<PresentNodeParams>,
    #[serde(default)]
    #[schemars(schema_with = "nullable_throws_schema")]
    throws: Option<Vec<PresentThrowParams>>,
    /// Places new fragments around this node. Does not create a parent relationship.
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    focus_node_id: Option<String>,
    #[serde(default)]
    open: bool,
    #[serde(default)]
    replace: bool,
}

impl From<PresentParams> for PresentPayload {
    fn from(value: PresentParams) -> Self {
        Self {
            source_id: value.source_id,
            reply: value.reply,
            topic: value.topic,
            form: value.form,
            nodes: value.nodes.into_iter().map(Into::into).collect(),
            throws: value
                .throws
                .map(|items| items.into_iter().map(Into::into).collect()),
            focus_node_id: value.focus_node_id,
            open: value.open,
            replace: value.replace,
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
struct ListenParams {
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    source_id: Option<String>,
    /// Read only this exact pending request. Requires source_id; returns immediately,
    /// ignoring since/wait. Acknowledged or missing requests return no event.
    #[serde(default)]
    sequence: Option<u64>,
    #[serde(default)]
    since: u64,
    #[serde(default)]
    wait: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AckParams {
    source_id: String,
    /// Sequence numbers this task has actually handled. Repeated acknowledgements are harmless.
    sequences: Vec<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateParams {
    source_id: String,
    #[serde(flatten)]
    patch: ReplyPatchRequest,
    #[serde(default)]
    feedback_sequences: Vec<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RememberParams {
    /// The durable fact, preference, decision, or reminder to save.
    text: String,
    #[serde(default)]
    #[schemars(schema_with = "nullable_string_schema")]
    title: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
struct RecallParams {
    /// Literal text to find. Empty returns the most recent memories.
    #[serde(default)]
    query: String,
    #[serde(default)]
    #[schemars(schema_with = "nullable_usize_schema")]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ForgetParams {
    /// Exact memory id returned by spellcast_remember or spellcast_recall.
    id: String,
}

#[derive(Clone)]
pub(crate) struct SpellcastMcp {
    bridge: Arc<Bridge>,
    tool_router: ToolRouter<Self>,
}

impl SpellcastMcp {
    fn new(bridge: Arc<Bridge>) -> Self {
        Self {
            bridge,
            tool_router: Self::tool_router(),
        }
    }

    fn identify(&self, context: &RequestContext<RoleServer>) {
        if let Some(client) = context.client_info() {
            self.bridge.identify_client(&client.name, &client.version);
        }
    }

    fn result(value: impl serde::Serialize) -> Result<CallToolResult, ErrorData> {
        serde_json::to_value(value)
            .map(CallToolResult::structured)
            .map_err(|err| {
                ErrorData::internal_error(format!("could not serialize tool result: {err}"), None)
            })
    }

    fn error(err: impl std::fmt::Display) -> ErrorData {
        ErrorData::internal_error(err.to_string(), None)
    }
}

#[tool_router]
impl SpellcastMcp {
    #[tool(
        name = "spellcast_artifact",
        description = "Publish a complete local HTML/CSS/JS work with its assets onto Canvas, or update the same block. Build the directory first; include libraries, original source and media locally. No fixed renderer whitelist. Stable reply/block ids, expected_revision and source ownership preserve other blocks and user state. When answering Ask feedback, inspect artifact_context, pass feedback_sequences, and ack only after the result is saved. For user-edited source, publish a candidate then propose patch_reply; do not overwrite. Runtime contract is on spellcast_artifact_read."
    )]
    async fn artifact(
        &self,
        Parameters(params): Parameters<crate::artifacts::PublishArtifact>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        let bridge = self.bridge.clone();
        let reply = tokio::task::spawn_blocking(move || bridge.publish_artifact(params))
            .await
            .map_err(Self::error)?
            .map_err(Self::error)?;
        Self::result(reply)
    }

    #[tool(
        name = "spellcast_artifact_read",
        description = "Read an immutable Canvas work's manifest, original source, version history and runtime contract. Omit file for metadata; pass an exact text filename from its manifest to inspect that source (up to 200 KB). Binary assets stay in the local store and export bundle. Read the current board too before revising a work."
    )]
    async fn artifact_read(
        &self,
        Parameters(params): Parameters<ArtifactReadParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        let bundle = self
            .bridge
            .artifact(&params.bundle_id)
            .map_err(Self::error)?;
        if let Some(name) = params.file {
            let (mime, bytes) = self
                .bridge
                .artifact_file(&params.bundle_id, &name)
                .map_err(Self::error)?;
            if bytes.len() > 200_000
                || !(mime.starts_with("text/")
                    || mime == "application/json"
                    || mime == "image/svg+xml")
            {
                return Err(Self::error("Use Canvas source/export for binary or large files; inspect a smaller original source file here."));
            }
            let text = String::from_utf8(bytes).map_err(Self::error)?;
            return Self::result(
                json!({ "bundle_id": bundle.id, "file": name, "media_type": mime, "text": text }),
            );
        }
        let history: Vec<_> = self
            .bridge
            .artifact_history(&bundle.id)
            .map_err(Self::error)?
            .into_iter()
            .map(|item| json!({ "id": item.id, "created_at_ms": item.created_at_ms }))
            .collect();
        Self::result(json!({ "bundle": bundle, "history": history, "runtime": {
            "initialize": "const saved = await window.spellcast.ready; Restore controls from saved before registering input handlers.",
            "save": "window.spellcast.setState({parameter: value}) merges a JSON object (64 KB max). Store large data as files. This does not ask a model.",
            "selection": "window.spellcast.select({ids: ['stable-object-id'], label: 'What is selected', asset: 'assets/file', region: {...}, time_range: {...}}). Use fields appropriate to your work; include coordinate units and asset names.",
            "restore": "window.spellcast.onRestore(state => restoreControlsWithoutSavingAgain(state)); The host's content revision does not reset saved parameters.",
            "inputs": "Declare bundle io.inputs/io.outputs. window.spellcast.inputs and onInputs(snapshot => ...) expose {revision,ports:{name:{status,value?,reason?,sources}}}, separate from saved state. Show unavailable explicitly; do not feed cached values onward.",
            "outputs": "window.spellcast.publishOutputs({port: scalar}, snapshot.revision) requires the input revision actually used. Only declared finite scalars are accepted; state changes save before outputs are forwarded. No host commands or expressions.",
            "errors": "window.spellcast.reportError(error). Uncaught errors are reported too. Handle pagehide to dispose graphics, listeners, media and workers.",
            "files": "Use relative local URLs. Bundle libraries, fonts and media with the work. The frame's message channel carries data, not host commands. Use the host to fetch external data and build files. __spellcast.js is injected by the container.",
            "export": "Canvas exports files, original sources, licenses and current state as ZIP. Exported Web works can run under a local static server."
        }}))
    }

    #[tool(
        name = "spellcast_bubble",
        description = "Throw one sparse side thought onto the user's desktop when the user explicitly asks to show it. Not an inline substitute for an independent observer. Never use it for progress, repetition, or a blocking question. Default to none; stay quiet on not_shown, expired, or dismissed."
    )]
    async fn bubble(
        &self,
        Parameters(params): Parameters<BubbleParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        let result = self
            .bridge
            .bubble(params.into())
            .await
            .map_err(Self::error)?;
        Self::result(result)
    }

    #[tool(
        name = "spellcast_observer_status",
        description = "Read aside switch state: enabled, paused, allowed, reason, and policy_revision. The App aside switch is the authority. Call this only when that state is missing or stale. unknown is not OFF; a prior OFF can be refreshed when fresh context next appears. This read does not authorize spawn or require a bubble. Submit checkpoints when enabled and not paused; only checkpoint status=ready starts a child. There is no MCP setter for the product switch."
    )]
    async fn observer_status(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(self.bridge.observer_status())
    }

    #[tool(
        name = "spellcast_checkpoint",
        description = "Submit a short current-project snapshot at the first substantial context and when a plan, new evidence, or a new constraint appears—not conversation history, not every tool call. The main task does not pre-judge bubble value. On a Codex main task, bind the stable source_id once to host startup metadata or the actual CODEX_THREAD_ID and cwd before the first non-null snapshot; do not use an Observer child id, guess the latest task, or bind again on later checkpoints. Submit when asides are enabled and not paused. Only status=ready authorizes one fresh host-native child with no history; forward only the returned brief. Other statuses mean do not spawn or immediately retry; a later new context submits again. Do not silently reason as the observer if the host cannot isolate a child. snapshot=null cancels this source's in-flight observation on task end or project switch; it is source lifecycle cleanup, not required for the App aside switch to turn off. This tool does not spawn a model or claim automatic scheduling."
    )]
    async fn checkpoint(
        &self,
        Parameters(params): Parameters<CheckpointRequest>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(self.bridge.checkpoint(params).map_err(Self::error)?)
    }

    #[tool(
        name = "spellcast_observer_complete",
        description = "An isolated no-history observer submits its single decision directly. thought=null is valid silence; do not invent an aside. A thought must be grounded in the supplied snapshot, not progress or the main answer. A short line that leaves the conversation must still be readable; if tease is not enough, use body for who it applies to and why. Do not call spellcast_bubble to bypass the ticket. The ticket enforces original source, freshness and one completion; return only the compact status to the parent, never the thought."
    )]
    async fn observer_complete(
        &self,
        Parameters(params): Parameters<ObserverCompletion>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(
            self.bridge
                .complete_observation(params)
                .map_err(Self::error)?,
        )
    }

    #[tool(
        name = "spellcast_present",
        description = "Lay several fragments out on the board as a constellation, spatial view, timeline, or stack. focus_node_id only places new fragments around that node; it does not create a relationship. Set parent_id on a node to record a parent link. Do not reduce a requested board reply to a progress notification. Do not clear a user-edited board without permission."
    )]
    async fn present(
        &self,
        Parameters(params): Parameters<PresentParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        let result = self.bridge.present(params.into()).map_err(Self::error)?;
        Self::result(json!({
            "form": result.form,
            "form_reason": result.form_reason,
            "topic": result.topic,
            "nodes": result.nodes,
            "edges": result.edges,
            "throws": result.throws,
            "opened": result.open,
            "surface": self.bridge.status().surface,
            "board_focused": self.bridge.status().board_focused,
        }))
    }

    #[tool(
        name = "spellcast_reply",
        description = "Present a full structured reply on the user's board: mix text, aligned comparisons, labeled relationship graphs, and storyboards. Use a stable originating source_id and the adopted origin_node_id. Read current board versions first; preserve user edits. Include feedback_sequences when answering this source's feedback; ack only after handling."
    )]
    async fn reply(
        &self,
        Parameters(params): Parameters<ReplySubmission>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(
            self.bridge
                .write_reply_for_feedback(params.reply, &params.feedback_sequences)
                .map_err(Self::error)?,
        )
    }

    #[tool(
        name = "spellcast_update",
        description = "Update one block of an existing board reply using its latest expected_revision. Other blocks and the user's edits remain intact. Do not replace an entire reply to evade protection. Include feedback_sequences when answering this source's feedback; ack only after handling. A stale revision is rejected so it can be reconciled explicitly."
    )]
    async fn update_reply(
        &self,
        Parameters(params): Parameters<UpdateParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(
            self.bridge
                .patch_reply_for_feedback(
                    &params.source_id,
                    params.patch,
                    &params.feedback_sequences,
                )
                .map_err(Self::error)?,
        )
    }

    #[tool(
        name = "spellcast_canvas_batch",
        description = "Atomically create native text/images/shapes, patch selected object fields, arrange explicit targets, or compose/ungroup objects. Read spellcast_board first. Declare content/presentation/composition reads and expected write revisions. Use caller-generated stable IDs and request_id; retry identical requests with that ID. User edits/layout are protected: any conflict retains the entire batch as a reviewable proposal and no partial writes occur. Operate only on this source's targets; other sources may be read as context. Include feedback_sequences and all anchored content reads when answering Canvas feedback."
    )]
    async fn canvas_batch(
        &self,
        Parameters(params): Parameters<crate::canvas::CanvasSubmission>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(self.bridge.canvas_batch(params.batch, Some(&params.source_id)).map_err(Self::error)?)
    }

    #[tool(
        name = "spellcast_bind_codex",
        description = "Bind this source to the current Codex task's actual CODEX_THREAD_ID and cwd. Verifies the saved task without starting a model. User-submitted Canvas requests return to this exact task through the running Codex Desktop app; never pass a guessed or most-recent task."
    )]
    async fn bind_codex(
        &self,
        Parameters(params): Parameters<BindCodexRequest>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(self.bridge.bind_codex(params).await.map_err(Self::error)?)
    }

    #[tool(
        name = "spellcast_listen",
        description = "For a Canvas delivery notice, pass source_id and sequence to read only that exact pending request, immediately. status=not_pending means stop; do not redo it. The returned handling instructions match its context. The user's text determines scope; testing or asking does not authorize executing context options. Without sequence, read this source's events after since plus pending input. pending_sequences, not historical events, identifies unhandled requests. Acknowledge only after handling."
    )]
    async fn listen(
        &self,
        Parameters(params): Parameters<ListenParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        if let Some(source) = &params.source_id {
            spellcast_core::reply::validate_id(source).map_err(Self::error)?;
        }
        if let Some(sequence) = params.sequence {
            let source = params.source_id.as_deref().ok_or_else(|| Self::error("按请求编号读取时必须指定 source_id。"))?;
            let mut result = self.bridge.read_feedback_request(source, sequence).map_err(Self::error)?;
            let status = self.bridge.status();
            result["surface"] = json!(status.surface);
            result["board_focused"] = json!(status.board_focused);
            return Self::result(result);
        }
        let (events, last_seq) = self
            .bridge
            .listen_scoped(params.since, params.wait, params.source_id.as_deref())
            .await;
        Self::result(json!({
            "events": events,
            "last_seq": last_seq,
            "pending_sequences": self.bridge.pending_feedback(params.source_id.as_deref()).iter().map(|e| e.seq).collect::<Vec<_>>(),
            "surface": self.bridge.status().surface,
            "board_focused": self.bridge.status().board_focused,
        }))
    }

    #[tool(
        name = "spellcast_ack",
        description = "Acknowledge explicit feedback only after this originating source task has actually handled it. Never ack another task's input. Acknowledgements are idempotent and persist across restart."
    )]
    async fn ack(
        &self,
        Parameters(params): Parameters<AckParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        let acknowledged = self
            .bridge
            .acknowledge_feedback(&params.source_id, &params.sequences)
            .map_err(Self::error)?;
        Self::result(json!({ "acknowledged": acknowledged }))
    }

    #[tool(
        name = "spellcast_board",
        description = "Read the current board and object versions before referring to fragments or revising them. surface is the selected mode; board_focused is actual window focus. User-edited content and layout stay protected."
    )]
    async fn board(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        self.bridge.hello_quiet();
        let status = self.bridge.status();
        let mut board = json!(self.bridge.board());
        board["surface"] = json!(status.surface);
        board["board_focused"] = json!(status.board_focused);
        Self::result(board)
    }

    #[tool(
        name = "spellcast_clear",
        description = "Empty the board and close every bubble. Ask before clearing a board the user edited."
    )]
    async fn clear(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        self.bridge.clear().map_err(Self::error)?;
        Self::result(json!({ "ok": true }))
    }

    #[tool(
        name = "spellcast_remember",
        description = "Save durable memory only when the user explicitly asks to remember it or clearly confirms it should persist. A kept bubble is not enough."
    )]
    async fn remember(
        &self,
        Parameters(params): Parameters<RememberParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        self.bridge.hello_quiet();
        let memory = self
            .bridge
            .remember(params.title, params.text)
            .map_err(Self::error)?;
        Self::result(memory)
    }

    #[tool(
        name = "spellcast_recall",
        description = "Search durable Spellcast memory. Use this before claiming what was previously remembered."
    )]
    async fn recall(
        &self,
        Parameters(params): Parameters<RecallParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        self.bridge.hello_quiet();
        let memories = self
            .bridge
            .recall(&params.query, params.limit.unwrap_or(8))
            .map_err(Self::error)?;
        Self::result(json!({ "memories": memories }))
    }

    #[tool(
        name = "spellcast_forget",
        description = "Permanently remove one durable memory by its exact id when the user asks to forget it."
    )]
    async fn forget(
        &self,
        Parameters(params): Parameters<ForgetParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        self.bridge.hello_quiet();
        let forgotten = self.bridge.forget(&params.id).map_err(Self::error)?;
        Self::result(json!({ "forgotten": forgotten }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SpellcastMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("spellcast", VERSION))
            .with_instructions(INSTRUCTIONS)
    }

    fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<InitializeResult, ErrorData>> + Send + '_ {
        context.peer.set_peer_info(request.clone());
        self.bridge
            .identify_client(&request.client_info.name, &request.client_info.version);
        let mut info = self.get_info();
        let requested = request.protocol_version;
        let selected = if requested.as_str() < ProtocolVersion::V_2026_07_28.as_str()
            && ProtocolVersion::KNOWN_VERSIONS.contains(&requested)
        {
            requested
        } else {
            ProtocolVersion::KNOWN_VERSIONS
                .iter()
                .filter(|version| version.as_str() < ProtocolVersion::V_2026_07_28.as_str())
                .max_by(|left, right| left.as_str().cmp(right.as_str()))
                .cloned()
                .unwrap_or(ProtocolVersion::V_2025_11_25)
        };
        info.protocol_version = selected;
        ready(Ok(info))
    }
}

pub(crate) fn service(
    bridge: Arc<Bridge>,
) -> StreamableHttpService<SpellcastMcp, LocalSessionManager> {
    let handler = SpellcastMcp::new(bridge);
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_allowed_origins(TRUSTED_ORIGINS);
    StreamableHttpService::new(move || Ok(handler.clone()), Default::default(), config)
}

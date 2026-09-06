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
use spellcast_core::{ReplyPatchRequest, ReplyRequest};

use crate::{Bridge, TRUSTED_ORIGINS, VERSION};

pub const PROTOCOL_VERSION: &str = "2025-03-26";

pub const INSTRUCTIONS: &str = r#"Spellcast is the user's local desktop stage and everything board. The model stays in its existing host.

Use spellcast_bubble sparingly for a worthwhile aside from the Agent's current task. It appears on the user's foreground display without bringing the host or board forward. Selected board mode and actual window focus are separate: surface=focus is not a pause when board_focused=false. A kept bubble becomes a board fragment. Use one stable source_id for the originating task, and reuse it when listening.

When the user enters board mode or asks to develop a kept idea, the board can carry the full reply. Use spellcast_reply with text, comparison, graph, and sequence blocks, and origin_node_id when developing an adopted fragment. Use spellcast_present for loose fragments. Never reduce the user's requested board reply to a progress notification.

Read spellcast_board before revising existing content. Use spellcast_update to change one block with its latest expected_revision; preserve the user's edits and the other blocks. Graph edges need meaningful labels. Comparisons share criteria; sequence order is explicit, not derived from screen position.

Read feedback with spellcast_listen(source_id, since). Pending explicit feedback is returned until acknowledged, even when older than since. Handle only your source's input, then call spellcast_ack with its sequence ids. A quiet or closed model is not automatically awakened; do not promise an immediate reply without a live handler.

Only call spellcast_remember when the user explicitly asks to remember something or clearly confirms that it should become durable memory. A kept bubble is not automatically memory. Use spellcast_recall before claiming what was remembered, and spellcast_forget when the user asks to remove a memory."#;

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
        name = "spellcast_bubble",
        description = "Throw one sparse side thought onto the user's desktop. Never use it for progress, repetition, or a blocking question."
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
        name = "spellcast_present",
        description = "Lay several fragments out on the board as a constellation, spatial view, timeline, or stack."
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
        description = "Present a full structured reply on the user's board: mix text, aligned comparisons, labeled relationship graphs, and storyboards. Use a stable source_id and the adopted origin_node_id. Read the board before replacing an existing reply."
    )]
    async fn reply(
        &self,
        Parameters(params): Parameters<ReplyRequest>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(self.bridge.write_reply(params).map_err(Self::error)?)
    }

    #[tool(
        name = "spellcast_update",
        description = "Update one block of an existing board reply using its latest expected_revision. Other blocks and the user's edits remain intact. A stale revision is rejected so it can be reconciled explicitly."
    )]
    async fn update_reply(
        &self,
        Parameters(params): Parameters<UpdateParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.identify(&context);
        Self::result(
            self.bridge
                .patch_reply_from_source(&params.source_id, params.patch)
                .map_err(Self::error)?,
        )
    }

    #[tool(
        name = "spellcast_listen",
        description = "Read this source_id's feedback after a sequence number, plus unacknowledged explicit input. Use the originating task's id; acknowledge only after handling it. Without source_id this remains a legacy all-source view."
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
        description = "Acknowledge explicit feedback only after this source task has handled it. The source_id must match the feedback; acknowledgements are idempotent and persist across restart."
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
        description = "Read the current board before referring to its fragments or arrangement."
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

//! Native application delegation. There are deliberately no HTTP or MCP routes.
//! The caller must establish kernel peer identity before constructing OsClient.
//! Wire contract: docs/client-write-protocol.md. Public epochs are not credentials.
use crate::{
    project_records::{RecordActor, RecordChange, RecordCommand, RecordFields},
    sigils::{SigilActor, SigilPlan},
    Bridge,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellcast_core::{
    inbox::now_ms, CanvasBatchRequest, CanvasContent, CanvasOperation, CanvasPlacementFields,
};

pub const PROTOCOL: u32 = 1;
pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_REPLY: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientIdentity {
    pub path: String,
    pub sha256: String,
    pub sid: String,
    pub file_id: String,
}

#[derive(Debug, Clone)]
pub struct OsClient {
    identity: ClientIdentity,
    process_id: u32,
    created_at: u64,
}
impl OsClient {
    /// NOT an authenticator. Only an OS peer verifier may call this; never use JSON
    /// request fields. The native adapter holds the verified process/image handles.
    pub fn from_verified_os(
        identity: ClientIdentity,
        process_id: u32,
        created_at: u64,
    ) -> Result<Self, ClientError> {
        if process_id == 0
            || created_at == 0
            || !hex(&identity.sha256, 64)
            || identity.file_id.is_empty()
            || identity.file_id.len() > 128
            || !identity
                .file_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
            || !identity.sid.starts_with("S-1-")
            || identity.sid.len() > 184
            || !identity
                .sid
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
            || identity.path.len() > 32768
            || identity.path.contains('\0')
            || !std::path::Path::new(&identity.path).is_absolute()
            || !identity
                .path
                .replace('/', "\\")
                .rsplit('\\')
                .next()
                .is_some_and(|s| s.eq_ignore_ascii_case("ccgui-next.exe"))
        {
            return Err(ClientError::IdentityUnknown);
        }
        Ok(Self {
            identity,
            process_id,
            created_at,
        })
    }
    pub fn identity(&self) -> &ClientIdentity {
        &self.identity
    }
    pub fn process_id(&self) -> u32 {
        self.process_id
    }
    pub fn created_at(&self) -> u64 {
        self.created_at
    }
    pub fn key(&self) -> String {
        digest(&json!([self.identity.sid, self.identity.path.to_lowercase()]).to_string())
    }
    pub fn process_stamp(&self) -> String {
        digest(&json!([self.key(), self.identity, self.process_id, self.created_at]).to_string())
    }
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientScopes {
    pub records: bool,
    pub sigil_drafts: bool,
}
impl ClientScopes {
    fn allows(self, scope: &str) -> bool {
        match scope {
            "records" => self.records,
            "sigil_drafts" => self.sigil_drafts,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientGrant {
    pub id: String,
    pub identity: ClientIdentity,
    pub scopes: ClientScopes,
    pub state: String,
    pub revision: u64,
    pub generation: u64,
    pub approved_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientChange {
    PutRecord {
        project_id: String,
        id: String,
        expected_revision: u64,
        fields: RecordFields,
    },
    SigilCreate {
        plan: SigilPlan,
    },
    SigilPutPlan {
        id: String,
        expected_revision: u64,
        plan: SigilPlan,
    },
}
impl ClientChange {
    fn scope(&self) -> &'static str {
        match self {
            Self::PutRecord { .. } => "records",
            _ => "sigil_drafts",
        }
    }
    fn operation(&self) -> &'static str {
        match self {
            Self::PutRecord { .. } => "put_record",
            Self::SigilCreate { .. } => "sigil_create",
            _ => "sigil_put_plan",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientSession {
    pub server_epoch: String,
    pub process_stamp: String,
    pub grant_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientRequest {
    Status {
        protocol: u32,
    },
    Save {
        protocol: u32,
        session: ClientSession,
        request_id: String,
        change: ClientChange,
    },
    Receipt {
        protocol: u32,
        session: ClientSession,
        request_id: String,
    },
}
impl ClientRequest {
    pub fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        if bytes.len() > MAX_FRAME {
            return Err(ClientError::InvalidRequest);
        }
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| ClientError::InvalidRequest)?;
        // Existing product structs are backward-compatible, permissive decoders.
        // This new protocol must reject unknown fields at EVERY nested boundary.
        if let Some(change) = value.get("change") {
            if let Some(fields) = change.get("fields") {
                keys(
                    fields,
                    &[
                        "object_id",
                        "title",
                        "goal",
                        "scope",
                        "status",
                        "result",
                        "boundaries",
                        "next_step",
                        "references",
                    ],
                )?;
                objects(fields, "references", &["label", "uri", "version"])?;
            }
            if let Some(plan) = change.get("plan") {
                keys(
                    plan,
                    &[
                        "title",
                        "goal",
                        "repository",
                        "base_ref",
                        "location",
                        "worktree_path",
                        "materials",
                        "open_questions",
                        "steps",
                    ],
                )?;
                objects(plan, "materials", &["object_id", "content_revision"])?;
                if let Some(steps) = plan.get("steps") {
                    for step in steps.as_array().ok_or(ClientError::InvalidRequest)? {
                        keys(
                            step,
                            &[
                                "id",
                                "title",
                                "instructions",
                                "inputs",
                                "scope",
                                "checks",
                                "depends_on",
                                "stop_when",
                            ],
                        )?;
                        if let Some(checks) = step.get("checks") {
                            for check in checks.as_array().ok_or(ClientError::InvalidRequest)? {
                                keys(
                                    check,
                                    match check.get("kind").and_then(Value::as_str) {
                                        Some("command") => &["kind", "label", "argv", "timeout_s"],
                                        Some("manual") => &["kind", "label", "description", "blocking"],
                                        _ => return Err(ClientError::InvalidRequest),
                                    },
                                )?;
                            }
                        }
                    }
                }
            }
        }
        serde_json::from_value(value).map_err(|_| ClientError::InvalidRequest)
    }
    fn protocol(&self) -> u32 {
        match self {
            Self::Status { protocol }
            | Self::Save { protocol, .. }
            | Self::Receipt { protocol, .. } => *protocol,
        }
    }
}
fn keys(value: &Value, allowed: &[&str]) -> Result<(), ClientError> {
    if value
        .as_object()
        .ok_or(ClientError::InvalidRequest)?
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err(ClientError::InvalidRequest);
    }
    Ok(())
}
fn objects(value: &Value, field: &str, allowed: &[&str]) -> Result<(), ClientError> {
    if let Some(items) = value.get(field) {
        for item in items.as_array().ok_or(ClientError::InvalidRequest)? {
            keys(item, allowed)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientError {
    InvalidRequest,
    IdentityUnknown,
    GrantRequired,
    IdentityChanged,
    Revoked,
    StaleSession,
    ScopeDenied,
    Conflict,
    NotDraft,
    IdempotencyConflict,
    NotFound,
    StorageUnavailable,
    OutcomeUnknown,
}
impl ClientError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::IdentityUnknown => "identity_unknown",
            Self::GrantRequired => "grant_required",
            Self::IdentityChanged => "identity_changed",
            Self::Revoked => "revoked",
            Self::StaleSession => "stale_session",
            Self::ScopeDenied => "scope_denied",
            Self::Conflict => "conflict",
            Self::NotDraft => "not_draft",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::NotFound => "not_found",
            Self::StorageUnavailable => "storage_unavailable",
            Self::OutcomeUnknown => "outcome_unknown",
        }
    }
}
impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ClientError {}

#[derive(Debug, Serialize)]
pub struct ClientReply {
    pub protocol: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}
impl ClientReply {
    pub fn failure(error: ClientError) -> Self {
        Self {
            protocol: PROTOCOL,
            ok: false,
            data: None,
            error: Some(
                json!({"code":error.code(),"outcome_unknown":error == ClientError::OutcomeUnknown}),
            ),
        }
    }
    fn success(data: Value) -> Self {
        Self {
            protocol: PROTOCOL,
            ok: true,
            data: Some(data),
            error: None,
        }
    }
}

pub(crate) fn init_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS spellcast_client_grants(client_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS spellcast_client_receipts(grant_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL,
            scope TEXT NOT NULL, result_json TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(grant_id,request_id));
        CREATE TABLE IF NOT EXISTS spellcast_client_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL,
            grant_id TEXT NOT NULL, generation INTEGER NOT NULL, operation TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
            identity_fingerprint TEXT NOT NULL, policy_revision INTEGER NOT NULL, scopes_json TEXT NOT NULL);")
        .map_err(|e| e.to_string())
}
fn stored_grant(db: &Connection, key: &str) -> Result<Option<ClientGrant>, ClientError> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM spellcast_client_grants WHERE client_key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| ClientError::StorageUnavailable)?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| ClientError::StorageUnavailable))
        .transpose()
}
fn audit(
    db: &Connection,
    grant: &ClientGrant,
    operation: &str,
    request_hash: &str,
    result: &str,
) -> Result<(), ClientError> {
    db.execute("INSERT INTO spellcast_client_audit(at_ms,grant_id,generation,operation,request_hash,result,identity_fingerprint,policy_revision,scopes_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![now_ms(), grant.id, grant.generation, operation, request_hash, result,
            digest(&serde_json::to_string(&grant.identity).map_err(|_| ClientError::StorageUnavailable)?),grant.revision,
            serde_json::to_string(&grant.scopes).map_err(|_| ClientError::StorageUnavailable)?]).map_err(|_| ClientError::StorageUnavailable)?;
    Ok(())
}
fn save_grant(tx: &Transaction<'_>, key: &str, grant: &ClientGrant) -> Result<(), ClientError> {
    let value = serde_json::to_string(grant).map_err(|_| ClientError::StorageUnavailable)?;
    tx.execute("INSERT INTO spellcast_client_grants(client_key,id,value) VALUES(?1,?2,?3) ON CONFLICT(client_key) DO UPDATE SET value=excluded.value",
        params![key,grant.id,value]).map_err(|_| ClientError::StorageUnavailable)?;
    Ok(())
}

/// Importing a database is data restoration, not native application approval.
/// Existing write receipts remain intact. Legacy databases have no grant table
/// and this function does not create one for them.
pub fn revoke_imported_grants(db: &mut Connection) -> Result<(), ClientError> {
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='spellcast_client_grants')",[],|r|r.get(0)).map_err(|_|ClientError::StorageUnavailable)?;
    if !exists {
        return Ok(());
    }
    init_schema(db).map_err(|_| ClientError::StorageUnavailable)?;
    let tx = db
        .transaction()
        .map_err(|_| ClientError::StorageUnavailable)?;
    let rows = {
        let mut stmt = tx
            .prepare("SELECT client_key,value FROM spellcast_client_grants")
            .map_err(|_| ClientError::StorageUnavailable)?;
        let values = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| ClientError::StorageUnavailable)?;
        values
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ClientError::StorageUnavailable)?
    };
    for (key, raw) in rows {
        let mut grant: ClientGrant =
            serde_json::from_str(&raw).map_err(|_| ClientError::StorageUnavailable)?;
        grant.state = "revoked".into();
        grant.revision = grant.revision.checked_add(1).ok_or(ClientError::Conflict)?;
        grant.generation = grant
            .generation
            .checked_add(1)
            .ok_or(ClientError::Conflict)?;
        grant.updated_at_ms = now_ms();
        save_grant(&tx, &key, &grant)?;
        audit(&tx, &grant, "import_revoke", "", "revoked")?;
    }
    tx.commit().map_err(|_| ClientError::OutcomeUnknown)
}

impl Bridge {
    pub fn client_grants(&self) -> Result<Vec<ClientGrant>, ClientError> {
        let store = self
            .project_store()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let mut stmt = store
            .connection
            .prepare("SELECT value FROM spellcast_client_grants ORDER BY rowid DESC LIMIT 500")
            .map_err(|_| ClientError::StorageUnavailable)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| ClientError::StorageUnavailable)?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|_| ClientError::StorageUnavailable)?)
                .map_err(|_| ClientError::StorageUnavailable)
        })
        .collect()
    }
    /// Native MAIN window confirmation ONLY; never register as an HTTP/MCP operation.
    pub fn client_approve(
        &self,
        peer: &OsClient,
        expected_revision: u64,
        scopes: ClientScopes,
    ) -> Result<ClientGrant, ClientError> {
        if !scopes.records && !scopes.sigil_drafts {
            return Err(ClientError::ScopeDenied);
        }
        let mut store = self
            .project_store()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let tx = store
            .connection
            .transaction()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let previous = stored_grant(&tx, &peer.key())?;
        if previous.as_ref().map_or(0, |g| g.revision) != expected_revision {
            return Err(ClientError::Conflict);
        }
        let time = now_ms();
        let grant = ClientGrant {
            id: previous
                .as_ref()
                .map_or_else(|| uuid::Uuid::new_v4().to_string(), |g| g.id.clone()),
            identity: peer.identity.clone(),
            scopes,
            state: "approved".into(),
            revision: expected_revision
                .checked_add(1)
                .ok_or(ClientError::Conflict)?,
            generation: previous.as_ref().map_or(Ok(1), |g| {
                g.generation.checked_add(1).ok_or(ClientError::Conflict)
            })?,
            approved_at_ms: time,
            updated_at_ms: time,
        };
        save_grant(&tx, &peer.key(), &grant)?;
        audit(&tx, &grant, "approve", "", "approved")?;
        tx.commit().map_err(|_| ClientError::OutcomeUnknown)?;
        Ok(grant)
    }
    pub fn client_revoke(
        &self,
        grant_id: &str,
        expected_revision: u64,
    ) -> Result<ClientGrant, ClientError> {
        let mut store = self
            .project_store()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let tx = store
            .connection
            .transaction()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let pair: Option<(String, String)> = tx
            .query_row(
                "SELECT client_key,value FROM spellcast_client_grants WHERE id=?1",
                [grant_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let (key, raw) = pair.ok_or(ClientError::NotFound)?;
        let mut grant: ClientGrant =
            serde_json::from_str(&raw).map_err(|_| ClientError::StorageUnavailable)?;
        if grant.revision != expected_revision {
            return Err(ClientError::Conflict);
        }
        grant.revision = grant.revision.checked_add(1).ok_or(ClientError::Conflict)?;
        grant.generation = grant
            .generation
            .checked_add(1)
            .ok_or(ClientError::Conflict)?;
        grant.state = "revoked".into();
        grant.updated_at_ms = now_ms();
        save_grant(&tx, &key, &grant)?;
        audit(&tx, &grant, "revoke", "", "revoked")?;
        tx.commit().map_err(|_| ClientError::OutcomeUnknown)?;
        Ok(grant)
    }
    fn client_authorize(
        &self,
        db: &Connection,
        peer: &OsClient,
        session: &ClientSession,
    ) -> Result<ClientGrant, ClientError> {
        if session.server_epoch != self.client_epoch
            || session.process_stamp != peer.process_stamp()
        {
            return Err(ClientError::StaleSession);
        }
        let grant = stored_grant(db, &peer.key())?.ok_or(ClientError::GrantRequired)?;
        if grant.identity != peer.identity {
            return Err(ClientError::IdentityChanged);
        }
        if grant.state != "approved" {
            return Err(ClientError::Revoked);
        }
        if grant.id != session.grant_id || grant.generation != session.generation {
            return Err(ClientError::StaleSession);
        }
        Ok(grant)
    }
    pub fn client_handle(&self, peer: &OsClient, request: ClientRequest) -> ClientReply {
        if request.protocol() != PROTOCOL {
            return ClientReply::failure(ClientError::InvalidRequest);
        }
        let result = match request {
            ClientRequest::Status { .. } => self.client_status(peer),
            ClientRequest::Save {
                session,
                request_id,
                change,
                ..
            } => self.client_save(peer, &session, &request_id, &change),
            ClientRequest::Receipt {
                session,
                request_id,
                ..
            } => self.client_receipt(peer, &session, &request_id),
        };
        match result {
            Ok(v) => ClientReply::success(v),
            Err(e) => ClientReply::failure(e),
        }
    }
    fn client_status(&self, peer: &OsClient) -> Result<Value, ClientError> {
        let store = self
            .project_store()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let grant = stored_grant(&store.connection, &peer.key())?;
        let granted = grant
            .as_ref()
            .is_some_and(|g| g.state == "approved" && g.identity == peer.identity);
        Ok(
            json!({"server_epoch":self.client_epoch,"process_stamp":peer.process_stamp(),"identity":peer.identity,"grant":grant,"granted":granted}),
        )
    }
    fn client_receipt(
        &self,
        peer: &OsClient,
        session: &ClientSession,
        request_id: &str,
    ) -> Result<Value, ClientError> {
        crate::sigil_workspace::validate_request_id(request_id)
            .map_err(|_| ClientError::InvalidRequest)?;
        let store = self
            .project_store()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let grant = self.client_authorize(&store.connection, peer, session)?;
        let saved: Option<(String,String)> = store.connection.query_row("SELECT scope,result_json FROM spellcast_client_receipts WHERE grant_id=?1 AND request_id=?2", params![grant.id,request_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| ClientError::StorageUnavailable)?;
        let Some((scope, result)) = saved else {
            return Ok(json!({"request_id":request_id,"state":"not_found"}));
        };
        if !grant.scopes.allows(&scope) {
            return Err(ClientError::ScopeDenied);
        }
        let result: Value =
            serde_json::from_str(&result).map_err(|_| ClientError::StorageUnavailable)?;
        Ok(json!({"request_id":request_id,"state":"committed","result":result}))
    }
    fn client_save(
        &self,
        peer: &OsClient,
        session: &ClientSession,
        request_id: &str,
        change: &ClientChange,
    ) -> Result<Value, ClientError> {
        crate::sigil_workspace::validate_request_id(request_id)
            .map_err(|_| ClientError::InvalidRequest)?;
        // Same lock order as all existing Canvas writes: state -> Store. Revoke
        // acquires Store, so it cannot race any part of this transaction.
        let mut current = self
            .state
            .lock()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let mut store = self
            .project_store()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let grant = self.client_authorize(&store.connection, peer, session)?;
        if !grant.scopes.allows(change.scope()) {
            audit(
                &store.connection,
                &grant,
                change.operation(),
                &digest(request_id),
                "scope_denied",
            )?;
            return Err(ClientError::ScopeDenied);
        }
        let body = serde_json::to_string(change).map_err(|_| ClientError::InvalidRequest)?;
        if body.len() > MAX_FRAME {
            return Err(ClientError::InvalidRequest);
        }
        let body_hash = digest(&body);
        let tx = store
            .connection
            .transaction()
            .map_err(|_| ClientError::StorageUnavailable)?;
        let existing: Option<(String,String)> = tx.query_row("SELECT body_hash,result_json FROM spellcast_client_receipts WHERE grant_id=?1 AND request_id=?2", params![grant.id,request_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_| ClientError::StorageUnavailable)?;
        if let Some((hash, result)) = existing {
            if hash != body_hash {
                return Err(ClientError::IdempotencyConflict);
            }
            let mut result: Value =
                serde_json::from_str(&result).map_err(|_| ClientError::StorageUnavailable)?;
            result["replayed"] = json!(true);
            audit(
                &tx,
                &grant,
                change.operation(),
                &digest(request_id),
                "replayed",
            )?;
            tx.commit().map_err(|_| ClientError::OutcomeUnknown)?;
            return Ok(result);
        }
        let mut next = current.clone();
        let mutation = (|| {
            let actor_id = format!("client:{}", grant.id);
            let result = match change {
                ClientChange::PutRecord {
                    project_id,
                    id,
                    expected_revision,
                    fields,
                } => {
                    let revision: Option<u64> = tx.query_row("SELECT revision FROM spellcast_project_records WHERE project_id=?1 AND id=?2", params![project_id,id], |r| r.get(0)).optional().map_err(|_| ClientError::StorageUnavailable)?;
                    cas(revision, *expected_revision)?;
                    let command = RecordCommand {
                        request_id: format!(
                            "client-{}",
                            digest(&format!("{}:{request_id}", grant.id))
                        ),
                        project_id: project_id.clone(),
                        change: RecordChange::PutRecord {
                            id: id.clone(),
                            expected_revision: *expected_revision,
                            fields: fields.clone(),
                        },
                    };
                    let actor = RecordActor {
                        kind: "client".into(),
                        source_id: Some(actor_id),
                        thread_id: None,
                        cwd: None,
                        label: "CCGUI".into(),
                    };
                    let result =
                        crate::project_record_store::client_put_record(&tx, &command, &actor)
                            .map_err(|_| ClientError::InvalidRequest)?;
                    serde_json::to_value(result).map_err(|_| ClientError::StorageUnavailable)?
                }
                ClientChange::SigilCreate { plan } | ClientChange::SigilPutPlan { plan, .. } => {
                    for material in &plan.materials {
                        let object = next
                            .session
                            .board
                            .canvas
                            .object(&material.object_id)
                            .ok_or(ClientError::Conflict)?;
                        if object.content_revision != material.content_revision
                            || !next
                                .session
                                .board
                                .canvas
                                .items
                                .iter()
                                .any(|i| i.item_id == material.object_id && !i.removed)
                        {
                            return Err(ClientError::Conflict);
                        }
                    }
                    let (id, revision, created) = match change {
                        ClientChange::SigilCreate { .. } => {
                            (format!("client-{}", uuid::Uuid::new_v4().simple()), 0, true)
                        }
                        ClientChange::SigilPutPlan {
                            id,
                            expected_revision,
                            ..
                        } => {
                            crate::sigils::validate_sigil_id(id)
                                .map_err(|_| ClientError::InvalidRequest)?;
                            let existing: Option<(u64, String)> = tx
                                .query_row(
                                    "SELECT revision,state FROM spellcast_sigils WHERE id=?1",
                                    [id],
                                    |r| Ok((r.get(0)?, r.get(1)?)),
                                )
                                .optional()
                                .map_err(|_| ClientError::StorageUnavailable)?;
                            let (revision, state) = existing.ok_or(ClientError::NotFound)?;
                            cas(Some(revision), *expected_revision)?;
                            if state != "draft" {
                                return Err(ClientError::NotDraft);
                            }
                            (id.clone(), *expected_revision, false)
                        }
                        _ => unreachable!(),
                    };
                    let actor = SigilActor {
                        kind: "client".into(),
                        source_id: Some(actor_id),
                        label: "CCGUI".into(),
                    };
                    let saved = crate::sigil_store::client_put_plan(
                        &tx,
                        &id,
                        revision,
                        plan,
                        &actor,
                        now_ms(),
                    )
                    .map_err(|_| ClientError::InvalidRequest)?;
                    let card_id = format!("sigil-{id}");
                    if created {
                        if next.session.board.canvas.object(&card_id).is_some() {
                            return Err(ClientError::Conflict);
                        }
                        let x = next
                            .session
                            .board
                            .canvas
                            .items
                            .iter()
                            .filter(|i| !i.removed)
                            .map(|i| i.x + i.width)
                            .fold(0.0_f64, f64::max)
                            + 48.0;
                        let batch = CanvasBatchRequest {
                            request_id: format!(
                                "client-card-{}",
                                digest(&format!("{}:{request_id}", grant.id))
                            ),
                            reads: vec![],
                            feedback_sequences: vec![],
                            operations: vec![CanvasOperation::Create {
                                id: card_id.clone(),
                                content: CanvasContent::Sigil {
                                    sigil_id: id.clone(),
                                },
                                origin: None,
                                placement: CanvasPlacementFields {
                                    x: Some(x),
                                    y: Some(80.0),
                                    width: Some(480.0),
                                    height: Some(300.0),
                                    ..Default::default()
                                },
                                bindings: vec![],
                            }],
                        };
                        let applied = next
                            .session
                            .apply_canvas_batch(batch, None)
                            .map_err(|_| ClientError::Conflict)?;
                        if applied.status != spellcast_core::CanvasBatchStatus::Applied {
                            return Err(ClientError::Conflict);
                        }
                        next.session.sync_canvas();
                        current
                            .session
                            .ensure_delete_locks_preserved(&next.session)
                            .map_err(|_| ClientError::Conflict)?;
                        tx.execute("INSERT INTO spellcast_state(id,schema_version,value) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version,value=excluded.value",
                            params![crate::store::SCHEMA_VERSION,serde_json::to_string(&next).map_err(|_| ClientError::StorageUnavailable)?]).map_err(|_| ClientError::StorageUnavailable)?;
                    }
                    json!({"sigil_id":id,"sigil":saved.sigil,"created":created,"deleted":false,"replayed":false,"card_id":card_id})
                }
            };
            let result_json =
                serde_json::to_string(&result).map_err(|_| ClientError::StorageUnavailable)?;
            if result_json.len() > MAX_REPLY - 4096 {
                return Err(ClientError::InvalidRequest);
            }
            tx.execute("INSERT INTO spellcast_client_receipts(grant_id,request_id,body_hash,scope,result_json,generation) VALUES(?1,?2,?3,?4,?5,?6)",
                params![grant.id,request_id,body_hash,change.scope(),result_json,grant.generation]).map_err(|_| ClientError::StorageUnavailable)?;
            audit(
                &tx,
                &grant,
                change.operation(),
                &digest(request_id),
                "committed",
            )?;
            Ok(result)
        })();
        let result = match mutation {
            Ok(result) => result,
            Err(error) => {
                drop(tx);
                audit(
                    &store.connection,
                    &grant,
                    change.operation(),
                    &digest(request_id),
                    error.code(),
                )?;
                return Err(error);
            }
        };
        tx.commit().map_err(|_| ClientError::OutcomeUnknown)?;
        *current = next;
        drop(store);
        *self
            .annotation_index
            .lock()
            .map_err(|_| ClientError::OutcomeUnknown)? = None;
        drop(current);
        // Only a UI invalidation. No sigil_answer/review/observer/executor hook.
        self.surface.board_changed();
        Ok(result)
    }
}
fn cas(current: Option<u64>, expected: u64) -> Result<(), ClientError> {
    if current.map_or(expected != 0, |r| r != expected || expected == 0) {
        Err(ClientError::Conflict)
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "client_access_tests.rs"]
mod tests;

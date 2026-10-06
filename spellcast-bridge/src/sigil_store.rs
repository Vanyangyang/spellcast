//! Sigil persistence in the canonical database. Tables live outside the versioned schema, so
//! older builds ignore them. Each mutation commits state, history, events and receipt together.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sigils::{is_notice, validate_plan, Sigil, SigilActor, SigilFreeze, SigilPlan, SigilState, SigilSummary};
use crate::store::Store;

pub(crate) fn init_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS spellcast_sigils (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                state TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                value_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS spellcast_sigil_plan_history (
                sigil_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                operation TEXT NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(sigil_id, revision)
            );
            CREATE TABLE IF NOT EXISTS spellcast_sigil_events (
                sigil_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                at_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(sigil_id, seq)
            );
            CREATE TABLE IF NOT EXISTS spellcast_sigil_receipts (
                request_id TEXT PRIMARY KEY,
                sigil_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL,
                at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS spellcast_sigil_check_outputs (
                sigil_id TEXT NOT NULL,
                run INTEGER NOT NULL,
                step_id TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                check_index INTEGER NOT NULL,
                output TEXT NOT NULL,
                PRIMARY KEY(sigil_id, run)
            );",
        )
        .map_err(|error| format!("创建法阵表失败：{error}"))
}

/// Draft and freeze changes shared by the agent and window paths.
pub(crate) enum SigilChange<'a> {
    PutPlan { expected_revision: u64, plan: &'a SigilPlan },
    Freeze { expected_revision: u64, record: SigilFreeze, reviewed_revision: u64, blocked: Option<String> },
    Unfreeze { expected_revision: u64 },
    Delete { expected_revision: u64 },
}

/// What a change produced. `history` names the operation when the plan revision changed.
pub(crate) enum Applied {
    Write { sigil: Box<Sigil>, history: Option<&'static str>, created: bool },
    Delete,
}

/// Events a change appends, in order.
pub(crate) type Events = Vec<(String, Value)>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SigilMutation {
    pub sigil_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sigil: Option<Sigil>,
    #[serde(default)]
    pub created: bool,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub replayed: bool,
    /// Events for the calling executor since it was last told.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<SigilEvent>,
    /// The latest event sequence after this change.
    #[serde(default)]
    pub cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SigilEvent {
    pub seq: u64,
    pub at_ms: u64,
    pub kind: String,
    pub value: Value,
}

/// The kept output of one command run, stored beside the sigil so the row and its receipts
/// stay small.
pub(crate) struct CheckOutput<'a> {
    pub run: u64,
    pub step_id: &'a str,
    pub attempt: u32,
    pub index: usize,
    pub output: &'a str,
}

fn db_u64(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "数值超出存储范围。".to_string())
}

fn decode(id: &str, json: &str) -> Result<Sigil, String> {
    let sigil: Sigil = serde_json::from_str(json).map_err(|error| format!("法阵数据损坏：{error}"))?;
    if sigil.id != id {
        return Err("法阵身份与存储位置不一致。".into());
    }
    Ok(sigil)
}

fn read(connection: &Connection, id: &str) -> Result<Option<Sigil>, String> {
    let json: Option<String> = connection
        .query_row("SELECT value_json FROM spellcast_sigils WHERE id = ?1", params![id], |row| row.get(0))
        .optional()
        .map_err(|error| format!("读取法阵失败：{error}"))?;
    json.map(|json| decode(id, &json)).transpose()
}

fn write(transaction: &Transaction<'_>, sigil: &Sigil, history: Option<&str>) -> Result<(), String> {
    let json = serde_json::to_string(sigil).map_err(|error| format!("序列化法阵失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO spellcast_sigils (id, revision, state, updated_at_ms, value_json) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state,
                updated_at_ms = excluded.updated_at_ms, value_json = excluded.value_json",
            params![sigil.id, db_u64(sigil.revision)?, sigil.state.as_str(), db_u64(sigil.updated_at_ms)?, json],
        )
        .map_err(|error| format!("写入法阵失败：{error}"))?;
    if let Some(operation) = history {
        transaction
            .execute(
                "INSERT INTO spellcast_sigil_plan_history (sigil_id, revision, operation, value_json) VALUES (?1, ?2, ?3, ?4)",
                params![sigil.id, db_u64(sigil.revision)?, operation, json],
            )
            .map_err(|error| format!("写入法阵历史失败：{error}"))?;
    }
    Ok(())
}

fn last_seq(connection: &Connection, sigil_id: &str) -> Result<u64, String> {
    let seq: i64 = connection
        .query_row("SELECT COALESCE(MAX(seq), 0) FROM spellcast_sigil_events WHERE sigil_id = ?1", params![sigil_id], |row| row.get(0))
        .map_err(|error| format!("读取法阵事件序号失败：{error}"))?;
    Ok(seq as u64)
}

fn append_event(transaction: &Transaction<'_>, sigil_id: &str, at_ms: u64, kind: &str, value: &Value) -> Result<u64, String> {
    let seq = last_seq(transaction, sigil_id)? + 1;
    transaction
        .execute(
            "INSERT INTO spellcast_sigil_events (sigil_id, seq, at_ms, kind, value_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![sigil_id, db_u64(seq)?, db_u64(at_ms)?, kind, value.to_string()],
        )
        .map_err(|error| format!("写入法阵事件失败：{error}"))?;
    Ok(seq)
}

fn events_since(connection: &Connection, id: &str, since: u64, limit: usize) -> Result<Vec<SigilEvent>, String> {
    let mut statement = connection
        .prepare("SELECT seq, at_ms, kind, value_json FROM spellcast_sigil_events WHERE sigil_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3")
        .map_err(|error| format!("准备法阵事件失败：{error}"))?;
    let rows = statement
        .query_map(params![id, db_u64(since)?, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        })
        .map_err(|error| format!("读取法阵事件失败：{error}"))?;
    let mut events = Vec::new();
    for row in rows {
        let (seq, at_ms, kind, value) = row.map_err(|error| format!("读取法阵事件行失败：{error}"))?;
        events.push(SigilEvent {
            seq: seq as u64,
            at_ms: at_ms as u64,
            kind,
            value: serde_json::from_str(&value).map_err(|error| format!("法阵事件损坏：{error}"))?,
        });
    }
    Ok(events)
}

pub(crate) fn check_revision(sigil: &Sigil, expected: u64) -> Result<(), String> {
    if sigil.revision == expected {
        Ok(())
    } else {
        Err(format!("法阵已经变化（当前版本 {}，请求基于 {expected}）；请重新读取后再改。", sigil.revision))
    }
}

pub(crate) fn actor_json(actor: &SigilActor) -> Value {
    json!({"kind": actor.kind, "source_id": actor.source_id, "label": actor.label})
}

/// Draft and freeze rules. Run changes are written as closures by the workspace.
fn apply_change(change: SigilChange<'_>, sigil_id: &str, current: Option<Sigil>, actor: &SigilActor, now: u64, events: &mut Events) -> Result<Applied, String> {
    apply_change_with_draft_authority(change, sigil_id, current, actor, now, events, false)
}

fn apply_change_with_draft_authority(change: SigilChange<'_>, sigil_id: &str, current: Option<Sigil>, actor: &SigilActor, now: u64, events: &mut Events, delegated_draft: bool) -> Result<Applied, String> {
    // This does not turn a client into a user or grant any lifecycle authority.
    if delegated_draft && (actor.kind != "client" || !matches!(&change, SigilChange::PutPlan { .. })) {
        return Err("invalid delegated draft operation".into());
    }
    let lifecycle = |sigil: &mut Sigil| {
        sigil.revision += 1;
        sigil.updated_at_ms = now;
        sigil.updated_by = actor.clone();
    };
    match change {
        SigilChange::PutPlan { expected_revision, plan } => {
            validate_plan(plan)?;
            let (sigil, created) = match current {
                None if expected_revision == 0 => {
                    let sigil = Sigil {
                        id: sigil_id.into(),
                        plan: plan.clone(),
                        state: SigilState::Draft,
                        revision: 1,
                        owner_source: if delegated_draft { String::new() } else { actor.source_id.clone().unwrap_or_default() },
                        created_at_ms: now,
                        updated_at_ms: now,
                        updated_by: actor.clone(),
                        freeze: None,
                        run: None,
                    };
                    (sigil, true)
                }
                None => return Err(format!("法阵 {sigil_id} 不存在；新建时 expected_revision 填 0。")),
                Some(_) if expected_revision == 0 => return Err(format!("法阵 id {sigil_id} 已存在；请读取当前版本后修改。")),
                Some(mut sigil) => {
                    check_revision(&sigil, expected_revision)?;
                    if sigil.state != SigilState::Draft {
                        return Err("只有草稿可以修改方案；已冻结的法阵请先在窗口解除冻结。".into());
                    }
                    if !actor.is_user() && !delegated_draft {
                        let source = actor.source_id.clone().unwrap_or_default();
                        if sigil.owner_source.is_empty() {
                            sigil.owner_source = source;
                        } else if sigil.owner_source != source {
                            return Err("这个法阵草稿由另一个来源编写；可以读取，不能修改。".into());
                        }
                    }
                    sigil.plan = plan.clone();
                    lifecycle(&mut sigil);
                    (sigil, false)
                }
            };
            events.push((if created { "created" } else { "plan_updated" }.into(), json!({"revision": sigil.revision, "actor": actor_json(actor)})));
            Ok(Applied::Write { sigil: Box::new(sigil), history: Some("put_plan"), created })
        }
        SigilChange::Freeze { expected_revision, record, reviewed_revision, blocked } => {
            let mut sigil = current.ok_or_else(|| format!("法阵 {sigil_id} 不存在。"))?;
            check_revision(&sigil, expected_revision)?;
            if reviewed_revision != expected_revision {
                return Err("法阵在检查期间变化了；请重新读取后再冻结。".into());
            }
            if sigil.state != SigilState::Draft {
                return Err("只有草稿可以冻结。".into());
            }
            if let Some(reason) = blocked {
                return Err(reason);
            }
            sigil.state = SigilState::Frozen;
            lifecycle(&mut sigil);
            events.push(("frozen".into(), json!({"revision": sigil.revision, "commands": record.commands.len()})));
            sigil.freeze = Some(record);
            Ok(Applied::Write { sigil: Box::new(sigil), history: Some("freeze"), created: false })
        }
        SigilChange::Unfreeze { expected_revision } => {
            let mut sigil = current.ok_or_else(|| format!("法阵 {sigil_id} 不存在。"))?;
            check_revision(&sigil, expected_revision)?;
            if sigil.state != SigilState::Frozen {
                return Err("只有尚未开始执行的冻结法阵可以解除冻结。".into());
            }
            sigil.state = SigilState::Draft;
            sigil.freeze = None;
            lifecycle(&mut sigil);
            events.push(("unfrozen".into(), json!({"revision": sigil.revision})));
            Ok(Applied::Write { sigil: Box::new(sigil), history: Some("unfreeze"), created: false })
        }
        SigilChange::Delete { expected_revision } => {
            let sigil = current.ok_or_else(|| format!("法阵 {sigil_id} 不存在。"))?;
            check_revision(&sigil, expected_revision)?;
            if !matches!(sigil.state, SigilState::Draft | SigilState::Frozen) {
                return Err("执行开始后不能直接删除；请在结束后归档并清理。".into());
            }
            Ok(Applied::Delete)
        }
    }
}

/// Pure draft persistence inside the client boundary's grant/receipt/audit transaction.
/// No review, filesystem access, notifications to executors, or process launch.
pub(crate) fn client_put_plan(transaction: &Transaction<'_>, id: &str, revision: u64, plan: &SigilPlan, actor: &SigilActor, now: u64) -> Result<SigilMutation, String> {
    let mut events = Events::new();
    let applied = apply_change_with_draft_authority(SigilChange::PutPlan { expected_revision: revision, plan }, id,
        read(transaction, id)?, actor, now, &mut events, true)?;
    let Applied::Write { sigil, history, created } = applied else { return Err("invalid client draft result".into()); };
    for (kind, value) in &events { append_event(transaction, id, now, kind, value)?; }
    write(transaction, &sigil, history)?;
    Ok(SigilMutation { sigil_id: id.into(), sigil: Some(*sigil), created, deleted: false, replayed: false,
        notices: vec![], cursor: last_seq(transaction, id)? })
}

impl Store {
    pub(crate) fn sigil_list(&self) -> Result<Vec<SigilSummary>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT id, value_json FROM spellcast_sigils WHERE state != 'archived' ORDER BY updated_at_ms DESC, id ASC LIMIT 500")
            .map_err(|error| format!("准备法阵列表失败：{error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| format!("读取法阵列表失败：{error}"))?;
        let mut list = Vec::new();
        for row in rows {
            let (id, json) = row.map_err(|error| format!("读取法阵行失败：{error}"))?;
            list.push(SigilSummary::from(&decode(&id, &json)?));
        }
        Ok(list)
    }

    /// Running and paused sigils, which are observed.
    pub(crate) fn sigil_active(&self) -> Result<Vec<Sigil>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT id, value_json FROM spellcast_sigils WHERE state IN ('running', 'paused') ORDER BY id")
            .map_err(|error| format!("准备法阵列表失败：{error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| format!("读取法阵列表失败：{error}"))?;
        let mut active = Vec::new();
        for row in rows {
            let (id, json) = row.map_err(|error| format!("读取法阵行失败：{error}"))?;
            active.push(decode(&id, &json)?);
        }
        Ok(active)
    }

    /// Records an observation: no request id or receipt, and nothing is written when `change`
    /// reports no change.
    pub(crate) fn sigil_observe(&mut self, id: &str, change: impl FnOnce(&mut Sigil, &mut Events) -> bool) -> Result<bool, String> {
        self.sigil_record(id, None, |sigil, events| change(sigil, events).then_some(None))
    }

    /// Records a change Spellcast makes on its own, such as a check result: no request id or
    /// receipt. `change` returns `None` to write nothing, or the history operation when it moved
    /// the revision (completing the run). `output` is stored with the change.
    pub(crate) fn sigil_record(&mut self, id: &str, output: Option<&CheckOutput<'_>>,
        change: impl FnOnce(&mut Sigil, &mut Events) -> Option<Option<&'static str>>) -> Result<bool, String> {
        let transaction = self.connection.transaction().map_err(|error| format!("开始法阵事务失败：{error}"))?;
        let Some(mut sigil) = read(&transaction, id)? else { return Ok(false) };
        let mut events = Events::new();
        let Some(history) = change(&mut sigil, &mut events) else { return Ok(false) };
        let now = spellcast_core::inbox::now_ms();
        for (kind, value) in &events {
            append_event(&transaction, id, now, kind, value)?;
        }
        if let Some(output) = output {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO spellcast_sigil_check_outputs (sigil_id, run, step_id, attempt, check_index, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, db_u64(output.run)?, output.step_id, output.attempt, output.index as i64, output.output],
                )
                .map_err(|error| format!("写入验证输出失败：{error}"))?;
        }
        write(&transaction, &sigil, history)?;
        transaction.commit().map_err(|error| format!("提交法阵事务失败：{error}"))?;
        Ok(true)
    }

    /// Kept outputs of the given command runs.
    pub(crate) fn sigil_check_outputs(&self, id: &str, runs: &[u64]) -> Result<BTreeMap<u64, String>, String> {
        let mut outputs = BTreeMap::new();
        let mut statement = self
            .connection
            .prepare("SELECT output FROM spellcast_sigil_check_outputs WHERE sigil_id = ?1 AND run = ?2")
            .map_err(|error| format!("准备验证输出失败：{error}"))?;
        for run in runs {
            let output: Option<String> = statement.query_row(params![id, db_u64(*run)?], |row| row.get(0)).optional()
                .map_err(|error| format!("读取验证输出失败：{error}"))?;
            if let Some(output) = output {
                outputs.insert(*run, output);
            }
        }
        Ok(outputs)
    }

    pub(crate) fn sigil_get(&self, id: &str) -> Result<Sigil, String> {
        read(&self.connection, id)?.ok_or_else(|| format!("法阵 {id} 不存在。"))
    }

    pub(crate) fn sigil_exists(&self, id: &str) -> Result<bool, String> {
        Ok(read(&self.connection, id)?.is_some())
    }

    pub(crate) fn sigil_events(&self, id: &str, since: u64, limit: usize) -> Result<Vec<SigilEvent>, String> {
        events_since(&self.connection, id, since, limit)
    }

    pub(crate) fn sigil_last_seq(&self, id: &str) -> Result<u64, String> {
        last_seq(&self.connection, id)
    }

    /// Records that `source` has seen events up to `cursor`, as `wait` does. Never moves back.
    pub(crate) fn sigil_advance_cursor(&mut self, id: &str, source: &str, cursor: u64) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(|error| format!("开始法阵事务失败：{error}"))?;
        let Some(mut sigil) = read(&transaction, id)? else { return Ok(()) };
        let Some(run) = sigil.run.as_mut() else { return Ok(()) };
        if run.executor.as_ref().is_none_or(|executor| executor.source_id != source) {
            return Ok(());
        }
        let entry = run.notice_cursor.entry(source.into()).or_default();
        if *entry >= cursor {
            return Ok(());
        }
        *entry = cursor;
        write(&transaction, &sigil, None)?;
        transaction.commit().map_err(|error| format!("提交法阵事务失败：{error}"))
    }

    /// The stored result for a retried request, or an error if the id carried other content.
    pub(crate) fn sigil_receipt(&self, request_id: &str, request_hash: &str) -> Result<Option<SigilMutation>, String> {
        receipt(&self.connection, request_id, request_hash)
    }

    pub(crate) fn sigil_mutate(&mut self, request_id: &str, request_hash: &str, sigil_id: &str, change: SigilChange<'_>, actor: &SigilActor, now: u64) -> Result<SigilMutation, String> {
        self.sigil_apply(request_id, request_hash, sigil_id, now, None, |current, events| apply_change(change, sigil_id, current, actor, now, events))
    }

    /// Apply one change with its receipt in a single transaction. An identical retry returns
    /// the original result; reusing a request id with different content is refused. When
    /// `notices_for` names the executor, events it has not been told about are returned and its
    /// cursor advances.
    pub(crate) fn sigil_apply(&mut self, request_id: &str, request_hash: &str, sigil_id: &str, now: u64, notices_for: Option<&str>,
        change: impl FnOnce(Option<Sigil>, &mut Events) -> Result<Applied, String>) -> Result<SigilMutation, String> {
        let transaction = self.connection.transaction().map_err(|error| format!("开始法阵事务失败：{error}"))?;
        if let Some(replay) = receipt(&transaction, request_id, request_hash)? {
            return Ok(replay);
        }
        let current = read(&transaction, sigil_id)?;
        let mut events = Events::new();
        let applied = change(current, &mut events)?;
        let mut result = SigilMutation { sigil_id: sigil_id.into(), sigil: None, created: false, deleted: false, replayed: false, notices: vec![], cursor: 0 };
        match applied {
            Applied::Delete => {
                for table in ["spellcast_sigils WHERE id", "spellcast_sigil_plan_history WHERE sigil_id", "spellcast_sigil_events WHERE sigil_id",
                    "spellcast_sigil_receipts WHERE sigil_id", "spellcast_sigil_check_outputs WHERE sigil_id"] {
                    transaction
                        .execute(&format!("DELETE FROM {table} = ?1"), params![sigil_id])
                        .map_err(|error| format!("删除法阵失败：{error}"))?;
                }
                result.deleted = true;
            }
            Applied::Write { mut sigil, history, created } => {
                for (kind, value) in &events {
                    append_event(&transaction, sigil_id, now, kind, value)?;
                }
                result.cursor = last_seq(&transaction, sigil_id)?;
                if let (Some(source), Some(run)) = (notices_for, sigil.run.as_mut()) {
                    if let Some(cursor) = run.notice_cursor.get(source).copied() {
                        result.notices = events_since(&transaction, sigil_id, cursor, 200)?.into_iter().filter(|event| is_notice(&event.kind)).collect();
                    }
                    run.notice_cursor.insert(source.into(), result.cursor);
                }
                write(&transaction, &sigil, history)?;
                result.created = created;
                result.sigil = Some(*sigil);
            }
        }
        // A delete keeps only its own receipt, detached from the removed sigil, so a retry
        // still reports the original outcome.
        let owner = if result.deleted { "" } else { sigil_id };
        let json = serde_json::to_string(&result).map_err(|error| format!("序列化法阵收据失败：{error}"))?;
        transaction
            .execute(
                "INSERT INTO spellcast_sigil_receipts (request_id, sigil_id, request_hash, result_json, at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![request_id, owner, request_hash, json, db_u64(now)?],
            )
            .map_err(|error| format!("写入法阵收据失败：{error}"))?;
        transaction.commit().map_err(|error| format!("提交法阵事务失败：{error}"))?;
        Ok(result)
    }
}

fn receipt(connection: &Connection, request_id: &str, request_hash: &str) -> Result<Option<SigilMutation>, String> {
    let stored: Option<(String, String)> = connection
        .query_row("SELECT request_hash, result_json FROM spellcast_sigil_receipts WHERE request_id = ?1", params![request_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(|error| format!("读取法阵收据失败：{error}"))?;
    let Some((hash, json)) = stored else { return Ok(None) };
    if hash != request_hash {
        return Err("request_id 已用于另一项法阵操作；请为新的操作换一个 request_id。".into());
    }
    let mut replay: SigilMutation = serde_json::from_str(&json).map_err(|error| format!("法阵收据损坏：{error}"))?;
    replay.replayed = true;
    Ok(Some(replay))
}

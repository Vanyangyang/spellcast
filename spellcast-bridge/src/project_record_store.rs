//! SQLite persistence for phase-1 project records.
//!
//! The legacy session schema deliberately has no dependency on these tables. Project record
//! mutations own their own transaction, immutable history, and request receipt.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::project_records::{
    DevelopmentObject, Project, ProjectExport, ProjectExternalFile, ProjectImportProvenance,
    RecordActor, RecordChange, RecordCommand, RecordFields, RecordHistory, RecordHistoryKind,
    RecordMutationResult, RecordStatus, SourceReference, WorkRecord,
};
use crate::store::Store;

#[path = "project_evidence_store.rs"]
mod evidence;
#[cfg(test)]
#[path = "project_evidence_tests.rs"]
mod evidence_tests;
#[path = "project_proposal_store.rs"]
mod proposals;
#[cfg(test)]
#[path = "project_proposal_tests.rs"]
mod proposal_tests;

/// Proposal tables sit outside the versioned record schema so older builds still open the store.
pub(crate) fn init_proposal_schema(connection: &Connection) -> Result<(), String> {
    proposals::init_schema(connection)
}

/// v4 adds candidate, trial and adoption tables. Migrations only add tables or columns.
const PROJECT_SCHEMA_VERSION: i64 = 4;
const MAX_LIST_RECORDS: usize = 1_000;
/// Complete trials travel with the project, so bundles are larger than phase-1 records.
const MAX_IMPORT_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMPORT_OBJECTS: usize = 4_000;
const MAX_IMPORT_RECORDS: usize = 10_000;
const MAX_IMPORT_HISTORY: usize = 100_000;
const MAX_ALIASES: usize = 128;
const MAX_REFERENCES: usize = 128;
const MAX_ID_BYTES: usize = 256;
const MAX_NAME_BYTES: usize = 512;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_URI_BYTES: usize = 4 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 256;

/// Initializes only the project-record schema. It never changes `spellcast_state.schema_version`.
pub(crate) fn init_project_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS spellcast_project_schema_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                schema_version INTEGER NOT NULL
            );",
        )
        .map_err(|error| format!("初始化项目记录版本表失败：{error}"))?;

    let found: Option<i64> = connection
        .query_row(
            "SELECT schema_version FROM spellcast_project_schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取项目记录版本失败：{error}"))?;

    match found {
        Some(version) if version > PROJECT_SCHEMA_VERSION => {
            return Err(format!(
                "项目记录库版本是 {version}，当前只支持 {PROJECT_SCHEMA_VERSION}；没有覆盖原数据。"
            ));
        }
        Some(version) if version == PROJECT_SCHEMA_VERSION => return Ok(()),
        Some(version) if version < 1 => {
            return Err(format!(
                "项目记录库版本是 {version}，当前不能安全迁移到 {PROJECT_SCHEMA_VERSION}；没有覆盖原数据。"
            ));
        }
        Some(1..=3) => {}
        Some(version) => {
            return Err(format!(
                "项目记录库版本是 {version}，当前不能安全迁移到 {PROJECT_SCHEMA_VERSION}；没有覆盖原数据。"
            ));
        }
        None => {}
    }

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("开始项目记录初始化失败：{error}"))?;
    match found {
        None => transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS spellcast_projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                aliases_json TEXT NOT NULL,
                revision INTEGER NOT NULL,
                archived INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                imported_from_json TEXT
            );
            CREATE TABLE IF NOT EXISTS spellcast_project_objects (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                revision INTEGER NOT NULL,
                archived INTEGER NOT NULL,
                planning_json TEXT,
                PRIMARY KEY(project_id, id)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_objects_project_idx
                ON spellcast_project_objects(project_id, archived, name);
            CREATE TABLE IF NOT EXISTS spellcast_project_records (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                object_id TEXT,
                title TEXT NOT NULL,
                goal TEXT NOT NULL,
                scope TEXT NOT NULL,
                status TEXT NOT NULL,
                result TEXT NOT NULL,
                boundaries TEXT NOT NULL,
                next_step TEXT NOT NULL,
                references_json TEXT NOT NULL,
                revision INTEGER NOT NULL,
                archived INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                updated_by_json TEXT NOT NULL,
                PRIMARY KEY(project_id, id)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_records_project_idx
                ON spellcast_project_records(project_id, archived, status, updated_at_ms DESC);
            CREATE TABLE IF NOT EXISTS spellcast_project_history (
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                at_ms INTEGER NOT NULL,
                actor_json TEXT NOT NULL,
                operation TEXT NOT NULL,
                request_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                PRIMARY KEY(project_id, kind, entity_id, revision)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_history_entity_idx
                ON spellcast_project_history(project_id, kind, entity_id, revision);
            CREATE TABLE IF NOT EXISTS spellcast_project_request_receipts (
                request_id TEXT PRIMARY KEY,
                actor_hash TEXT NOT NULL,
                body_hash TEXT NOT NULL,
                result_json TEXT NOT NULL
            );",
            )
            .map_err(|error| format!("创建项目记录表失败：{error}"))?,
        Some(1) => transaction
            .execute_batch("ALTER TABLE spellcast_projects ADD COLUMN imported_from_json TEXT;
                ALTER TABLE spellcast_project_objects ADD COLUMN planning_json TEXT;")
            .map_err(|error| format!("迁移项目记录导入来源失败：{error}"))?,
        Some(2) => transaction
            .execute_batch("ALTER TABLE spellcast_project_objects ADD COLUMN planning_json TEXT;")
            .map_err(|error| format!("迁移规划内容失败：{error}"))?,
        Some(3) => {}
        Some(version) => {
            return Err(format!(
                "项目记录库版本是 {version}，当前不能安全迁移到 {PROJECT_SCHEMA_VERSION}；没有覆盖原数据。"
            ));
        }
    }
    evidence::init_schema(&transaction)?;
    match found {
        None => transaction
            .execute(
                "INSERT INTO spellcast_project_schema_version (id, schema_version) VALUES (1, ?1)",
                [PROJECT_SCHEMA_VERSION],
            )
            .map_err(|error| format!("写入项目记录版本失败：{error}"))?,
        Some(1..=3) => transaction
            .execute(
                "UPDATE spellcast_project_schema_version SET schema_version = ?1 WHERE id = 1",
                [PROJECT_SCHEMA_VERSION],
            )
            .map_err(|error| format!("写入项目记录迁移版本失败：{error}"))?,
        Some(_) => unreachable!("supported project schema state was returned earlier"),
    };
    transaction
        .commit()
        .map_err(|error| format!("提交项目记录初始化失败：{error}"))
}

impl Store {
    pub fn project_list(&self) -> Result<Vec<Project>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, name, aliases_json, revision, archived, created_at_ms, updated_at_ms,
                        imported_from_json
                 FROM spellcast_projects
                 ORDER BY updated_at_ms DESC, id ASC",
            )
            .map_err(|error| format!("准备项目列表失败：{error}"))?;
        let rows = statement
            .query_map([], stored_project_from_row)
            .map_err(|error| format!("读取项目列表失败：{error}"))?;
        let mut projects = Vec::new();
        for row in rows {
            projects.push(project_from_stored(
                row.map_err(|error| format!("读取项目列表行失败：{error}"))?,
            )?);
        }
        Ok(projects)
    }

    pub fn project_get(&self, id: &str) -> Result<Project, String> {
        validate_project_id(id)?;
        read_project(&self.connection, id)?.ok_or_else(|| format!("找不到项目 {id}。"))
    }

    pub fn project_objects(&self, project: &str) -> Result<Vec<DevelopmentObject>, String> {
        self.project_get(project)?;
        read_all_objects(&self.connection, project)
    }

    pub fn project_records(
        &self,
        project: &str,
        query: &str,
        status: Option<&str>,
        include_archived: bool,
    ) -> Result<Vec<WorkRecord>, String> {
        self.project_get(project)?;
        let status = match status.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => RecordStatus::parse(value)
                .ok_or_else(|| format!("未知的记录状态 {value}。"))?
                .as_str(),
            None => "",
        };
        let query = query.trim();
        validate_query(query)?;
        let pattern = format!("%{}%", escape_like(query));
        let mut statement = self
            .connection
            .prepare(
                "SELECT project_id, id, object_id, title, goal, scope, status, result,
                        boundaries, next_step, references_json, revision, archived,
                        created_at_ms, updated_at_ms, updated_by_json
                 FROM spellcast_project_records
                 WHERE project_id = ?1
                   AND (?2 = 1 OR archived = 0)
                   AND (?3 = '' OR status = ?3)
                   AND (?4 = '' OR title LIKE ?5 ESCAPE '\\'
                        OR goal LIKE ?5 ESCAPE '\\'
                        OR result LIKE ?5 ESCAPE '\\'
                        OR boundaries LIKE ?5 ESCAPE '\\'
                        OR next_step LIKE ?5 ESCAPE '\\')
                 ORDER BY updated_at_ms DESC, id ASC
                 LIMIT ?6",
            )
            .map_err(|error| format!("准备项目记录列表失败：{error}"))?;
        let rows = statement
            .query_map(
                params![
                    project,
                    if include_archived { 1_i64 } else { 0_i64 },
                    status,
                    query,
                    pattern,
                    MAX_LIST_RECORDS as i64
                ],
                stored_record_from_row,
            )
            .map_err(|error| format!("读取项目记录列表失败：{error}"))?;
        let mut records = Vec::new();
        for row in rows {
            records.push(record_from_stored(
                row.map_err(|error| format!("读取项目记录列表行失败：{error}"))?,
            )?);
        }
        Ok(records)
    }

    pub fn project_record(&self, project: &str, id: &str) -> Result<WorkRecord, String> {
        self.project_get(project)?;
        validate_local_id("记录 id", id)?;
        read_record(&self.connection, project, id)?.ok_or_else(|| format!("找不到记录 {id}。"))
    }

    pub fn project_history(
        &self,
        project: &str,
        kind: &str,
        id: &str,
    ) -> Result<Vec<RecordHistory>, String> {
        self.project_get(project)?;
        let kind =
            RecordHistoryKind::parse(kind).ok_or_else(|| format!("未知的历史类型 {kind}。"))?;
        match kind {
            RecordHistoryKind::Project => {
                if id != project {
                    return Err("项目历史的 id 必须等于项目 id。".into());
                }
            }
            RecordHistoryKind::Object => {
                if read_object(&self.connection, project, id)?.is_none() {
                    return Err(format!("找不到开发对象 {id}。"));
                }
            }
            RecordHistoryKind::Record => {
                if read_record(&self.connection, project, id)?.is_none() {
                    return Err(format!("找不到记录 {id}。"));
                }
            }
            RecordHistoryKind::Candidate => {
                if evidence::read_candidate(&self.connection, project, id)?.is_none() {
                    return Err(format!("找不到数值候选 {id}。"));
                }
            }
        }
        read_history(&self.connection, project, kind, id)
    }

    pub fn project_mutate(
        &mut self,
        command: &RecordCommand,
        actor: &RecordActor,
    ) -> Result<RecordMutationResult, String> {
        validate_command_envelope(command, actor)?;
        let actor_hash = stable_hash(actor)?;
        let body_hash = stable_hash(command)?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| format!("开始项目记录事务失败：{error}"))?;

        if let Some(receipt) = read_receipt(&transaction, &command.request_id)? {
            if receipt.actor_hash != actor_hash || receipt.body_hash != body_hash {
                return Err("这个 request_id 已用于不同的请求或执行者。".into());
            }
            let mut replay: RecordMutationResult = serde_json::from_str(&receipt.result_json)
                .map_err(|error| format!("项目请求回执损坏：{error}"))?;
            replay.replayed = true;
            return Ok(replay);
        }

        if actor.kind == "agent" {
            proposals::guard_agent_change(&transaction, command)?;
        }
        let now = current_time_ms()?;
        let result = match &command.change {
            RecordChange::CreateProject { name, aliases } => {
                create_project(&transaction, command, actor, name, aliases, now)?
            }
            RecordChange::UpdateProject {
                expected_revision,
                name,
                aliases,
                archived,
            } => update_project(
                &transaction,
                command,
                actor,
                *expected_revision,
                name,
                aliases,
                *archived,
                now,
            )?,
            RecordChange::PutObject {
                id,
                expected_revision,
                name,
                kind,
                archived,
                planning,
            } => put_object(
                &transaction,
                command,
                actor,
                id,
                *expected_revision,
                name,
                kind,
                *archived,
                planning.as_ref(),
                now,
            )?,
            RecordChange::RestoreObject { id, expected_revision, restore_revision } =>
                restore_object(&transaction, command, actor, id, *expected_revision, *restore_revision, now)?,
            RecordChange::SetObjectLock { id, expected_revision, locked } =>
                set_object_lock(&transaction, command, actor, id, *expected_revision, *locked, now)?,
            RecordChange::PutRecord {
                id,
                expected_revision,
                fields,
            } => put_record(
                &transaction,
                command,
                actor,
                id,
                *expected_revision,
                fields,
                now,
            )?,
            RecordChange::ArchiveRecord {
                id,
                expected_revision,
                archived,
            } => archive_record(
                &transaction,
                command,
                actor,
                id,
                *expected_revision,
                *archived,
                now,
            )?,
            RecordChange::RestoreRecord {
                id,
                expected_revision,
                restore_revision,
            } => restore_record(
                &transaction,
                command,
                actor,
                id,
                *expected_revision,
                *restore_revision,
                now,
            )?,
            RecordChange::ImportProject { bundle, name } => {
                import_project(&transaction, command, actor, bundle, name, now)?
            }
            RecordChange::PutCandidate { id, expected_revision, parameter_id, label, value, reason, base_revision, archived, from_variant } =>
                evidence::put_candidate(&transaction, command, actor, id, *expected_revision, parameter_id, label, value, reason,
                    *base_revision, *archived, from_variant.as_ref(), now)?,
            RecordChange::SaveTrial { id, label, origin, parent_trial_id, run } =>
                evidence::save_trial(&transaction, command, actor, id, label, origin, parent_trial_id.as_ref(), run, now)?,
            RecordChange::AdoptCandidate { adoption_id, parameter_id, expected_revision, candidate_id, candidate_revision, trial_ids, reason, lock_after } =>
                evidence::adopt_candidate(&transaction, command, actor, adoption_id, parameter_id, *expected_revision, candidate_id,
                    *candidate_revision, trial_ids, reason, *lock_after, now)?,
            RecordChange::PutProposal { id, expected_revision, title, summary, subject, goal_id, items, references, boundaries } =>
                proposals::put_proposal(&transaction, command, actor, id, *expected_revision, title, summary, subject, goal_id.as_ref(),
                    items, references, boundaries, now)?,
            RecordChange::DecideProposal { id, expected_revision, item_ids, decision, note, revised_object, revised_record, confirm, unlock } =>
                proposals::decide_proposal(&transaction, command, actor, id, *expected_revision, item_ids, decision, note,
                    revised_object.as_ref(), revised_record.as_ref(), *confirm, *unlock, now)?,
        };

        let result_json = serde_json::to_string(&result)
            .map_err(|error| format!("序列化项目请求结果失败：{error}"))?;
        transaction
            .execute(
                "INSERT INTO spellcast_project_request_receipts
                 (request_id, actor_hash, body_hash, result_json) VALUES (?1, ?2, ?3, ?4)",
                params![command.request_id, actor_hash, body_hash, result_json],
            )
            .map_err(|error| format!("写入项目请求回执失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交项目记录事务失败：{error}"))?;
        Ok(result)
    }

    pub fn project_proposals(&self, project: &str, include_closed: bool) -> Result<Vec<crate::project_proposals::ProjectProposal>, String> {
        self.project_get(project)?;
        proposals::read_proposals(&self.connection, project, include_closed)
    }

    pub fn project_proposal(&self, project: &str, id: &str) -> Result<crate::project_proposals::ProjectProposal, String> {
        self.project_get(project)?;
        validate_local_id("提案 id", id)?;
        proposals::read_proposal(&self.connection, project, id)?.ok_or_else(|| format!("找不到提案 {id}。"))
    }

    pub fn project_export(&self, project: &str) -> Result<ProjectExport, String> {
        let project = self.project_get(project)?;
        let objects = self.project_objects(&project.id)?;
        let records = read_all_records(&self.connection, &project.id)?;
        let history = read_all_history(&self.connection, &project.id)?;
        let mut export = ProjectExport {
            format: "spellcast.project".into(),
            version: if has_planning(&objects, &history) { 2 } else { 1 },
            exported_at_ms: current_time_ms()?,
            external_files: external_files_for(&objects, &records, &history)?,
            candidates: evidence::read_candidates(&self.connection, &project.id)?,
            trials: evidence::read_trials(&self.connection, &project.id, true)?,
            adoptions: evidence::read_adoptions(&self.connection, &project.id)?,
            project,
            objects,
            records,
            history,
        };
        if evidence::needs_v3(&export) { export.version = 3; }
        if has_sections(&export.objects, &export.history) { export.version = 4; }
        Ok(export)
    }

    pub fn project_markdown(&self, project: &str) -> Result<String, String> {
        let export = self.project_export(project)?;
        let mut markdown = String::new();
        markdown.push_str("# ");
        markdown.push_str(&markdown_text(&export.project.name));
        markdown.push_str("\n\n");
        markdown.push_str("- Project ID: `");
        markdown.push_str(&export.project.id);
        markdown.push_str("`\n- Project revision: `");
        markdown.push_str(&export.project.revision.to_string());
        markdown.push_str("`\n- Archived: `");
        markdown.push_str(&export.project.archived.to_string());
        markdown.push_str("`\n\n");
        if !export.project.aliases.is_empty() {
            markdown.push_str("## Aliases\n\n");
            for alias in &export.project.aliases {
                markdown.push_str("- ");
                markdown.push_str(&markdown_text(alias));
                markdown.push('\n');
            }
            markdown.push('\n');
        }
        markdown.push_str("## Development objects\n\n");
        if export.objects.is_empty() {
            markdown.push_str("No development objects.\n\n");
        } else {
            for object in &export.objects {
                markdown.push_str("### ");
                markdown.push_str(&markdown_text(&object.name));
                markdown.push_str("\n\n- ID: `");
                markdown.push_str(&object.id);
                markdown.push_str("`\n- Kind: ");
                markdown.push_str(&markdown_text(&object.kind));
                markdown.push_str("\n- Revision: `");
                markdown.push_str(&object.revision.to_string());
                markdown.push_str("`\n- Archived: `");
                markdown.push_str(&object.archived.to_string());
                markdown.push_str("`\n\n");
                if let Some(planning) = &object.planning {
                    write_markdown_field(&mut markdown, "Planning", &serde_json::to_string_pretty(planning)
                        .map_err(|error| format!("导出规划字段失败：{error}"))?);
                }
            }
        }
        markdown.push_str("## Work records\n\n");
        if export.records.is_empty() {
            markdown.push_str("No work records.\n\n");
        } else {
            for record in &export.records {
                markdown.push_str("### ");
                markdown.push_str(&markdown_text(&record.fields.title));
                markdown.push_str("\n\n- ID: `");
                markdown.push_str(&record.id);
                markdown.push_str("`\n- Revision: `");
                markdown.push_str(&record.revision.to_string());
                markdown.push_str("`\n- Status: ");
                markdown.push_str(record.fields.status.as_str());
                markdown.push_str("\n- Archived: `");
                markdown.push_str(&record.archived.to_string());
                markdown.push_str("`\n");
                if let Some(object_id) = &record.fields.object_id {
                    markdown.push_str("- Development object ID: `");
                    markdown.push_str(object_id);
                    markdown.push_str("`\n");
                }
                write_markdown_field(&mut markdown, "Goal", &record.fields.goal);
                write_markdown_field(&mut markdown, "Scope", &record.fields.scope);
                write_markdown_field(&mut markdown, "Result", &record.fields.result);
                write_markdown_field(&mut markdown, "Boundaries", &record.fields.boundaries);
                write_markdown_field(&mut markdown, "Next step", &record.fields.next_step);
                if !record.fields.references.is_empty() {
                    markdown.push_str("\n#### External references\n\n");
                    for reference in &record.fields.references {
                        markdown.push_str("- ");
                        markdown.push_str(&markdown_text(&reference.label));
                        markdown.push_str(": ");
                        markdown.push_str(&reference.uri);
                        if !reference.version.is_empty() {
                            markdown.push_str(" (version ");
                            markdown.push_str(&markdown_text(&reference.version));
                            markdown.push(')');
                        }
                        markdown.push('\n');
                    }
                }
                markdown.push('\n');
            }
        }
        markdown.push_str("## External file disclaimer\n\n");
        markdown
            .push_str("This is a one-way snapshot. Source references below are external links; ");
        markdown.push_str(
            "no original files, Canvas layout, permissions, or credentials are included.\n\n",
        );
        if export.external_files.is_empty() {
            markdown.push_str("No external source links were declared.\n");
        } else {
            for file in &export.external_files {
                markdown.push_str("- `original_included: false` — ");
                markdown.push_str(&file.uri);
                markdown.push('\n');
            }
        }
        Ok(markdown)
    }
}

#[derive(Debug)]
struct StoredProject {
    id: String,
    name: String,
    aliases_json: String,
    revision: i64,
    archived: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    imported_from_json: Option<String>,
}

#[derive(Debug)]
struct StoredObject {
    project_id: String,
    id: String,
    name: String,
    kind: String,
    revision: i64,
    archived: i64,
    planning_json: Option<String>,
}

#[derive(Debug)]
struct StoredRecord {
    project_id: String,
    id: String,
    object_id: Option<String>,
    title: String,
    goal: String,
    scope: String,
    status: String,
    result: String,
    boundaries: String,
    next_step: String,
    references_json: String,
    revision: i64,
    archived: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
    updated_by_json: String,
}

#[derive(Debug)]
struct StoredHistory {
    project_id: String,
    kind: String,
    entity_id: String,
    revision: i64,
    at_ms: i64,
    actor_json: String,
    operation: String,
    request_id: String,
    snapshot_json: String,
}

#[derive(Debug)]
struct StoredReceipt {
    actor_hash: String,
    body_hash: String,
    result_json: String,
}

fn stored_project_from_row(row: &Row<'_>) -> rusqlite::Result<StoredProject> {
    Ok(StoredProject {
        id: row.get(0)?,
        name: row.get(1)?,
        aliases_json: row.get(2)?,
        revision: row.get(3)?,
        archived: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
        imported_from_json: row.get(7)?,
    })
}

fn stored_object_from_row(row: &Row<'_>) -> rusqlite::Result<StoredObject> {
    Ok(StoredObject {
        project_id: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        revision: row.get(4)?,
        archived: row.get(5)?,
        planning_json: row.get(6)?,
    })
}

fn stored_record_from_row(row: &Row<'_>) -> rusqlite::Result<StoredRecord> {
    Ok(StoredRecord {
        project_id: row.get(0)?,
        id: row.get(1)?,
        object_id: row.get(2)?,
        title: row.get(3)?,
        goal: row.get(4)?,
        scope: row.get(5)?,
        status: row.get(6)?,
        result: row.get(7)?,
        boundaries: row.get(8)?,
        next_step: row.get(9)?,
        references_json: row.get(10)?,
        revision: row.get(11)?,
        archived: row.get(12)?,
        created_at_ms: row.get(13)?,
        updated_at_ms: row.get(14)?,
        updated_by_json: row.get(15)?,
    })
}

fn stored_history_from_row(row: &Row<'_>) -> rusqlite::Result<StoredHistory> {
    Ok(StoredHistory {
        project_id: row.get(0)?,
        kind: row.get(1)?,
        entity_id: row.get(2)?,
        revision: row.get(3)?,
        at_ms: row.get(4)?,
        actor_json: row.get(5)?,
        operation: row.get(6)?,
        request_id: row.get(7)?,
        snapshot_json: row.get(8)?,
    })
}

fn project_from_stored(value: StoredProject) -> Result<Project, String> {
    let aliases: Vec<String> = serde_json::from_str(&value.aliases_json)
        .map_err(|error| format!("项目别名数据损坏：{error}"))?;
    let imported_from = value
        .imported_from_json
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| format!("项目导入来源数据损坏：{error}"))
        })
        .transpose()?;
    let project = Project {
        id: value.id,
        name: value.name,
        aliases,
        revision: from_db_u64(value.revision, "项目 revision")?,
        archived: from_db_bool(value.archived, "项目 archived")?,
        created_at_ms: from_db_u64(value.created_at_ms, "项目 created_at_ms")?,
        updated_at_ms: from_db_u64(value.updated_at_ms, "项目 updated_at_ms")?,
        imported_from,
    };
    validate_project(&project)?;
    Ok(project)
}

fn object_from_stored(value: StoredObject) -> Result<DevelopmentObject, String> {
    let planning = value.planning_json.map(|json| serde_json::from_str(&json)
        .map_err(|error| format!("规划内容损坏：{error}"))).transpose()?;
    let object = DevelopmentObject {
        project_id: value.project_id,
        id: value.id,
        name: value.name,
        kind: value.kind,
        revision: from_db_u64(value.revision, "开发对象 revision")?,
        archived: from_db_bool(value.archived, "开发对象 archived")?,
        planning,
    };
    validate_object(&object)?;
    Ok(object)
}

fn record_from_stored(value: StoredRecord) -> Result<WorkRecord, String> {
    let references: Vec<SourceReference> = serde_json::from_str(&value.references_json)
        .map_err(|error| format!("记录引用数据损坏：{error}"))?;
    let updated_by: RecordActor = serde_json::from_str(&value.updated_by_json)
        .map_err(|error| format!("记录执行者数据损坏：{error}"))?;
    let record = WorkRecord {
        project_id: value.project_id,
        id: value.id,
        fields: RecordFields {
            object_id: value.object_id,
            title: value.title,
            goal: value.goal,
            scope: value.scope,
            status: RecordStatus::parse(&value.status)
                .ok_or_else(|| format!("记录状态数据损坏：{}", value.status))?,
            result: value.result,
            boundaries: value.boundaries,
            next_step: value.next_step,
            references,
        },
        revision: from_db_u64(value.revision, "记录 revision")?,
        archived: from_db_bool(value.archived, "记录 archived")?,
        created_at_ms: from_db_u64(value.created_at_ms, "记录 created_at_ms")?,
        updated_at_ms: from_db_u64(value.updated_at_ms, "记录 updated_at_ms")?,
        updated_by,
    };
    validate_record(&record)?;
    Ok(record)
}

fn history_from_stored(value: StoredHistory) -> Result<RecordHistory, String> {
    let actor: RecordActor = serde_json::from_str(&value.actor_json)
        .map_err(|error| format!("历史执行者数据损坏：{error}"))?;
    let snapshot = serde_json::from_str(&value.snapshot_json)
        .map_err(|error| format!("历史快照数据损坏：{error}"))?;
    let history = RecordHistory {
        project_id: value.project_id,
        kind: RecordHistoryKind::parse(&value.kind)
            .ok_or_else(|| format!("历史类型数据损坏：{}", value.kind))?,
        id: value.entity_id,
        revision: from_db_u64(value.revision, "历史 revision")?,
        at_ms: from_db_u64(value.at_ms, "历史 at_ms")?,
        actor,
        operation: value.operation,
        request_id: value.request_id,
        snapshot,
    };
    validate_history_shape(&history)?;
    Ok(history)
}

fn read_project(connection: &Connection, id: &str) -> Result<Option<Project>, String> {
    let stored = connection
        .query_row(
            "SELECT id, name, aliases_json, revision, archived, created_at_ms, updated_at_ms,
                    imported_from_json
             FROM spellcast_projects WHERE id = ?1",
            [id],
            stored_project_from_row,
        )
        .optional()
        .map_err(|error| format!("读取项目失败：{error}"))?;
    stored.map(project_from_stored).transpose()
}

fn read_object(
    connection: &Connection,
    project: &str,
    id: &str,
) -> Result<Option<DevelopmentObject>, String> {
    let stored = connection
        .query_row(
            "SELECT project_id, id, name, kind, revision, archived, planning_json
             FROM spellcast_project_objects WHERE project_id = ?1 AND id = ?2",
            params![project, id],
            stored_object_from_row,
        )
        .optional()
        .map_err(|error| format!("读取开发对象失败：{error}"))?;
    stored.map(object_from_stored).transpose()
}

fn read_all_objects(connection: &Connection, project: &str) -> Result<Vec<DevelopmentObject>, String> {
    let mut statement=connection.prepare("SELECT project_id, id, name, kind, revision, archived, planning_json
        FROM spellcast_project_objects WHERE project_id=?1 ORDER BY archived ASC, name COLLATE NOCASE ASC, id ASC")
        .map_err(|e|e.to_string())?;
    let rows=statement.query_map([project],stored_object_from_row).map_err(|e|e.to_string())?;
    rows.map(|row| object_from_stored(row.map_err(|e|e.to_string())?)).collect()
}

fn validate_object_in_project(connection: &Connection, object: &DevelopmentObject) -> Result<(),String> {
    validate_object(object)?;
    let mut objects=read_all_objects(connection,&object.project_id)?;
    objects.retain(|existing|existing.id!=object.id);
    objects.push(object.clone());
    crate::project_planning::validate_graph(&objects)
}

fn read_record(
    connection: &Connection,
    project: &str,
    id: &str,
) -> Result<Option<WorkRecord>, String> {
    let stored = connection
        .query_row(
            "SELECT project_id, id, object_id, title, goal, scope, status, result,
                    boundaries, next_step, references_json, revision, archived,
                    created_at_ms, updated_at_ms, updated_by_json
             FROM spellcast_project_records WHERE project_id = ?1 AND id = ?2",
            params![project, id],
            stored_record_from_row,
        )
        .optional()
        .map_err(|error| format!("读取项目记录失败：{error}"))?;
    stored.map(record_from_stored).transpose()
}

fn read_all_records(connection: &Connection, project: &str) -> Result<Vec<WorkRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT project_id, id, object_id, title, goal, scope, status, result,
                    boundaries, next_step, references_json, revision, archived,
                    created_at_ms, updated_at_ms, updated_by_json
             FROM spellcast_project_records
             WHERE project_id = ?1
             ORDER BY updated_at_ms DESC, id ASC",
        )
        .map_err(|error| format!("准备完整项目记录导出失败：{error}"))?;
    let rows = statement
        .query_map([project], stored_record_from_row)
        .map_err(|error| format!("读取完整项目记录导出失败：{error}"))?;
    let mut records = Vec::new();
    for row in rows {
        records.push(record_from_stored(
            row.map_err(|error| format!("读取完整项目记录导出行失败：{error}"))?,
        )?);
    }
    Ok(records)
}

fn read_history(
    connection: &Connection,
    project: &str,
    kind: RecordHistoryKind,
    id: &str,
) -> Result<Vec<RecordHistory>, String> {
    let mut statement = connection
        .prepare(
            "SELECT project_id, kind, entity_id, revision, at_ms, actor_json, operation,
                    request_id, snapshot_json
             FROM spellcast_project_history
             WHERE project_id = ?1 AND kind = ?2 AND entity_id = ?3
             ORDER BY revision ASC",
        )
        .map_err(|error| format!("准备项目历史读取失败：{error}"))?;
    let rows = statement
        .query_map(params![project, kind.as_str(), id], stored_history_from_row)
        .map_err(|error| format!("读取项目历史失败：{error}"))?;
    let mut history = Vec::new();
    for row in rows {
        history.push(history_from_stored(
            row.map_err(|error| format!("读取项目历史行失败：{error}"))?,
        )?);
    }
    Ok(history)
}

fn read_all_history(connection: &Connection, project: &str) -> Result<Vec<RecordHistory>, String> {
    let mut statement = connection
        .prepare(
            "SELECT project_id, kind, entity_id, revision, at_ms, actor_json, operation,
                    request_id, snapshot_json
             FROM spellcast_project_history
             WHERE project_id = ?1
             ORDER BY CASE kind WHEN 'project' THEN 0 WHEN 'object' THEN 1 WHEN 'record' THEN 2 ELSE 3 END,
                      entity_id ASC, revision ASC",
        )
        .map_err(|error| format!("准备完整项目历史读取失败：{error}"))?;
    let rows = statement
        .query_map([project], stored_history_from_row)
        .map_err(|error| format!("读取完整项目历史失败：{error}"))?;
    let mut history = Vec::new();
    for row in rows {
        history.push(history_from_stored(
            row.map_err(|error| format!("读取完整项目历史行失败：{error}"))?,
        )?);
    }
    Ok(history)
}

fn read_receipt(
    transaction: &Transaction<'_>,
    request_id: &str,
) -> Result<Option<StoredReceipt>, String> {
    transaction
        .query_row(
            "SELECT actor_hash, body_hash, result_json
             FROM spellcast_project_request_receipts WHERE request_id = ?1",
            [request_id],
            |row| {
                Ok(StoredReceipt {
                    actor_hash: row.get(0)?,
                    body_hash: row.get(1)?,
                    result_json: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("读取项目请求回执失败：{error}"))
}

fn create_project(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    name: &str,
    aliases: &[String],
    now: u64,
) -> Result<RecordMutationResult, String> {
    validate_name("项目名称", name)?;
    validate_aliases(aliases)?;
    if read_project(transaction, &command.project_id)?.is_some() {
        return Err(format!("项目 {} 已存在。", command.project_id));
    }
    let project = Project {
        id: command.project_id.clone(),
        name: name.into(),
        aliases: aliases.to_vec(),
        revision: 1,
        archived: false,
        created_at_ms: now,
        updated_at_ms: now,
        imported_from: None,
    };
    insert_project(transaction, &project)?;
    append_history(
        transaction,
        &project.id,
        RecordHistoryKind::Project,
        &project.id,
        project.revision,
        now,
        actor,
        "create_project",
        &command.request_id,
        serde_json::to_value(&project)
            .map_err(|error| format!("序列化项目历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        project: Some(project),
        ..Default::default()
    })
}

#[allow(clippy::too_many_arguments)]
fn update_project(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    expected_revision: u64,
    name: &str,
    aliases: &[String],
    archived: bool,
    now: u64,
) -> Result<RecordMutationResult, String> {
    validate_name("项目名称", name)?;
    validate_aliases(aliases)?;
    let current = require_project(transaction, &command.project_id)?;
    require_expected_revision("项目", current.revision, expected_revision)?;
    let project = Project {
        id: current.id,
        name: name.into(),
        aliases: aliases.to_vec(),
        revision: next_revision(current.revision)?,
        archived,
        created_at_ms: current.created_at_ms,
        updated_at_ms: now,
        imported_from: current.imported_from,
    };
    update_project_row(transaction, &project)?;
    append_history(
        transaction,
        &project.id,
        RecordHistoryKind::Project,
        &project.id,
        project.revision,
        now,
        actor,
        "update_project",
        &command.request_id,
        serde_json::to_value(&project)
            .map_err(|error| format!("序列化项目历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        project: Some(project),
        ..Default::default()
    })
}

#[allow(clippy::too_many_arguments)]
fn put_object(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    name: &str,
    kind: &str,
    archived: bool,
    planning: Option<&crate::project_planning::PlanningFields>,
    now: u64,
) -> Result<RecordMutationResult, String> {
    require_project(transaction, &command.project_id)?;
    validate_local_id("开发对象 id", id)?;
    validate_name("开发对象名称", name)?;
    validate_name("开发对象类型", kind)?;
    let previous = read_object(transaction, &command.project_id, id)?;
    let revision = match previous {
        None if expected_revision == 0 => 1,
        None => {
            return Err(format!(
                "开发对象 {id} 尚不存在，创建时 expected_revision 必须是 0。"
            ))
        }
        Some(_) if expected_revision == 0 => {
            return Err(format!("开发对象 {id} 已存在，更新需要当前 revision。"));
        }
        Some(ref current) => {
            require_expected_revision("开发对象", current.revision, expected_revision)?;
            require_unlocked_object(current)?;
            next_revision(current.revision)?
        }
    };
    if previous.as_ref().and_then(|object| object.planning.as_ref())
        .is_some_and(|old| old.sections.is_some())
        && planning.is_some_and(|incoming| incoming.sections.is_none())
    {
        return Err("已有片段的对象更新 planning 时必须明确提供 sections；省略整个 planning 可保留原内容。".into());
    }
    let object = DevelopmentObject {
        id: id.into(),
        project_id: command.project_id.clone(),
        name: name.into(),
        kind: kind.into(),
        revision,
        archived,
        planning: planning.cloned().or_else(||previous.and_then(|object|object.planning)),
    };
    validate_object_in_project(transaction,&object)?;
    upsert_object(transaction, &object)?;
    append_history(
        transaction,
        &object.project_id,
        RecordHistoryKind::Object,
        &object.id,
        object.revision,
        now,
        actor,
        "put_object",
        &command.request_id,
        serde_json::to_value(&object)
            .map_err(|error| format!("序列化开发对象历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        object: Some(object),
        ..Default::default()
    })
}

fn restore_object(transaction:&Transaction<'_>,command:&RecordCommand,actor:&RecordActor,id:&str,expected_revision:u64,restore_revision:u64,now:u64) -> Result<RecordMutationResult,String> {
    require_project(transaction,&command.project_id)?;
    let current=read_object(transaction,&command.project_id,id)?.ok_or("找不到开发对象。")?;
    require_expected_revision("开发对象",current.revision,expected_revision)?;
    require_unlocked_object(&current)?;
    let history=read_history_revision(transaction,&command.project_id,RecordHistoryKind::Object,id,restore_revision)?
        .ok_or("找不到这个对象历史版本。")?;
    let mut restored:DevelopmentObject=decode_snapshot(&history.snapshot,"开发对象历史")?;
    if restored.id!=id || restored.project_id!=command.project_id || restored.revision!=restore_revision {
        return Err("开发对象历史身份不一致。".into());
    }
    restored.revision=next_revision(current.revision)?;
    validate_object_in_project(transaction,&restored)?;
    upsert_object(transaction,&restored)?;
    append_history(transaction,&restored.project_id,RecordHistoryKind::Object,&restored.id,restored.revision,now,actor,"restore_object",&command.request_id,
        serde_json::to_value(&restored).map_err(|e|e.to_string())?)?;
    Ok(RecordMutationResult { object:Some(restored),..Default::default() })
}

fn require_unlocked_object(object: &DevelopmentObject) -> Result<(), String> {
    if object.planning.as_ref().is_some_and(|planning| planning.locked) {
        return Err("对象已锁定；请明确解锁后再修改、归档或恢复历史。".into());
    }
    Ok(())
}

fn set_object_lock(transaction:&Transaction<'_>,command:&RecordCommand,actor:&RecordActor,id:&str,expected_revision:u64,locked:bool,now:u64) -> Result<RecordMutationResult,String> {
    require_project(transaction,&command.project_id)?;
    let mut object=read_object(transaction,&command.project_id,id)?.ok_or("找不到开发对象。")?;
    require_expected_revision("开发对象",object.revision,expected_revision)?;
    object.planning.as_mut().ok_or("此对象尚未加入规划。")?.locked=locked;
    object.revision=next_revision(object.revision)?;
    upsert_object(transaction,&object)?;
    append_history(transaction,&object.project_id,RecordHistoryKind::Object,&object.id,object.revision,now,actor,"set_object_lock",&command.request_id,
        serde_json::to_value(&object).map_err(|e|e.to_string())?)?;
    Ok(RecordMutationResult{object:Some(object),..Default::default()})
}

fn put_record(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    fields: &RecordFields,
    now: u64,
) -> Result<RecordMutationResult, String> {
    require_project(transaction, &command.project_id)?;
    validate_local_id("记录 id", id)?;
    validate_record_fields(fields)?;
    validate_record_object_membership(transaction, &command.project_id, fields)?;
    let previous = read_record(transaction, &command.project_id, id)?;
    let (revision, archived, created_at_ms) = match previous {
        None if expected_revision == 0 => (1, false, now),
        None => {
            return Err(format!(
                "记录 {id} 尚不存在，创建时 expected_revision 必须是 0。"
            ))
        }
        Some(_) if expected_revision == 0 => {
            return Err(format!("记录 {id} 已存在，更新需要当前 revision。"));
        }
        Some(ref current) => {
            require_expected_revision("记录", current.revision, expected_revision)?;
            (
                next_revision(current.revision)?,
                current.archived,
                current.created_at_ms,
            )
        }
    };
    let record = WorkRecord {
        id: id.into(),
        project_id: command.project_id.clone(),
        fields: fields.clone(),
        revision,
        archived,
        created_at_ms,
        updated_at_ms: now,
        updated_by: actor.clone(),
    };
    upsert_record(transaction, &record)?;
    append_history(
        transaction,
        &record.project_id,
        RecordHistoryKind::Record,
        &record.id,
        record.revision,
        now,
        actor,
        "put_record",
        &command.request_id,
        serde_json::to_value(&record)
            .map_err(|error| format!("序列化记录历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        record: Some(record),
        ..Default::default()
    })
}

fn archive_record(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    archived: bool,
    now: u64,
) -> Result<RecordMutationResult, String> {
    require_project(transaction, &command.project_id)?;
    validate_local_id("记录 id", id)?;
    let current = require_record(transaction, &command.project_id, id)?;
    require_expected_revision("记录", current.revision, expected_revision)?;
    let record = WorkRecord {
        revision: next_revision(current.revision)?,
        archived,
        updated_at_ms: now,
        updated_by: actor.clone(),
        ..current
    };
    upsert_record(transaction, &record)?;
    append_history(
        transaction,
        &record.project_id,
        RecordHistoryKind::Record,
        &record.id,
        record.revision,
        now,
        actor,
        "archive_record",
        &command.request_id,
        serde_json::to_value(&record)
            .map_err(|error| format!("序列化记录历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        record: Some(record),
        ..Default::default()
    })
}

fn restore_record(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    restore_revision: u64,
    now: u64,
) -> Result<RecordMutationResult, String> {
    require_project(transaction, &command.project_id)?;
    validate_local_id("记录 id", id)?;
    if restore_revision == 0 {
        return Err("restore_revision 必须是已有的正整数 revision。".into());
    }
    let current = require_record(transaction, &command.project_id, id)?;
    require_expected_revision("记录", current.revision, expected_revision)?;
    let previous = read_history_revision(
        transaction,
        &command.project_id,
        RecordHistoryKind::Record,
        id,
        restore_revision,
    )?
    .ok_or_else(|| format!("记录 {id} 没有 revision {restore_revision} 的历史。"))?;
    let restored: WorkRecord = decode_snapshot(&previous.snapshot, "记录历史快照")?;
    validate_record(&restored)?;
    if restored.project_id != command.project_id
        || restored.id != id
        || restored.revision != restore_revision
    {
        return Err("记录历史快照的身份或 revision 不一致。".into());
    }
    validate_record_object_membership(transaction, &command.project_id, &restored.fields)?;
    let record = WorkRecord {
        id: current.id,
        project_id: current.project_id,
        fields: restored.fields,
        revision: next_revision(current.revision)?,
        archived: restored.archived,
        created_at_ms: current.created_at_ms,
        updated_at_ms: now,
        updated_by: actor.clone(),
    };
    upsert_record(transaction, &record)?;
    append_history(
        transaction,
        &record.project_id,
        RecordHistoryKind::Record,
        &record.id,
        record.revision,
        now,
        actor,
        "restore_record",
        &command.request_id,
        serde_json::to_value(&record)
            .map_err(|error| format!("序列化记录历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        record: Some(record),
        ..Default::default()
    })
}

fn import_project(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    bundle: &ProjectExport,
    name: &str,
    now: u64,
) -> Result<RecordMutationResult, String> {
    validate_name("导入后项目名称", name)?;
    validate_import_bundle(bundle)?;
    ensure_new_import_target(transaction, &command.project_id)?;

    let project = Project {
        id: command.project_id.clone(),
        name: name.into(),
        aliases: bundle.project.aliases.clone(),
        revision: next_revision(bundle.project.revision)?,
        archived: bundle.project.archived,
        created_at_ms: now,
        updated_at_ms: now,
        imported_from: Some(ProjectImportProvenance {
            project_id: bundle.project.id.clone(),
            revision: bundle.project.revision,
        }),
    };
    insert_project(transaction, &project)?;
    for imported in &bundle.objects {
        let mut object = imported.clone();
        object.project_id = command.project_id.clone();
        upsert_object(transaction, &object)?;
    }
    for imported in &bundle.records {
        let mut record = imported.clone();
        record.project_id = command.project_id.clone();
        upsert_record(transaction, &record)?;
    }
    for imported in &bundle.history {
        let history = remap_history(imported, &command.project_id)?;
        insert_history(transaction, &history)?;
    }
    evidence::import_evidence(transaction, bundle, &command.project_id)?;

    let import_actor = RecordActor {
        kind: "import".into(),
        source_id: actor.source_id.clone(),
        thread_id: actor.thread_id.clone(),
        cwd: actor.cwd.clone(),
        label: actor.label.clone(),
    };
    append_history(
        transaction,
        &project.id,
        RecordHistoryKind::Project,
        &project.id,
        project.revision,
        now,
        &import_actor,
        "import_project",
        &command.request_id,
        serde_json::to_value(&project)
            .map_err(|error| format!("序列化导入项目历史快照失败：{error}"))?,
    )?;
    Ok(RecordMutationResult {
        project: Some(project),
        ..Default::default()
    })
}

fn ensure_new_import_target(transaction: &Transaction<'_>, project_id: &str) -> Result<(), String> {
    if read_project(transaction, project_id)?.is_some() {
        return Err(format!("导入目标项目 {project_id} 已存在。"));
    }
    for (label, table) in [
        ("开发对象", "spellcast_project_objects"),
        ("记录", "spellcast_project_records"),
        ("历史", "spellcast_project_history"),
        ("候选", "spellcast_project_candidates"),
        ("试走", "spellcast_project_trials"),
        ("采用记录", "spellcast_project_adoptions"),
    ] {
        let exists: i64 = transaction
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE project_id = ?1)"),
                [project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("检查导入目标{label}失败：{error}"))?;
        if exists != 0 {
            return Err(format!("导入目标项目 {project_id} 不是新的空项目。"));
        }
    }
    Ok(())
}

fn remap_history(history: &RecordHistory, target_project: &str) -> Result<RecordHistory, String> {
    let mut mapped = history.clone();
    mapped.project_id = target_project.into();
    match mapped.kind {
        RecordHistoryKind::Project => {
            let mut project: Project = decode_snapshot(&mapped.snapshot, "导入项目历史快照")?;
            project.id = target_project.into();
            mapped.id = target_project.into();
            mapped.snapshot = serde_json::to_value(project)
                .map_err(|error| format!("重映射项目历史快照失败：{error}"))?;
        }
        RecordHistoryKind::Object => {
            let mut object: DevelopmentObject =
                decode_snapshot(&mapped.snapshot, "导入开发对象历史快照")?;
            object.project_id = target_project.into();
            mapped.snapshot = serde_json::to_value(object)
                .map_err(|error| format!("重映射开发对象历史快照失败：{error}"))?;
        }
        RecordHistoryKind::Record => {
            let mut record: WorkRecord = decode_snapshot(&mapped.snapshot, "导入记录历史快照")?;
            record.project_id = target_project.into();
            mapped.snapshot = serde_json::to_value(record)
                .map_err(|error| format!("重映射记录历史快照失败：{error}"))?;
        }
        RecordHistoryKind::Candidate => {
            let mut candidate: crate::project_trials::ParameterCandidate =
                decode_snapshot(&mapped.snapshot, "导入候选历史快照")?;
            candidate.project_id = target_project.into();
            mapped.snapshot = serde_json::to_value(candidate)
                .map_err(|error| format!("重映射候选历史快照失败：{error}"))?;
        }
    }
    Ok(mapped)
}

fn insert_project(transaction: &Transaction<'_>, project: &Project) -> Result<(), String> {
    let aliases_json = serde_json::to_string(&project.aliases)
        .map_err(|error| format!("序列化项目别名失败：{error}"))?;
    let imported_from_json = project
        .imported_from
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("序列化项目导入来源失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO spellcast_projects
             (id, name, aliases_json, revision, archived, created_at_ms, updated_at_ms,
              imported_from_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                project.id,
                project.name,
                aliases_json,
                to_db_u64(project.revision, "项目 revision")?,
                to_db_bool(project.archived),
                to_db_u64(project.created_at_ms, "项目 created_at_ms")?,
                to_db_u64(project.updated_at_ms, "项目 updated_at_ms")?,
                imported_from_json,
            ],
        )
        .map_err(|error| format!("写入项目失败：{error}"))?;
    Ok(())
}

fn update_project_row(transaction: &Transaction<'_>, project: &Project) -> Result<(), String> {
    let aliases_json = serde_json::to_string(&project.aliases)
        .map_err(|error| format!("序列化项目别名失败：{error}"))?;
    let imported_from_json = project
        .imported_from
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("序列化项目导入来源失败：{error}"))?;
    let changed = transaction
        .execute(
            "UPDATE spellcast_projects SET name = ?2, aliases_json = ?3, revision = ?4,
                archived = ?5, updated_at_ms = ?6, imported_from_json = ?7 WHERE id = ?1",
            params![
                project.id,
                project.name,
                aliases_json,
                to_db_u64(project.revision, "项目 revision")?,
                to_db_bool(project.archived),
                to_db_u64(project.updated_at_ms, "项目 updated_at_ms")?,
                imported_from_json,
            ],
        )
        .map_err(|error| format!("更新项目失败：{error}"))?;
    if changed != 1 {
        return Err("项目在更新时不再存在。".into());
    }
    Ok(())
}

fn upsert_object(transaction: &Transaction<'_>, object: &DevelopmentObject) -> Result<(), String> {
    let planning_json=object.planning.as_ref().map(serde_json::to_string).transpose().map_err(|e|e.to_string())?;
    transaction
        .execute(
            "INSERT INTO spellcast_project_objects
             (project_id, id, name, kind, revision, archived, planning_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_id, id) DO UPDATE SET
                name = excluded.name,
                kind = excluded.kind,
                revision = excluded.revision,
                archived = excluded.archived,
                planning_json = excluded.planning_json",
            params![
                object.project_id,
                object.id,
                object.name,
                object.kind,
                to_db_u64(object.revision, "开发对象 revision")?,
                to_db_bool(object.archived),
                planning_json,
            ],
        )
        .map_err(|error| format!("写入开发对象失败：{error}"))?;
    Ok(())
}

fn upsert_record(transaction: &Transaction<'_>, record: &WorkRecord) -> Result<(), String> {
    let references_json = serde_json::to_string(&record.fields.references)
        .map_err(|error| format!("序列化记录引用失败：{error}"))?;
    let updated_by_json = serde_json::to_string(&record.updated_by)
        .map_err(|error| format!("序列化记录执行者失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO spellcast_project_records
             (project_id, id, object_id, title, goal, scope, status, result, boundaries,
              next_step, references_json, revision, archived, created_at_ms, updated_at_ms,
              updated_by_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(project_id, id) DO UPDATE SET
                object_id = excluded.object_id,
                title = excluded.title,
                goal = excluded.goal,
                scope = excluded.scope,
                status = excluded.status,
                result = excluded.result,
                boundaries = excluded.boundaries,
                next_step = excluded.next_step,
                references_json = excluded.references_json,
                revision = excluded.revision,
                archived = excluded.archived,
                updated_at_ms = excluded.updated_at_ms,
                updated_by_json = excluded.updated_by_json",
            params![
                record.project_id,
                record.id,
                record.fields.object_id,
                record.fields.title,
                record.fields.goal,
                record.fields.scope,
                record.fields.status.as_str(),
                record.fields.result,
                record.fields.boundaries,
                record.fields.next_step,
                references_json,
                to_db_u64(record.revision, "记录 revision")?,
                to_db_bool(record.archived),
                to_db_u64(record.created_at_ms, "记录 created_at_ms")?,
                to_db_u64(record.updated_at_ms, "记录 updated_at_ms")?,
                updated_by_json,
            ],
        )
        .map_err(|error| format!("写入项目记录失败：{error}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_history(
    transaction: &Transaction<'_>,
    project_id: &str,
    kind: RecordHistoryKind,
    id: &str,
    revision: u64,
    at_ms: u64,
    actor: &RecordActor,
    operation: &str,
    request_id: &str,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let history = RecordHistory {
        project_id: project_id.into(),
        kind,
        id: id.into(),
        revision,
        at_ms,
        actor: actor.clone(),
        operation: operation.into(),
        request_id: request_id.into(),
        snapshot,
    };
    insert_history(transaction, &history)
}

fn insert_history(transaction: &Transaction<'_>, history: &RecordHistory) -> Result<(), String> {
    let actor_json = serde_json::to_string(&history.actor)
        .map_err(|error| format!("序列化历史执行者失败：{error}"))?;
    let snapshot_json = serde_json::to_string(&history.snapshot)
        .map_err(|error| format!("序列化历史快照失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO spellcast_project_history
             (project_id, kind, entity_id, revision, at_ms, actor_json, operation, request_id,
              snapshot_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                history.project_id,
                history.kind.as_str(),
                history.id,
                to_db_u64(history.revision, "历史 revision")?,
                to_db_u64(history.at_ms, "历史 at_ms")?,
                actor_json,
                history.operation,
                history.request_id,
                snapshot_json,
            ],
        )
        .map_err(|error| format!("追加项目历史失败：{error}"))?;
    Ok(())
}

fn read_history_revision(
    transaction: &Transaction<'_>,
    project: &str,
    kind: RecordHistoryKind,
    id: &str,
    revision: u64,
) -> Result<Option<RecordHistory>, String> {
    let stored = transaction
        .query_row(
            "SELECT project_id, kind, entity_id, revision, at_ms, actor_json, operation,
                    request_id, snapshot_json
             FROM spellcast_project_history
             WHERE project_id = ?1 AND kind = ?2 AND entity_id = ?3 AND revision = ?4",
            params![
                project,
                kind.as_str(),
                id,
                to_db_u64(revision, "历史 revision")?
            ],
            stored_history_from_row,
        )
        .optional()
        .map_err(|error| format!("读取指定项目历史失败：{error}"))?;
    stored.map(history_from_stored).transpose()
}

fn require_project(connection: &Connection, id: &str) -> Result<Project, String> {
    read_project(connection, id)?.ok_or_else(|| format!("找不到项目 {id}。"))
}

fn require_record(connection: &Connection, project: &str, id: &str) -> Result<WorkRecord, String> {
    read_record(connection, project, id)?.ok_or_else(|| format!("找不到记录 {id}。"))
}

fn validate_command_envelope(command: &RecordCommand, actor: &RecordActor) -> Result<(), String> {
    validate_project_id(&command.project_id)?;
    validate_request_id(&command.request_id)?;
    validate_actor(actor)
}

fn validate_project(project: &Project) -> Result<(), String> {
    validate_project_id(&project.id)?;
    validate_name("项目名称", &project.name)?;
    validate_aliases(&project.aliases)?;
    if project.revision == 0 {
        return Err("项目 revision 必须从 1 开始。".into());
    }
    if project.created_at_ms > project.updated_at_ms {
        return Err("项目 created_at_ms 不能晚于 updated_at_ms。".into());
    }
    if let Some(imported_from) = &project.imported_from {
        validate_project_id(&imported_from.project_id)?;
        if imported_from.revision == 0 {
            return Err("项目 imported_from.revision 必须从 1 开始。".into());
        }
    }
    Ok(())
}

fn validate_object(object: &DevelopmentObject) -> Result<(), String> {
    validate_project_id(&object.project_id)?;
    validate_local_id("开发对象 id", &object.id)?;
    validate_name("开发对象名称", &object.name)?;
    validate_name("开发对象类型", &object.kind)?;
    if let Some(planning)=&object.planning {
        crate::project_planning::validate_fields(&object.kind,planning)?;
        for reference in &planning.references { validate_source_reference(reference)?; }
        if let Some(sections) = &planning.sections {
            for section in sections {
                for reference in &section.references { validate_source_reference(reference)?; }
            }
        }
    }
    if object.revision == 0 {
        return Err("开发对象 revision 必须从 1 开始。".into());
    }
    Ok(())
}

fn validate_record(record: &WorkRecord) -> Result<(), String> {
    validate_project_id(&record.project_id)?;
    validate_local_id("记录 id", &record.id)?;
    validate_record_fields(&record.fields)?;
    validate_actor(&record.updated_by)?;
    if record.revision == 0 {
        return Err("记录 revision 必须从 1 开始。".into());
    }
    if record.created_at_ms > record.updated_at_ms {
        return Err("记录 created_at_ms 不能晚于 updated_at_ms。".into());
    }
    Ok(())
}

fn validate_record_fields(fields: &RecordFields) -> Result<(), String> {
    if let Some(object_id) = &fields.object_id {
        validate_local_id("记录 object_id", object_id)?;
    }
    validate_name("记录标题", &fields.title)?;
    for (label, value) in [
        ("记录目标", &fields.goal),
        ("记录范围", &fields.scope),
        ("记录结果", &fields.result),
        ("记录边界", &fields.boundaries),
        ("记录下一步", &fields.next_step),
    ] {
        validate_free_text(label, value)?;
    }
    if fields.references.len() > MAX_REFERENCES {
        return Err(format!("记录引用最多 {MAX_REFERENCES} 条。"));
    }
    for reference in &fields.references {
        validate_source_reference(reference)?;
    }
    Ok(())
}

fn validate_source_reference(reference: &SourceReference) -> Result<(), String> {
    validate_name("来源引用标签", &reference.label)?;
    validate_uri(&reference.uri)?;
    validate_free_text("来源引用版本", &reference.version)
}

/// Only the native OS-authenticated application boundary calls this. Its outer
/// transaction owns grant checks, receipts and audit; this cannot manage a project.
pub(crate) fn client_put_record(
    transaction: &Transaction<'_>, command: &RecordCommand, actor: &RecordActor,
) -> Result<RecordMutationResult, String> {
    validate_command_envelope(command, actor)?;
    if actor.kind != "client" { return Err("invalid client actor".into()); }
    let RecordChange::PutRecord { id, expected_revision, fields } = &command.change else {
        return Err("client save only supports put_record".into());
    };
    put_record(transaction, command, actor, id, *expected_revision, fields, current_time_ms()?)
}

fn validate_record_object_membership(
    connection: &Connection,
    project: &str,
    fields: &RecordFields,
) -> Result<(), String> {
    let Some(object_id) = &fields.object_id else {
        return Ok(());
    };
    if read_object(connection, project, object_id)?.is_none() {
        return Err(format!(
            "记录引用的开发对象 {object_id} 不属于项目 {project}。"
        ));
    }
    Ok(())
}

fn validate_history_shape(history: &RecordHistory) -> Result<(), String> {
    validate_project_id(&history.project_id)?;
    match history.kind {
        RecordHistoryKind::Project => validate_project_id(&history.id)?,
        RecordHistoryKind::Object => validate_local_id("历史开发对象 id", &history.id)?,
        RecordHistoryKind::Record => validate_local_id("历史记录 id", &history.id)?,
        RecordHistoryKind::Candidate => validate_local_id("历史候选 id", &history.id)?,
    }
    if history.revision == 0 {
        return Err("历史 revision 必须从 1 开始。".into());
    }
    validate_actor(&history.actor)?;
    validate_name("历史操作", &history.operation)?;
    validate_request_id(&history.request_id)?;
    Ok(())
}

fn validate_actor(actor: &RecordActor) -> Result<(), String> {
    if !matches!(actor.kind.as_str(), "user" | "agent" | "import" | "client") {
        return Err("记录执行者 kind 必须是 user、agent、import 或 client。".into());
    }
    validate_name("记录执行者标签", &actor.label)?;
    for (label, value, maximum) in [
        (
            "记录执行者 source_id",
            actor.source_id.as_deref(),
            MAX_ID_BYTES,
        ),
        (
            "记录执行者 thread_id",
            actor.thread_id.as_deref(),
            MAX_ID_BYTES,
        ),
        ("记录执行者 cwd", actor.cwd.as_deref(), MAX_URI_BYTES),
    ] {
        if let Some(value) = value {
            validate_bounded_text(label, value, maximum, false)?;
        }
    }
    Ok(())
}

fn validate_import_bundle(bundle: &ProjectExport) -> Result<(), String> {
    let bytes = serde_json::to_vec(bundle)
        .map_err(|error| format!("序列化导入包以检查大小失败：{error}"))?;
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(format!("导入包超过 {MAX_IMPORT_BYTES} 字节上限。"));
    }
    if bundle.format != "spellcast.project" || !matches!(bundle.version,1..=4) {
        return Err("导入包格式必须是 spellcast.project v1、v2、v3 或 v4。".into());
    }
    if bundle.version < 4 && has_sections(&bundle.objects, &bundle.history) {
        return Err("含内容片段的导入包必须使用 v4，不能伪装为旧版本。".into());
    }
    if bundle.version==1 && has_planning(&bundle.objects,&bundle.history) {
        return Err("含规划内容的导出包必须使用 v2，以免旧客户端丢失内容。".into());
    }
    if bundle.version<3 && evidence::needs_v3(bundle) {
        return Err("含流程位置关联、独立候选、试走或采用记录的导出包必须使用 v3。".into());
    }
    if bundle.objects.len() > MAX_IMPORT_OBJECTS
        || bundle.records.len() > MAX_IMPORT_RECORDS
        || bundle.history.len() > MAX_IMPORT_HISTORY
    {
        return Err("导入包超过 phase 1 的对象、记录或历史上限。".into());
    }
    validate_project(&bundle.project)?;

    let source_project = &bundle.project.id;
    let mut object_ids = BTreeSet::new();
    for object in &bundle.objects {
        validate_object(object)?;
        if &object.project_id != source_project {
            return Err("导入开发对象的 project_id 与导入项目不一致。".into());
        }
        if !object_ids.insert(object.id.as_str()) {
            return Err(format!("导入包包含重复的开发对象 id {}。", object.id));
        }
    }

    crate::project_planning::validate_graph(&bundle.objects)?;
    let mut record_ids = BTreeSet::new();
    for record in &bundle.records {
        validate_record(record)?;
        if &record.project_id != source_project {
            return Err("导入记录的 project_id 与导入项目不一致。".into());
        }
        if let Some(object_id) = &record.fields.object_id {
            if !object_ids.contains(object_id.as_str()) {
                return Err(format!("导入记录引用了不存在的开发对象 {object_id}。"));
            }
        }
        if !record_ids.insert(record.id.as_str()) {
            return Err(format!("导入包包含重复的记录 id {}。", record.id));
        }
    }
    validate_import_histories(bundle)?;
    evidence::validate_import_evidence(bundle)?;
    validate_external_files(bundle)
}

fn validate_external_files(bundle: &ProjectExport) -> Result<(), String> {
    let expected: BTreeSet<String> = external_files_for(&bundle.objects, &bundle.records, &bundle.history)?
        .into_iter()
        .map(|file| file.uri)
        .collect();
    let mut actual = BTreeSet::new();
    for file in &bundle.external_files {
        validate_uri(&file.uri)?;
        if file.original_included {
            return Err("portable export 不能包含外部原始文件。".into());
        }
        if !actual.insert(file.uri.clone()) {
            return Err(format!("导入包包含重复外部文件 URI {}。", file.uri));
        }
    }
    if actual != expected {
        return Err("导入包的 external_files 必须完整且只能列出记录中的外部引用。".into());
    }
    Ok(())
}

fn validate_import_histories(bundle: &ProjectExport) -> Result<(), String> {
    let source_project = &bundle.project.id;
    let mut expected: BTreeMap<(String, String), (u64, serde_json::Value)> = BTreeMap::new();
    expected.insert(
        ("project".into(), source_project.clone()),
        (
            bundle.project.revision,
            serde_json::to_value(&bundle.project)
                .map_err(|error| format!("序列化导入项目当前值失败：{error}"))?,
        ),
    );
    for object in &bundle.objects {
        expected.insert(
            ("object".into(), object.id.clone()),
            (
                object.revision,
                serde_json::to_value(object)
                    .map_err(|error| format!("序列化导入开发对象当前值失败：{error}"))?,
            ),
        );
    }
    for record in &bundle.records {
        expected.insert(
            ("record".into(), record.id.clone()),
            (
                record.revision,
                serde_json::to_value(record)
                    .map_err(|error| format!("序列化导入记录当前值失败：{error}"))?,
            ),
        );
    }
    for candidate in &bundle.candidates {
        expected.insert(
            ("candidate".into(), candidate.id.clone()),
            (
                candidate.revision,
                serde_json::to_value(candidate)
                    .map_err(|error| format!("序列化导入候选当前值失败：{error}"))?,
            ),
        );
    }

    let object_ids: BTreeSet<&str> = bundle
        .objects
        .iter()
        .map(|object| object.id.as_str())
        .collect();
    let mut groups: BTreeMap<(String, String), Vec<&RecordHistory>> = BTreeMap::new();
    for history in &bundle.history {
        validate_history_shape(history)?;
        if &history.project_id != source_project {
            return Err("导入历史的 project_id 与导入项目不一致。".into());
        }
        let key = (history.kind.as_str().into(), history.id.clone());
        if !expected.contains_key(&key) {
            return Err("导入历史引用了不存在的项目、开发对象、记录或候选。".into());
        }
        validate_history_snapshot_identity(history, source_project, &object_ids)?;
        groups.entry(key).or_default().push(history);
    }

    for (key, (current_revision, current_snapshot)) in expected {
        let mut entries = groups
            .remove(&key)
            .ok_or_else(|| format!("导入包缺少 {} {} 的完整历史。", key.0, key.1))?;
        entries.sort_by_key(|history| history.revision);
        if entries.len() as u64 != current_revision {
            return Err(format!(
                "导入 {} {} 的历史不是连续完整的 revision。",
                key.0, key.1
            ));
        }
        for (index, history) in entries.iter().enumerate() {
            let expected_revision = index as u64 + 1;
            if history.revision != expected_revision {
                return Err(format!("导入 {} {} 的历史 revision 不连续。", key.0, key.1));
            }
        }
        let last = entries
            .last()
            .expect("nonempty history after revision count validation");
        if last.snapshot != current_snapshot {
            return Err(format!(
                "导入 {} {} 的当前行与最后一个历史快照不一致。",
                key.0, key.1
            ));
        }
    }
    if !groups.is_empty() {
        return Err("导入包包含未归属的历史。".into());
    }
    Ok(())
}

fn validate_history_snapshot_identity(
    history: &RecordHistory,
    source_project: &str,
    object_ids: &BTreeSet<&str>,
) -> Result<(), String> {
    match history.kind {
        RecordHistoryKind::Project => {
            let snapshot: Project = decode_snapshot(&history.snapshot, "项目历史快照")?;
            validate_project(&snapshot)?;
            ensure_canonical_snapshot(&snapshot, &history.snapshot, "项目历史快照")?;
            if snapshot.id != source_project
                || history.id != source_project
                || snapshot.revision != history.revision
            {
                return Err("项目历史快照的身份或 revision 不一致。".into());
            }
        }
        RecordHistoryKind::Object => {
            let snapshot: DevelopmentObject =
                decode_snapshot(&history.snapshot, "开发对象历史快照")?;
            validate_object(&snapshot)?;
            ensure_canonical_snapshot(&snapshot, &history.snapshot, "开发对象历史快照")?;
            if snapshot.project_id != source_project
                || snapshot.id != history.id
                || snapshot.revision != history.revision
            {
                return Err("开发对象历史快照的身份或 revision 不一致。".into());
            }
            if let Some(planning) = &snapshot.planning {
                if planning.links.iter().any(|link| !object_ids.contains(link.target_id.as_str()))
                    || planning.anchors.iter().any(|anchor| !object_ids.contains(anchor.flow_id.as_str())) {
                    return Err("规划对象历史引用了不在导出项目中的对象。".into());
                }
            }
        }
        RecordHistoryKind::Candidate => {
            let snapshot: crate::project_trials::ParameterCandidate =
                decode_snapshot(&history.snapshot, "候选历史快照")?;
            crate::project_trials::validate_candidate(&snapshot)?;
            ensure_canonical_snapshot(&snapshot, &history.snapshot, "候选历史快照")?;
            if snapshot.project_id != source_project
                || snapshot.id != history.id
                || snapshot.revision != history.revision
                || !object_ids.contains(snapshot.parameter_id.as_str())
            {
                return Err("候选历史快照的身份、revision 或参数不一致。".into());
            }
        }
        RecordHistoryKind::Record => {
            let snapshot: WorkRecord = decode_snapshot(&history.snapshot, "记录历史快照")?;
            validate_record(&snapshot)?;
            ensure_canonical_snapshot(&snapshot, &history.snapshot, "记录历史快照")?;
            if snapshot.project_id != source_project
                || snapshot.id != history.id
                || snapshot.revision != history.revision
            {
                return Err("记录历史快照的身份或 revision 不一致。".into());
            }
            if let Some(object_id) = &snapshot.fields.object_id {
                if !object_ids.contains(object_id.as_str()) {
                    return Err(format!("记录历史快照引用了不存在的开发对象 {object_id}。"));
                }
            }
        }
    }
    Ok(())
}

fn ensure_canonical_snapshot<T: Serialize>(
    decoded: &T,
    snapshot: &serde_json::Value,
    label: &str,
) -> Result<(), String> {
    let canonical =
        serde_json::to_value(decoded).map_err(|error| format!("重新序列化{label}失败：{error}"))?;
    if &canonical != snapshot {
        return Err(format!("{label} 包含未知字段或缺少完整字段。"));
    }
    Ok(())
}

fn decode_snapshot<T: DeserializeOwned>(
    snapshot: &serde_json::Value,
    label: &str,
) -> Result<T, String> {
    serde_json::from_value(snapshot.clone()).map_err(|error| format!("{label} 损坏：{error}"))
}

fn validate_project_id(id: &str) -> Result<(), String> {
    if id.len() > MAX_ID_BYTES {
        return Err(format!("项目 id 超过 {MAX_ID_BYTES} 字节。"));
    }
    Uuid::parse_str(id).map_err(|_| "项目 id 必须是稳定 UUID。".to_string())?;
    Ok(())
}

fn validate_local_id(label: &str, id: &str) -> Result<(), String> {
    validate_bounded_text(label, id, MAX_ID_BYTES, false)?;
    if id.trim().is_empty() {
        return Err(format!("{label} 不能为空。"));
    }
    Ok(())
}

fn validate_name(label: &str, value: &str) -> Result<(), String> {
    validate_bounded_text(label, value, MAX_NAME_BYTES, false)?;
    if value.trim().is_empty() {
        return Err(format!("{label} 不能为空。"));
    }
    Ok(())
}

fn validate_aliases(aliases: &[String]) -> Result<(), String> {
    if aliases.len() > MAX_ALIASES {
        return Err(format!("项目别名最多 {MAX_ALIASES} 条。"));
    }
    let mut unique = BTreeSet::new();
    for alias in aliases {
        validate_name("项目别名", alias)?;
        if !unique.insert(alias.as_str()) {
            return Err(format!("项目别名重复：{alias}。"));
        }
    }
    Ok(())
}

fn validate_free_text(label: &str, value: &str) -> Result<(), String> {
    validate_bounded_text(label, value, MAX_TEXT_BYTES, true)
}

fn validate_bounded_text(
    label: &str,
    value: &str,
    maximum: usize,
    allow_newlines: bool,
) -> Result<(), String> {
    if value.len() > maximum {
        return Err(format!("{label} 超过 {maximum} 字节。"));
    }
    if value.contains('\0') {
        return Err(format!("{label} 不能包含 NUL 字符。"));
    }
    if !allow_newlines && value.chars().any(char::is_control) {
        return Err(format!("{label} 不能包含控制字符。"));
    }
    Ok(())
}

fn validate_uri(uri: &str) -> Result<(), String> {
    if uri.len() > MAX_URI_BYTES || uri.is_empty() || uri.trim() != uri {
        return Err("来源引用 URI 不能为空、不能带首尾空白且必须在大小限制内。".into());
    }
    if uri.chars().any(char::is_control) {
        return Err("来源引用 URI 不能包含控制字符。".into());
    }
    let Some((raw_scheme, _)) = uri.split_once(':') else {
        return Err("来源引用必须是带 scheme 的外部 URI。".into());
    };
    let mut characters = raw_scheme.chars();
    let Some(first) = characters.next() else {
        return Err("来源引用 URI 缺少 scheme。".into());
    };
    if !first.is_ascii_alphabetic()
        || !characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
    {
        return Err("来源引用 URI 的 scheme 无效。".into());
    }
    if matches!(
        raw_scheme.to_ascii_lowercase().as_str(),
        "javascript" | "data" | "vbscript"
    ) {
        return Err("来源引用不能是脚本或嵌入式 URI。".into());
    }
    Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    validate_bounded_text("request_id", request_id, MAX_REQUEST_ID_BYTES, false)?;
    if request_id.trim().is_empty() {
        return Err("request_id 不能为空。".into());
    }
    Ok(())
}

fn validate_query(query: &str) -> Result<(), String> {
    validate_bounded_text("查询", query, MAX_TEXT_BYTES, true)
}

fn require_expected_revision(label: &str, current: u64, expected: u64) -> Result<(), String> {
    if expected == 0 || expected != current {
        return Err(format!(
            "{label} revision 已变化；当前是 {current}，请求的是 {expected}。"
        ));
    }
    Ok(())
}

fn next_revision(current: u64) -> Result<u64, String> {
    current
        .checked_add(1)
        .ok_or_else(|| "revision 已达到上限。".into())
}

fn to_db_u64(value: u64, label: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{label} 超出 SQLite INTEGER 范围。"))
}

fn from_db_u64(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("{label} 不能是负数。"))
}

fn to_db_bool(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn from_db_bool(value: i64, label: &str) -> Result<bool, String> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(format!("{label} 数据损坏。")),
    }
}

fn stable_hash<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| format!("计算请求哈希失败：{error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn current_time_ms() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("系统时间早于 Unix epoch：{error}"))?;
    u64::try_from(duration.as_millis()).map_err(|_| "当前时间超过毫秒时间戳范围。".into())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn external_files_for(
    objects: &[DevelopmentObject],
    records: &[WorkRecord],
    history: &[RecordHistory],
) -> Result<Vec<ProjectExternalFile>, String> {
    let mut uris: BTreeSet<String> = records
        .iter()
        .flat_map(|record| {
            record
                .fields
                .references
                .iter()
                .map(|reference| reference.uri.clone())
        })
        .collect();
    for fields in objects.iter().filter_map(|object|object.planning.as_ref()) {
        uris.extend(fields.references.iter().map(|reference|reference.uri.clone()));
        if let Some(sections) = &fields.sections {
            uris.extend(sections.iter().flat_map(|section| section.references.iter().map(|reference| reference.uri.clone())));
        }
    }
    for entry in history {
        if entry.kind == RecordHistoryKind::Object {
            let object:DevelopmentObject=decode_snapshot(&entry.snapshot,"开发对象历史快照")?;
            validate_object(&object)?;
            if let Some(fields)=object.planning {
                uris.extend(fields.references.into_iter().map(|reference|reference.uri));
                if let Some(sections) = fields.sections {
                    uris.extend(sections.into_iter().flat_map(|section| section.references.into_iter().map(|reference| reference.uri)));
                }
            }
        }
        if entry.kind != RecordHistoryKind::Record {
            continue;
        }
        let record: WorkRecord = decode_snapshot(&entry.snapshot, "记录历史快照")?;
        validate_record(&record)?;
        for reference in record.fields.references {
            uris.insert(reference.uri);
        }
    }
    Ok(uris
        .into_iter()
        .map(|uri| ProjectExternalFile {
            uri,
            original_included: false,
        })
        .collect())
}

fn has_planning(objects:&[DevelopmentObject],history:&[RecordHistory]) -> bool {
    objects.iter().any(|object|object.planning.is_some()) || history.iter().any(|entry|
        entry.kind==RecordHistoryKind::Object && entry.snapshot.get("planning").is_some_and(|value|!value.is_null()))
}

fn has_sections(objects: &[DevelopmentObject], history: &[RecordHistory]) -> bool {
    objects.iter().any(|object| object.planning.as_ref().is_some_and(|planning| planning.sections.is_some()))
        || history.iter().any(|entry| entry.kind == RecordHistoryKind::Object
            && entry.snapshot.get("planning").and_then(|planning| planning.get("sections")).is_some_and(|sections| !sections.is_null()))
}

fn markdown_text(value: &str) -> String {
    value.replace('\r', "").replace('\n', " ")
}

fn write_markdown_field(markdown: &mut String, label: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    markdown.push_str("\n#### ");
    markdown.push_str(label);
    markdown.push_str("\n\n");
    markdown.push_str(value);
    markdown.push_str("\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fresh_id() -> String {
        Uuid::new_v4().to_string()
    }

    fn temp_store(label: &str) -> (Store, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "spellcast-project-records-{label}-{}.sqlite3",
            Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&path);
        (Store::open(&path).expect("temporary project store"), path)
    }

    fn cleanup(store: Store, path: PathBuf) {
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    fn actor() -> RecordActor {
        RecordActor {
            kind: "user".into(),
            source_id: None,
            thread_id: None,
            cwd: None,
            label: "Unit test".into(),
        }
    }

    fn command(project_id: &str, change: RecordChange) -> RecordCommand {
        RecordCommand {
            request_id: fresh_id(),
            project_id: project_id.into(),
            change,
        }
    }

    fn fields(object_id: Option<String>) -> RecordFields {
        RecordFields {
            object_id,
            title: "Acceptance record".into(),
            goal: "Verify history and restore".into(),
            scope: String::new(),
            status: RecordStatus::Planned,
            result: String::new(),
            boundaries: "Only the approved scope".into(),
            next_step: String::new(),
            references: Vec::new(),
        }
    }

    fn create_project(store: &mut Store, project_id: &str) -> Project {
        store
            .project_mutate(
                &command(
                    project_id,
                    RecordChange::CreateProject {
                        name: "Project records test".into(),
                        aliases: vec!["test-alias".into()],
                    },
                ),
                &actor(),
            )
            .expect("create project")
            .project
            .expect("project result")
    }

    fn planning_change(id: &str, revision: u64, kind: &str, planning: serde_json::Value) -> RecordChange {
        RecordChange::PutObject { id:id.into(), expected_revision:revision, name:id.into(), kind:kind.into(), archived:false,
            planning:Some(serde_json::from_value(planning).unwrap()) }
    }

    #[test]
    fn planning_flow_validation_history_and_portability() {
        let (mut store,path)=temp_store("planning-flow"); let project=fresh_id();create_project(&mut store,&project);
        let legacy=serde_json::json!({"scopes":["R0"]});
        let canonical:crate::project_planning::PlanningFields=serde_json::from_value(legacy).unwrap();
        assert!(serde_json::to_value(canonical).unwrap().get("flow").is_none());
        store.project_mutate(&command(&project,planning_change("reward",0,"parameter",serde_json::json!({"scopes":["R0"],"parameter":{"value":"5"}}))),&actor()).unwrap();
        let flow=serde_json::json!({"scopes":["R0"],"locked":true,"links":[{"target_id":"reward","relation":"uses"}],"flow":{
            "entry":"start","variables":[{"id":"coins","name":"Coins","value_type":"number","initial":"","unit":"","parameter_id":"reward"}],
            "steps":[{"id":"start","title":"Start","goal":"","action":"","feedback":"","external":false,"terminal":false,"choices":[{"id":"go","label":"Go","to":"end","conditions":[{"variable_id":"coins","op":"gte","operand":{"kind":"literal","value":"0"}}],"effects":[{"variable_id":"coins","op":"add","operand":{"kind":"literal","value":"2"}}]}]},
              {"id":"end","title":"End","goal":"","action":"","feedback":"","external":false,"terminal":true,"choices":[]}]}});
        for change in [
            {let mut x=flow.clone();x["flow"]["steps"][0]["choices"][0]["to"]="missing".into();x},
            {let mut x=flow.clone();x["flow"]["steps"][0]["choices"][0]["effects"][0]["operand"]["value"]="NaN".into();x},
            {let mut x=flow.clone();x["flow"]["steps"][0]["choices"][0]["conditions"][0]["variable_id"]="missing".into();x},
            {let mut x=flow.clone();x["links"]=serde_json::json!([]);x},
            {let mut x=flow.clone();x["flow"]["variables"][0]["value_type"]="flag".into();x},
        ] { assert!(store.project_mutate(&command(&project,planning_change("invalid",0,"flow",change)),&actor()).is_err()); }
        store.project_mutate(&command(&project,planning_change("flow",0,"flow",flow.clone())),&actor()).unwrap();
        assert!(store.project_mutate(&command(&project,planning_change("flow",1,"flow",flow.clone())),&actor()).unwrap_err().contains("已锁定"));
        store.project_mutate(&command(&project,RecordChange::SetObjectLock{id:"flow".into(),expected_revision:1,locked:false}),&actor()).unwrap();
        let mut changed=flow.clone();changed["flow"]["steps"][0]["choices"][0]["effects"][0]["operand"]["value"]="3".into();
        store.project_mutate(&command(&project,planning_change("flow",2,"flow",changed)),&actor()).unwrap();
        store.project_mutate(&command(&project,RecordChange::SetObjectLock{id:"flow".into(),expected_revision:3,locked:false}),&actor()).unwrap();
        store.project_mutate(&command(&project,RecordChange::RestoreObject{id:"flow".into(),expected_revision:4,restore_revision:1}),&actor()).unwrap();
        let bundle=store.project_export(&project).unwrap(); let original=bundle.objects.iter().find(|o|o.id=="flow").unwrap().planning.clone();
        assert_eq!(original.as_ref().unwrap().flow.as_ref().unwrap().steps[0].choices[0].effects[0].operand.value,"2");
        let target=fresh_id();store.project_mutate(&command(&target,RecordChange::ImportProject{bundle,name:"flow copy".into()}),&actor()).unwrap();
        drop(store);let store=Store::open(&path).unwrap();
        assert_eq!(store.project_objects(&target).unwrap().iter().find(|o|o.id=="flow").unwrap().planning,original);
        cleanup(store,path);
    }

    #[test]
    fn planning_lock_guards_edits_archive_restore_and_survives_portability() {
        let (mut store,path)=temp_store("planning-lock");
        let project=fresh_id(); create_project(&mut store,&project);
        let original=serde_json::json!({"scopes":["R0"],"body":"keep this design","locked":true});
        store.project_mutate(&command(&project,planning_change("system",0,"system",original.clone())),&actor()).unwrap();
        let before=store.project_export(&project).unwrap();
        for change in [
            planning_change("system",1,"system",serde_json::json!({"scopes":["R0"],"body":"","locked":false})),
            RecordChange::PutObject{id:"system".into(),expected_revision:1,name:"erase".into(),kind:"system".into(),archived:true,planning:None},
            RecordChange::RestoreObject{id:"system".into(),expected_revision:1,restore_revision:1},
        ] {
            assert!(store.project_mutate(&command(&project,change),&actor()).unwrap_err().contains("已锁定"));
        }
        let after=store.project_export(&project).unwrap();
        assert_eq!(before.objects,after.objects); assert_eq!(before.history,after.history);
        let unlock=command(&project,RecordChange::SetObjectLock{id:"system".into(),expected_revision:1,locked:false});
        let unlocked=store.project_mutate(&unlock,&actor()).unwrap().object.unwrap();
        assert!(!unlocked.planning.as_ref().unwrap().locked); assert_eq!(unlocked.revision,2);
        assert!(store.project_mutate(&unlock,&actor()).unwrap().replayed);
        assert!(store.project_mutate(&command(&project,RecordChange::SetObjectLock{id:"system".into(),expected_revision:1,locked:true}),&actor()).is_err());
        let mut edited=original; edited["body"]="intentional change".into();
        store.project_mutate(&command(&project,planning_change("system",2,"system",edited)),&actor()).unwrap();
        store.project_mutate(&command(&project,RecordChange::SetObjectLock{id:"system".into(),expected_revision:3,locked:false}),&actor()).unwrap();
        let restored=store.project_mutate(&command(&project,RecordChange::RestoreObject{id:"system".into(),expected_revision:4,restore_revision:1}),&actor()).unwrap().object.unwrap();
        assert_eq!(restored.planning.as_ref().unwrap().body,"keep this design");
        assert!(restored.planning.as_ref().unwrap().locked);
        let bundle=store.project_export(&project).unwrap();
        assert_eq!(bundle.history.iter().filter(|entry|entry.operation=="set_object_lock").count(),2);
        let imported_id=fresh_id();
        store.project_mutate(&command(&imported_id,RecordChange::ImportProject{bundle:bundle.clone(),name:"lock copy".into()}),&actor()).unwrap();
        drop(store); let mut store=Store::open(&path).unwrap();
        for id in [&project,&imported_id] {
            let snapshot=store.project_export(id).unwrap();
            assert!(snapshot.objects[0].planning.as_ref().unwrap().locked);
            assert_eq!(snapshot.objects[0].planning,bundle.objects[0].planning);
            assert!(store.project_mutate(&command(id,RecordChange::PutObject{id:"system".into(),expected_revision:5,name:"accident".into(),kind:"system".into(),archived:false,planning:None}),&actor()).is_err());
        }
        cleanup(store,path);
    }

    #[test]
    fn planning_shared_values_overrides_conflicts_restore_and_portability() {
        let (mut store,path)=temp_store("planning");
        let project=fresh_id(); create_project(&mut store,&project);
        let parameter=serde_json::json!({"scopes":["R0","R1"],"parameter":{"value":"10","min":"0","max":"100","unit":"points","variants":[{"label":"gentle","value":"8","reason":"fixture"}]},"references":[{"label":"spec","uri":"https://example.test/planning","version":"v1"}]});
        let create=command(&project,planning_change("reward",0,"parameter",parameter.clone()));
        store.project_mutate(&create,&actor()).unwrap();
        assert!(store.project_mutate(&create,&actor()).unwrap().replayed);
        for (id,local) in [("one",serde_json::Value::Null),("two",serde_json::json!({"value":"5","reason":"intro"}))] {
            store.project_mutate(&command(&project,planning_change(id,0,"content",serde_json::json!({"scopes":["R0"],"links":[{"target_id":"reward","relation":"uses","local":local}]}))),&actor()).unwrap();
        }
        let mut changed=parameter.clone(); changed["parameter"]["value"]="20".into(); changed["references"]=serde_json::json!([]);
        let update=command(&project,planning_change("reward",1,"parameter",changed.clone()));
        store.project_mutate(&update,&actor()).unwrap();
        assert!(store.project_mutate(&command(&project,planning_change("reward",1,"parameter",changed.clone())),&actor()).is_err());
        let mut invalid=changed.clone(); invalid["parameter"]["min"]="6".into();
        assert!(store.project_mutate(&command(&project,planning_change("reward",2,"parameter",invalid)),&actor()).is_err());
        for fields in [
            serde_json::json!({"scopes":["R0"],"links":[{"target_id":"absent","relation":"uses"}]}),
            serde_json::json!({"scopes":["R3"]}),
            serde_json::json!({"scopes":["R0"],"parameter":{"value":"NaN"}}),
        ] { assert!(store.project_mutate(&command(&project,planning_change("invalid",0,"parameter",fields)),&actor()).is_err()); }
        // A legacy client can rename an object without erasing its planning payload.
        store.project_mutate(&command(&project,RecordChange::PutObject {id:"reward".into(),expected_revision:2,name:"renamed".into(),kind:"parameter".into(),archived:false,planning:None}),&actor()).unwrap();
        let all=store.project_objects(&project).unwrap();
        assert_eq!(all.iter().find(|o|o.id=="reward").unwrap().planning.as_ref().unwrap().parameter.as_ref().unwrap().value,"20");
        assert_eq!(all.iter().find(|o|o.id=="two").unwrap().planning.as_ref().unwrap().links[0].local.as_ref().unwrap().value,"5");
        store.project_mutate(&command(&project,RecordChange::RestoreObject{id:"reward".into(),expected_revision:3,restore_revision:1}),&actor()).unwrap();
        let bundle=store.project_export(&project).unwrap();
        assert_eq!(bundle.version,2);
        assert_eq!(bundle.external_files.len(),1);
        assert_eq!(bundle.objects.iter().find(|o|o.id=="reward").unwrap().revision,4);
        let target=fresh_id();
        store.project_mutate(&command(&target,RecordChange::ImportProject{bundle:bundle.clone(),name:"copy".into()}),&actor()).unwrap();
        let imported=store.project_export(&target).unwrap();
        assert_eq!(imported.objects.len(),3);
        assert_eq!(imported.objects.iter().find(|o|o.id=="two").unwrap().planning,bundle.objects.iter().find(|o|o.id=="two").unwrap().planning);
        let mut invalid_v1=bundle; invalid_v1.version=1;
        assert!(store.project_mutate(&command(&fresh_id(),RecordChange::ImportProject{bundle:invalid_v1,name:"bad".into()}),&actor()).is_err());
        drop(store); let store=Store::open(&path).unwrap();
        assert_eq!(store.project_export(&target).unwrap().objects,imported.objects);
        cleanup(store,path);
    }

    #[test]
    fn planning_migration_preserves_legacy_rows_and_rejects_containment_cycles() {
        let (mut store,path)=temp_store("planning-migration"); let project=fresh_id();create_project(&mut store,&project);
        store.project_mutate(&command(&project,RecordChange::PutObject{id:"legacy".into(),expected_revision:0,name:"legacy".into(),kind:"module".into(),archived:false,planning:None}),&actor()).unwrap();
        let before=store.project_export(&project).unwrap(); drop(store);
        let conn=Connection::open(&path).unwrap();
        conn.execute_batch("ALTER TABLE spellcast_project_objects DROP COLUMN planning_json; UPDATE spellcast_project_schema_version SET schema_version=2;").unwrap();drop(conn);
        let mut store=Store::open(&path).unwrap();
        let after=store.project_export(&project).unwrap(); assert_eq!(before.objects,after.objects);assert_eq!(before.history,after.history);assert_eq!(after.version,1);
        store.project_mutate(&command(&project,planning_change("system-a",0,"system",serde_json::json!({"scopes":["R0"]}))),&actor()).unwrap();
        store.project_mutate(&command(&project,planning_change("system-b",0,"system",serde_json::json!({"scopes":["R0"],"links":[{"target_id":"system-a","relation":"belongs_to"}]}))),&actor()).unwrap();
        assert!(store.project_mutate(&command(&project,planning_change("system-a",1,"system",serde_json::json!({"scopes":["R0"],"links":[{"target_id":"system-b","relation":"belongs_to"}]}))),&actor()).is_err());
        let other=fresh_id();create_project(&mut store,&other);
        assert!(store.project_mutate(&command(&other,planning_change("foreign",0,"content",serde_json::json!({"scopes":["R0"],"links":[{"target_id":"system-a","relation":"uses"}]}))),&actor()).is_err());
        cleanup(store,path);
    }

    #[test]
    fn creates_updates_restores_and_reopens_complete_record_history() {
        let (mut store, path) = temp_store("history");
        let project_id = fresh_id();
        create_project(&mut store, &project_id);
        let object_id = fresh_id();
        store
            .project_mutate(
                &command(
                    &project_id,
                    RecordChange::PutObject {
                        id: object_id.clone(),
                        expected_revision: 0,
                        name: "Storage".into(),
                        kind: "module".into(),
                        archived: false,
                        planning: None,
                    },
                ),
                &actor(),
            )
            .unwrap();
        let record_id = fresh_id();
        let initial = fields(Some(object_id));
        let created = store
            .project_mutate(
                &command(
                    &project_id,
                    RecordChange::PutRecord {
                        id: record_id.clone(),
                        expected_revision: 0,
                        fields: initial.clone(),
                    },
                ),
                &actor(),
            )
            .unwrap()
            .record
            .unwrap();
        assert_eq!(created.revision, 1);

        let mut completed = initial.clone();
        completed.status = RecordStatus::Done;
        completed.result = "Bounded result".into();
        let updated = store
            .project_mutate(
                &command(
                    &project_id,
                    RecordChange::PutRecord {
                        id: record_id.clone(),
                        expected_revision: 1,
                        fields: completed,
                    },
                ),
                &actor(),
            )
            .unwrap()
            .record
            .unwrap();
        assert_eq!(updated.revision, 2);
        let archived = store
            .project_mutate(
                &command(
                    &project_id,
                    RecordChange::ArchiveRecord {
                        id: record_id.clone(),
                        expected_revision: 2,
                        archived: true,
                    },
                ),
                &actor(),
            )
            .unwrap()
            .record
            .unwrap();
        assert!(archived.archived);
        let restored = store
            .project_mutate(
                &command(
                    &project_id,
                    RecordChange::RestoreRecord {
                        id: record_id.clone(),
                        expected_revision: 3,
                        restore_revision: 1,
                    },
                ),
                &actor(),
            )
            .unwrap()
            .record
            .unwrap();
        assert_eq!(restored.revision, 4);
        assert!(!restored.archived);
        assert_eq!(restored.fields.result, "");
        let history = store
            .project_history(&project_id, "record", &record_id)
            .unwrap();
        assert_eq!(
            history
                .iter()
                .map(|entry| entry.revision)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert_eq!(history[1].snapshot["result"], "Bounded result");

        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.project_record(&project_id, &record_id).unwrap(),
            restored
        );
        cleanup(reopened, path);
    }

    #[test]
    fn receipt_replay_refuses_changed_body_actor_and_stale_revision() {
        let (mut store, path) = temp_store("receipt");
        let project_id = fresh_id();
        let first = command(
            &project_id,
            RecordChange::CreateProject {
                name: "Receipt project".into(),
                aliases: Vec::new(),
            },
        );
        let created = store.project_mutate(&first, &actor()).unwrap();
        assert!(!created.replayed);
        assert!(store.project_mutate(&first, &actor()).unwrap().replayed);

        let mut changed_body = first.clone();
        changed_body.change = RecordChange::CreateProject {
            name: "Changed body".into(),
            aliases: Vec::new(),
        };
        assert!(store.project_mutate(&changed_body, &actor()).is_err());
        let mut changed_actor = actor();
        changed_actor.label = "Another actor".into();
        assert!(store.project_mutate(&first, &changed_actor).is_err());

        let update = command(
            &project_id,
            RecordChange::UpdateProject {
                expected_revision: 1,
                name: "Revision two".into(),
                aliases: Vec::new(),
                archived: false,
            },
        );
        store.project_mutate(&update, &actor()).unwrap();
        let stale = command(
            &project_id,
            RecordChange::UpdateProject {
                expected_revision: 1,
                name: "Stale".into(),
                aliases: Vec::new(),
                archived: false,
            },
        );
        assert!(store.project_mutate(&stale, &actor()).is_err());
        cleanup(store, path);
    }

    #[test]
    fn a_history_write_failure_rolls_back_current_row_and_receipt() {
        let (mut store, path) = temp_store("rollback");
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_project_history
                 BEFORE INSERT ON spellcast_project_history
                 BEGIN SELECT RAISE(ABORT, 'forced history failure'); END;",
            )
            .unwrap();
        let project_id = fresh_id();
        let command = command(
            &project_id,
            RecordChange::CreateProject {
                name: "Must rollback".into(),
                aliases: Vec::new(),
            },
        );
        assert!(store.project_mutate(&command, &actor()).is_err());
        assert!(store.project_get(&project_id).is_err());
        let receipts: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM spellcast_project_request_receipts WHERE request_id = ?1",
                [&command.request_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(receipts, 0);
        cleanup(store, path);
    }

    #[test]
    fn future_project_schema_is_rejected_without_opening_the_store() {
        let (store, path) = temp_store("future-schema");
        drop(store);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE spellcast_project_schema_version SET schema_version = ?1 WHERE id = 1",
                [PROJECT_SCHEMA_VERSION + 1],
            )
            .unwrap();
        drop(connection);
        let error = match Store::open(&path) {
            Ok(store) => {
                drop(store);
                panic!("future project schema unexpectedly opened");
            }
            Err(error) => error,
        };
        assert!(error.contains("项目记录库版本"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn export_import_remaps_project_and_keeps_historical_external_links() {
        let (mut store, path) = temp_store("portable");
        let source_id = fresh_id();
        let source = create_project(&mut store, &source_id);
        let object_id = fresh_id();
        store
            .project_mutate(
                &command(
                    &source_id,
                    RecordChange::PutObject {
                        id: object_id.clone(),
                        expected_revision: 0,
                        name: "Feature".into(),
                        kind: "feature".into(),
                        archived: false,
                        planning: None,
                    },
                ),
                &actor(),
            )
            .unwrap();
        let record_id = fresh_id();
        let mut with_link = fields(Some(object_id.clone()));
        with_link.references.push(SourceReference {
            label: "Design note".into(),
            uri: "https://example.test/design-v1".into(),
            version: "v1".into(),
        });
        store
            .project_mutate(
                &command(
                    &source_id,
                    RecordChange::PutRecord {
                        id: record_id.clone(),
                        expected_revision: 0,
                        fields: with_link.clone(),
                    },
                ),
                &actor(),
            )
            .unwrap();
        with_link.references.clear();
        store
            .project_mutate(
                &command(
                    &source_id,
                    RecordChange::PutRecord {
                        id: record_id.clone(),
                        expected_revision: 1,
                        fields: with_link,
                    },
                ),
                &actor(),
            )
            .unwrap();
        let bundle = store.project_export(&source_id).unwrap();
        assert_eq!(bundle.external_files.len(), 1);
        assert_eq!(
            bundle.external_files[0].uri,
            "https://example.test/design-v1"
        );
        assert!(!bundle.external_files[0].original_included);

        let mut malformed = bundle.clone();
        let historical_record = malformed
            .history
            .iter_mut()
            .find(|entry| entry.kind == RecordHistoryKind::Record && entry.revision == 1)
            .unwrap();
        historical_record.snapshot["object_id"] = serde_json::Value::String("not-in-bundle".into());
        let rejected_target = fresh_id();
        assert!(store
            .project_mutate(
                &command(
                    &rejected_target,
                    RecordChange::ImportProject {
                        bundle: malformed,
                        name: "Rejected import".into(),
                    },
                ),
                &actor(),
            )
            .is_err());
        assert!(store.project_get(&rejected_target).is_err());

        let target_id = fresh_id();
        let imported = store
            .project_mutate(
                &command(
                    &target_id,
                    RecordChange::ImportProject {
                        bundle: bundle.clone(),
                        name: "Imported copy".into(),
                    },
                ),
                &actor(),
            )
            .unwrap()
            .project
            .unwrap();
        assert_eq!(
            imported.imported_from,
            Some(ProjectImportProvenance {
                project_id: source.id,
                revision: source.revision,
            })
        );
        let target = store.project_export(&target_id).unwrap();
        assert_eq!(target.records[0].id, record_id);
        assert_eq!(target.records[0].project_id, target_id);
        assert_eq!(target.external_files, bundle.external_files);
        assert!(target.history.iter().any(|entry| {
            entry.kind == RecordHistoryKind::Record
                && entry.id == target.records[0].id
                && entry.snapshot["project_id"] == target_id
        }));
        assert_eq!(target.project.revision, bundle.project.revision + 1);
        cleanup(store, path);
    }
}

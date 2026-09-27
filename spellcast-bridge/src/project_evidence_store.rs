//! Candidates, immutable trials and adoptions. A child of the record store so every write shares
//! its transaction, request receipt, validation and history helpers.

use super::*;
use crate::project_trials::{
    parameter_definition, trial_digest, trial_summary, validate_adoption, validate_candidate, validate_trial,
    CandidateAdoption, CandidateBase, FlowTrial, ParameterCandidate, TrialRun, TrialSummary, MAX_TRIAL_EVIDENCE,
};

const MAX_CANDIDATES_PER_PARAMETER: i64 = 64;
const MAX_PROJECT_TRIALS: i64 = 2_000;
const MAX_IMPORT_CANDIDATES: usize = 4_000;
const MAX_IMPORT_ADOPTIONS: usize = 4_000;

pub(super) fn init_schema(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS spellcast_project_candidates (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                parameter_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                archived INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(project_id, id)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_candidates_parameter_idx
                ON spellcast_project_candidates(project_id, parameter_id);
            CREATE TABLE IF NOT EXISTS spellcast_project_trials (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                flow_id TEXT NOT NULL,
                digest TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(project_id, id)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_trials_flow_idx
                ON spellcast_project_trials(project_id, flow_id, created_at_ms);
            CREATE UNIQUE INDEX IF NOT EXISTS spellcast_project_trials_digest_idx
                ON spellcast_project_trials(project_id, digest);
            CREATE TABLE IF NOT EXISTS spellcast_project_adoptions (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                parameter_id TEXT NOT NULL,
                at_ms INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(project_id, id)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_adoptions_parameter_idx
                ON spellcast_project_adoptions(project_id, parameter_id, at_ms);",
        )
        .map_err(|error| format!("创建候选与试走表失败：{error}"))
}

fn decode<T: DeserializeOwned>(json: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|error| format!("{label}数据损坏：{error}"))
}

fn encode<T: Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("序列化{label}失败：{error}"))
}

fn stored_candidate(project: &str, id: &str, json: &str) -> Result<ParameterCandidate, String> {
    let candidate: ParameterCandidate = decode(json, "数值候选")?;
    validate_candidate(&candidate)?;
    if candidate.project_id != project || candidate.id != id { return Err("数值候选身份与存储位置不一致。".into()); }
    Ok(candidate)
}

pub(super) fn read_candidate(connection: &Connection, project: &str, id: &str) -> Result<Option<ParameterCandidate>, String> {
    let json: Option<String> = connection
        .query_row("SELECT value_json FROM spellcast_project_candidates WHERE project_id = ?1 AND id = ?2", params![project, id], |row| row.get(0))
        .optional().map_err(|error| format!("读取数值候选失败：{error}"))?;
    json.map(|json| stored_candidate(project, id, &json)).transpose()
}

pub(super) fn read_candidates(connection: &Connection, project: &str) -> Result<Vec<ParameterCandidate>, String> {
    let mut statement = connection
        .prepare("SELECT id, value_json FROM spellcast_project_candidates WHERE project_id = ?1 ORDER BY parameter_id ASC, id ASC")
        .map_err(|error| format!("准备候选列表失败：{error}"))?;
    let rows = statement.query_map([project], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("读取候选列表失败：{error}"))?;
    let mut candidates = Vec::new();
    for row in rows {
        let (id, json) = row.map_err(|error| format!("读取候选行失败：{error}"))?;
        candidates.push(stored_candidate(project, &id, &json)?);
    }
    candidates.sort_by(|a, b| a.parameter_id.cmp(&b.parameter_id).then(a.created_at_ms.cmp(&b.created_at_ms)).then(a.id.cmp(&b.id)));
    Ok(candidates)
}

fn upsert_candidate(transaction: &Transaction<'_>, candidate: &ParameterCandidate) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO spellcast_project_candidates (project_id, id, parameter_id, revision, archived, value_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(project_id, id) DO UPDATE SET parameter_id = excluded.parameter_id,
                revision = excluded.revision, archived = excluded.archived, value_json = excluded.value_json",
            params![candidate.project_id, candidate.id, candidate.parameter_id, to_db_u64(candidate.revision, "候选 revision")?,
                to_db_bool(candidate.archived), encode(candidate, "数值候选")?],
        )
        .map_err(|error| format!("写入数值候选失败：{error}"))?;
    Ok(())
}

fn stored_trial(project: &str, id: &str, json: &str, full: bool) -> Result<FlowTrial, String> {
    let trial: FlowTrial = decode(json, "试走记录")?;
    if full { validate_trial(&trial)?; }
    if trial.project_id != project || trial.id != id { return Err("试走记录身份与存储位置不一致。".into()); }
    Ok(trial)
}

pub(super) fn read_trial(connection: &Connection, project: &str, id: &str) -> Result<Option<FlowTrial>, String> {
    let json: Option<String> = connection
        .query_row("SELECT value_json FROM spellcast_project_trials WHERE project_id = ?1 AND id = ?2", params![project, id], |row| row.get(0))
        .optional().map_err(|error| format!("读取试走记录失败：{error}"))?;
    json.map(|json| stored_trial(project, id, &json, true)).transpose()
}

fn trial_by_digest(connection: &Connection, project: &str, digest: &str) -> Result<Option<FlowTrial>, String> {
    let row: Option<(String, String)> = connection
        .query_row("SELECT id, value_json FROM spellcast_project_trials WHERE project_id = ?1 AND digest = ?2", params![project, digest],
            |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map_err(|error| format!("查找相同试走失败：{error}"))?;
    row.map(|(id, json)| stored_trial(project, &id, &json, true)).transpose()
}

/// Full validation is used for export and single reads; list summaries only need identity.
pub(super) fn read_trials(connection: &Connection, project: &str, full: bool) -> Result<Vec<FlowTrial>, String> {
    let mut statement = connection
        .prepare("SELECT id, value_json FROM spellcast_project_trials WHERE project_id = ?1 ORDER BY created_at_ms ASC, rowid ASC")
        .map_err(|error| format!("准备试走列表失败：{error}"))?;
    let rows = statement.query_map([project], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("读取试走列表失败：{error}"))?;
    let mut trials = Vec::new();
    for row in rows {
        let (id, json) = row.map_err(|error| format!("读取试走行失败：{error}"))?;
        trials.push(stored_trial(project, &id, &json, full)?);
    }
    Ok(trials)
}

fn insert_trial(transaction: &Transaction<'_>, trial: &FlowTrial) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO spellcast_project_trials (project_id, id, flow_id, digest, created_at_ms, value_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![trial.project_id, trial.id, trial.flow_id, trial.digest, to_db_u64(trial.created_at_ms, "试走时间")?, encode(trial, "试走记录")?],
        )
        .map_err(|error| format!("写入试走记录失败：{error}"))?;
    Ok(())
}

fn stored_adoption(project: &str, id: &str, json: &str) -> Result<CandidateAdoption, String> {
    let adoption: CandidateAdoption = decode(json, "采用记录")?;
    validate_adoption(&adoption)?;
    if adoption.project_id != project || adoption.id != id { return Err("采用记录身份与存储位置不一致。".into()); }
    Ok(adoption)
}

pub(super) fn read_adoptions(connection: &Connection, project: &str) -> Result<Vec<CandidateAdoption>, String> {
    let mut statement = connection
        .prepare("SELECT id, value_json FROM spellcast_project_adoptions WHERE project_id = ?1 ORDER BY at_ms ASC, id ASC")
        .map_err(|error| format!("准备采用记录失败：{error}"))?;
    let rows = statement.query_map([project], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("读取采用记录失败：{error}"))?;
    let mut adoptions = Vec::new();
    for row in rows {
        let (id, json) = row.map_err(|error| format!("读取采用记录行失败：{error}"))?;
        adoptions.push(stored_adoption(project, &id, &json)?);
    }
    Ok(adoptions)
}

fn insert_adoption(transaction: &Transaction<'_>, adoption: &CandidateAdoption) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO spellcast_project_adoptions (project_id, id, parameter_id, at_ms, value_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![adoption.project_id, adoption.id, adoption.parameter_id, to_db_u64(adoption.at_ms, "采用时间")?, encode(adoption, "采用记录")?],
        )
        .map_err(|error| format!("写入采用记录失败：{error}"))?;
    Ok(())
}

fn count(connection: &Connection, sql: &str, parameters: &[&dyn rusqlite::ToSql]) -> Result<i64, String> {
    connection.query_row(sql, parameters, |row| row.get(0)).map_err(|error| format!("统计项目数据失败：{error}"))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn put_candidate(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    parameter_id: &str,
    label: &str,
    value: &str,
    reason: &str,
    base_revision: u64,
    archived: bool,
    from_variant: Option<&String>,
    now: u64,
) -> Result<RecordMutationResult, String> {
    let project = &command.project_id;
    require_project(transaction, project)?;
    validate_local_id("候选 id", id)?;
    let parameter = read_object(transaction, project, parameter_id)?.ok_or_else(|| format!("找不到数值参数 {parameter_id}。"))?;
    let current_base = CandidateBase::of(&parameter)?;
    let previous = read_candidate(transaction, project, id)?;
    let (revision, created_at_ms, base, from_variant) = match &previous {
        None if expected_revision == 0 => {
            if base_revision != parameter.revision {
                return Err(format!("数值「{}」已更新到版本 {}，请刷新后基于最新版本建立候选。", parameter.name, parameter.revision));
            }
            if parameter.archived { return Err("参数已归档，不能新建候选。".into()); }
            if let Some(label) = from_variant {
                if !parameter_definition(&parameter)?.variants.iter().any(|variant| &variant.label == label) {
                    return Err("要转换的旧候选方案在当前参数中不存在。".into());
                }
            }
            let existing = count(transaction, "SELECT COUNT(*) FROM spellcast_project_candidates WHERE project_id = ?1 AND parameter_id = ?2", params![project, parameter_id])?;
            if existing >= MAX_CANDIDATES_PER_PARAMETER { return Err(format!("一个参数最多保留 {MAX_CANDIDATES_PER_PARAMETER} 个独立候选。")); }
            (1, now, current_base, from_variant.cloned())
        }
        None => return Err(format!("候选 {id} 尚不存在，创建时 expected_revision 必须是 0。")),
        Some(_) if expected_revision == 0 => return Err(format!("候选 {id} 已存在，更新需要当前 revision。")),
        Some(current) => {
            require_expected_revision("候选", current.revision, expected_revision)?;
            if current.parameter_id != parameter_id { return Err("候选不能改为另一个参数的候选。".into()); }
            if from_variant.is_some() && from_variant != current.from_variant.as_ref() { return Err("候选的旧方案来源不能修改。".into()); }
            let base = if base_revision == current.base.revision { current.base.clone() }
                else if base_revision == parameter.revision { current_base }
                else { return Err("候选基准只能保留原版本，或明确更新为参数当前版本。".into()); };
            (next_revision(current.revision)?, current.created_at_ms, base, current.from_variant.clone())
        }
    };
    let candidate = ParameterCandidate {
        id: id.into(), project_id: project.clone(), parameter_id: parameter_id.into(), label: label.trim().into(),
        value: value.trim().into(), reason: reason.into(), base, from_variant, revision, archived,
        created_at_ms, updated_at_ms: now, updated_by: actor.clone(),
    };
    validate_candidate(&candidate)?;
    upsert_candidate(transaction, &candidate)?;
    append_history(transaction, project, RecordHistoryKind::Candidate, id, revision, now, actor, "put_candidate", &command.request_id,
        serde_json::to_value(&candidate).map_err(|error| format!("序列化候选历史快照失败：{error}"))?)?;
    Ok(RecordMutationResult { candidate: Some(candidate), ..Default::default() })
}

fn same_snapshot<T: Serialize>(saved: &serde_json::Value, snapshot: &T) -> Result<bool, String> {
    Ok(saved == &serde_json::to_value(snapshot).map_err(|error| format!("序列化来源快照失败：{error}"))?)
}

/// A trial may only freeze revisions that the project actually saved.
fn verify_saved_snapshots(
    run: &TrialRun,
    saved: &dyn Fn(RecordHistoryKind, &str, u64) -> Result<Option<serde_json::Value>, String>,
) -> Result<(), String> {
    for object in std::iter::once(&run.source).chain(&run.dependencies) {
        let found = saved(RecordHistoryKind::Object, &object.id, object.revision)?
            .ok_or_else(|| format!("试走引用的「{}」版本 {} 不在项目历史中。", object.name, object.revision))?;
        if !same_snapshot(&found, object)? {
            return Err(format!("试走引用的「{}」版本 {} 与项目保存的版本不一致。", object.name, object.revision));
        }
    }
    for candidate in &run.candidates {
        let found = saved(RecordHistoryKind::Candidate, &candidate.id, candidate.revision)?
            .ok_or_else(|| format!("试走选用的候选「{}」版本 {} 不在项目历史中。", candidate.label, candidate.revision))?;
        if !same_snapshot(&found, candidate)? {
            return Err(format!("试走选用的候选「{}」版本 {} 与项目保存的版本不一致。", candidate.label, candidate.revision));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn save_trial(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    label: &str,
    origin: &str,
    parent_trial_id: Option<&String>,
    run: &TrialRun,
    now: u64,
) -> Result<RecordMutationResult, String> {
    let project = &command.project_id;
    require_project(transaction, project)?;
    validate_local_id("试走 id", id)?;
    if run.source.project_id != *project { return Err("试走来源不属于这个项目。".into()); }
    crate::project_trials::validate_trial_run(run)?;
    let flow = read_object(transaction, project, &run.source.id)?.ok_or("试走来源流程不存在于本项目。")?;
    if flow.kind != "flow" { return Err("试走来源必须是玩家流程。".into()); }
    verify_saved_snapshots(run, &|kind, entity, revision| {
        Ok(read_history_revision(transaction, project, kind, entity, revision)?.map(|entry| entry.snapshot))
    })?;
    for anchor in &run.anchors {
        if read_object(transaction, project, &anchor.object_id)?.is_none() { return Err("试走记录的关联设计不属于本项目。".into()); }
    }
    if let Some(replay) = &run.replay {
        let base = read_trial(transaction, project, &replay.base_trial_id)?.ok_or("重放的基准试走不存在于本项目。")?;
        if base.flow_id != run.source.id || base.run.id != replay.base_run_id { return Err("重放基准与本次流程不一致。".into()); }
    }
    if let Some(parent) = parent_trial_id {
        let parent = read_trial(transaction, project, parent)?.ok_or("上级试走不存在于本项目。")?;
        if parent.flow_id != run.source.id { return Err("上级试走属于另一个流程。".into()); }
    }
    let digest = trial_digest(run)?;
    if let Some(existing) = trial_by_digest(transaction, project, &digest)? {
        return Ok(RecordMutationResult { trial: Some(trial_summary(&existing)), deduplicated: true, ..Default::default() });
    }
    if read_trial(transaction, project, id)?.is_some() {
        return Err(format!("试走 {id} 已存在且内容不同；已保存的试走不能被覆盖。"));
    }
    if count(transaction, "SELECT COUNT(*) FROM spellcast_project_trials WHERE project_id = ?1", params![project])? >= MAX_PROJECT_TRIALS {
        return Err(format!("一个项目最多保存 {MAX_PROJECT_TRIALS} 条试走。"));
    }
    let trial = FlowTrial {
        id: id.into(), project_id: project.clone(), flow_id: run.source.id.clone(), flow_revision: run.source.revision,
        label: label.trim().into(), origin: origin.into(), parent_trial_id: parent_trial_id.cloned(), digest,
        created_at_ms: now, created_by: actor.clone(), run: run.clone(),
    };
    validate_trial(&trial)?;
    insert_trial(transaction, &trial)?;
    Ok(RecordMutationResult { trial: Some(trial_summary(&trial)), ..Default::default() })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn adopt_candidate(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    adoption_id: &str,
    parameter_id: &str,
    expected_revision: u64,
    candidate_id: &str,
    candidate_revision: u64,
    trial_ids: &[String],
    reason: &str,
    lock_after: bool,
    now: u64,
) -> Result<RecordMutationResult, String> {
    let project = &command.project_id;
    require_project(transaction, project)?;
    validate_local_id("采用记录 id", adoption_id)?;
    let exists = count(transaction, "SELECT COUNT(*) FROM spellcast_project_adoptions WHERE project_id = ?1 AND id = ?2", params![project, adoption_id])?;
    if exists != 0 { return Err(format!("采用记录 {adoption_id} 已存在。")); }
    let current = read_object(transaction, project, parameter_id)?.ok_or_else(|| format!("找不到数值参数 {parameter_id}。"))?;
    require_expected_revision("数值参数", current.revision, expected_revision)?;
    require_unlocked_object(&current)?;
    if current.archived { return Err("参数已归档，不能采用候选。".into()); }
    let base_now = CandidateBase::of(&current)?;
    let candidate = read_candidate(transaction, project, candidate_id)?.ok_or_else(|| format!("找不到候选 {candidate_id}。"))?;
    if candidate.parameter_id != parameter_id { return Err("这个候选不属于要修改的参数。".into()); }
    require_expected_revision("候选", candidate.revision, candidate_revision)?;
    if candidate.archived { return Err("候选已归档，不能采用。".into()); }
    if !candidate.base.same_definition(&base_now) {
        return Err(format!(
            "候选「{}」基于参数版本 {}（{}），当前参数是版本 {}（{}）。请先核对差异，并明确以当前参数为新基准更新候选。",
            candidate.label, candidate.base.revision, candidate.base.describe(), current.revision, base_now.describe()));
    }
    if reason.trim().is_empty() { return Err("采用需要填写理由。".into()); }
    if trial_ids.len() > MAX_TRIAL_EVIDENCE { return Err(format!("采用依据最多 {MAX_TRIAL_EVIDENCE} 条试走。")); }
    for trial_id in trial_ids {
        let trial = read_trial(transaction, project, trial_id)?.ok_or_else(|| format!("采用依据中的试走 {trial_id} 不存在。"))?;
        if !trial.run.dependencies.iter().any(|dependency| dependency.id == parameter_id) {
            return Err(format!("试走 {trial_id} 没有使用这个参数，不能作为采用依据。"));
        }
    }
    let value_before = parameter_definition(&current)?.value.clone();
    let mut object = current.clone();
    let planning = object.planning.as_mut().ok_or("参数缺少规划内容。")?;
    planning.parameter.as_mut().ok_or("参数缺少数值定义。")?.value = candidate.value.clone();
    planning.locked = lock_after;
    object.revision = next_revision(current.revision)?;
    validate_object_in_project(transaction, &object)?;
    upsert_object(transaction, &object)?;
    append_history(transaction, project, RecordHistoryKind::Object, parameter_id, object.revision, now, actor, "adopt_candidate", &command.request_id,
        serde_json::to_value(&object).map_err(|error| format!("序列化参数历史快照失败：{error}"))?)?;
    let adoption = CandidateAdoption {
        id: adoption_id.into(), project_id: project.clone(), parameter_id: parameter_id.into(),
        parameter_revision_before: current.revision, parameter_revision_after: object.revision,
        value_before, value_after: candidate.value.clone(), candidate, trial_ids: trial_ids.to_vec(),
        reason: reason.trim().into(), at_ms: now, actor: actor.clone(), request_id: command.request_id.clone(),
    };
    validate_adoption(&adoption)?;
    insert_adoption(transaction, &adoption)?;
    Ok(RecordMutationResult { object: Some(object), adoption: Some(adoption), ..Default::default() })
}

fn has_anchors(value: &serde_json::Value) -> bool {
    value.get("planning").and_then(|planning| planning.get("anchors")).and_then(|anchors| anchors.as_array()).is_some_and(|items| !items.is_empty())
}

/// Version 3 carries flow anchors, candidates, trials or adoptions.
pub(super) fn needs_v3(bundle: &ProjectExport) -> bool {
    !bundle.candidates.is_empty() || !bundle.trials.is_empty() || !bundle.adoptions.is_empty()
        || bundle.objects.iter().any(|object| object.planning.as_ref().is_some_and(|planning| !planning.anchors.is_empty()))
        || bundle.history.iter().any(|entry| entry.kind == RecordHistoryKind::Object && has_anchors(&entry.snapshot))
}

pub(super) fn validate_import_evidence(bundle: &ProjectExport) -> Result<(), String> {
    let source = &bundle.project.id;
    if bundle.candidates.len() > MAX_IMPORT_CANDIDATES || bundle.trials.len() > MAX_PROJECT_TRIALS as usize || bundle.adoptions.len() > MAX_IMPORT_ADOPTIONS {
        return Err("导入包的候选、试走或采用记录超过上限。".into());
    }
    let objects: BTreeMap<&str, &DevelopmentObject> = bundle.objects.iter().map(|object| (object.id.as_str(), object)).collect();
    let saved: BTreeMap<(&str, &str, u64), &RecordHistory> = bundle.history.iter()
        .map(|entry| ((entry.kind.as_str(), entry.id.as_str(), entry.revision), entry)).collect();
    let lookup = |kind: RecordHistoryKind, id: &str, revision: u64| -> Result<Option<serde_json::Value>, String> {
        Ok(saved.get(&(kind.as_str(), id, revision)).map(|entry| entry.snapshot.clone()))
    };
    let mut candidates = BTreeMap::new();
    for candidate in &bundle.candidates {
        validate_candidate(candidate)?;
        if &candidate.project_id != source { return Err("导入候选的 project_id 与导入项目不一致。".into()); }
        if !objects.get(candidate.parameter_id.as_str()).is_some_and(|object| object.kind == "parameter") {
            return Err(format!("导入候选 {} 引用了不存在的数值参数。", candidate.id));
        }
        if candidates.insert(candidate.id.as_str(), candidate).is_some() { return Err(format!("导入包包含重复候选 {}。", candidate.id)); }
    }
    let mut trials = BTreeMap::new();
    let mut digests = BTreeSet::new();
    for trial in &bundle.trials {
        validate_trial(trial)?;
        if &trial.project_id != source { return Err("导入试走的 project_id 与导入项目不一致。".into()); }
        if !objects.get(trial.flow_id.as_str()).is_some_and(|object| object.kind == "flow") {
            return Err(format!("导入试走 {} 引用了不存在的流程。", trial.id));
        }
        verify_saved_snapshots(&trial.run, &lookup)?;
        if trial.run.anchors.iter().any(|anchor| !objects.contains_key(anchor.object_id.as_str())) {
            return Err(format!("导入试走 {} 的关联设计不在导出项目中。", trial.id));
        }
        if trials.insert(trial.id.as_str(), trial).is_some() || !digests.insert(trial.digest.as_str()) {
            return Err(format!("导入包包含重复试走 {}。", trial.id));
        }
    }
    for trial in &bundle.trials {
        if let Some(replay) = &trial.run.replay {
            let base = trials.get(replay.base_trial_id.as_str()).ok_or_else(|| format!("导入试走 {} 的重放基准不在导出项目中。", trial.id))?;
            if base.flow_id != trial.flow_id || base.run.id != replay.base_run_id { return Err(format!("导入试走 {} 的重放基准不一致。", trial.id)); }
        }
        if let Some(parent) = &trial.parent_trial_id {
            if !trials.get(parent.as_str()).is_some_and(|parent| parent.flow_id == trial.flow_id) {
                return Err(format!("导入试走 {} 的上级试走不一致。", trial.id));
            }
        }
    }
    let mut adoptions = BTreeSet::new();
    for adoption in &bundle.adoptions {
        validate_adoption(adoption)?;
        if &adoption.project_id != source { return Err("导入采用记录的 project_id 与导入项目不一致。".into()); }
        if !adoptions.insert(adoption.id.as_str()) { return Err(format!("导入包包含重复采用记录 {}。", adoption.id)); }
        if !candidates.contains_key(adoption.candidate.id.as_str()) { return Err(format!("采用记录 {} 的候选不在导出项目中。", adoption.id)); }
        if !lookup(RecordHistoryKind::Candidate, &adoption.candidate.id, adoption.candidate.revision)?
            .is_some_and(|snapshot| same_snapshot(&snapshot, &adoption.candidate).unwrap_or(false)) {
            return Err(format!("采用记录 {} 的候选版本与历史不一致。", adoption.id));
        }
        for trial_id in &adoption.trial_ids {
            let trial = trials.get(trial_id.as_str()).ok_or_else(|| format!("采用记录 {} 的试走依据不在导出项目中。", adoption.id))?;
            if !trial.run.dependencies.iter().any(|dependency| dependency.id == adoption.parameter_id) {
                return Err(format!("采用记录 {} 的试走依据没有使用该参数。", adoption.id));
            }
        }
        let value_at = |revision: u64| saved.get(&("object", adoption.parameter_id.as_str(), revision))
            .map(|entry| (entry.operation.as_str(), entry.snapshot.pointer("/planning/parameter/value").and_then(|value| value.as_str()).unwrap_or_default().to_string()));
        let before = value_at(adoption.parameter_revision_before);
        let after = value_at(adoption.parameter_revision_after);
        if !before.is_some_and(|(_, value)| value == adoption.value_before)
            || !after.is_some_and(|(operation, value)| operation == "adopt_candidate" && value == adoption.value_after) {
            return Err(format!("采用记录 {} 与参数历史不一致。", adoption.id));
        }
    }
    Ok(())
}

/// Called after objects and history were copied; remaps IDs and writes the evidence rows.
pub(super) fn import_evidence(transaction: &Transaction<'_>, bundle: &ProjectExport, target: &str) -> Result<(), String> {
    for imported in &bundle.candidates {
        let mut candidate = imported.clone();
        candidate.project_id = target.into();
        upsert_candidate(transaction, &candidate)?;
    }
    for imported in &bundle.trials {
        let mut trial = imported.clone();
        trial.project_id = target.into();
        trial.run.source.project_id = target.into();
        for dependency in &mut trial.run.dependencies { dependency.project_id = target.into(); }
        for candidate in &mut trial.run.candidates { candidate.project_id = target.into(); }
        if trial.digest != trial_digest(&trial.run)? { return Err("导入试走的内容摘要在迁移后不一致。".into()); }
        insert_trial(transaction, &trial)?;
    }
    for imported in &bundle.adoptions {
        let mut adoption = imported.clone();
        adoption.project_id = target.into();
        adoption.candidate.project_id = target.into();
        insert_adoption(transaction, &adoption)?;
    }
    Ok(())
}

impl Store {
    pub fn project_candidates(&self, project: &str) -> Result<Vec<ParameterCandidate>, String> {
        self.project_get(project)?;
        read_candidates(&self.connection, project)
    }

    /// Newest first. An empty flow filter lists every flow in the project.
    pub fn project_trials(&self, project: &str, flow_id: &str) -> Result<Vec<TrialSummary>, String> {
        self.project_get(project)?;
        let mut trials: Vec<TrialSummary> = read_trials(&self.connection, project, false)?.iter()
            .filter(|trial| flow_id.is_empty() || trial.flow_id == flow_id).map(trial_summary).collect();
        trials.reverse();
        Ok(trials)
    }

    pub fn project_trial(&self, project: &str, id: &str) -> Result<FlowTrial, String> {
        self.project_get(project)?;
        validate_local_id("试走 id", id)?;
        read_trial(&self.connection, project, id)?.ok_or_else(|| format!("找不到试走 {id}。"))
    }

    pub fn project_adoptions(&self, project: &str) -> Result<Vec<CandidateAdoption>, String> {
        self.project_get(project)?;
        read_adoptions(&self.connection, project)
    }
}

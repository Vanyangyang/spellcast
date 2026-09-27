//! Reviewable proposals. A child of the record store so every write shares its transaction,
//! request receipt and validation. Proposals are local review state: they are not exported, and
//! only a user decision copies an item into canonical objects or records.

use super::*;
use crate::project_proposals::{
    ProjectProposal, ProposalDecision, ProposalItem, ProposalItemInput, ProposalItemStatus, ProposalSubject,
    ProposalTarget, ProposedObject, MAX_PROPOSAL_ITEMS, PROPOSAL_BASIS,
};

const MAX_OPEN_PROPOSALS: i64 = 500;

pub(super) const AGENT_DESIGN_WRITE: &str = "Agent 不能直接修改规划设计（内容、规则、钩子、数值、流程、系统）或它们的确认与锁定。请用 op=put_proposal 提交带基线版本、来源与理由的提案，由用户在游戏开发工作区采纳。";

/// Created independently of the versioned record schema: older builds ignore these tables.
pub(super) fn init_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS spellcast_project_proposals (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                status TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(project_id, id)
            );
            CREATE INDEX IF NOT EXISTS spellcast_project_proposals_status_idx
                ON spellcast_project_proposals(project_id, status, updated_at_ms);
            CREATE TABLE IF NOT EXISTS spellcast_project_proposal_history (
                project_id TEXT NOT NULL,
                id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY(project_id, id, revision)
            );",
        )
        .map_err(|error| format!("创建提案表失败：{error}"))
}

fn decode_proposal(project: &str, id: &str, json: &str) -> Result<ProjectProposal, String> {
    let proposal: ProjectProposal = serde_json::from_str(json).map_err(|error| format!("提案数据损坏：{error}"))?;
    if proposal.project_id != project || proposal.id != id {
        return Err("提案身份与存储位置不一致。".into());
    }
    Ok(proposal)
}

pub(super) fn read_proposal(connection: &Connection, project: &str, id: &str) -> Result<Option<ProjectProposal>, String> {
    let json: Option<String> = connection
        .query_row("SELECT value_json FROM spellcast_project_proposals WHERE project_id = ?1 AND id = ?2", params![project, id], |row| row.get(0))
        .optional()
        .map_err(|error| format!("读取提案失败：{error}"))?;
    json.map(|json| decode_proposal(project, id, &json)).transpose()
}

pub(super) fn read_proposals(connection: &Connection, project: &str, include_closed: bool) -> Result<Vec<ProjectProposal>, String> {
    let mut statement = connection
        .prepare("SELECT id, value_json FROM spellcast_project_proposals WHERE project_id = ?1 AND (?2 OR status = 'open')
                  ORDER BY updated_at_ms DESC, id ASC LIMIT 1000")
        .map_err(|error| format!("准备提案列表失败：{error}"))?;
    let rows = statement
        .query_map(params![project, include_closed], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("读取提案列表失败：{error}"))?;
    let mut proposals = Vec::new();
    for row in rows {
        let (id, json) = row.map_err(|error| format!("读取提案行失败：{error}"))?;
        proposals.push(decode_proposal(project, &id, &json)?);
    }
    Ok(proposals)
}

fn write_proposal(transaction: &Transaction<'_>, proposal: &ProjectProposal) -> Result<(), String> {
    let json = serde_json::to_string(proposal).map_err(|error| format!("序列化提案失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO spellcast_project_proposals (project_id, id, revision, status, updated_at_ms, value_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(project_id, id) DO UPDATE SET revision = excluded.revision, status = excluded.status,
                updated_at_ms = excluded.updated_at_ms, value_json = excluded.value_json",
            params![proposal.project_id, proposal.id, to_db_u64(proposal.revision, "提案 revision")?, proposal.status,
                to_db_u64(proposal.updated_at_ms, "提案时间")?, json],
        )
        .map_err(|error| format!("写入提案失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO spellcast_project_proposal_history (project_id, id, revision, value_json) VALUES (?1, ?2, ?3, ?4)",
            params![proposal.project_id, proposal.id, to_db_u64(proposal.revision, "提案 revision")?, json],
        )
        .map_err(|error| format!("写入提案历史失败：{error}"))?;
    Ok(())
}

fn validate_subject(subject: &ProposalSubject) -> Result<(), String> {
    if !matches!(subject.scale.as_str(), "" | "overview" | "experience" | "object") {
        return Err("提案范围只能是 overview、experience 或 object。".into());
    }
    for (label, value) in [("Zone", &subject.zone_id), ("地点", &subject.location_id), ("对象类型", &subject.entity_kind), ("对象", &subject.entity_id)] {
        validate_bounded_text(label, value, MAX_ID_BYTES, false)?;
    }
    Ok(())
}

fn validate_references(label: &str, references: &[SourceReference]) -> Result<(), String> {
    if references.len() > MAX_REFERENCES {
        return Err(format!("{label}最多 {MAX_REFERENCES} 条来源。"));
    }
    for reference in references {
        validate_source_reference(reference)?;
    }
    Ok(())
}

fn object_link_targets(object: &ProposedObject) -> impl Iterator<Item = &String> {
    object.planning.links.iter().map(|link| &link.target_id).chain(object.planning.anchors.iter().map(|anchor| &anchor.flow_id))
}

/// Shape, source and base checks shared by authors and user revisions.
fn validate_item(connection: &Connection, project: &str, item: &ProposalItemInput, proposed: &BTreeSet<String>) -> Result<(), String> {
    validate_local_id("提案项 id", &item.id)?;
    validate_local_id("提案目标 id", &item.target_id)?;
    validate_free_text("提案理由", &item.reason)?;
    validate_free_text("提案边界", &item.boundaries)?;
    let basis: BTreeSet<_> = item.basis.iter().collect();
    if basis.len() != item.basis.len() || item.basis.iter().any(|value| !PROPOSAL_BASIS.contains(&value.as_str())) {
        return Err("提案依据只能是 config、design、code、inference，且不能重复；玩家或 Unity 验证不是提案依据。".into());
    }
    validate_references("提案项", &item.references)?;
    match item.target {
        ProposalTarget::Object => {
            let object = item.object.as_ref().ok_or("对象提案项需要完整的拟议对象（name、kind、planning）。")?;
            if item.record.is_some() {
                return Err("对象提案项不能同时包含事项。".into());
            }
            if object.planning.confirmed || object.planning.locked {
                return Err("提案不能自带确认或锁定；设计只在用户采纳时确认。".into());
            }
            validate_object(&DevelopmentObject {
                id: item.target_id.clone(), project_id: project.into(), name: object.name.clone(), kind: object.kind.clone(),
                revision: 1, archived: object.archived, planning: Some(object.planning.clone()),
            })?;
            let current = read_object(connection, project, &item.target_id)?;
            check_base("对象", &object.name, item.base_revision, current.as_ref().map(|value| value.revision))?;
            if let Some(current) = &current {
                if current.planning.as_ref().is_some_and(|planning| planning.sections.is_some()) && object.planning.sections.is_none() {
                    return Err(format!("「{}」已有内容片段；提案必须提供完整的 sections。", current.name));
                }
            }
            for target in object_link_targets(object) {
                if !proposed.contains(target) && read_object(connection, project, target)?.is_none() {
                    return Err(format!("「{}」关联的 {target} 既不在项目中，也不在本提案中。", object.name));
                }
            }
        }
        ProposalTarget::Record => {
            let fields = item.record.as_ref().ok_or("事项提案项需要完整的事项字段。")?;
            if item.object.is_some() {
                return Err("事项提案项不能同时包含规划对象。".into());
            }
            validate_record_fields(fields)?;
            if let Some(object_id) = &fields.object_id {
                if !proposed.contains(object_id) && read_object(connection, project, object_id)?.is_none() {
                    return Err(format!("事项引用的开发对象 {object_id} 不在项目或本提案中。"));
                }
            }
            let current = read_record(connection, project, &item.target_id)?;
            check_base("事项", &fields.title, item.base_revision, current.as_ref().map(|value| value.revision))?;
        }
    }
    Ok(())
}

fn check_base(label: &str, name: &str, base: u64, current: Option<u64>) -> Result<(), String> {
    match (base, current) {
        (0, None) => Ok(()),
        (0, Some(current)) => Err(format!("{label}「{name}」已存在（版本 {current}）；修改时请以当前版本为基准，避免覆盖。")),
        (_, None) => Err(format!("{label}「{name}」不存在；新建时 base_revision 应为 0。")),
        (base, Some(current)) if base != current => Err(format!(
            "{label}「{name}」已从提案基准版本 {base} 变为 {current}；为避免覆盖，没有写入。请基于当前版本重新提出。")),
        _ => Ok(()),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn put_proposal(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    title: &str,
    summary: &str,
    subject: &ProposalSubject,
    goal_id: Option<&String>,
    items: &[ProposalItemInput],
    references: &[SourceReference],
    boundaries: &str,
    now: u64,
) -> Result<RecordMutationResult, String> {
    let project = &command.project_id;
    if require_project(transaction, project)?.archived {
        return Err("项目已归档，不能提交提案。".into());
    }
    validate_local_id("提案 id", id)?;
    validate_name("提案标题", title)?;
    validate_free_text("提案摘要", summary)?;
    validate_free_text("提案边界", boundaries)?;
    validate_subject(subject)?;
    if let Some(goal) = goal_id {
        validate_local_id("目标 id", goal)?;
    }
    validate_references("提案", references)?;
    if items.is_empty() {
        return Err("提案至少需要一项具体改动。".into());
    }
    if items.len() > MAX_PROPOSAL_ITEMS {
        return Err(format!("一个提案最多 {MAX_PROPOSAL_ITEMS} 项。"));
    }
    let mut ids = BTreeSet::new();
    let mut targets = BTreeSet::new();
    for item in items {
        if !ids.insert(item.id.as_str()) {
            return Err(format!("提案项 id 重复：{}。", item.id));
        }
        if !targets.insert((item.target, item.target_id.clone())) {
            return Err(format!("同一提案不能对 {} 提出两项改动。", item.target_id));
        }
    }
    let proposed: BTreeSet<String> = items.iter().map(|item| item.target_id.clone()).collect();
    let previous = read_proposal(transaction, project, id)?;
    let decided: BTreeMap<String, ProposalItem> = previous
        .iter()
        .flat_map(|proposal| proposal.items.iter())
        .filter(|item| matches!(item.status, ProposalItemStatus::Adopted | ProposalItemStatus::Dismissed))
        .map(|item| (item.id.clone(), item.clone()))
        .collect();
    let mut next_items = Vec::new();
    for item in items {
        if let Some(existing) = decided.get(&item.id) {
            if existing.content() != *item {
                return Err(format!("提案项 {} 已被用户采纳或放弃，不能修改；请用新的 id 另提一项。", item.id));
            }
            next_items.push(existing.clone());
        } else {
            validate_item(transaction, project, item, &proposed)?;
            next_items.push(ProposalItem::from_input(item.clone()));
        }
    }
    for existing in decided.values() {
        if !items.iter().any(|item| item.id == existing.id) {
            next_items.push(existing.clone());
        }
    }
    let mut proposal = match previous {
        None if expected_revision == 0 => {
            let open: i64 = transaction
                .query_row("SELECT COUNT(*) FROM spellcast_project_proposals WHERE project_id = ?1 AND status = 'open'", params![project], |row| row.get(0))
                .map_err(|error| format!("统计提案失败：{error}"))?;
            if open >= MAX_OPEN_PROPOSALS {
                return Err(format!("一个项目最多保留 {MAX_OPEN_PROPOSALS} 个待审提案；请先处理已有提案。"));
            }
            ProjectProposal {
                id: id.into(), project_id: project.clone(), revision: 1, title: title.trim().into(), summary: summary.into(),
                subject: subject.clone(), goal_id: goal_id.cloned(), items: next_items, references: references.to_vec(),
                boundaries: boundaries.into(), status: "open".into(), created_at_ms: now, updated_at_ms: now,
                created_by: actor.clone(), updated_by: actor.clone(),
            }
        }
        None => return Err(format!("提案 {id} 尚不存在，创建时 expected_revision 必须是 0。")),
        Some(_) if expected_revision == 0 => return Err(format!("提案 {id} 已存在；修订时请提供当前 revision。")),
        Some(current) => {
            require_expected_revision("提案", current.revision, expected_revision)?;
            if current.goal_id.as_ref() != goal_id {
                return Err("提案关联的目标不能修改。".into());
            }
            ProjectProposal {
                revision: next_revision(current.revision)?, title: title.trim().into(), summary: summary.into(), subject: subject.clone(),
                items: next_items, references: references.to_vec(), boundaries: boundaries.into(), updated_at_ms: now,
                updated_by: actor.clone(), ..current
            }
        }
    };
    proposal.derive_status();
    write_proposal(transaction, &proposal)?;
    Ok(RecordMutationResult { proposal: Some(proposal), ..Default::default() })
}

fn apply_object(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    item: &ProposalItem,
    confirm: bool,
    unlock: bool,
    now: u64,
) -> Result<DevelopmentObject, String> {
    let project = &command.project_id;
    let object = item.object.as_ref().ok_or("对象提案项缺少拟议对象。")?;
    let current = read_object(transaction, project, &item.target_id)?;
    check_base("对象", &object.name, item.base_revision, current.as_ref().map(|value| value.revision))?;
    if let Some(current) = &current {
        if current.planning.as_ref().is_some_and(|planning| planning.locked) && !unlock {
            return Err(format!("「{}」已锁定。确认要用提案内容替换时，请明确选择「解锁并采纳」。", current.name));
        }
        if current.planning.as_ref().is_some_and(|planning| planning.sections.is_some()) && object.planning.sections.is_none() {
            return Err(format!("「{}」已有内容片段；采纳的内容必须提供完整的 sections。", current.name));
        }
    }
    let mut planning = object.planning.clone();
    planning.confirmed = confirm;
    planning.locked = confirm;
    let adopted = DevelopmentObject {
        id: item.target_id.clone(), project_id: project.clone(), name: object.name.trim().into(), kind: object.kind.clone(),
        revision: match &current { Some(current) => next_revision(current.revision)?, None => 1 },
        archived: object.archived, planning: Some(planning),
    };
    validate_object_in_project(transaction, &adopted)?;
    upsert_object(transaction, &adopted)?;
    append_history(transaction, project, RecordHistoryKind::Object, &adopted.id, adopted.revision, now, actor, "adopt_proposal",
        &command.request_id, serde_json::to_value(&adopted).map_err(|error| format!("序列化对象历史失败：{error}"))?)?;
    Ok(adopted)
}

fn apply_record(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    item: &ProposalItem,
    now: u64,
) -> Result<WorkRecord, String> {
    let project = &command.project_id;
    let fields = item.record.as_ref().ok_or("事项提案项缺少事项字段。")?;
    validate_record_fields(fields)?;
    validate_record_object_membership(transaction, project, fields)?;
    let current = read_record(transaction, project, &item.target_id)?;
    check_base("事项", &fields.title, item.base_revision, current.as_ref().map(|value| value.revision))?;
    let record = WorkRecord {
        id: item.target_id.clone(), project_id: project.clone(), fields: fields.clone(),
        revision: match &current { Some(current) => next_revision(current.revision)?, None => 1 },
        archived: current.as_ref().is_some_and(|value| value.archived),
        created_at_ms: current.as_ref().map_or(now, |value| value.created_at_ms),
        updated_at_ms: now, updated_by: actor.clone(),
    };
    validate_record(&record)?;
    upsert_record(transaction, &record)?;
    append_history(transaction, project, RecordHistoryKind::Record, &record.id, record.revision, now, actor, "adopt_proposal",
        &command.request_id, serde_json::to_value(&record).map_err(|error| format!("序列化事项历史失败：{error}"))?)?;
    Ok(record)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn decide_proposal(
    transaction: &Transaction<'_>,
    command: &RecordCommand,
    actor: &RecordActor,
    id: &str,
    expected_revision: u64,
    item_ids: &[String],
    decision: &str,
    note: &str,
    revised_object: Option<&ProposedObject>,
    revised_record: Option<&RecordFields>,
    confirm: bool,
    unlock: bool,
    now: u64,
) -> Result<RecordMutationResult, String> {
    if actor.kind != "user" {
        return Err("只有用户可以采纳、修订、退回或放弃提案。".into());
    }
    let project = &command.project_id;
    require_project(transaction, project)?;
    let mut proposal = read_proposal(transaction, project, id)?.ok_or_else(|| format!("找不到提案 {id}。"))?;
    require_expected_revision("提案", proposal.revision, expected_revision)?;
    validate_free_text("决定说明", note)?;
    if item_ids.is_empty() || item_ids.len() > MAX_PROPOSAL_ITEMS {
        return Err("请至少选择一项，且不超过提案项数。".into());
    }
    let unique: BTreeSet<_> = item_ids.iter().collect();
    if unique.len() != item_ids.len() {
        return Err("选择的提案项重复。".into());
    }
    let revised = revised_object.is_some() || revised_record.is_some();
    if revised && item_ids.len() != 1 {
        return Err("一次只能修订一项。".into());
    }
    if !matches!(decision, "adopt" | "revise" | "return" | "dismiss") {
        return Err("决定只能是 adopt、revise、return 或 dismiss。".into());
    }
    if decision == "revise" && !revised {
        return Err("修订需要提供修改后的内容。".into());
    }
    if decision == "return" && note.trim().is_empty() {
        return Err("退回时请写明需要 Agent 调整什么。".into());
    }
    let proposed: BTreeSet<String> = proposal.items.iter().map(|item| item.target_id.clone()).collect();
    let mut adopted_objects = Vec::new();
    let mut adopted_records = Vec::new();
    for item_id in item_ids {
        let index = proposal.items.iter().position(|item| &item.id == item_id).ok_or_else(|| format!("提案中没有这一项：{item_id}。"))?;
        let item = &mut proposal.items[index];
        if !matches!(item.status, ProposalItemStatus::Pending | ProposalItemStatus::Returned) {
            return Err(format!("提案项 {item_id} 已经决定过，不能再次处理。"));
        }
        if revised {
            let mut content = item.content();
            match item.target {
                ProposalTarget::Object => content.object = Some(revised_object.cloned().ok_or("对象提案项需要修订后的对象。")?),
                ProposalTarget::Record => content.record = Some(revised_record.cloned().ok_or("事项提案项需要修订后的事项。")?),
            }
            if content != item.content() {
                validate_item(transaction, project, &content, &proposed)?;
                let (status, decision) = (item.status, item.decision.clone());
                *item = ProposalItem { status, decision, edited_by: Some(actor.clone()), ..ProposalItem::from_input(content) };
            }
        }
        let record = |status: ProposalItemStatus, applied_revision: Option<u64>, confirmed: bool, item: &ProposalItem| ProposalDecision {
            status, at_ms: now, actor: actor.clone(), request_id: command.request_id.clone(), note: note.trim().into(),
            revised: item.edited_by.is_some(), confirmed, applied_revision, unlocked: unlock && status == ProposalItemStatus::Adopted,
        };
        match decision {
            "revise" => item.status = ProposalItemStatus::Pending,
            "return" => { item.decision = Some(record(ProposalItemStatus::Returned, None, false, item)); item.status = ProposalItemStatus::Returned; }
            "dismiss" => { item.decision = Some(record(ProposalItemStatus::Dismissed, None, false, item)); item.status = ProposalItemStatus::Dismissed; }
            _ => {
                let item_snapshot = item.clone();
                let (applied, confirmed) = match item_snapshot.target {
                    ProposalTarget::Object => {
                        let object = apply_object(transaction, command, actor, &item_snapshot, confirm, unlock, now)?;
                        let revision = object.revision;
                        adopted_objects.push(object);
                        (revision, confirm)
                    }
                    ProposalTarget::Record => {
                        let written = apply_record(transaction, command, actor, &item_snapshot, now)?;
                        let revision = written.revision;
                        adopted_records.push(written);
                        (revision, false)
                    }
                };
                let item = &mut proposal.items[index];
                item.decision = Some(record(ProposalItemStatus::Adopted, Some(applied), confirmed, item));
                item.status = ProposalItemStatus::Adopted;
            }
        }
    }
    proposal.revision = next_revision(proposal.revision)?;
    proposal.updated_at_ms = now;
    proposal.updated_by = actor.clone();
    proposal.derive_status();
    write_proposal(transaction, &proposal)?;
    Ok(RecordMutationResult { proposal: Some(proposal), adopted_objects, adopted_records, ..Default::default() })
}

/// Agents keep work records and minimal ownership objects, but planning design and its
/// confirmation/lock state change only through proposals adopted by the user.
pub(super) fn guard_agent_change(connection: &Transaction<'_>, command: &RecordCommand) -> Result<(), String> {
    let project = &command.project_id;
    match &command.change {
        RecordChange::PutObject { id, planning, .. } => {
            let previous = read_object(connection, project, id)?;
            if planning.is_some() || previous.as_ref().is_some_and(|object| object.planning.is_some()) {
                return Err(AGENT_DESIGN_WRITE.into());
            }
        }
        RecordChange::RestoreObject { id, restore_revision, .. } => {
            let current = read_object(connection, project, id)?;
            let restored = read_history_revision(connection, project, RecordHistoryKind::Object, id, *restore_revision)?;
            let planned = |value: &serde_json::Value| value.get("planning").is_some_and(|planning| !planning.is_null());
            if current.as_ref().is_some_and(|object| object.planning.is_some()) || restored.as_ref().is_some_and(|entry| planned(&entry.snapshot)) {
                return Err(AGENT_DESIGN_WRITE.into());
            }
        }
        RecordChange::SetObjectLock { .. } => return Err(AGENT_DESIGN_WRITE.into()),
        RecordChange::DecideProposal { .. } => return Err("只有用户可以采纳、修订、退回或放弃提案。".into()),
        _ => {}
    }
    Ok(())
}

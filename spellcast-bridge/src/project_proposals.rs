//! Reviewable Agent proposals. They live beside canonical objects and records, never inside
//! them: only a user decision writes an adopted item into the project, in one transaction.
use crate::project_planning::PlanningFields;
use crate::project_records::{RecordActor, RecordFields, SourceReference};
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_PROPOSAL_ITEMS: usize = 64;
pub(crate) const PROPOSAL_BASIS: [&str; 4] = ["config", "design", "code", "inference"];

/// Where a proposal applies in the game view. Descriptive only; it grants nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ProposalSubject {
    /// overview | experience | object
    #[serde(default)]
    pub scale: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub zone_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub location_id: String,
    /// Configuration entity for the object scale, for example `content` + `content_battle_x`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub entity_kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub entity_id: String,
}

/// The complete proposed state of one planning object. `confirmed` and `locked` must be false:
/// confirmation only happens when the user adopts the item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposedObject {
    pub name: String,
    /// system | rule | hook | parameter | content | flow
    pub kind: String,
    #[serde(default)]
    pub archived: bool,
    pub planning: PlanningFields,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProposalTarget {
    /// A planning object: content, rule, hook, parameter, flow or system.
    Object,
    /// A work record, only when implementation or verification needs tracking.
    Record,
}

/// One proposed change, as supplied by its author. Server-owned review fields (status,
/// decision, edited_by) are ignored when an author sends a stored item back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposalItemInput {
    /// Stable within the proposal; keep it when revising the proposal.
    pub id: String,
    pub target: ProposalTarget,
    /// Existing object/record id to change, or a new stable id to create.
    pub target_id: String,
    /// 0 creates. Otherwise the current revision this item was written against.
    pub base_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<ProposedObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<RecordFields>,
    /// Why this change: the design intent it serves.
    #[serde(default)]
    pub reason: String,
    /// What the item rests on: config | design | code | inference. Never player verification.
    #[serde(default)]
    pub basis: Vec<String>,
    /// Sources with version or SHA-256 at the time the item was written.
    #[serde(default)]
    pub references: Vec<SourceReference>,
    /// What remains unverified, especially in Unity or with real player input.
    #[serde(default)]
    pub boundaries: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProposalItemStatus {
    #[default]
    Pending,
    Adopted,
    Returned,
    Dismissed,
}

/// A user decision about one item. Written by the server from the user's command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposalDecision {
    pub status: ProposalItemStatus,
    pub at_ms: u64,
    pub actor: RecordActor,
    pub request_id: String,
    #[serde(default)]
    pub note: String,
    /// Adopted content differs from what the author proposed.
    #[serde(default)]
    pub revised: bool,
    #[serde(default)]
    pub confirmed: bool,
    /// The user explicitly unlocked a locked target to adopt this item.
    #[serde(default)]
    pub unlocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_revision: Option<u64>,
}

/// A stored item: the author's content plus the server-owned review state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProposalItem {
    pub id: String,
    pub target: ProposalTarget,
    pub target_id: String,
    pub base_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<ProposedObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<RecordFields>,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub basis: Vec<String>,
    #[serde(default)]
    pub references: Vec<SourceReference>,
    #[serde(default)]
    pub boundaries: String,
    #[serde(default)]
    pub status: ProposalItemStatus,
    /// Set when the user edited the proposed content before deciding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_by: Option<RecordActor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<ProposalDecision>,
}

impl ProposalItem {
    pub(crate) fn from_input(input: ProposalItemInput) -> Self {
        Self {
            id: input.id, target: input.target, target_id: input.target_id, base_revision: input.base_revision,
            object: input.object, record: input.record, reason: input.reason, basis: input.basis,
            references: input.references, boundaries: input.boundaries,
            status: ProposalItemStatus::Pending, edited_by: None, decision: None,
        }
    }
    /// The author-visible content, used to detect edits to decided items.
    pub(crate) fn content(&self) -> ProposalItemInput {
        ProposalItemInput {
            id: self.id.clone(), target: self.target, target_id: self.target_id.clone(), base_revision: self.base_revision,
            object: self.object.clone(), record: self.record.clone(), reason: self.reason.clone(), basis: self.basis.clone(),
            references: self.references.clone(), boundaries: self.boundaries.clone(),
        }
    }
}

/// A stored, reviewable proposal. Not part of portable project exports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectProposal {
    pub id: String,
    pub project_id: String,
    pub revision: u64,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub subject: ProposalSubject,
    /// The user goal this answers, when it came from one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_id: Option<String>,
    pub items: Vec<ProposalItem>,
    #[serde(default)]
    pub references: Vec<SourceReference>,
    #[serde(default)]
    pub boundaries: String,
    /// open while an item is pending or returned; closed when every item is decided.
    pub status: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub created_by: RecordActor,
    pub updated_by: RecordActor,
}

impl ProjectProposal {
    pub(crate) fn derive_status(&mut self) {
        let open = self.items.iter().any(|item| matches!(item.status, ProposalItemStatus::Pending | ProposalItemStatus::Returned));
        self.status = if open { "open" } else { "closed" }.into();
    }
}

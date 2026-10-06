//! Public, portable project-record types. Storage and access control live in sibling modules.

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};

/// The deliberately small lifecycle vocabulary for a work record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordStatus {
    Planned,
    Active,
    Blocked,
    Done,
    Cancelled,
}

impl Default for RecordStatus {
    fn default() -> Self {
        Self::Planned
    }
}

impl RecordStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Active => "active",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(Self::Planned),
            "active" => Some(Self::Active),
            "blocked" => Some(Self::Blocked),
            "done" => Some(Self::Done),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// A link to material that remains outside the portable project bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceReference {
    pub label: String,
    pub uri: String,
    #[serde(default)]
    pub version: String,
}

/// Mutable user-facing fields for a work record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecordFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub status: RecordStatus,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub boundaries: String,
    #[serde(default)]
    pub next_step: String,
    #[serde(default)]
    pub references: Vec<SourceReference>,
}

/// A stable project identity and its current metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub revision: u64,
    pub archived: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// The source project whose portable bundle created this project, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<ProjectImportProvenance>,
}

/// Durable provenance for a portable import. It contains no authority or source files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectImportProvenance {
    pub project_id: String,
    pub revision: u64,
}

/// A project-local development object such as a feature, asset, or subsystem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DevelopmentObject {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub revision: u64,
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<crate::project_planning::PlanningFields>,
}

/// A persisted work record. `fields` remains flattened in JSON for API compatibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WorkRecord {
    pub id: String,
    pub project_id: String,
    #[serde(flatten)]
    pub fields: RecordFields,
    pub revision: u64,
    pub archived: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub updated_by: RecordActor,
}

/// Provenance supplied by the bridge, never accepted from a mutation body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecordActor {
    /// `user`, `agent`, `import`, or a native-authorized application `client`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub label: String,
}

/// The entity family represented by a historical snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordHistoryKind {
    Project,
    Object,
    Record,
    /// Independent parameter candidates keep every saved revision.
    Candidate,
}

impl RecordHistoryKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Object => "object",
            Self::Record => "record",
            Self::Candidate => "candidate",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "project" => Some(Self::Project),
            "object" => Some(Self::Object),
            "record" => Some(Self::Record),
            "candidate" => Some(Self::Candidate),
            _ => None,
        }
    }
}

/// An immutable complete snapshot for one current-row revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordHistory {
    pub project_id: String,
    pub kind: RecordHistoryKind,
    pub id: String,
    pub revision: u64,
    pub at_ms: u64,
    pub actor: RecordActor,
    pub operation: String,
    pub request_id: String,
    pub snapshot: serde_json::Value,
}

/// The tagged data-changing part of a [`RecordCommand`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RecordChange {
    CreateProject {
        name: String,
        #[serde(default)]
        aliases: Vec<String>,
    },
    UpdateProject {
        expected_revision: u64,
        name: String,
        aliases: Vec<String>,
        archived: bool,
    },
    PutObject {
        id: String,
        expected_revision: u64,
        name: String,
        kind: String,
        archived: bool,
        /// Omitted by older clients: preserve any existing planning content.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        planning: Option<crate::project_planning::PlanningFields>,
    },
    RestoreObject {
        id: String,
        expected_revision: u64,
        restore_revision: u64,
    },
    SetObjectLock {
        id: String,
        expected_revision: u64,
        locked: bool,
    },
    PutRecord {
        id: String,
        expected_revision: u64,
        fields: RecordFields,
    },
    ArchiveRecord {
        id: String,
        expected_revision: u64,
        archived: bool,
    },
    RestoreRecord {
        id: String,
        expected_revision: u64,
        restore_revision: u64,
    },
    ImportProject {
        bundle: ProjectExport,
        name: String,
    },
    /// Creates or revises an independent numeric candidate. It never changes the parameter.
    /// `base_revision` must be the candidate's current base or the parameter's current revision.
    PutCandidate {
        id: String,
        expected_revision: u64,
        parameter_id: String,
        label: String,
        value: String,
        #[serde(default)]
        reason: String,
        base_revision: u64,
        #[serde(default)]
        archived: bool,
        /// Set only when the user explicitly converts a legacy `parameter.variants` entry.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_variant: Option<String>,
    },
    /// Persists one immutable walkthrough or replay. Identical content is deduplicated.
    SaveTrial {
        id: String,
        #[serde(default)]
        label: String,
        /// walkthrough | replay | legacy_local
        origin: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_trial_id: Option<String>,
        run: crate::project_trials::TrialRun,
    },
    /// Writes one candidate value to its unlocked shared parameter with reason and evidence.
    AdoptCandidate {
        adoption_id: String,
        parameter_id: String,
        expected_revision: u64,
        candidate_id: String,
        candidate_revision: u64,
        #[serde(default)]
        trial_ids: Vec<String>,
        reason: String,
        #[serde(default)]
        lock_after: bool,
    },
    /// Creates (expected_revision 0) or revises a reviewable proposal. It never changes an object
    /// or record. Items carry complete proposed states with base revisions, sources and reasons;
    /// `planning.confirmed` and `planning.locked` must stay false. Decided items are immutable.
    PutProposal {
        id: String,
        expected_revision: u64,
        title: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        subject: crate::project_proposals::ProposalSubject,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        goal_id: Option<String>,
        items: Vec<crate::project_proposals::ProposalItemInput>,
        #[serde(default)]
        references: Vec<SourceReference>,
        #[serde(default)]
        boundaries: String,
    },
    /// User-only review. `decision` is adopt | revise | return | dismiss. Adopt writes the items in
    /// the given order in one transaction, refusing stale bases and locked targets unless `unlock`.
    DecideProposal {
        id: String,
        expected_revision: u64,
        item_ids: Vec<String>,
        decision: String,
        #[serde(default)]
        note: String,
        /// Replaces the single selected item's proposed object (revise, or adopt with edits).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revised_object: Option<crate::project_proposals::ProposedObject>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revised_record: Option<RecordFields>,
        /// Adopt marks the design confirmed and locked; false adopts an unconfirmed draft.
        #[serde(default = "default_true")]
        confirm: bool,
        /// Explicit user choice to unlock a locked target before writing the adopted state.
        #[serde(default)]
        unlock: bool,
    },
}

fn default_true() -> bool {
    true
}

/// A request-receipted mutation. `project_id` is supplied by the caller and must be a UUID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordCommand {
    pub request_id: String,
    pub project_id: String,
    #[serde(flatten)]
    pub change: RecordChange,
}

/// The current entity returned by a successful mutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
pub struct RecordMutationResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<DevelopmentObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<WorkRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<crate::project_trials::ParameterCandidate>,
    /// A compact view; read the complete immutable trial separately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trial: Option<crate::project_trials::TrialSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adoption: Option<crate::project_trials::CandidateAdoption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<crate::project_proposals::ProjectProposal>,
    /// Objects and records written by one adopt decision, in the order they were applied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adopted_objects: Vec<DevelopmentObject>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adopted_records: Vec<WorkRecord>,
    #[serde(default)]
    pub replayed: bool,
    /// The saved trial already existed with identical content; no second copy was made.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deduplicated: bool,
}

/// A portable link declaration. Original source files are never embedded in phase 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectExternalFile {
    pub uri: String,
    pub original_included: bool,
}

/// A complete, JSON-portable project snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectExport {
    pub format: String,
    pub version: u64,
    pub exported_at_ms: u64,
    pub project: Project,
    #[serde(default)]
    pub objects: Vec<DevelopmentObject>,
    #[serde(default)]
    pub records: Vec<WorkRecord>,
    #[serde(default)]
    pub history: Vec<RecordHistory>,
    #[serde(default)]
    pub external_files: Vec<ProjectExternalFile>,
    /// Version 3 data. Omitted when empty so version 1/2 bundles keep their shape.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<crate::project_trials::ParameterCandidate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trials: Vec<crate::project_trials::FlowTrial>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adoptions: Vec<crate::project_trials::CandidateAdoption>,
}

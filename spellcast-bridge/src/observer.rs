//! Short-lived, source-bound observation tickets. Models remain in their host.

use std::collections::HashMap;

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use spellcast_core::types::{new_id, BubbleRequest, SpellcastError};

use crate::Bridge;

const COOLDOWN_MS: u64 = 120_000;
const LEASE_MS: u64 = 180_000;
const RETAIN_MS: u64 = 1_800_000;
const MAX_SOURCES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProjectSnapshot {
    /// A stable revision or natural checkpoint; not a timer tick.
    pub checkpoint_id: String,
    pub project: String,
    pub goal: String,
    /// What materially changed or which design choice is now being considered.
    pub change: String,
    /// Only the few facts needed for this observation. Never full conversation history.
    #[serde(default)]
    pub facts: Vec<String>,
}

impl ProjectSnapshot {
    fn same_context(&self, other: &Self) -> bool {
        self.project == other.project
            && self.goal == other.goal
            && self.change == other.change
            && self.facts == other.facts
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckpointRequest {
    pub source_id: String,
    /// Null cancels this task's pending observer (stop, task end, or project switch).
    pub snapshot: Option<ProjectSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObserverBrief {
    pub observer_id: String,
    pub source_id: String,
    pub snapshot: ProjectSnapshot,
    pub expires_at_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct CheckpointResult {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<ObserverBrief>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ObserverThought {
    /// Complete, project-grounded aside; at most 120 characters. Not progress or the main answer.
    pub tease: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub shape: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ObserverCompletion {
    pub observer_id: String,
    /// Null is a successful quiet decision. Do not invent a thought to fill a quota.
    pub thought: Option<ObserverThought>,
}

#[derive(Debug, Serialize)]
pub struct ObserverResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bubble_id: Option<String>,
}

#[derive(Default)]
struct Source {
    last_seen: u64,
    last_started: Option<u64>,
    last_snapshot: Option<ProjectSnapshot>,
    pending: Option<ObserverBrief>,
}

#[derive(Default)]
pub(crate) struct Observers {
    sources: HashMap<String, Source>,
}

fn text_limit(value: &str, limit: usize, field: &str) -> Result<(), SpellcastError> {
    if value.trim().is_empty() || value.chars().count() > limit {
        return Err(SpellcastError::user(format!(
            "{field} must contain 1–{limit} characters."
        )));
    }
    Ok(())
}

impl Observers {
    fn checkpoint(
        &mut self,
        req: CheckpointRequest,
        now: u64,
        allowed: bool,
    ) -> Result<CheckpointResult, SpellcastError> {
        text_limit(&req.source_id, 200, "source_id")?;
        self.sources
            .retain(|_, source| now.saturating_sub(source.last_seen) < RETAIN_MS);
        let Some(mut snapshot) = req.snapshot else {
            self.sources.remove(&req.source_id);
            return Ok(CheckpointResult {
                status: "cancelled",
                brief: None,
            });
        };
        snapshot.checkpoint_id = snapshot.checkpoint_id.trim().into();
        snapshot.project = snapshot.project.trim().into();
        snapshot.goal = snapshot.goal.trim().into();
        snapshot.change = snapshot.change.trim().into();
        snapshot.facts = snapshot
            .facts
            .iter()
            .map(|fact| fact.trim().to_owned())
            .collect();
        text_limit(&snapshot.checkpoint_id, 200, "checkpoint_id")?;
        text_limit(&snapshot.project, 500, "project")?;
        text_limit(&snapshot.goal, 500, "goal")?;
        text_limit(&snapshot.change, 1500, "change")?;
        if snapshot.facts.len() > 4 {
            return Err(SpellcastError::user(
                "An observation accepts at most four short facts.",
            ));
        }
        for fact in &snapshot.facts {
            text_limit(fact, 500, "fact")?;
        }
        if !self.sources.contains_key(&req.source_id) && self.sources.len() >= MAX_SOURCES {
            return Ok(CheckpointResult {
                status: "capacity",
                brief: None,
            });
        }
        let source = self.sources.entry(req.source_id.clone()).or_default();
        source.last_seen = now;
        // Invalidate old work even when the new checkpoint cannot launch another observer yet.
        if source.pending.as_ref().is_some_and(|brief| {
            !brief.snapshot.same_context(&snapshot) || now >= brief.expires_at_ms
        }) {
            source.pending = None;
        }
        if !allowed {
            source.pending = None;
            return Ok(CheckpointResult {
                status: "suppressed",
                brief: None,
            });
        }
        if source.last_snapshot.as_ref().is_some_and(|last| {
            last.project == snapshot.project
                && (last.checkpoint_id == snapshot.checkpoint_id || last.same_context(&snapshot))
        }) {
            return Ok(CheckpointResult {
                status: "duplicate",
                brief: None,
            });
        }
        if source
            .last_started
            .is_some_and(|started| now.saturating_sub(started) < COOLDOWN_MS)
        {
            return Ok(CheckpointResult {
                status: "cooldown",
                brief: None,
            });
        }
        let brief = ObserverBrief {
            observer_id: new_id(),
            source_id: req.source_id,
            snapshot: snapshot.clone(),
            expires_at_ms: now.saturating_add(LEASE_MS),
        };
        source.last_started = Some(now);
        source.last_snapshot = Some(snapshot);
        source.pending = Some(brief.clone());
        Ok(CheckpointResult {
            status: "ready",
            brief: Some(brief),
        })
    }

    fn take(&mut self, id: &str, now: u64) -> Option<ObserverBrief> {
        let source = self.sources.values_mut().find(|source| {
            source
                .pending
                .as_ref()
                .is_some_and(|brief| brief.observer_id == id)
        })?;
        let brief = source.pending.take()?;
        (now < brief.expires_at_ms).then_some(brief)
    }
}

impl Bridge {
    pub fn checkpoint(&self, req: CheckpointRequest) -> Result<CheckpointResult, SpellcastError> {
        let status = self.status();
        let allowed = !status.paused && !(status.surface == "focus" && status.board_focused);
        self.observers
            .lock()
            .unwrap()
            .checkpoint(req, spellcast_core::inbox::now_ms(), allowed)
    }

    pub fn complete_observation(
        &self,
        req: ObserverCompletion,
    ) -> Result<ObserverResult, SpellcastError> {
        if let Some(thought) = &req.thought {
            text_limit(&thought.tease, 120, "tease")?;
            if thought.body.chars().count() > 2000 {
                return Err(SpellcastError::user(
                    "Observer detail must be at most 2000 characters.",
                ));
            }
        }
        // Keep ticket validation and synchronous dispatch atomic against newer checkpoints.
        let mut observers = self.observers.lock().unwrap();
        let Some(brief) = observers.take(&req.observer_id, spellcast_core::inbox::now_ms()) else {
            return Ok(ObserverResult {
                status: "stale".into(),
                bubble_id: None,
            });
        };
        let Some(thought) = req.thought else {
            return Ok(ObserverResult {
                status: "silent".into(),
                bubble_id: None,
            });
        };
        let result = self.bubble_now(BubbleRequest {
            source_id: Some(brief.source_id),
            tease: thought.tease,
            body: Some(thought.body),
            kind: thought.kind,
            shape: thought.shape,
            screen: Some("active".into()),
            wait: Some(0),
            ..Default::default()
        })?;
        Ok(ObserverResult {
            status: result.outcome,
            bubble_id: Some(result.bubble.id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(source: &str, change: &str) -> CheckpointRequest {
        CheckpointRequest {
            source_id: source.into(),
            snapshot: Some(ProjectSnapshot {
                checkpoint_id: change.into(),
                project: "calendar".into(),
                goal: "A realistic week".into(),
                change: change.into(),
                facts: vec!["Friday demo at 15:00".into()],
            }),
        }
    }

    #[test]
    fn observations_are_sparse_source_bound_and_fresh() {
        let mut gate = Observers::default();
        let a = gate
            .checkpoint(checkpoint("a", "Lunch resolved"), 0, true)
            .unwrap()
            .brief
            .unwrap();
        assert_eq!(
            gate.checkpoint(checkpoint("a", "Lunch resolved"), 1, true)
                .unwrap()
                .status,
            "duplicate"
        );
        assert_eq!(
            gate.checkpoint(checkpoint("a", "Recording moved"), 2, true)
                .unwrap()
                .status,
            "cooldown"
        );
        assert!(
            gate.take(&a.observer_id, 3).is_none(),
            "new information must invalidate old work during cooldown"
        );
        let b = gate
            .checkpoint(checkpoint("b", "Lunch resolved"), 3, true)
            .unwrap()
            .brief
            .unwrap();
        assert_eq!(gate.take(&b.observer_id, 4).unwrap().source_id, "b");
        assert!(
            gate.take(&b.observer_id, 5).is_none(),
            "ticket can only finish once"
        );
        let a = gate
            .checkpoint(checkpoint("a", "Recording moved"), COOLDOWN_MS, true)
            .unwrap()
            .brief
            .unwrap();
        assert!(gate.take(&a.observer_id, COOLDOWN_MS + LEASE_MS).is_none());
        let c = gate
            .checkpoint(checkpoint("c", "Open buffer"), 0, true)
            .unwrap()
            .brief
            .unwrap();
        gate.checkpoint(
            CheckpointRequest {
                source_id: "c".into(),
                snapshot: None,
            },
            1,
            true,
        )
        .unwrap();
        assert!(gate.take(&c.observer_id, 2).is_none());
        assert_eq!(
            gate.checkpoint(checkpoint("d", "Open buffer"), 0, false)
                .unwrap()
                .status,
            "suppressed"
        );
    }

    #[test]
    fn duplicate_content_and_oversized_context_do_not_launch() {
        let mut gate = Observers::default();
        gate.checkpoint(checkpoint("a", "Lunch resolved"), 0, true)
            .unwrap();
        let mut duplicate = checkpoint("a", "Lunch resolved");
        duplicate.snapshot.as_mut().unwrap().checkpoint_id = "different label".into();
        assert_eq!(
            gate.checkpoint(duplicate, COOLDOWN_MS, true)
                .unwrap()
                .status,
            "duplicate"
        );
        let mut large = checkpoint("b", "Lunch resolved");
        large.snapshot.as_mut().unwrap().facts = vec!["a".repeat(501)];
        assert!(gate.checkpoint(large, 0, true).is_err());
    }

    #[test]
    fn quiet_completion_and_native_dispatch_keep_the_original_source() {
        let (bridge, surface) = crate::tests::bridge();
        let brief = bridge
            .checkpoint(checkpoint("calendar-task", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        let result = bridge
            .complete_observation(ObserverCompletion {
                observer_id: brief.observer_id,
                thought: None,
            })
            .unwrap();
        assert_eq!(result.status, "silent");
        assert!(surface.thrown.lock().unwrap().is_empty());
        let brief = bridge
            .checkpoint(checkpoint("second-task", "Open buffer"))
            .unwrap()
            .brief
            .unwrap();
        let id = brief.observer_id.clone();
        let result = bridge
            .complete_observation(ObserverCompletion {
                observer_id: id.clone(),
                thought: Some(ObserverThought {
                    tease: "A free hour can stay free.".into(),
                    body: String::new(),
                    kind: None,
                    shape: None,
                }),
            })
            .unwrap();
        assert_eq!(result.status, "accepted");
        assert_eq!(
            surface.thrown.lock().unwrap()[0].source_id.as_deref(),
            Some("second-task")
        );
        assert_eq!(
            bridge
                .complete_observation(ObserverCompletion {
                    observer_id: id,
                    thought: None
                })
                .unwrap()
                .status,
            "stale"
        );
    }

    #[test]
    fn pause_and_new_project_prevent_late_delivery() {
        let (bridge, surface) = crate::tests::bridge();
        let brief = bridge
            .checkpoint(checkpoint("a", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        bridge.set_paused(true).unwrap();
        let result = bridge
            .complete_observation(ObserverCompletion {
                observer_id: brief.observer_id,
                thought: Some(ObserverThought {
                    tease: "Leave the buffer open.".into(),
                    body: String::new(),
                    kind: None,
                    shape: None,
                }),
            })
            .unwrap();
        assert_eq!(result.status, "not_shown");
        assert!(surface.thrown.lock().unwrap().is_empty());
        bridge.set_paused(false).unwrap();
        let brief = bridge
            .checkpoint(checkpoint("b", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        let mut next = checkpoint("b", "Lunch resolved");
        next.snapshot.as_mut().unwrap().project = "different-project".into();
        assert_eq!(bridge.checkpoint(next).unwrap().status, "cooldown");
        assert_eq!(
            bridge
                .complete_observation(ObserverCompletion {
                    observer_id: brief.observer_id,
                    thought: None
                })
                .unwrap()
                .status,
            "stale"
        );
        let (restarted, _) = crate::tests::bridge();
        assert_eq!(
            restarted
                .complete_observation(ObserverCompletion {
                    observer_id: "old-ticket".into(),
                    thought: None
                })
                .unwrap()
                .status,
            "stale"
        );
    }
}

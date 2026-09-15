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

#[derive(Debug, Clone, Serialize)]
pub struct ObserverStatus {
    pub enabled: bool,
    pub paused: bool,
    pub allowed: bool,
    pub reason: &'static str,
    pub policy_revision: u64,
}

impl ObserverStatus {
    pub(crate) fn from_flags(
        enabled: bool,
        paused: bool,
        board_focused: bool,
        policy_revision: u64,
    ) -> Self {
        let (allowed, reason) = if !enabled {
            (false, "disabled")
        } else if paused {
            (false, "paused")
        } else if board_focused {
            (false, "board_focused")
        } else {
            (true, "ok")
        };
        Self {
            enabled,
            paused,
            allowed,
            reason,
            policy_revision,
        }
    }
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

    pub(crate) fn invalidate_all(&mut self) {
        for source in self.sources.values_mut() {
            source.pending = None;
        }
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
        let mut observers = self.observers.lock().unwrap();
        let now = spellcast_core::inbox::now_ms();
        if req.snapshot.is_none() {
            return observers.checkpoint(req, now, true);
        }
        let gate = self.observer_gate();
        if !gate.enabled {
            observers.invalidate_all();
            return Ok(CheckpointResult {
                status: "disabled",
                brief: None,
            });
        }
        observers.checkpoint(req, now, gate.allowed)
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
        let (brief, thought) = {
            let mut observers = self.observers.lock().unwrap();
            let gate = self.observer_gate();
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
            if !gate.enabled {
                return Ok(ObserverResult {
                    status: "stale".into(),
                    bubble_id: None,
                });
            }
            (brief, thought)
        };
        let captured = self.capture_from_brief(&brief);
        let result = self.bubble_now_captured(
            BubbleRequest {
                source_id: Some(brief.source_id),
                tease: thought.tease,
                body: Some(thought.body),
                kind: thought.kind,
                shape: thought.shape,
                screen: Some("active".into()),
                wait: Some(0),
                ..Default::default()
            },
            Some(captured),
        )?;
        Ok(ObserverResult {
            status: result.outcome,
            bubble_id: Some(result.bubble.id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observing() -> (std::sync::Arc<Bridge>, std::sync::Arc<crate::tests::Recording>) {
        let (bridge, surface) = crate::tests::bridge();
        bridge.set_observer_enabled(true).unwrap();
        (bridge, surface)
    }

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
        let (bridge, surface) = observing();
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
        let (bridge, surface) = observing();
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
        assert_eq!(result.status, "stale");
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

    #[test]
    fn product_switch_defaults_off_and_does_not_issue_tickets() {
        let (bridge, _) = crate::tests::bridge();
        let status = bridge.observer_status();
        assert!(!status.enabled);
        assert!(!status.allowed);
        assert_eq!(status.reason, "disabled");
        assert_eq!(status.policy_revision, 0);
        let result = bridge.checkpoint(checkpoint("a", "Lunch resolved")).unwrap();
        assert_eq!(result.status, "disabled");
        assert!(result.brief.is_none());
    }

    #[test]
    fn turning_off_invalidates_tickets_and_reopen_does_not_revive_them() {
        let (bridge, _) = observing();
        let first_rev = bridge.observer_status().policy_revision;
        let brief = bridge
            .checkpoint(checkpoint("a", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        let off = bridge.set_observer_enabled(false).unwrap();
        assert!(!off.enabled);
        assert_eq!(off.reason, "disabled");
        assert!(off.policy_revision > first_rev);
        assert_eq!(
            bridge
                .complete_observation(ObserverCompletion {
                    observer_id: brief.observer_id.clone(),
                    thought: Some(ObserverThought {
                        tease: "A free hour can stay free.".into(),
                        body: String::new(),
                        kind: None,
                        shape: None,
                    }),
                })
                .unwrap()
                .status,
            "stale"
        );
        bridge.set_observer_enabled(true).unwrap();
        assert_eq!(
            bridge
                .complete_observation(ObserverCompletion {
                    observer_id: brief.observer_id,
                    thought: None,
                })
                .unwrap()
                .status,
            "stale"
        );
        assert_eq!(
            bridge
                .checkpoint(checkpoint("a", "Lunch resolved"))
                .unwrap()
                .status,
            "duplicate"
        );
    }

    #[test]
    fn cancel_succeeds_while_disabled() {
        let (bridge, _) = observing();
        let brief = bridge
            .checkpoint(checkpoint("a", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        bridge.set_observer_enabled(false).unwrap();
        assert_eq!(
            bridge
                .checkpoint(CheckpointRequest {
                    source_id: "a".into(),
                    snapshot: None,
                })
                .unwrap()
                .status,
            "cancelled"
        );
        assert_eq!(
            bridge
                .complete_observation(ObserverCompletion {
                    observer_id: brief.observer_id,
                    thought: None,
                })
                .unwrap()
                .status,
            "stale"
        );
    }

    #[test]
    fn pause_and_actual_focus_are_distinct_from_disabled() {
        let (bridge, surface) = observing();
        bridge.set_surface("focus");
        let status = bridge.observer_status();
        assert!(status.enabled);
        assert!(status.allowed);
        assert_eq!(status.reason, "ok");
        surface.board_focused.store(true, std::sync::atomic::Ordering::SeqCst);
        let focused = bridge.observer_status();
        assert!(focused.enabled);
        assert!(!focused.allowed);
        assert_eq!(focused.reason, "board_focused");
        assert_eq!(
            bridge.checkpoint(checkpoint("a", "Lunch resolved")).unwrap().status,
            "suppressed"
        );
        surface.board_focused.store(false, std::sync::atomic::Ordering::SeqCst);
        bridge.set_paused(true).unwrap();
        let paused = bridge.observer_status();
        assert!(paused.enabled);
        assert!(paused.paused);
        assert_eq!(paused.reason, "paused");
        assert_eq!(
            bridge.checkpoint(checkpoint("b", "Open buffer")).unwrap().status,
            "suppressed"
        );
    }

    #[test]
    fn observer_setting_persists_across_reopen() {
        let path = crate::tests::temp_db();
        let rec = std::sync::Arc::new(crate::tests::Recording::default());
        {
            let bridge = Bridge::open(rec.clone(), 0, &path).unwrap();
            assert!(!bridge.observer_status().enabled);
            bridge.set_observer_enabled(true).unwrap();
            assert!(bridge.observer_status().enabled);
            assert!(bridge.observer_status().policy_revision > 0);
        }
        let restored = Bridge::open(rec, 0, &path).unwrap();
        let status = restored.observer_status();
        assert!(status.enabled);
        assert!(status.policy_revision > 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn concurrent_off_vs_checkpoint_cannot_issue_after_disable_returns() {
        let (bridge, _) = observing();
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let b1 = bridge.clone();
        let b2 = bridge.clone();
        let ready = start.clone();
        let check = std::thread::spawn(move || {
            ready.wait();
            b1.checkpoint(checkpoint("race-a", "Lunch resolved"))
        });
        let off = std::thread::spawn(move || {
            start.wait();
            b2.set_observer_enabled(false).unwrap()
        });
        let issued = check.join().unwrap().unwrap();
        let disabled = off.join().unwrap();
        assert!(!disabled.enabled);
        if let Some(brief) = issued.brief {
            assert_eq!(
                bridge
                    .complete_observation(ObserverCompletion {
                        observer_id: brief.observer_id,
                        thought: None,
                    })
                    .unwrap()
                    .status,
                "stale"
            );
        }
        assert_eq!(
            bridge.checkpoint(checkpoint("race-a", "Lunch resolved")).unwrap().status,
            "disabled"
        );
    }

    #[test]
    fn concurrent_off_vs_complete_rejects_old_ticket_after_disable() {
        let (bridge, surface) = observing();
        let brief = bridge
            .checkpoint(checkpoint("race-b", "Lunch resolved"))
            .unwrap()
            .brief
            .unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let b1 = bridge.clone();
        let b2 = bridge.clone();
        let id = brief.observer_id.clone();
        let ready = start.clone();
        let complete = std::thread::spawn(move || {
            ready.wait();
            b1.complete_observation(ObserverCompletion {
                observer_id: id,
                thought: Some(ObserverThought {
                    tease: "A free hour can stay free.".into(),
                    body: String::new(),
                    kind: None,
                    shape: None,
                }),
            })
        });
        let off = std::thread::spawn(move || {
            start.wait();
            b2.set_observer_enabled(false).unwrap()
        });
        let finished = complete.join().unwrap().unwrap();
        let disabled = off.join().unwrap();
        assert!(!disabled.enabled);
        assert!(finished.status == "stale" || finished.status == "accepted" || finished.status == "not_shown");
        assert_eq!(
            bridge
                .complete_observation(ObserverCompletion {
                    observer_id: brief.observer_id.clone(),
                    thought: Some(ObserverThought {
                        tease: "A free hour can stay free.".into(),
                        body: String::new(),
                        kind: None,
                        shape: None,
                    }),
                })
                .unwrap()
                .status,
            "stale"
        );
        assert_eq!(
            bridge.checkpoint(checkpoint("race-c", "Open buffer")).unwrap().status,
            "disabled"
        );
        let _ = surface;
    }

    #[tokio::test]
    async fn direct_bubble_is_not_blocked_by_observer_switch() {
        let (bridge, surface) = crate::tests::bridge();
        assert!(!bridge.observer_status().enabled);
        let result = bridge
            .bubble(BubbleRequest {
                tease: "Keep this reminder.".into(),
                wait: Some(0),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.outcome, "accepted");
        assert_eq!(surface.thrown.lock().unwrap().len(), 1);
    }
}

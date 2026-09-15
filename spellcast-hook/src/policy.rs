use crate::cache::CacheState;
use crate::event::{HookEvent, SessionSource};
use crate::http::ObserverStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Empty,
    Bootstrap,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheView {
    Missing,
    Present(CacheState),
    Unusable,
    Corrupt,
    Busy,
}

impl CacheView {
    fn state(&self) -> Option<CacheState> {
        match self {
            CacheView::Present(state) => Some(state.clone()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    pub next_cache: Option<CacheState>,
}

pub fn decide(event: &HookEvent, status: Option<&ObserverStatus>, view: CacheView) -> Decision {
    let is_session_start = event.hook_event_name == "SessionStart";
    let is_prompt = event.hook_event_name == "UserPromptSubmit";
    if !is_session_start && !is_prompt {
        return Decision {
            action: Action::Empty,
            next_cache: view.state(),
        };
    }
    if matches!(view, CacheView::Busy) {
        return Decision {
            action: Action::Empty,
            next_cache: view.state(),
        };
    }
    let unusable = matches!(view, CacheView::Unusable | CacheView::Corrupt);
    let Some(status) = status else {
        return unavailable(event, view, unusable);
    };
    if unusable {
        if is_session_start && status.asides_on() {
            return Decision {
                action: Action::Bootstrap,
                next_cache: Some(on_cache(status, event)),
            };
        }
        return Decision {
            action: Action::Empty,
            next_cache: None,
        };
    }
    let previous = view.state().unwrap_or_default();
    if matches!(view, CacheView::Present(_)) && status.policy_revision < previous.last_revision {
        return Decision {
            action: Action::Empty,
            next_cache: Some(previous),
        };
    }
    let on = status.asides_on();
    let force_refresh = is_session_start
        && event
            .source
            .as_ref()
            .is_some_and(SessionSource::force_refresh);
    if on {
        let miss = !previous.injected || !previous.last_available || !previous.last_on;
        let changed = previous.last_revision != status.policy_revision;
        let should = if force_refresh {
            true
        } else if is_session_start {
            miss || changed || !previous.injected
        } else {
            miss || changed
        };
        if should {
            return Decision {
                action: Action::Bootstrap,
                next_cache: Some(on_cache(status, event)),
            };
        }
        return Decision {
            action: Action::Empty,
            next_cache: Some(on_cache_keep_emit(status, previous.last_emit.clone())),
        };
    }
    if previous.injected {
        return Decision {
            action: Action::Stop,
            next_cache: Some(off_cache(status, false, Some(emit_tag(event, status.policy_revision)))),
        };
    }
    Decision {
        action: Action::Empty,
        next_cache: Some(off_cache(status, previous.last_available, previous.last_emit.clone())),
    }
}

fn unavailable(event: &HookEvent, view: CacheView, unusable: bool) -> Decision {
    if unusable {
        return Decision {
            action: Action::Empty,
            next_cache: None,
        };
    }
    let previous = view.state().unwrap_or_default();
    if previous.injected {
        return Decision {
            action: Action::Stop,
            next_cache: Some(CacheState {
                injected: false,
                last_on: false,
                last_available: false,
                last_revision: previous.last_revision,
                last_emit: Some(format!("{}:unavailable", event.hook_event_name)),
            }),
        };
    }
    Decision {
        action: Action::Empty,
        next_cache: Some(CacheState {
            injected: false,
            last_on: previous.last_on,
            last_available: false,
            last_revision: previous.last_revision,
            last_emit: previous.last_emit,
        }),
    }
}

fn emit_tag(event: &HookEvent, revision: u64) -> String {
    let source = event
        .source
        .as_ref()
        .map(|source| format!("{source:?}"))
        .unwrap_or_else(|| "none".into());
    format!("{}:{source}:{revision}", event.hook_event_name)
}

fn on_cache(status: &ObserverStatus, event: &HookEvent) -> CacheState {
    CacheState {
        injected: true,
        last_on: true,
        last_available: true,
        last_revision: status.policy_revision,
        last_emit: Some(emit_tag(event, status.policy_revision)),
    }
}

fn on_cache_keep_emit(status: &ObserverStatus, last_emit: Option<String>) -> CacheState {
    CacheState {
        injected: true,
        last_on: true,
        last_available: true,
        last_revision: status.policy_revision,
        last_emit,
    }
}

fn off_cache(status: &ObserverStatus, last_available: bool, last_emit: Option<String>) -> CacheState {
    CacheState {
        injected: false,
        last_on: false,
        last_available,
        last_revision: status.policy_revision,
        last_emit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::SessionSource;

    fn event(name: &str, source: Option<SessionSource>) -> HookEvent {
        HookEvent {
            hook_event_name: name.into(),
            session_id: "s1".into(),
            source,
            is_subagent: false,
            child_skip: None,
        }
    }

    fn on(rev: u64) -> ObserverStatus {
        ObserverStatus {
            enabled: true,
            paused: false,
            allowed: true,
            reason: "ok".into(),
            policy_revision: rev,
        }
    }

    fn focused(rev: u64) -> ObserverStatus {
        ObserverStatus {
            enabled: true,
            paused: false,
            allowed: false,
            reason: "board_focused".into(),
            policy_revision: rev,
        }
    }

    fn off(rev: u64) -> ObserverStatus {
        ObserverStatus {
            enabled: false,
            paused: false,
            allowed: false,
            reason: "disabled".into(),
            policy_revision: rev,
        }
    }

    fn paused(rev: u64) -> ObserverStatus {
        ObserverStatus {
            enabled: true,
            paused: true,
            allowed: false,
            reason: "paused".into(),
            policy_revision: rev,
        }
    }

    #[test]
    fn first_off_is_silent() {
        let d = decide(&event("SessionStart", Some(SessionSource::Startup)), Some(&off(0)), CacheView::Missing);
        assert_eq!(d.action, Action::Empty);
    }

    #[test]
    fn on_startup_bootstraps_and_next_prompt_is_silent() {
        let first = decide(&event("SessionStart", Some(SessionSource::Startup)), Some(&on(1)), CacheView::Missing);
        assert_eq!(first.action, Action::Bootstrap);
        let second = decide(
            &event("UserPromptSubmit", None),
            Some(&on(1)),
            CacheView::Present(first.next_cache.unwrap()),
        );
        assert_eq!(second.action, Action::Empty);
    }

    #[test]
    fn force_refresh_repeats_for_each_real_resume_compact_clear() {
        let mut cache = CacheView::Missing;
        for source in [SessionSource::Resume, SessionSource::Resume, SessionSource::Compact, SessionSource::Clear] {
            let d = decide(&event("SessionStart", Some(source.clone())), Some(&on(3)), cache);
            assert_eq!(d.action, Action::Bootstrap, "{source:?}");
            let prompt = decide(
                &event("UserPromptSubmit", None),
                Some(&on(3)),
                CacheView::Present(d.next_cache.clone().unwrap()),
            );
            assert_eq!(prompt.action, Action::Empty, "unchanged prompt after {source:?}");
            cache = CacheView::Present(d.next_cache.unwrap());
        }
    }

    #[test]
    fn stale_on_after_newer_off_is_ignored() {
        let cache = CacheState {
            injected: false,
            last_on: false,
            last_available: true,
            last_revision: 6,
            last_emit: None,
        };
        let d = decide(&event("SessionStart", Some(SessionSource::Startup)), Some(&on(5)), CacheView::Present(cache.clone()));
        assert_eq!(d.action, Action::Empty);
        let kept = d.next_cache.unwrap();
        assert_eq!(kept.last_revision, 6);
        assert!(!kept.injected);
    }

    #[test]
    fn stale_off_after_newer_on_does_not_stop() {
        let cache = CacheState {
            injected: true,
            last_on: true,
            last_available: true,
            last_revision: 6,
            last_emit: None,
        };
        let d = decide(&event("UserPromptSubmit", None), Some(&off(5)), CacheView::Present(cache));
        assert_eq!(d.action, Action::Empty);
        let next = d.next_cache.unwrap();
        assert!(next.injected);
        assert_eq!(next.last_revision, 6);
    }

    #[test]
    fn offline_stop_keeps_known_revision() {
        let cache = CacheState {
            injected: true,
            last_on: true,
            last_available: true,
            last_revision: 4,
            last_emit: None,
        };
        let d = decide(&event("UserPromptSubmit", None), None, CacheView::Present(cache));
        assert_eq!(d.action, Action::Stop);
        assert_eq!(d.next_cache.unwrap().last_revision, 4);
    }

    #[test]
    fn busy_is_always_empty() {
        let d = decide(&event("SessionStart", Some(SessionSource::Startup)), Some(&on(1)), CacheView::Busy);
        assert_eq!(d.action, Action::Empty);
    }

    #[test]
    fn off_after_on_stops_once() {
        let cache = CacheState {
            injected: true,
            last_on: true,
            last_available: true,
            last_revision: 1,
            last_emit: None,
        };
        let stop = decide(&event("UserPromptSubmit", None), Some(&off(2)), CacheView::Present(cache));
        assert_eq!(stop.action, Action::Stop);
        let again = decide(
            &event("UserPromptSubmit", None),
            Some(&off(2)),
            CacheView::Present(stop.next_cache.unwrap()),
        );
        assert_eq!(again.action, Action::Empty);
    }

    #[test]
    fn missed_startup_is_filled_on_first_prompt() {
        let d = decide(&event("UserPromptSubmit", None), Some(&on(1)), CacheView::Missing);
        assert_eq!(d.action, Action::Bootstrap);
    }

    #[test]
    fn unusable_cache_does_not_repeat_on_prompt() {
        let start = decide(
            &event("SessionStart", Some(SessionSource::Startup)),
            Some(&on(1)),
            CacheView::Unusable,
        );
        assert_eq!(start.action, Action::Bootstrap);
        let prompt = decide(&event("UserPromptSubmit", None), Some(&on(1)), CacheView::Unusable);
        assert_eq!(prompt.action, Action::Empty);
    }

    #[test]
    fn board_focus_does_not_stop_injected_on() {
        let cache = CacheState {
            injected: true,
            last_on: true,
            last_available: true,
            last_revision: 1,
            last_emit: Some("SessionStart:Startup:1".into()),
        };
        let d = decide(
            &event("UserPromptSubmit", None),
            Some(&focused(1)),
            CacheView::Present(cache),
        );
        assert_eq!(d.action, Action::Empty);
        assert!(d.next_cache.unwrap().injected);
    }

    #[test]
    fn pause_then_resume_bootstraps_again() {
        let on_cache_state = CacheState {
            injected: true,
            last_on: true,
            last_available: true,
            last_revision: 1,
            last_emit: None,
        };
        let stopped = decide(&event("UserPromptSubmit", None), Some(&paused(2)), CacheView::Present(on_cache_state));
        assert_eq!(stopped.action, Action::Stop);
        let resumed = decide(
            &event("UserPromptSubmit", None),
            Some(&on(3)),
            CacheView::Present(stopped.next_cache.unwrap()),
        );
        assert_eq!(resumed.action, Action::Bootstrap);
    }
}

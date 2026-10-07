//! One authorized execution request prepares an autonomous run and, for native agents,
//! claims it. Durable child receipts let a retry resume preparation without another run.

use serde_json::{json, Value};
use spellcast_core::{inbox::now_ms, SpellcastError};

use crate::{sigil_run::AgentRunOp, sigil_store::{check_revision, Applied},
    sigil_workspace::{request_hash, validate_request_id},
    sigils::{validate_sigil_id, SigilActor, SigilAutomation, SigilState}, Bridge};

impl Bridge {
    pub(crate) async fn sigil_execute(&self, id: &str, request_id: &str, expected_revision: u64,
        actor: &SigilActor) -> Result<Value, SpellcastError> {
        let fail = |error: String| SpellcastError::user(error);
        validate_request_id(request_id)?;
        validate_sigil_id(id).map_err(fail)?;
        let hash = request_hash(&json!({"op": "execute", "sigil_id": id,
            "expected_revision": expected_revision, "actor": actor, "automation": "autonomous"}));
        // Reserve the request before any filesystem work. The original state/revision, not
        // today's state, determines the stable freeze and start requests on every retry.
        let reserved = self.sigil_store()?.sigil_apply(request_id, &hash, id, now_ms(), None, |current, events| {
            let sigil = current.ok_or("法阵不存在。")?;
            check_revision(&sigil, expected_revision)?;
            if !matches!(sigil.state, SigilState::Draft | SigilState::Frozen) {
                return Err("只有草稿或尚未开始的冻结法阵可以启动；已有运行请继续原运行。".into());
            }
            if actor.kind != "user" {
                let source = actor.source_id.as_deref().ok_or("启动缺少原生任务来源。")?;
                if actor.kind != "agent" || source.starts_with("client:") || sigil.updated_by.kind == "client" {
                    return Err("客户端草稿需要在 Spellcast 窗口启动；客户端写入不会授权执行。".into());
                }
                if !sigil.owner_source.is_empty() && sigil.owner_source != source {
                    return Err("只能直接启动你编写的法阵；其他会话的方案需要用户在窗口启动。".into());
                }
            }
            events.push(("execution_requested".into(), json!({"actor": actor,
                "revision": expected_revision, "automation": "autonomous"})));
            Ok(Applied::Write { sigil: Box::new(sigil), history: None, created: false })
        }).map_err(fail)?;
        let original = reserved.sigil.ok_or_else(|| fail("启动请求缺少方案记录。".into()))?;
        // Hash the parent identity into bounded child IDs, even for 120-character requests.
        let child = |stage: &str| format!("execute-{}-{stage}", request_hash(&json!(request_id)));
        let start_revision = if original.state == SigilState::Draft {
            self.sigil_freeze_as(id, &child("freeze"), expected_revision, actor)?;
            expected_revision.checked_add(1).ok_or_else(|| fail("方案版本超出范围。".into()))?
        } else { expected_revision };
        self.sigil_start_with_automation(id, &child("start"), start_revision, SigilAutomation::Autonomous, actor).await?;
        if let Some(source) = actor.source_id.as_deref().filter(|_| actor.kind == "agent") {
            let claim_hash = request_hash(&json!({"op": "claim", "sigil_id": id, "actor": actor}));
            let mut answer = self.sigil_agent_run(&child("claim"), &claim_hash, id, source, &actor.label, AgentRunOp::Claim).await?;
            answer["replayed"] = json!(reserved.replayed);
            return Ok(answer);
        }
        let sigil = self.sigil_store()?.sigil_get(id).map_err(fail)?;
        Ok(json!({"sigil_id": id, "sigil": sigil, "replayed": reserved.replayed}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Headless, sigil_workspace::{SigilAgentOp, SigilUpdate}, sigils::{SigilLocation, SigilPlan, SigilStep}};

    struct Fixture { root: std::path::PathBuf, repo: std::path::PathBuf, bridge: Option<Bridge> }
    impl Drop for Fixture {
        fn drop(&mut self) { drop(self.bridge.take()); let _ = std::fs::remove_dir_all(&self.root); }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sigil-execute-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [vec!["init", "-q"], vec!["add", "-A"], vec!["commit", "--allow-empty", "-q", "-m", "init"]] {
            let out = std::process::Command::new("git").args(["-c", "user.name=Sigil Test", "-c", "user.email=sigil@test.invalid", "-c", "commit.gpgsign=false"])
                .args(args).current_dir(&repo).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let bridge = Bridge::open(Headless, 0, &root.join("state.sqlite3")).unwrap();
        Fixture { root, repo, bridge: Some(bridge) }
    }
    async fn draft(f: &Fixture, id: &str, location: SigilLocation) {
        let step: SigilStep = serde_json::from_value(json!({"id":"one", "title":"One", "instructions":"Work", "checks":[]})).unwrap();
        let plan = SigilPlan { title: "Execute once".into(), repository: f.repo.to_string_lossy().into(), location, steps: vec![step], ..Default::default() };
        f.bridge.as_ref().unwrap().sigil_agent_update(SigilUpdate { request_id: format!("{id}-plan"), sigil_id: id.into(), source_id: "codex:author".into(),
            label: "Author".into(), op: SigilAgentOp::PutPlan { expected_revision: 0, plan } }).await.unwrap();
    }
    fn actor(source: &str) -> SigilActor { SigilActor { kind: "agent".into(), source_id: Some(source.into()), label: "Author".into() } }

    #[tokio::test]
    async fn autonomous_execute_freezes_starts_claims_and_replays_without_a_second_worktree() {
        let f = fixture(); draft(&f, "one", SigilLocation::Worktree).await;
        let b = f.bridge.as_ref().unwrap();
        let first = b.sigil_agent_update(SigilUpdate { request_id: "execute-once".into(), sigil_id: "one".into(), source_id: "codex:author".into(),
            label: "Author".into(), op: SigilAgentOp::Execute { expected_revision: 1 } }).await.unwrap();
        assert_eq!(first["status"], "accepted");
        let current = b.sigil_store().unwrap().sigil_get("one").unwrap();
        assert_eq!(current.state, SigilState::Running);
        let run = current.run.unwrap();
        assert_eq!(run.automation, SigilAutomation::Autonomous);
        assert_eq!(run.executor.unwrap().source_id, "codex:author");
        let retry = b.sigil_execute("one", "execute-once", 1, &actor("codex:author")).await.unwrap();
        assert_eq!(retry["replayed"], true);
        assert_eq!(b.sigil_store().unwrap().sigil_get("one").unwrap().run.unwrap().started_at_ms, run.started_at_ms);
        assert!(b.sigil_execute("one", "execute-once", 2, &actor("codex:author")).await.is_err());
        assert!(b.sigil_execute("one", "new-run", 3, &actor("codex:author")).await.is_err());
        let out = std::process::Command::new("git").args(["worktree", "list", "--porcelain"]).current_dir(&f.repo).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).lines().filter(|line| line.starts_with("worktree ")).count(), 2);
    }

    #[tokio::test]
    async fn execute_refuses_other_sources_and_client_drafts_before_preparation() {
        let f = fixture(); draft(&f, "owned", SigilLocation::InPlace).await;
        let b = f.bridge.as_ref().unwrap();
        assert!(b.sigil_execute("owned", "other", 1, &actor("codex:other")).await.unwrap_err().to_string().contains("你编写"));
        b.sigil_store().unwrap().sigil_record("owned", None, |sigil, _| {
            sigil.owner_source.clear(); sigil.updated_by.kind = "client".into(); Some(None)
        }).unwrap();
        assert!(b.sigil_execute("owned", "client", 1, &actor("codex:author")).await.unwrap_err().to_string().contains("客户端草稿"));
        let untouched = b.sigil_store().unwrap().sigil_get("owned").unwrap();
        assert!(untouched.freeze.is_none() && untouched.run.is_none());
        let window = b.sigil_execute("owned", "window", 1, &SigilActor::user()).await.unwrap();
        assert_eq!(window["sigil"]["run"]["automation"], "autonomous");
        assert!(window["sigil"]["run"].get("executor").is_none());
    }

    #[tokio::test]
    async fn execute_retry_resumes_after_preparation_failed_and_manual_review_remains_truthful() {
        let f = fixture(); draft(&f, "resume", SigilLocation::Worktree).await;
        let b = f.bridge.as_ref().unwrap();
        b.sigil_freeze("resume", "resume-freeze", 1).unwrap();
        let target = f.root.join("repo.sigils").join("resume");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.txt"), "existing content").unwrap();
        assert!(b.sigil_execute("resume", "resume-execute", 2, &actor("codex:author")).await.unwrap_err().to_string().contains("已存在"));
        assert_eq!(std::fs::read_to_string(target.join("keep.txt")).unwrap(), "existing content");
        assert_eq!(b.sigil_store().unwrap().sigil_get("resume").unwrap().state, SigilState::Frozen);
        // Only the fixture's deliberately created obstruction is removed.
        std::fs::remove_file(target.join("keep.txt")).unwrap(); std::fs::remove_dir(&target).unwrap();
        let answer = b.sigil_execute("resume", "resume-execute", 2, &actor("codex:author")).await.unwrap();
        assert_eq!(answer["status"], "accepted");
        assert_eq!(answer["replayed"], true);
        b.sigil_store().unwrap().sigil_record("resume", None, |sigil, _| {
            sigil.plan.steps[0].checks = vec![serde_json::from_value(json!({"kind":"manual", "label":"Appearance", "description":"Review later"})).unwrap()];
            Some(None)
        }).unwrap();
        b.sigil_agent_update(SigilUpdate { request_id: "manual-report".into(), sigil_id: "resume".into(), source_id: "codex:author".into(), label: "Author".into(),
            op: SigilAgentOp::ReportStep { step_id: "one".into(), summary: "Ready".into(), evidence: vec![] } }).await.unwrap();
        let completed = b.sigil_store().unwrap().sigil_get("resume").unwrap();
        assert_eq!(completed.state, SigilState::Completed);
        assert_eq!(completed.run.unwrap().steps["one"].checks[0].status, crate::sigils::CheckStatus::Deferred);
        let rejected = b.sigil_decide_check("resume", "review-failed", "one", 0, false, "Needs polish").unwrap();
        assert_eq!(rejected["sigil"]["state"], "completed");
        assert_eq!(rejected["sigil"]["run"]["steps"]["one"]["checks"][0]["status"], "failed");
        let next = b.sigil_next("resume").unwrap();
        assert!(next["next"].is_null());
        assert_eq!(next["remaining"], 0);
        assert!(b.sigil_query(crate::sigil_workspace::SigilQuery { view: "sigil".into(), sigil_id: "resume".into(), ..Default::default() }).unwrap()["next"].is_null());
    }
}

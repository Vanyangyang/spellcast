use super::test_support::*;
use super::*;

#[test]
fn decisions_must_be_structured_and_bound_to_the_dispatched_ticket() {
    let ready = br#"{"status":"ready","observer_id":"a","thought":{"tease":"A concrete aside"}}"#;
    assert_eq!(
        parse_decision(ready, "a").unwrap().unwrap().tease,
        "A concrete aside"
    );
    assert!(parse_decision(ready, "b").is_err());
    assert!(parse_decision(
        br#"{"status":"ready","observer_id":"a","thought":null}"#,
        "a"
    )
    .is_err());
    assert!(parse_decision(
        br#"{"status":"silent","observer_id":"b","thought":null}"#,
        "a"
    )
    .is_err());
    assert!(parse_decision(
        br#"{"status":"silent","observer_id":"a","thought":{"tease":"unexpected"}}"#,
        "a"
    )
    .is_err());
    assert!(parse_decision(br#"{"status":"unavailable"}"#, "a").is_err());
    assert!(parse_decision(
        br#"{"status":"silent","observer_id":"a","thought":null}"#,
        "a"
    )
    .unwrap()
    .is_none());
    assert!(parse_decision(
        br#"{"status":"ready","observer_id":"a","thought":{"tease":"   "}}"#,
        "a"
    )
    .is_err());
}

#[test]
fn runner_checks_exit_status_and_output_not_just_process_completion() {
    let f = Fixture::new();
    let runner = f.runner();
    let cancelled = AtomicBool::new(false);
    let thought = run(&runner, &brief("good", "finish-ready", 10_000), &cancelled)
        .unwrap()
        .unwrap();
    assert!(thought.tease.contains("good/finish-ready"));
    assert!(run(
        &runner,
        &brief("quiet", "finish-silent", 10_000),
        &cancelled
    )
    .unwrap()
    .is_none());
    assert!(run(
        &runner,
        &brief("failed", "finish-failed", 10_000),
        &cancelled
    )
    .is_err());
    assert!(run(&runner, &brief("bad", "finish-invalid", 10_000), &cancelled).is_err());
}

#[test]
fn cancellation_kills_the_runner_and_its_real_descendant() {
    let f = Fixture::new();
    let runner = f.runner();
    let token = Arc::new(AtomicBool::new(false));
    let other = token.clone();
    let handle = std::thread::spawn(move || run(&runner, &brief("cancel", "tree", 30_000), &other));
    let started = f.wait_started("cancel");
    let child = f.child("cancel");
    token.store(true, Ordering::Release);
    assert!(handle.join().unwrap().is_err());
    assert_exited(started["pid"].as_u64().unwrap() as u32);
    assert_exited(child);
    assert!(!f.0.join("cancel.late").exists());
}

#[test]
fn expiry_ends_a_blocked_runner_without_a_followup_checkpoint() {
    let f = Fixture::new();
    let runner = f.runner();
    let began = Instant::now();
    let handle = std::thread::spawn(move || {
        run(
            &runner,
            &brief("expired", "hold", 2_000),
            &AtomicBool::new(false),
        )
    });
    let started = f.wait_started("expired");
    assert!(handle.join().unwrap().is_err());
    assert!(began.elapsed() < Duration::from_secs(8));
    assert_exited(started["pid"].as_u64().unwrap() as u32);
}

#[test]
fn normal_exit_reaps_descendants_and_bounded_output_cannot_keep_a_job_alive() {
    let f = Fixture::new();
    let runner = f.runner();
    let cancelled = AtomicBool::new(false);
    assert!(
        run(&runner, &brief("normal", "finish-tree", 10_000), &cancelled)
            .unwrap()
            .is_some()
    );
    assert_exited(f.child("normal"));
    let began = Instant::now();
    assert!(run(&runner, &brief("large", "large", 30_000), &cancelled).is_err());
    assert!(began.elapsed() < Duration::from_secs(8));
    let started = f.started("large").unwrap();
    assert_exited(started["pid"].as_u64().unwrap() as u32);
}

#[test]
fn expired_or_cancelled_work_never_starts_a_process() {
    let f = Fixture::new();
    let runner = f.runner();
    assert!(run(&runner, &brief("old", "hold", 0), &AtomicBool::new(false)).is_err());
    assert!(run(
        &runner,
        &brief("cancelled", "hold", 10_000),
        &AtomicBool::new(true)
    )
    .is_err());
    let mut wrong_provider = brief("codex", "hold", 10_000);
    wrong_provider.provider = "codex".into();
    assert!(run(&runner, &wrong_provider, &AtomicBool::new(false)).is_err());
    assert!(
        f.started("old").is_none()
            && f.started("cancelled").is_none()
            && f.started("codex").is_none()
    );
}

#[cfg(windows)]
#[test]
fn node_paths_preserve_unicode_and_unc_without_verbatim_prefixes() {
    assert_eq!(
        node_path(PathBuf::from(r"\\?\C:\旁念 测试\runner.mjs")),
        PathBuf::from(r"C:\旁念 测试\runner.mjs")
    );
    assert_eq!(
        node_path(PathBuf::from(r"\\?\UNC\server\share\runner.mjs")),
        PathBuf::from(r"\\server\share\runner.mjs")
    );
}

#[cfg(windows)]
#[test]
fn a_suspended_child_that_never_joined_the_job_is_still_reaped() {
    let f = Fixture::new();
    let runner = f.runner();
    let mut command = Command::new(&runner.node);
    command
        .arg(&runner.script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let tree = ProcessTree::prepare(&mut command).unwrap();
    let child = command.spawn().unwrap();
    let pid = child.id();
    let began = Instant::now();
    // This is the exact ownership state when AssignProcessToJobObject fails: suspended,
    // outside the job, and therefore unaffected by TerminateJobObject.
    drop(OwnedProcess { child, tree });
    assert!(began.elapsed() < Duration::from_secs(5));
    assert_exited(pid);
}

#[test]
fn cancelled_intermediate_replacements_cannot_bypass_the_original_source_gate() {
    let f = Fixture::new();
    let dispatcher = ObserverDispatcher::new(f.runner(), Weak::new());
    let gate = Arc::new(Mutex::new(()));
    dispatcher
        .gates
        .lock()
        .unwrap()
        .insert("serial".into(), Arc::downgrade(&gate));
    // Model an old process that is still being reaped. Any number of cancelled waiters must
    // leave this exclusion intact, rather than releasing a direct-predecessor completion flag.
    let held = gate.lock().unwrap();
    let a = dispatcher
        .schedule(brief("serial", "plan-a", 30_000))
        .unwrap();
    drop(a);
    let b = dispatcher
        .schedule(brief("serial", "plan-b", 30_000))
        .unwrap();
    drop(b);
    let c = dispatcher
        .schedule(brief("serial", "plan-c", 30_000))
        .unwrap();
    wait(|| dispatcher.active() == 1);
    assert!(f.started("serial").is_none());
    drop(held);
    assert_eq!(f.wait_started("serial")["mode"], "plan-c");
    f.release("serial");
    wait(|| dispatcher.active() == 0);
    drop(c);
}

#[cfg(windows)]
#[test]
fn shutdown_barrier_waits_until_a_suspended_child_is_assigned_or_reaped() {
    let f = Fixture::new();
    let dispatcher = Arc::new(ObserverDispatcher::new(f.runner(), Weak::new()));
    let gate = dispatcher.spawn_gate.clone();
    let runner = f.runner();
    let (pid_tx, pid_rx) = mpsc::sync_channel(1);
    let (resume_tx, resume_rx) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        let startup = gate.lock().unwrap();
        let mut command = Command::new(&runner.node);
        command
            .arg(&runner.script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let tree = ProcessTree::prepare(&mut command).unwrap();
        let child = command.spawn().unwrap();
        let owned = OwnedProcess { child, tree };
        pid_tx.send(owned.child.id()).unwrap();
        resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        owned.tree.adopt(&owned.child).unwrap();
        drop(startup);
        drop(owned);
    });
    let pid = pid_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (waiting_tx, waiting_rx) = mpsc::sync_channel(1);
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let shutting_down = dispatcher.clone();
    let shutdown = std::thread::spawn(move || {
        waiting_tx.send(()).unwrap();
        shutting_down.synchronize_spawns();
        done_tx.send(()).unwrap();
    });
    waiting_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "shutdown must not return while the child is still outside its Job"
    );
    resume_tx.send(()).unwrap();
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.join().unwrap();
    shutdown.join().unwrap();
    assert_exited(pid);
}

#[test]
fn a_cancelled_worker_waiting_to_spawn_never_creates_a_child() {
    let f = Fixture::new();
    let runner = f.runner();
    let gate = Arc::new(Mutex::new(()));
    let held = gate.lock().unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let token = cancelled.clone();
    let other_gate = gate.clone();
    let (waiting_tx, waiting_rx) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        waiting_tx.send(()).unwrap();
        run_with_spawn_gate(
            &runner,
            &brief("shutdown", "hold", 10_000),
            &token,
            &other_gate,
        )
    });
    waiting_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    cancelled.store(true, Ordering::Release);
    drop(held);
    assert!(worker.join().unwrap().is_err());
    assert!(f.started("shutdown").is_none());
}

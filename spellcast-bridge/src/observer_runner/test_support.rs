use super::*;
use crate::observer::{CheckpointRequest, ProjectSnapshot};
use serde_json::Value;

pub(crate) struct Fixture(pub(crate) PathBuf);

impl Fixture {
    pub(crate) fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("spellcast-observer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("runner.mjs"), r#"
import fs from 'node:fs';
import { spawn } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const brief = JSON.parse(input);
const mode = brief.snapshot.change;
const key = encodeURIComponent(brief.source_id);
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
if (mode.includes('tree')) {
  spawn(process.execPath, ['-e',
    "const fs=require('node:fs'); fs.writeFileSync(process.argv[1],String(process.pid)); setTimeout(()=>fs.writeFileSync(process.argv[2],'escaped'),10000)",
    key + '.child', key + '.late'], { stdio: 'inherit' }).unref();
  while (!fs.existsSync(key + '.child')) await pause();
}
fs.writeFileSync(key + '.started', JSON.stringify({
  pid: process.pid, id: brief.observer_id, source: brief.source_id,
  locale: brief.locale, mode, provider: brief.provider
}));
if (mode === 'large') {
  process.stdout.write('x'.repeat(140000));
  await new Promise(resolve => setTimeout(resolve, 30000));
}
if (!mode.startsWith('finish')) {
  while (!fs.existsSync(key + '.release')) await pause();
}
if (mode === 'finish-failed') { process.exitCode = 1; }
else if (mode === 'finish-invalid') { process.stdout.write('not a decision'); }
else process.stdout.write(JSON.stringify({
  status: mode === 'finish-silent' ? 'silent' : 'ready',
  observer_id: brief.observer_id,
  thought: mode === 'finish-silent' ? null : { tease: '旁念结果：' + brief.source_id + '/' + mode }
}));
"#).unwrap();
        Self(dir)
    }

    pub(crate) fn runner(&self) -> ClaudeObserverRunner {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = std::env::var_os("PATH")
            .and_then(|path| {
                std::env::split_paths(&path)
                    .filter(|path| path.is_absolute())
                    .map(|path| path.join(name))
                    .find(|path| path.is_file())
            })
            .expect("observer process tests require the installed Node runtime");
        ClaudeObserverRunner::new(node, self.0.join("runner.mjs")).unwrap()
    }

    pub(crate) fn started(&self, source: &str) -> Option<Value> {
        std::fs::read(self.0.join(format!("{source}.started")))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub(crate) fn wait_started(&self, source: &str) -> Value {
        wait(|| self.started(source).is_some());
        self.started(source).unwrap()
    }

    pub(crate) fn release(&self, source: &str) {
        std::fs::write(self.0.join(format!("{source}.release")), "").unwrap();
    }

    pub(crate) fn child(&self, source: &str) -> u32 {
        std::fs::read_to_string(self.0.join(format!("{source}.child")))
            .unwrap()
            .parse()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only the unique directory created by this fixture is removed.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn wait(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !check() {
        assert!(
            Instant::now() < deadline,
            "observer condition did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(crate) fn checkpoint(source: &str, change: &str) -> CheckpointRequest {
    CheckpointRequest {
        source_id: source.into(),
        snapshot: Some(ProjectSnapshot {
            checkpoint_id: change.into(),
            project: "Observer regression".into(),
            goal: "Main reply finishes independently".into(),
            change: change.into(),
            facts: vec![],
        }),
    }
}

pub(crate) fn brief(source: &str, change: &str, lease: u64) -> ObserverBrief {
    ObserverBrief {
        observer_id: uuid::Uuid::new_v4().to_string(),
        source_id: source.into(),
        provider: "claude".into(),
        locale: "zh-CN".into(),
        snapshot: checkpoint(source, change).snapshot.unwrap(),
        expires_at_ms: spellcast_core::inbox::now_ms() + lease,
    }
}

#[cfg(windows)]
pub(crate) fn assert_exited(pid: u32) {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    const SYNCHRONIZE: u32 = 0x0010_0000;
    wait(|| unsafe {
        // The PID is read only from a process created by this fixture.
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return true;
        }
        let exited = WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
        CloseHandle(handle);
        exited
    });
}

#[cfg(not(windows))]
pub(crate) fn assert_exited(pid: u32) {
    wait(|| unsafe { libc::kill(pid as libc::pid_t, 0) != 0 });
}

//! Isolated measurement of the actual notification code; no production data is used.
#![allow(dead_code)]
#[path = "../src/completion_hook.rs"]
mod completion_hook;
#[path = "../src/completion_read.rs"]
mod completion_read;
#[path = "../src/configure.rs"]
mod configure;

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Instant};

fn sample(mut run: impl FnMut(), count: usize) -> Value {
    let mut micros = Vec::with_capacity(count);
    for _ in 0..count {
        let started = Instant::now();
        run();
        micros.push(started.elapsed().as_secs_f64() * 1_000_000.0);
    }
    micros.sort_by(f64::total_cmp);
    json!({"samples":count,"median_us":micros[count/2],
        "p95_us":micros[((count as f64 * 0.95).ceil() as usize - 1).min(count-1)],
        "max_us":micros[count-1]})
}

fn scenario(root: &Path, name: &str, history: usize, pending: usize, bytes: usize, unread: bool) -> Value {
    let root = root.join(name);
    fs::create_dir(&root).unwrap();
    let mut inbox = completion_hook::inbox(&root).unwrap();
    let tx = inbox.transaction().unwrap();
    for i in 0..history {
        let thread = format!("{i:08x}-1234-4234-9234-123456789abc");
        tx.execute("INSERT INTO completions (thread_id,turn_id,title,summary,project,completed_at_ms,dismissed)
            VALUES (?1,'turn','fixture','summary','performance fixture',0,?2)",
            params![thread, i >= pending]).unwrap();
    }
    tx.commit().unwrap();
    drop(inbox);
    let mut metadata = Connection::open(root.join("state_5.sqlite")).unwrap();
    metadata.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,source TEXT);").unwrap();
    let tx = metadata.transaction().unwrap();
    let mut threads = Vec::new();
    for i in 0..pending {
        let thread = format!("{i:08x}-1234-4234-9234-123456789abc");
        tx.execute("INSERT INTO threads VALUES (?1,'fixture','cli')", [&thread]).unwrap();
        if unread { threads.push(thread); }
    }
    tx.commit().unwrap();
    drop(metadata);
    let unrelated: Vec<_> = (0..bytes / 420).map(|i| json!({
        "id":i,"title":"unrelated fixture metadata","flags":[true,false,null],"text":"x".repeat(320)
    })).collect();
    let state = serde_json::to_vec(&json!({"unrelated":unrelated,
        "electron-thread-read-state-v1":{"version":1,"unreadByIdentity":{"account":{"local:fixture":threads}}}
    })).unwrap();
    fs::write(root.join(".codex-global-state.json"), &state).unwrap();
    let items = completion_hook::pending(&root).unwrap();
    let mut sync = completion_read::ReadSync::default();
    sync.synchronize(&root, &root, &items).unwrap();
    let count = if pending >= 100 { 100 } else { 200 };
    let read_sync = sample(|| { sync.synchronize(&root, &root, &items).unwrap(); }, count);
    let fresh_read_sync = sample(|| { completion_read::ReadSync::default().synchronize(&root, &root, &items).unwrap(); }, count);
    completion_hook::visible(&root, &root, &mut sync).unwrap();
    let entire_poll = sample(|| { completion_hook::visible(&root, &root, &mut sync).unwrap(); }, count);
    json!({"name":name,"history":history,"pending":pending,"global_bytes":state.len(),
        "read_sync":read_sync,"fresh_read_sync":fresh_read_sync,"entire_poll":entire_poll})
}

fn main() {
    assert!(!cfg!(debug_assertions), "Run this measurement with --release");
    let root = std::env::args_os().nth(1).expect("Pass a new output directory");
    let root = Path::new(&root);
    fs::create_dir(root).expect("Output directory must not already exist");
    let scenarios = vec![
        scenario(root,"idle",191,0,926_000,false),
        scenario(root,"current_unknown",191,27,926_000,false),
        scenario(root,"current_unread",191,27,926_000,true),
        scenario(root,"large_unread",5000,100,8*1024*1024,true),
    ];
    let report = json!({"evidence":"Release build, synthetic isolated fixtures, warm repeated polls; excludes UI rendering and speech",
        "scenarios":scenarios});
    fs::write(root.join("report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("{}", report);
}

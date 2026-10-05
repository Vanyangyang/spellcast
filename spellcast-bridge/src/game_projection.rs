//! Read-only projections of a connected VESPERIX repository beyond level configuration: the
//! world and regions, missions, design-document mentions and static code references. Every
//! value carries its source path and SHA-256. None of it observes a Run or a player.
use crate::game_config::{self, name_field, GameIssue, GameZoneView, Repository};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

const WORLD_ROOTS: [&str; 3] = ["Assets/Resources/Configs/Worlds", "Assets/Resources/Configs/Regions", "Assets/Resources/Configs/Missions"];
// The document board inventories the whole game-document tree. Mentions still carry exact
// source paths and are leads for review, never a claim that a document is current.
const DESIGN_ROOTS: [&str; 1] = ["Assets/Documents"];
pub const LOOP_SOURCE: &str = "Assets/Documents/GameDesign/Overview.md";
const LEGACY_LOOP_SOURCE: &str = "Assets/Documents/Atlas/domains/cycle.md";
const SKELETON_SOURCE: &str = "Assets/Documents/GameDesign/Skeleton.json";
const CODE_ROOTS: [&str; 1] = ["Assets/Scripts"];
/// Configuration fields whose consumers the object view points at. A text match in C# is a
/// static lead to read, never proof that a player path works.
pub const CODE_FIELDS: [&str; 14] = [
    "SubLocationRoutes", "EntrySubLocationId", "SubLocationRefs", "ContentPoolIds", "ContentPoolWeights", "FirstEntryContent",
    "BossGateContentId", "UnlocksZoneId", "LootPoints", "LootTableId", "AssociatedDataId", "RestContentId", "ShopConfigId", "EliteEncounterRules",
];
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_SKELETON_FILE: u64 = 8 * 1024 * 1024;
const MAX_SKELETON_TEXT: usize = 4 * 1024 * 1024;
const MAX_MENTIONS: usize = 8;
const MAX_CODE_HITS: usize = 8;

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

#[cfg(test)]
mod loop_source_tests {
    use super::*;

    #[test]
    fn current_overview_takes_precedence_and_legacy_repository_falls_back() {
        let root = std::env::temp_dir().join(format!("spellcast-loop-{}", uuid::Uuid::new_v4()));
        let legacy = root.join(LEGACY_LOOP_SOURCE);
        let current = root.join(LOOP_SOURCE);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::create_dir_all(current.parent().unwrap()).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(&legacy, "# 旧循环\n## 四层循环\n| 层级 | 内容 |\n|---|---|\n| 旧 | 旧值 |\n").unwrap();
        let cache = ProjectionCache::default();
        let old = cache.read(&root, true).unwrap().player_loop();
        assert_eq!(old["source"]["path"], LEGACY_LOOP_SOURCE);
        fs::write(&current, "# 新全景\n## 核心循环\n| 层级 | 内容 |\n|---|---|\n| 新 | 新值 |\n").unwrap();
        let new = cache.read(&root, true).unwrap().player_loop();
        assert_eq!(new["source"]["path"], LOOP_SOURCE);
        assert_eq!(new["rows"][0][1], "新值");
        fs::remove_file(current).unwrap();
        assert_eq!(cache.read(&root, true).unwrap().player_loop()["source"]["path"], LEGACY_LOOP_SOURCE);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod skeleton_tests {
    use super::*;

    const DOC_SOURCE: &str = "Assets/Documents/GameDesign/Guide.md";

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("spellcast-skeleton-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(game_config::CONFIG_ROOT)).unwrap();
        fs::create_dir_all(root.join("Assets/Documents/GameDesign")).unwrap();
        fs::write(root.join(DOC_SOURCE), "# Guide\n").unwrap();
        fs::canonicalize(root).unwrap()
    }

    fn model() -> Value {
        json!({
            "schema_version": 1,
            "title": "Game structure",
            "description": "Design map",
            "entry_ids": ["core"],
            "loop": [{"id": "explore", "title": "Explore", "summary": "Travel", "node_ids": ["core", "map"]}],
            "nodes": [
                {"id": "core", "kind": "system", "title": "Core", "summary": "Start", "state": "rules_preserved", "sources": [DOC_SOURCE]},
                {"id": "map", "kind": "structure", "title": "Map", "summary": "Browse", "parent_id": "core", "state": "structure_only", "sources": []}
            ],
            "relations": [{"from": "core", "to": "map", "label": "opens"}]
        })
    }

    fn projected(root: &Path, cache: &ProjectionCache, refresh: bool) -> Value {
        let indexes = cache.read(root, refresh).unwrap();
        let repository = Repository::read(root).unwrap();
        overview(&repository, &indexes)
    }

    #[test]
    fn optional_skeleton_loads_and_refreshes_source_revision() {
        let root = fixture();
        let cache = ProjectionCache::default();
        let missing = projected(&root, &cache, false);
        assert!(missing["skeleton"].is_null());
        assert!(!missing["issues"].as_array().unwrap().iter().any(|issue| issue["path"] == SKELETON_SOURCE));

        let source = root.join(SKELETON_SOURCE);
        fs::write(&source, model().to_string()).unwrap();
        let first = projected(&root, &cache, true);
        assert_eq!(first["skeleton"]["source"]["path"], SKELETON_SOURCE);
        assert_eq!(first["skeleton"]["model"]["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(first["runtime_verified"], false);
        let first_hash = first["skeleton"]["source"]["hash"].as_str().unwrap();
        assert_eq!(first_hash.len(), 64);

        let mut changed = model();
        changed["description"] = json!("Design map updated");
        fs::write(&source, changed.to_string()).unwrap();
        let second = projected(&root, &cache, true);
        assert_ne!(second["skeleton"]["source"]["hash"], first["skeleton"]["source"]["hash"]);
        assert_ne!(second["source_revision"], first["source_revision"]);
        assert_eq!(second["skeleton"]["model"]["description"], "Design map updated");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_invalid_skeleton_is_null_with_visible_issue() {
        let root = fixture();
        let source = root.join(SKELETON_SOURCE);
        let cache = ProjectionCache::default();
        fs::write(&source, "{").unwrap();
        let malformed = projected(&root, &cache, true);
        assert!(malformed["skeleton"].is_null());
        assert!(malformed["issues"].as_array().unwrap().iter().any(|issue| issue["path"] == SKELETON_SOURCE
            && issue["severity"] == "error" && issue["message"].as_str().unwrap().contains("JSON")));

        let mut bad = model();
        bad["nodes"][1]["parent_id"] = json!("missing");
        fs::write(&source, bad.to_string()).unwrap();
        let invalid = projected(&root, &cache, true);
        assert!(invalid["skeleton"].is_null());
        assert!(invalid["issues"].as_array().unwrap().iter().any(|issue| issue["path"] == SKELETON_SOURCE
            && issue["severity"] == "error" && issue["message"].as_str().unwrap().contains("parent_id")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_broken_graph_and_unindexed_or_traversal_sources() {
        let indexed_docs = BTreeSet::from([DOC_SOURCE.to_string()]);
        let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
            ("entry_ids", Box::new(|value| value["entry_ids"] = json!(["map"]))),
            ("重复", Box::new(|value| value["nodes"][1]["id"] = json!("core"))),
            ("无效", Box::new(|value| value["nodes"][1]["kind"] = json!("unknown"))),
            ("无效", Box::new(|value| value["nodes"][1]["state"] = json!("complete"))),
            ("环", Box::new(|value| value["nodes"][0]["parent_id"] = json!("map"))),
            ("不存在", Box::new(|value| value["loop"][0]["node_ids"] = json!(["lost"]))),
            ("不存在", Box::new(|value| value["relations"][0]["to"] = json!("lost"))),
            ("索引", Box::new(|value| value["nodes"][0]["sources"] = json!(["Assets/Documents/GameDesign/Absent.md"]))),
            ("索引", Box::new(|value| value["nodes"][0]["sources"] = json!(["Assets/Documents/../GameDesign/Guide.md"]))),
            ("schema_version", Box::new(|value| value["schema_version"] = json!(2))),
            ("字节", Box::new(|value| value["nodes"][0]["summary"] = json!("x".repeat(2_001)))),
            ("数量", Box::new(|value| value["nodes"] = Value::Array((0..4_097).map(|_| json!({})).collect()))),
            ("数量", Box::new(|value| value["relations"] = Value::Array((0..8_193).map(|_| json!({})).collect()))),
            ("数量", Box::new(|value| value["nodes"][0]["sources"] = json!(vec![DOC_SOURCE; 97]))),
        ];
        for (expected, mutate) in cases {
            let mut value = model();
            mutate(&mut value);
            let error = parse_skeleton(SKELETON_SOURCE, &value.to_string(), &indexed_docs).unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn markdown_index_removal_invalidates_unchanged_skeleton() {
        let root = fixture();
        fs::write(root.join(SKELETON_SOURCE), model().to_string()).unwrap();
        let cache = ProjectionCache::default();
        assert!(!projected(&root, &cache, false)["skeleton"].is_null());
        fs::remove_file(root.join(DOC_SOURCE)).unwrap();
        let updated = projected(&root, &cache, false);
        assert!(updated["skeleton"].is_null());
        assert!(updated["issues"].as_array().unwrap().iter().any(|issue| issue["path"] == SKELETON_SOURCE
            && issue["message"].as_str().unwrap().contains("索引")));
        fs::remove_dir_all(root).unwrap();
    }

    fn enriched_model() -> Value {
        let mut value = model();
        value["nodes"][1]["kind"] = json!("reference");
        value["nodes"][1]["state"] = json!("supporting_reference");
        value["nodes"][1]["sources"] = json!([DOC_SOURCE]);
        value["nodes"][1]["rule"] = json!({"trigger": ["Player enters"], "effects": ["Map opens"]});
        value["nodes"][1]["provenance"] = json!([
            {"path": DOC_SOURCE, "hash": "a".repeat(64), "start_line": 1, "end_line": 2, "quote": "Guide excerpt"},
            {"path": "Assets/Documents/Archive/Never.md", "hash": "b".repeat(64), "start_line": 10, "end_line": 11,
                "quote": "Historical excerpt", "archived": true}
        ]);
        value
    }

    #[test]
    fn accepts_rule_and_active_or_unopened_archived_provenance() {
        let root = fixture();
        fs::write(root.join(SKELETON_SOURCE), enriched_model().to_string()).unwrap();
        // Archive/Never.md does not exist. An archived citation is data, not a file to open.
        let overview = projected(&root, &ProjectionCache::default(), true);
        assert_eq!(overview["skeleton"]["model"]["nodes"][1]["kind"], "reference");
        assert_eq!(overview["skeleton"]["model"]["nodes"][1]["provenance"][1]["archived"], true);
        assert!(!root.join("Assets/Documents/Archive/Never.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_rule_or_provenance_without_opening_history() {
        let indexed_docs = BTreeSet::from([DOC_SOURCE.to_string()]);
        let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
            ("未知字段", Box::new(|value| value["nodes"][1]["rule"]["body"] = json!(["hidden"]))),
            ("数组", Box::new(|value| value["nodes"][1]["rule"]["trigger"] = json!("not array"))),
            ("数量", Box::new(|value| value["nodes"][1]["rule"]["trigger"] = json!(vec!["x"; 65]))),
            ("字节", Box::new(|value| value["nodes"][1]["rule"]["trigger"] = json!(["x".repeat(8_001)]))),
            ("path", Box::new(|value| value["nodes"][1]["provenance"][1]["path"] = json!("Assets/Documents/../Secret.md"))),
            ("path", Box::new(|value| value["nodes"][1]["provenance"][1]["path"] = json!("C:\\Secret.md"))),
            ("hash", Box::new(|value| value["nodes"][1]["provenance"][0]["hash"] = json!("short"))),
            ("hash", Box::new(|value| value["nodes"][1]["provenance"][0]["hash"] = json!("z".repeat(64)))),
            ("start_line", Box::new(|value| value["nodes"][1]["provenance"][0]["start_line"] = json!(0))),
            ("end_line", Box::new(|value| value["nodes"][1]["provenance"][0]["end_line"] = json!(0))),
            ("end_line", Box::new(|value| value["nodes"][1]["provenance"][0]["end_line"] = json!(0.5))),
            ("end_line", Box::new(|value| value["nodes"][1]["provenance"][0]["start_line"] = json!(3))),
            ("quote", Box::new(|value| value["nodes"][1]["provenance"][0]["quote"] = json!(""))),
            ("数量", Box::new(|value| value["nodes"][1]["provenance"] = Value::Array((0..129).map(|_| json!({})).collect()))),
            ("布尔值", Box::new(|value| value["nodes"][1]["provenance"][1]["archived"] = json!("true"))),
            ("sources", Box::new(|value| value["nodes"][1]["sources"] = json!([]))),
            ("索引", Box::new(|value| value["nodes"][1]["provenance"][0]["path"] = json!("Assets/Documents/GameDesign/Absent.md"))),
            ("未知字段", Box::new(|value| value["nodes"][1]["body"] = json!("unbudgeted body"))),
        ];
        for (expected, mutate) in cases {
            let mut value = enriched_model();
            mutate(&mut value);
            let error = parse_skeleton(SKELETON_SOURCE, &value.to_string(), &indexed_docs).unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn skeleton_has_own_file_cap_and_total_rule_text_budget() {
        let root = fixture();
        let path = root.join(SKELETON_SOURCE);
        let indexed_docs = BTreeSet::from([DOC_SOURCE.to_string()]);
        let padded = format!("{}{}", model(), " ".repeat((MAX_FILE + 1) as usize));
        fs::write(&path, padded).unwrap();
        let stamp = Stamp { len: fs::metadata(&path).unwrap().len(), modified: None };
        assert!(read_one(&root, SKELETON_SOURCE, &stamp, &|relative, text| parse_skeleton(relative, text, &indexed_docs)).1.is_ok());
        assert!(read_one(&root, DOC_SOURCE, &stamp, &parse_doc).1.is_err());
        let oversized = Stamp { len: MAX_SKELETON_FILE + 1, modified: None };
        assert!(read_one(&root, SKELETON_SOURCE, &oversized, &|relative, text| parse_skeleton(relative, text, &indexed_docs)).1.is_err());

        let mut large = model();
        let rule = json!({"trigger": vec!["x".repeat(8_000); 48], "conditions": vec!["x".repeat(8_000); 48],
            "effects": vec!["x".repeat(8_000); 48], "exceptions": vec!["x".repeat(8_000); 48],
            "formulas": vec!["x".repeat(8_000); 48], "conflicts": vec!["x".repeat(8_000); 48]});
        large["nodes"][0]["rule"] = rule.clone();
        large["nodes"][1]["rule"] = rule;
        let error = parse_skeleton(SKELETON_SOURCE, &large.to_string(), &indexed_docs).unwrap_err();
        assert!(error.contains("4 MiB"), "unexpected error: {error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expanded_node_and_relation_counts_remain_valid_within_bounds() {
        let mut value = model();
        for index in 0..255 {
            value["nodes"].as_array_mut().unwrap().push(json!({"id": format!("reference_{index}"), "kind": "reference",
                "title": "Reference", "summary": "Source", "state": "supporting_reference", "sources": []}));
        }
        value["relations"] = Value::Array((0..513).map(|_| json!({"from": "core", "to": "map", "label": "opens"})).collect());
        let indexed_docs = BTreeSet::from([DOC_SOURCE.to_string()]);
        assert!(parse_skeleton(SKELETON_SOURCE, &value.to_string(), &indexed_docs).is_ok());
    }

    #[test]
    fn supplied_repository_skeleton_passes_read_and_validation() {
        let Ok(root) = std::env::var("SPELLCAST_SKELETON_REPOSITORY") else { return };
        let root = fs::canonicalize(root).unwrap();
        let docs = refresh_set(&root, None, inventory(&root, &DESIGN_ROOTS, "md", Limits { files: 3_000, bytes: 32 << 20 }), true, parse_doc);
        let indexed_docs: BTreeSet<String> = docs.files.iter().filter(|(_, cached)| cached.value.is_ok()).map(|(path, _)| path.clone()).collect();
        let (files, issues) = skeleton_inventory(&root);
        assert!(issues.is_empty(), "skeleton inventory issues: {:?}", issues);
        let stamp = files.get(SKELETON_SOURCE).expect("supplied repository needs Skeleton.json");
        let (hash, parsed) = read_one(&root, SKELETON_SOURCE, stamp, &|path, text| parse_skeleton(path, text, &indexed_docs));
        let model = parsed.expect("supplied repository skeleton must validate");
        assert_eq!(hash.len(), 64);
        assert!(!model["nodes"].as_array().unwrap().is_empty());
        assert!(!model["loop"].as_array().unwrap().is_empty());
    }
}

struct Cached<T> {
    stamp: Stamp,
    hash: String,
    value: Result<Arc<T>, String>,
}

struct SourceSet<T> {
    files: BTreeMap<String, Cached<T>>,
    issues: Vec<GameIssue>,
}

#[derive(Clone, Copy)]
struct Limits {
    files: usize,
    bytes: u64,
}

fn inventory(root: &Path, roots: &[&str], extension: &str, limits: Limits) -> (BTreeMap<String, Stamp>, Vec<GameIssue>) {
    let mut files = BTreeMap::new();
    let mut issues = Vec::new();
    let mut bytes = 0u64;
    for relative in roots {
        let start = match game_config::checked_path(root, relative, true) {
            Ok(path) => path,
            Err(message) => {
                issues.push(GameIssue { severity: "warning".into(), message, path: (*relative).into() });
                continue;
            }
        };
        let mut pending = vec![start];
        while let Some(directory) = pending.pop() {
            let Ok(entries) = fs::read_dir(&directory) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                let Ok(stripped) = path.strip_prefix(root) else { continue };
                let relative = game_config::display_path(stripped);
                if game_config::linked(&meta) {
                    issues.push(GameIssue { severity: "warning".into(), message: "已跳过链接或重解析路径".into(), path: relative });
                    continue;
                }
                if meta.is_dir() {
                    pending.push(path);
                } else if meta.is_file() && path.extension().and_then(|value| value.to_str()) == Some(extension) {
                    if files.len() >= limits.files || bytes + meta.len() > limits.bytes {
                        issues.push(GameIssue { severity: "warning".into(), message: "来源数量超出本次读取上限，其余文件未索引。".into(), path: (*relative).into() });
                        return (files, issues);
                    }
                    bytes += meta.len();
                    files.insert(relative, Stamp { len: meta.len(), modified: meta.modified().ok() });
                }
            }
        }
    }
    (files, issues)
}

fn read_one<T>(root: &Path, relative: &str, stamp: &Stamp, parse: &(impl Fn(&str, &str) -> Result<T, String> + Sync)) -> (String, Result<Arc<T>, String>) {
    let read = game_config::checked_path(root, relative, false).and_then(|path| {
        let max_file = if relative == SKELETON_SOURCE { MAX_SKELETON_FILE } else { MAX_FILE };
        if stamp.len > max_file { return Err(format!("来源过大：{relative}")); }
        let mut bytes = Vec::with_capacity(stamp.len as usize);
        fs::File::open(path).map_err(|error| error.to_string())?.take(max_file + 1)
            .read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > max_file { return Err(format!("来源过大：{relative}")); }
        Ok(bytes)
    });
    match read {
        Ok(bytes) => {
            let hash = format!("{:x}", Sha256::digest(&bytes));
            let raw = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
            let value = std::str::from_utf8(raw).map_err(|_| format!("来源不是 UTF-8 文本：{relative}")).and_then(|text| parse(relative, text)).map(Arc::new);
            (hash, value)
        }
        Err(message) => (String::new(), Err(message)),
    }
}

/// Unchanged files are reused; changed ones are read in parallel, since cold reads on Windows
/// are dominated by per-file open latency rather than parsing.
fn refresh_set<T: Send + Sync>(root: &Path, previous: Option<&SourceSet<T>>, inventory: (BTreeMap<String, Stamp>, Vec<GameIssue>), force: bool,
    parse: impl Fn(&str, &str) -> Result<T, String> + Sync) -> SourceSet<T> {
    let (stamps, issues) = inventory;
    let mut files = BTreeMap::new();
    let mut pending = Vec::new();
    for (relative, stamp) in stamps {
        if !force {
            if let Some(cached) = previous.and_then(|set| set.files.get(&relative)).filter(|cached| cached.stamp == stamp && stamp.modified.is_some()) {
                files.insert(relative, Cached { stamp, hash: cached.hash.clone(), value: cached.value.clone() });
                continue;
            }
        }
        pending.push((relative, stamp));
    }
    let workers = std::thread::available_parallelism().map_or(4, |count| count.get()).clamp(2, 12);
    let chunk = pending.len().div_ceil(workers).max(1);
    let read: Vec<(String, Stamp, String, Result<Arc<T>, String>)> = std::thread::scope(|scope| {
        let parse = &parse;
        let handles: Vec<_> = pending.chunks(chunk).map(|group| scope.spawn(move || {
            group.iter().map(|(relative, stamp)| {
                let (hash, value) = read_one(root, relative, stamp, parse);
                (relative.clone(), stamp.clone(), hash, value)
            }).collect::<Vec<_>>()
        })).collect();
        handles.into_iter().flat_map(|handle| handle.join().unwrap_or_default()).collect()
    });
    for (relative, stamp, hash, value) in read {
        files.insert(relative, Cached { stamp, hash, value });
    }
    SourceSet { files, issues }
}

/// A Markdown design document: headings and the configuration-like identifiers it mentions.
struct Doc {
    title: String,
    lines: Vec<String>,
    headings: Vec<(usize, String)>,
    mentions: BTreeMap<String, Vec<usize>>,
    /// Lines inside fenced code blocks: literal examples rank after prose that states intent.
    fenced: BTreeSet<usize>,
}

fn identifiers(line: &str) -> impl Iterator<Item = &str> {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|token| token.len() > 4 && token.contains('_') && token.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && token.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
}

fn parse_doc(_: &str, text: &str) -> Result<Doc, String> {
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut headings = Vec::new();
    let mut mentions: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut fenced = false;
    let mut fenced_lines = BTreeSet::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") { fenced = !fenced; }
        if fenced { fenced_lines.insert(index); }
        if !fenced && trimmed.starts_with('#') {
            headings.push((index, trimmed.trim_start_matches('#').trim().to_string()));
        }
        for id in identifiers(line) {
            let entry = mentions.entry(id.to_string()).or_default();
            if entry.len() < 32 && entry.last() != Some(&index) { entry.push(index); }
        }
    }
    let title = headings.first().map(|(_, text)| text.clone()).unwrap_or_default();
    Ok(Doc { title, lines, headings, mentions, fenced: fenced_lines })
}

/// Static C# occurrences of the configuration fields in [`CODE_FIELDS`].
struct Code {
    hits: Vec<(usize, usize, String)>,
}

fn parse_code(_: &str, text: &str) -> Result<Code, String> {
    let mut hits = Vec::new();
    let mut per_field = [0usize; CODE_FIELDS.len()];
    for (line_index, line) in text.lines().enumerate() {
        for (field, name) in CODE_FIELDS.iter().enumerate() {
            if per_field[field] < 3 && line.contains(name) {
                per_field[field] += 1;
                hits.push((field, line_index, line.trim().chars().take(180).collect()));
            }
        }
    }
    Ok(Code { hits })
}

fn parse_json(relative: &str, text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|error| format!("JSON 无法解析 {relative}：{error}"))
}

fn skeleton_inventory(root: &Path) -> (BTreeMap<String, Stamp>, Vec<GameIssue>) {
    let mut files = BTreeMap::new();
    let mut issues = Vec::new();
    match fs::symlink_metadata(root.join(SKELETON_SOURCE)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => issues.push(GameIssue { severity: "error".into(), message: format!("骨架来源无法检查：{error}"), path: SKELETON_SOURCE.into() }),
        Ok(meta) if game_config::linked(&meta) || !meta.is_file() => issues.push(GameIssue {
            severity: "error".into(), message: "骨架来源不是普通文件，或是链接/重解析路径。".into(), path: SKELETON_SOURCE.into(),
        }),
        Ok(meta) => { files.insert(SKELETON_SOURCE.into(), Stamp { len: meta.len(), modified: meta.modified().ok() }); },
    }
    (files, issues)
}

fn skeleton_array<'a>(value: &'a Value, key: &str, context: &str, max: usize, nonempty: bool) -> Result<&'a Vec<Value>, String> {
    let array = value.get(key).and_then(Value::as_array).ok_or_else(|| format!("{context}.{key} 必须是数组"))?;
    if array.len() > max || (nonempty && array.is_empty()) { return Err(format!("{context}.{key} 数量必须在 {}..={max} 内", usize::from(nonempty))); }
    Ok(array)
}

fn skeleton_fields(value: &Value, allowed: &[&str], context: &str) -> Result<(), String> {
    let fields = value.as_object().ok_or_else(|| format!("{context} 必须是对象"))?;
    for key in fields.keys() {
        if !allowed.contains(&key.as_str()) { return Err(format!("{context} 有未知字段：{key}")); }
    }
    Ok(())
}

fn skeleton_document_path(path: &str) -> bool {
    path.starts_with("Assets/Documents/") && path.ends_with(".md")
        && !path.chars().any(|character| character.is_control() || matches!(character, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn skeleton_text<'a>(value: &'a Value, key: &str, context: &str, max: usize, total: &mut usize) -> Result<&'a str, String> {
    let text = value.get(key).and_then(Value::as_str).ok_or_else(|| format!("{context}.{key} 必须是字符串"))?;
    if text.trim().is_empty() || text.len() > max { return Err(format!("{context}.{key} 必须为非空文本且不超过 {max} 字节")); }
    *total += text.len();
    if *total > MAX_SKELETON_TEXT { return Err("骨架文本总量超过 4 MiB".into()); }
    Ok(text)
}

fn skeleton_id<'a>(value: &'a Value, key: &str, context: &str, total: &mut usize) -> Result<&'a str, String> {
    let id = skeleton_text(value, key, context, 120, total)?;
    if !game_config::valid_id(id) { return Err(format!("{context}.{key} 不是稳定 ID（只允许字母、数字、_、-、.）")); }
    Ok(id)
}

fn skeleton_string_items(value: &Value, key: &str, context: &str, max_items: usize, max_text: usize, total: &mut usize) -> Result<Vec<String>, String> {
    let items = skeleton_array(value, key, context, max_items, false)?;
    items.iter().enumerate().map(|(index, item)| {
        let text = item.as_str().ok_or_else(|| format!("{context}.{key}[{index}] 必须是字符串"))?;
        if text.trim().is_empty() || text.len() > max_text { return Err(format!("{context}.{key}[{index}] 必须为非空文本且不超过 {max_text} 字节")); }
        *total += text.len();
        if *total > MAX_SKELETON_TEXT { return Err("骨架文本总量超过 4 MiB".into()); }
        Ok(text.to_string())
    }).collect()
}

fn parse_skeleton(relative: &str, text: &str, indexed_docs: &BTreeSet<String>) -> Result<Value, String> {
    let model = parse_json(relative, text)?;
    skeleton_fields(&model, &["schema_version", "title", "description", "entry_ids", "loop", "nodes", "relations"], "骨架")?;
    if model.get("schema_version").and_then(Value::as_u64) != Some(1) { return Err("骨架 schema_version 必须为 1".into()); }
    let mut total = 0;
    skeleton_text(&model, "title", "骨架", 160, &mut total)?;
    skeleton_text(&model, "description", "骨架", 4_000, &mut total)?;
    let nodes = skeleton_array(&model, "nodes", "骨架", 4_096, true)?;
    let loop_stages = skeleton_array(&model, "loop", "骨架", 32, true)?;
    let relations = skeleton_array(&model, "relations", "骨架", 8_192, false)?;
    let entries = skeleton_string_items(&model, "entry_ids", "骨架", 64, 120, &mut total)?;
    if entries.is_empty() { return Err("骨架.entry_ids 至少需要一个系统入口".into()); }
    if entries.iter().collect::<BTreeSet<_>>().len() != entries.len() { return Err("骨架.entry_ids 存在重复 ID".into()); }

    let mut ids = BTreeSet::new();
    let mut parents = BTreeMap::new();
    let mut kinds = BTreeMap::new();
    for (index, node) in nodes.iter().enumerate() {
        let context = format!("骨架.nodes[{index}]");
        skeleton_fields(node, &["id", "kind", "title", "summary", "parent_id", "state", "notes", "steps", "rule", "provenance", "sources"], &context)?;
        let id = skeleton_id(node, "id", &context, &mut total)?.to_string();
        if !ids.insert(id.clone()) { return Err(format!("节点 ID 重复：{id}")); }
        let kind = skeleton_text(node, "kind", &context, 32, &mut total)?;
        if !matches!(kind, "system" | "region" | "structure" | "rule" | "world" | "reference") { return Err(format!("{context}.kind 无效：{kind}")); }
        kinds.insert(id.clone(), kind.to_string());
        let state = skeleton_text(node, "state", &context, 32, &mut total)?;
        if !matches!(state, "rules_preserved" | "structure_only" | "world_basis" | "supporting_reference" | "needs_reconciliation") { return Err(format!("{context}.state 无效：{state}")); }
        skeleton_text(node, "title", &context, 160, &mut total)?;
        skeleton_text(node, "summary", &context, 2_000, &mut total)?;
        if node.get("parent_id").is_some() {
            let parent = skeleton_id(node, "parent_id", &context, &mut total)?;
            parents.insert(id.clone(), parent.to_string());
        }
        if node.get("notes").is_some() {
            skeleton_string_items(node, "notes", &context, 32, 4_000, &mut total)?;
        }
        if node.get("steps").is_some() {
            let steps = skeleton_array(node, "steps", &context, 32, false)?;
            for (step_index, step) in steps.iter().enumerate() {
                let step_context = format!("{context}.steps[{step_index}]");
                skeleton_fields(step, &["title", "text"], &step_context)?;
                skeleton_text(step, "title", &step_context, 160, &mut total)?;
                skeleton_text(step, "text", &step_context, 4_000, &mut total)?;
            }
        }
        let sources = skeleton_string_items(node, "sources", &context, 96, 512, &mut total)?;
        for source in &sources {
            if !skeleton_document_path(source) || !indexed_docs.contains(source) {
                return Err(format!("{context}.sources 中的路径未在设计文档索引中：{source}"));
            }
        }
        if let Some(rule) = node.get("rule") {
            let rule_context = format!("{context}.rule");
            skeleton_fields(rule, &["trigger", "conditions", "effects", "exceptions", "formulas", "conflicts"], &rule_context)?;
            for key in rule.as_object().unwrap().keys() {
                total += key.len();
                if total > MAX_SKELETON_TEXT { return Err("骨架文本总量超过 4 MiB".into()); }
                skeleton_string_items(rule, key, &rule_context, 64, 8_000, &mut total)?;
            }
        }
        if node.get("provenance").is_some() {
            let records = skeleton_array(node, "provenance", &context, 128, false)?;
            for (evidence_index, evidence) in records.iter().enumerate() {
                let evidence_context = format!("{context}.provenance[{evidence_index}]");
                skeleton_fields(evidence, &["path", "hash", "start_line", "end_line", "quote", "archived"], &evidence_context)?;
                let path = skeleton_text(evidence, "path", &evidence_context, 512, &mut total)?;
                if !skeleton_document_path(path) { return Err(format!("{evidence_context}.path 不是正常的设计文档相对路径：{path}")); }
                let hash = skeleton_text(evidence, "hash", &evidence_context, 64, &mut total)?;
                if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(format!("{evidence_context}.hash 必须是 64 位十六进制 SHA-256"));
                }
                let line = |key: &str| evidence.get(key).and_then(Value::as_u64).filter(|line| *line > 0 && *line <= u32::MAX as u64)
                    .ok_or_else(|| format!("{evidence_context}.{key} 必须是正整数行号"));
                let start = line("start_line")?;
                let end = line("end_line")?;
                if end < start { return Err(format!("{evidence_context}.end_line 不能小于 start_line")); }
                skeleton_text(evidence, "quote", &evidence_context, 8_000, &mut total)?;
                let archived = match evidence.get("archived") {
                    None => false,
                    Some(value) => value.as_bool().ok_or_else(|| format!("{evidence_context}.archived 必须是布尔值"))?,
                };
                if !archived && (!indexed_docs.contains(path) || !sources.iter().any(|source| source == path)) {
                    return Err(format!("{evidence_context}.path 必须在当前文档索引和节点 sources 中：{path}"));
                }
            }
        }
    }
    for (id, parent) in &parents {
        if !ids.contains(parent) { return Err(format!("节点 {id} 的 parent_id 不存在：{parent}")); }
        let mut seen = BTreeSet::new();
        let mut cursor = id.as_str();
        while let Some(next) = parents.get(cursor) {
            if !seen.insert(cursor) { return Err(format!("节点 parent_id 存在环：{id}")); }
            cursor = next;
        }
    }
    for entry in entries {
        if !game_config::valid_id(&entry) || kinds.get(&entry).map(String::as_str) != Some("system") {
            return Err(format!("entry_ids 必须引用现有 system 节点：{entry}"));
        }
    }
    let mut stage_ids = BTreeSet::new();
    for (index, stage) in loop_stages.iter().enumerate() {
        let context = format!("骨架.loop[{index}]");
        skeleton_fields(stage, &["id", "title", "summary", "node_ids"], &context)?;
        let id = skeleton_id(stage, "id", &context, &mut total)?;
        if ids.contains(id) || !stage_ids.insert(id.to_string()) { return Err(format!("循环阶段 ID 重复：{id}")); }
        skeleton_text(stage, "title", &context, 160, &mut total)?;
        skeleton_text(stage, "summary", &context, 2_000, &mut total)?;
        for node_id in skeleton_string_items(stage, "node_ids", &context, 128, 120, &mut total)? {
            if !ids.contains(&node_id) { return Err(format!("{context}.node_ids 引用不存在的节点：{node_id}")); }
        }
    }
    for (index, relation) in relations.iter().enumerate() {
        let context = format!("骨架.relations[{index}]");
        skeleton_fields(relation, &["from", "to", "label"], &context)?;
        for key in ["from", "to"] {
            let id = skeleton_id(relation, key, &context, &mut total)?;
            if !ids.contains(id) { return Err(format!("{context}.{key} 引用不存在的节点：{id}")); }
        }
        skeleton_text(relation, "label", &context, 160, &mut total)?;
    }
    Ok(model)
}

pub struct Indexes {
    world: SourceSet<Value>,
    docs: SourceSet<Doc>,
    code: SourceSet<Code>,
    skeleton: SourceSet<Value>,
}

/// Process-local and bounded like the configuration cache: each read re-inventories, and an
/// explicit refresh re-reads every file.
#[derive(Default)]
pub struct ProjectionCache {
    entries: Mutex<VecDeque<(PathBuf, Arc<Indexes>)>>,
}

impl ProjectionCache {
    pub fn read(&self, root: &Path, refresh: bool) -> Result<Arc<Indexes>, String> {
        let mut entries = self.entries.lock().map_err(|_| "来源索引不可用。")?;
        let previous = entries.iter().position(|(path, _)| path == root).and_then(|index| entries.remove(index)).map(|(_, value)| value);
        let old = previous.as_deref();
        let docs = refresh_set(root, old.map(|value| &value.docs), inventory(root, &DESIGN_ROOTS, "md", Limits { files: 3_000, bytes: 32 << 20 }), refresh, parse_doc);
        let indexed_docs: BTreeSet<String> = docs.files.iter().filter(|(_, cached)| cached.value.is_ok()).map(|(path, _)| path.clone()).collect();
        let doc_paths_changed = old.is_some_and(|previous| previous.docs.files.iter().filter(|(_, cached)| cached.value.is_ok())
            .map(|(path, _)| path.clone()).collect::<BTreeSet<_>>() != indexed_docs);
        let indexes = Arc::new(Indexes {
            world: refresh_set(root, old.map(|value| &value.world), inventory(root, &WORLD_ROOTS, "json", Limits { files: 2_000, bytes: 16 << 20 }), refresh, parse_json),
            code: refresh_set(root, old.map(|value| &value.code), inventory(root, &CODE_ROOTS, "cs", Limits { files: 6_000, bytes: 64 << 20 }), refresh, parse_code),
            skeleton: refresh_set(root, old.map(|value| &value.skeleton), skeleton_inventory(root), refresh || doc_paths_changed,
                |path, text| parse_skeleton(path, text, &indexed_docs)),
            docs,
        });
        entries.push_back((root.to_path_buf(), indexes.clone()));
        while entries.len() > 4 { entries.pop_front(); }
        Ok(indexes)
    }
}

#[derive(Serialize)]
struct SourceRef<'a> {
    path: &'a str,
    hash: &'a str,
}

#[derive(Serialize, Clone)]
pub struct DocMention {
    pub path: String,
    pub hash: String,
    pub title: String,
    pub heading: String,
    pub line: usize,
    pub excerpt: String,
}

impl Indexes {
    pub fn documents(&self) -> Vec<Value> {
        self.docs.files.iter().map(|(path, cached)| {
            match &cached.value {
                Ok(doc) => json!({"path": path, "hash": cached.hash, "title": doc.title,
                    "lines": doc.lines.len(), "headings": doc.headings.len(), "identifiers": doc.mentions.len()}),
                Err(error) => json!({"path": path, "hash": cached.hash, "title": "", "error": error}),
            }
        }).collect()
    }

    pub fn document(&self, path: &str) -> Result<Value, String> {
        let cached = self.docs.files.get(path).ok_or("文档不在已连接仓库的索引中。")?;
        let doc = cached.value.as_ref().map_err(Clone::clone)?;
        Ok(json!({"path": path, "hash": cached.hash, "title": doc.title, "text": doc.lines.join("\n")}))
    }

    fn world_values(&self) -> impl Iterator<Item = (&String, &String, &Value)> {
        self.world.files.iter().filter_map(|(path, cached)| cached.value.as_ref().ok().map(|value| (path, &cached.hash, value.as_ref())))
    }

    fn missions(&self) -> Vec<(&String, &String, &Value)> {
        let mut missions = Vec::new();
        for (path, hash, value) in self.world_values().filter(|(path, _, _)| path.starts_with("Assets/Resources/Configs/Missions/")) {
            match value {
                Value::Array(items) => missions.extend(items.iter().filter(|item| item["id"].is_string()).map(|item| (path, hash, item))),
                Value::Object(_) if value["id"].is_string() => missions.push((path, hash, value)),
                _ => {}
            }
        }
        missions
    }

    /// Where the design documents mention one identifier, nearest heading first.
    pub fn mentions(&self, id: &str) -> Vec<DocMention> {
        let mut found = Vec::new();
        for (path, cached) in &self.docs.files {
            let Ok(doc) = &cached.value else { continue };
            let Some(lines) = doc.mentions.get(id) else { continue };
            for &line in lines {
                let heading = doc.headings.iter().rev().find(|(index, _)| *index <= line).map(|(_, text)| text.clone()).unwrap_or_default();
                let excerpt: String = doc.lines[line].trim().chars().take(220).collect();
                found.push((doc.fenced.contains(&line), DocMention { path: path.clone(), hash: cached.hash.clone(), title: doc.title.clone(), heading, line: line + 1, excerpt }));
            }
        }
        // Prose first, then literal code examples; stable by path and line within each group.
        found.sort_by(|(a, left), (b, right)| a.cmp(b).then_with(|| left.path.cmp(&right.path)).then(left.line.cmp(&right.line)));
        found.into_iter().take(MAX_MENTIONS).map(|(_, mention)| mention).collect()
    }

    fn code_hits(&self) -> BTreeMap<&'static str, Vec<Value>> {
        let mut hits: BTreeMap<&'static str, Vec<Value>> = BTreeMap::new();
        for (path, cached) in &self.code.files {
            let Ok(code) = &cached.value else { continue };
            for (field, line, text) in &code.hits {
                let entry = hits.entry(CODE_FIELDS[*field]).or_default();
                if entry.len() < MAX_CODE_HITS {
                    entry.push(json!({"path": path, "hash": cached.hash, "line": line + 1, "text": text}));
                }
            }
        }
        hits
    }

    /// The four-layer loop table from the current design overview, or a legacy repository.
    fn player_loop(&self) -> Value {
        let path = if self.docs.files.contains_key(LOOP_SOURCE) { LOOP_SOURCE } else { LEGACY_LOOP_SOURCE };
        let Some(cached) = self.docs.files.get(path) else { return Value::Null };
        let Ok(doc) = &cached.value else { return Value::Null };
        let Some((start, heading)) = doc.headings.iter().find(|(_, text)| text.contains("四层循环")).or_else(|| doc.headings.iter().find(|(_, text)| text.contains("核心循环"))) else {
            return Value::Null;
        };
        let cells = |line: &str| -> Vec<String> {
            line.trim().trim_matches('|').split('|').map(|cell| cell.trim().replace("**", "")).collect()
        };
        let mut table = doc.lines.iter().enumerate().skip(start + 1).skip_while(|(_, line)| !line.trim_start().starts_with('|'));
        let Some((header_line, header)) = table.next() else { return Value::Null };
        let columns = cells(header);
        let rows: Vec<Vec<String>> = table
            .take_while(|(_, line)| line.trim_start().starts_with('|'))
            .map(|(_, line)| cells(line))
            .filter(|row| !row.iter().all(|cell| cell.chars().all(|c| c == '-' || c == ':' || c.is_whitespace())))
            .take(12)
            .collect();
        if rows.is_empty() { return Value::Null; }
        json!({"source": {"path": path, "hash": cached.hash, "heading": heading, "line": header_line + 1}, "columns": columns, "rows": rows, "basis": "design"})
    }

    fn issues(&self) -> Vec<GameIssue> {
        let mut issues: Vec<GameIssue> = self.world.issues.iter().chain(&self.docs.issues).chain(&self.code.issues)
            .chain(&self.skeleton.issues).cloned().collect();
        for (path, cached) in self.world.files.iter() {
            if let Err(message) = &cached.value { issues.push(GameIssue { severity: "error".into(), message: message.clone(), path: path.clone() }); }
        }
        for (path, cached) in &self.skeleton.files {
            if let Err(message) = &cached.value { issues.push(GameIssue { severity: "error".into(), message: message.clone(), path: path.clone() }); }
        }
        issues
    }
}

fn revision(pairs: &mut Vec<(String, String)>) -> String {
    pairs.sort();
    pairs.dedup();
    format!("{:x}", Sha256::digest(serde_json::to_vec(pairs).unwrap_or_default()))
}

/// The game at a glance: player loop (design intent), world and regions (configuration
/// facts), routed zones that can be explored, counts and unknowns. No runtime claims.
pub fn overview(repository: &Repository, indexes: &Indexes) -> Value {
    let mut used: Vec<(String, String)> = Vec::new();
    let zones = repository.zones();
    let zone_by_id: BTreeMap<&str, &game_config::GameZoneSummary> = zones.iter().map(|zone| (zone.id.as_str(), zone)).collect();
    let dungeons = repository.sources_of("dungeon");
    let mut zone_dungeon: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (id, source) in &dungeons {
        for zone in source.json["ZoneIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            zone_dungeon.insert(zone.into(), (id.clone(), source.json["RegionId"].as_str().unwrap_or_default().into()));
        }
    }
    let missions = indexes.missions();
    let mission_ids: BTreeSet<&str> = missions.iter().filter_map(|(_, _, mission)| mission["id"].as_str()).collect();
    let mut issues = indexes.issues();
    let world = indexes.world_values().find(|(path, _, _)| path.starts_with("Assets/Resources/Configs/Worlds/")).map(|(path, hash, value)| {
        used.push((path.clone(), hash.clone()));
        json!({"id": value["id"], "name": value["name"], "description": value["description"], "starting_region_id": value["startingRegionId"],
            "region_order": value["regions"].as_array().map(|items| items.iter().filter_map(|item| item["id"].as_str()).collect::<Vec<_>>()),
            "source": {"path": path, "hash": hash}})
    });
    let order: Vec<String> = world.as_ref().and_then(|world| world["region_order"].as_array().cloned()).unwrap_or_default()
        .into_iter().filter_map(|value| value.as_str().map(str::to_string)).collect();
    let mut regions: Vec<Value> = Vec::new();
    for (path, hash, value) in indexes.world_values().filter(|(path, _, _)| path.starts_with("Assets/Resources/Configs/Regions/")) {
        let Some(id) = value["Id"].as_str() else { continue };
        used.push((path.clone(), hash.clone()));
        let region_dungeons: Vec<Value> = dungeons.iter().filter(|(_, source)| source.json["RegionId"].as_str() == Some(id)).map(|(dungeon, source)| {
            used.push((source.path.clone(), source.hash.clone()));
            let zone_ids: Vec<&str> = source.json["ZoneIds"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let hidden: BTreeSet<&str> = source.json["HiddenZoneIds"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let zones: Vec<Value> = zone_ids.iter().map(|zone| match zone_by_id.get(zone) {
                Some(summary) => json!({"id": zone, "name": summary.name, "locations": summary.locations, "routes": summary.routes, "path": summary.path, "hidden": hidden.contains(zone), "configured": true}),
                None => json!({"id": zone, "name": zone, "locations": 0, "routes": 0, "hidden": hidden.contains(zone), "configured": false}),
            }).collect();
            json!({"id": dungeon, "name": name_field(&source.json, dungeon), "type": source.json["Type"], "boss_id": source.json["BossId"], "zones": zones,
                "source": {"path": source.path, "hash": source.hash}})
        }).collect();
        let main_quest = value["MainQuestId"].as_str().unwrap_or_default();
        if !main_quest.is_empty() && !mission_ids.contains(main_quest) {
            issues.push(GameIssue { severity: "warning".into(), message: format!("区域主线 MainQuestId={main_quest} 没有对应的任务配置。"), path: path.clone() });
        }
        regions.push(json!({"id": id, "name": name_field(value, id), "description": value["Description"], "unlocked_by_default": value["IsUnlockedByDefault"],
            "connected": value["ConnectedRegionIds"], "main_quest_id": main_quest, "main_quest_found": main_quest.is_empty() || mission_ids.contains(main_quest),
            "in_world": order.iter().any(|item| item == id), "dungeons": region_dungeons, "source": {"path": path, "hash": hash}}));
    }
    regions.sort_by_key(|region| {
        let id = region["id"].as_str().unwrap_or_default();
        (order.iter().position(|item| item == id).unwrap_or(usize::MAX), id.to_string())
    });
    let routed: Vec<Value> = zones.iter().filter(|zone| zone.routes > 0).map(|zone| {
        let (dungeon, region) = zone_dungeon.get(&zone.id).cloned().unwrap_or_default();
        json!({"id": zone.id, "name": zone.name, "locations": zone.locations, "routes": zone.routes, "path": zone.path, "dungeon_id": dungeon, "region_id": region})
    }).collect();
    for zone in &zones { if zone.routes > 0 { if let Ok(Some(source)) = repository.source("zone", &zone.id) { used.push((source.path.clone(), source.hash.clone())); } } }
    let player_loop = indexes.player_loop();
    if let Some(source) = player_loop.get("source") {
        used.push((source["path"].as_str().unwrap_or_default().into(), source["hash"].as_str().unwrap_or_default().into()));
    }
    let skeleton = indexes.skeleton.files.get(SKELETON_SOURCE).map(|cached| {
        if !cached.hash.is_empty() { used.push((SKELETON_SOURCE.into(), cached.hash.clone())); }
        cached.value.as_ref().ok().map(|model| json!({"source": {"path": SKELETON_SOURCE, "hash": cached.hash}, "model": model.as_ref()}))
    }).flatten();
    for id in repository.duplicate_ids("zone") { issues.push(GameIssue { severity: "error".into(), message: format!("配置 ID 重复：{id}"), path: String::new() }); }
    json!({
        "world": world,
        "loop": player_loop,
        "skeleton": skeleton,
        "regions": regions,
        "routed_zones": routed,
        "counts": {"regions": regions.len(), "dungeons": dungeons.len(), "zones": zones.len(), "routed_zones": routed.len(),
            "locations": zones.iter().map(|zone| zone.locations).sum::<usize>(), "contents": repository.sources_of("content").len(),
            "battles": repository.sources_of("battle").len(), "loot_tables": repository.sources_of("loot").len(), "missions": missions.len(),
            "design_documents": indexes.docs.files.len(), "code_files": indexes.code.files.len()},
        "issues": issues,
        "documents": indexes.documents(),
        "source_revision": revision(&mut used),
        "runtime_verified": false,
    })
}

/// Relations of one zone beyond its own configuration: region, dungeon, missions that share its
/// dungeon or target its enemies, design mentions per identifier and static code references.
pub fn zone_relations(repository: &Repository, indexes: &Indexes, view: &GameZoneView) -> Value {
    let dungeon = repository.source("dungeon", &view.dungeon_id).ok().flatten();
    let region_id = dungeon.as_ref().and_then(|source| source.json["RegionId"].as_str()).unwrap_or_default().to_string();
    let region = indexes.world_values().find(|(path, _, value)| path.starts_with("Assets/Resources/Configs/Regions/") && value["Id"].as_str() == Some(region_id.as_str()))
        .map(|(path, hash, value)| json!({"id": region_id, "name": name_field(value, &region_id), "description": value["Description"], "source": SourceRef { path, hash }}));
    let mut enemies: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    let mut ids: BTreeSet<String> = BTreeSet::from([view.zone.id.clone()]);
    if !view.dungeon_id.is_empty() { ids.insert(view.dungeon_id.clone()); }
    for location in &view.locations {
        ids.insert(location.id.clone());
        for candidate in &location.candidates {
            ids.insert(candidate.id.clone());
            if let Some(associated) = &candidate.associated_id { ids.insert(associated.clone()); }
            for enemy in &candidate.enemy_ids { enemies.entry(enemy.as_str()).or_default().push((location.id.as_str(), candidate.id.as_str())); }
        }
    }
    let mut missions = Vec::new();
    for (path, hash, mission) in indexes.missions() {
        let mut basis = Vec::new();
        if !view.dungeon_id.is_empty() && mission["dungeonId"].as_str() == Some(view.dungeon_id.as_str()) {
            basis.push(json!({"kind": "dungeon", "text": format!("任务配置 dungeonId = {}", view.dungeon_id)}));
        }
        let mut objectives = Vec::new();
        for objective in mission["objectives"].as_array().into_iter().flatten() {
            let enemy = objective["requiredEnemyId"].as_str().unwrap_or_default();
            let at: Vec<Value> = enemies.get(enemy).map(|found| found.iter().map(|(location, candidate)| json!({"location_id": location, "candidate_id": candidate})).collect()).unwrap_or_default();
            if !at.is_empty() {
                basis.push(json!({"kind": "enemy", "text": format!("目标敌人 {enemy} 出现在本 Zone 的战斗候选中")}));
            }
            objectives.push(json!({"id": objective["id"], "name": objective["name"], "type": objective["type"], "enemy_id": enemy, "amount": objective["requiredAmount"],
                "reward_table_id": objective["rewardTableId"], "flag_id": objective["flagId"], "at": at}));
        }
        let text = mission.to_string();
        if view.locations.iter().any(|location| text.contains(&format!("\"{}\"", location.id))) || text.contains(&format!("\"{}\"", view.zone.id)) {
            basis.push(json!({"kind": "reference", "text": "任务配置引用了本 Zone 或地点 ID"}));
        }
        if basis.is_empty() { continue; }
        missions.push(json!({"id": mission["id"], "name": mission["name"], "description": mission["description"], "type": mission["type"],
            "dungeon_id": mission["dungeonId"], "prerequisites": mission["prerequisiteMissionIds"], "required_rank": mission["requiredRank"],
            "objectives": objectives, "basis": basis, "source": SourceRef { path, hash }}));
        if missions.len() >= 32 { break; }
    }
    let design: BTreeMap<String, Vec<DocMention>> = ids.iter().map(|id| (id.clone(), indexes.mentions(id))).filter(|(_, found)| !found.is_empty()).collect();
    json!({
        "region": region,
        "dungeon": dungeon.map(|source| json!({"id": view.dungeon_id, "name": name_field(&source.json, &view.dungeon_id), "type": source.json["Type"],
            "zone_ids": source.json["ZoneIds"], "boss_id": source.json["BossId"], "source": {"path": source.path, "hash": source.hash}})),
        "missions": missions,
        "design": design,
        "code": indexes.code_hits(),
        "loop": indexes.player_loop(),
    })
}

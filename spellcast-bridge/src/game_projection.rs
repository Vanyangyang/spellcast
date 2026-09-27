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
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

const WORLD_ROOTS: [&str; 3] = ["Assets/Resources/Configs/Worlds", "Assets/Resources/Configs/Regions", "Assets/Resources/Configs/Missions"];
// The document board inventories the whole game-document tree. Mentions still carry exact
// source paths and are leads for review, never a claim that a document is current.
const DESIGN_ROOTS: [&str; 1] = ["Assets/Documents"];
pub const LOOP_SOURCE: &str = "Assets/Documents/Atlas/domains/cycle.md";
const CODE_ROOTS: [&str; 1] = ["Assets/Scripts"];
/// Configuration fields whose consumers the object view points at. A text match in C# is a
/// static lead to read, never proof that a player path works.
pub const CODE_FIELDS: [&str; 14] = [
    "SubLocationRoutes", "EntrySubLocationId", "SubLocationRefs", "ContentPoolIds", "ContentPoolWeights", "FirstEntryContent",
    "BossGateContentId", "UnlocksZoneId", "LootPoints", "LootTableId", "AssociatedDataId", "RestContentId", "ShopConfigId", "EliteEncounterRules",
];
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_MENTIONS: usize = 8;
const MAX_CODE_HITS: usize = 8;

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
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
        if stamp.len > MAX_FILE { return Err(format!("来源过大：{relative}")); }
        fs::read(path).map_err(|error| error.to_string())
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

pub struct Indexes {
    world: SourceSet<Value>,
    docs: SourceSet<Doc>,
    code: SourceSet<Code>,
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
        let indexes = Arc::new(Indexes {
            world: refresh_set(root, old.map(|value| &value.world), inventory(root, &WORLD_ROOTS, "json", Limits { files: 2_000, bytes: 16 << 20 }), refresh, parse_json),
            docs: refresh_set(root, old.map(|value| &value.docs), inventory(root, &DESIGN_ROOTS, "md", Limits { files: 3_000, bytes: 32 << 20 }), refresh, parse_doc),
            code: refresh_set(root, old.map(|value| &value.code), inventory(root, &CODE_ROOTS, "cs", Limits { files: 6_000, bytes: 64 << 20 }), refresh, parse_code),
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

    /// The four-layer loop table of the cycle design domain, verbatim. Unknown when absent.
    fn player_loop(&self) -> Value {
        let Some(cached) = self.docs.files.get(LOOP_SOURCE) else { return Value::Null };
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
        json!({"source": {"path": LOOP_SOURCE, "hash": cached.hash, "heading": heading, "line": header_line + 1}, "columns": columns, "rows": rows, "basis": "design"})
    }

    fn issues(&self) -> Vec<GameIssue> {
        let mut issues: Vec<GameIssue> = self.world.issues.iter().chain(&self.docs.issues).chain(&self.code.issues).cloned().collect();
        for (path, cached) in self.world.files.iter() {
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
    for id in repository.duplicate_ids("zone") { issues.push(GameIssue { severity: "error".into(), message: format!("配置 ID 重复：{id}"), path: String::new() }); }
    json!({
        "world": world,
        "loop": player_loop,
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

//! Read-only VESPERIX configuration projection. It never represents a live Run.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

pub const CONFIG_ROOT: &str = "Assets/Resources/Configs/DungeonExploration";
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 6000;
const MAX_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameSource {
    pub path: String,
    pub hash: String,
    pub json: Value,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameIssue {
    pub severity: String,
    pub message: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameZoneSummary {
    pub id: String,
    pub name: String,
    pub locations: usize,
    pub routes: usize,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameRoute {
    pub from: String,
    pub to: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameCandidate {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub description: String,
    pub weight: Option<f64>,
    pub first_entry: bool,
    pub gate: bool,
    pub missing: bool,
    pub associated_id: Option<String>,
    pub associated_name: Option<String>,
    pub enemies: Vec<String>,
    /// Enemy template ids, for relating objectives to this encounter.
    #[serde(default)]
    pub enemy_ids: Vec<String>,
    /// The reward table named by the associated battle or treasure configuration.
    #[serde(default)]
    pub loot_table_id: Option<String>,
    #[serde(default)]
    pub loot_table_name: Option<String>,
    pub paths: Vec<String>,
}
/// A configured gathering/chest point. Its table lists possible items, not an observed drop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameLootPoint {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub loot_table_id: String,
    pub loot_table_name: Option<String>,
    pub category: Option<String>,
    pub unlock_condition: Option<String>,
    pub missing: bool,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameLocation {
    pub id: String,
    pub name: String,
    pub description: String,
    pub x: f64,
    pub y: f64,
    pub role: String,
    pub missing: bool,
    pub path: Option<String>,
    pub unlocks_zone: Option<String>,
    pub candidates: Vec<GameCandidate>,
    #[serde(default)]
    pub loot_points: Vec<GameLootPoint>,
    #[serde(default)]
    pub rest: bool,
    /// Raw configured unlock cost, when a location must be paid for.
    #[serde(default)]
    pub unlock_cost: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameZoneView {
    pub zone: GameZoneSummary,
    #[serde(default)]
    pub dungeon_id: String,
    pub description: String,
    pub entry: String,
    pub locations: Vec<GameLocation>,
    pub routes: Vec<GameRoute>,
    pub sources: Vec<GameSource>,
    pub issues: Vec<GameIssue>,
    pub source_revision: String,
    pub runtime_verified: bool,
}

#[derive(Clone)]
struct Document {
    source: Arc<GameSource>,
}
pub struct Repository {
    documents: BTreeMap<(String, String), Vec<Document>>,
    issues: Vec<GameIssue>,
    files: BTreeMap<String, CachedSource>,
    inventory_issues: Vec<GameIssue>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}
impl FileStamp {
    fn reusable(&self, other: &Self) -> bool {
        self.modified.is_some() && self == other
    }
}
#[derive(Clone)]
struct CachedSource {
    stamp: FileStamp,
    source: Result<Arc<GameSource>, String>,
}
struct Inventory {
    files: BTreeMap<String, FileStamp>,
    issues: Vec<GameIssue>,
}

/// Process-local, bounded index. Each read still inventories the repository so additions,
/// removals and reparse paths are detected. Explicit refreshes re-read all file contents.
#[derive(Default)]
pub struct RepositoryCache {
    entries: Mutex<VecDeque<(PathBuf, Arc<Repository>)>>,
}
impl RepositoryCache {
    pub fn read(&self, root: &Path, refresh: bool) -> Result<Arc<Repository>, String> {
        // Share concurrent scans without holding the application state or database lock.
        let mut entries = self.entries.lock().map_err(|_| "关卡索引不可用。")?;
        let inventory = Inventory::read(root)?;
        let previous = entries
            .iter()
            .position(|(path, _)| path == root)
            .and_then(|index| entries.remove(index))
            .map(|(_, repository)| repository);
        let repository = match previous {
            Some(previous) if !refresh && previous.matches(&inventory) => previous,
            previous => Arc::new(Repository::from_inventory(
                root,
                inventory,
                previous.as_deref().filter(|_| !refresh),
            )?),
        };
        entries.push_back((root.to_path_buf(), repository.clone()));
        while entries.len() > 4 {
            entries.pop_front();
        }
        Ok(repository)
    }
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
fn name(value: &Value, id: &str) -> String {
    let value = string(value, "DisplayName");
    if value.is_empty() {
        id.into()
    } else {
        value
    }
}
/// Tables, dungeons and regions use `Name`; zones and locations use `DisplayName`.
pub(crate) fn name_field(value: &Value, id: &str) -> String {
    ["DisplayName", "Name", "name"]
        .iter()
        .map(|key| string(value, key))
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| id.into())
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
pub(crate) fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
pub fn connect_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err("请选择本地项目的绝对目录。".into());
    }
    let root = fs::canonicalize(path).map_err(|e| format!("项目目录不可用：{e}"))?;
    if !root.is_dir() {
        return Err("项目路径不是目录。".into());
    }
    checked_path(&root, CONFIG_ROOT, true)?;
    checked_path(&root, "ProjectSettings/ProjectVersion.txt", false)?;
    Ok(root)
}
pub fn display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .replace('\\', "/")
}
pub fn source_uri(root: &str, relative: &str) -> String {
    let full = format!("{}/{}", root.trim_end_matches('/'), relative);
    let mut encoded = String::new();
    for b in full.bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~:".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!(
        "file://{}{}",
        if encoded.starts_with('/') { "" } else { "/" },
        encoded
    )
}
pub(crate) fn checked_path(root: &Path, relative: &str, directory: bool) -> Result<PathBuf, String> {
    if Path::new(relative)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("来源路径不合法。".into());
    }
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        path.push(part.as_os_str());
        let meta =
            fs::symlink_metadata(&path).map_err(|e| format!("来源不存在 {}：{e}", relative))?;
        if linked(&meta) {
            return Err(format!("不读取链接或重解析目录：{relative}"));
        }
    }
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(root)
        || (directory && !canonical.is_dir())
        || (!directory && !canonical.is_file())
    {
        return Err("来源不在已连接项目内。".into());
    }
    Ok(canonical)
}
pub fn read_source(root: &Path, relative: &str) -> Result<GameSource, String> {
    if !relative.starts_with(&format!("{CONFIG_ROOT}/")) || !relative.ends_with(".json") {
        return Err("只读取已连接项目内的关卡 JSON 配置。".into());
    }
    let path = checked_path(root, relative, false)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE {
        return Err(format!("配置过大：{relative}"));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(format!("配置过大：{relative}"));
    }
    let raw = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let json =
        serde_json::from_slice(raw).map_err(|e| format!("JSON 无法解析 {}：{e}", relative))?;
    Ok(GameSource {
        path: relative.into(),
        hash: format!("{:x}", Sha256::digest(&bytes)),
        json,
    })
}

impl Inventory {
    fn read(root: &Path) -> Result<Self, String> {
        let config = checked_path(root, CONFIG_ROOT, true)?;
        let mut pending = vec![config];
        let mut files = BTreeMap::new();
        let mut issues = Vec::new();
        let mut entries = 0;
        let mut bytes = 0u64;
        while let Some(directory) = pending.pop() {
            for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let path = item.path();
                // DirEntry metadata does not follow symlinks and is already available
                // from directory enumeration on Windows; avoid reopening every entry.
                let meta = item.metadata().map_err(|e| e.to_string())?;
                entries += 1;
                if entries > MAX_FILES * 3 {
                    return Err("关卡配置目录条目数量超出本次读取上限。".into());
                }
                let relative = display_path(path.strip_prefix(root).map_err(|e| e.to_string())?);
                if linked(&meta) {
                    issues.push(GameIssue {
                        severity: "error".into(),
                        message: "已跳过链接或重解析路径".into(),
                        path: relative,
                    });
                    continue;
                }
                if meta.is_dir() {
                    pending.push(path);
                } else if meta.is_file()
                    && path.extension().and_then(|v| v.to_str()) == Some("json")
                {
                    bytes += meta.len();
                    if bytes > MAX_BYTES as u64 {
                        return Err("关卡配置总量超出本次读取上限。".into());
                    }
                    files.insert(
                        relative,
                        FileStamp {
                            len: meta.len(),
                            modified: meta.modified().ok(),
                            created: meta.created().ok(),
                        },
                    );
                }
                if files.len() + pending.len() > MAX_FILES {
                    return Err("关卡配置文件数量超出本次读取上限。".into());
                }
            }
        }
        issues.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Self { files, issues })
    }
}

impl Repository {
    /// Always read fresh contents, including when metadata has been preserved by an editor.
    /// New game actions use this path for source-version validation, never the view cache.
    pub fn read(root: &Path) -> Result<Self, String> {
        Self::from_inventory(root, Inventory::read(root)?, None)
    }
    fn matches(&self, inventory: &Inventory) -> bool {
        self.inventory_issues == inventory.issues
            && self.files.len() == inventory.files.len()
            && inventory.files.iter().all(|(path, stamp)| {
                self.files
                    .get(path)
                    .is_some_and(|cached| cached.stamp.reusable(stamp))
            })
    }
    fn from_inventory(
        root: &Path,
        inventory: Inventory,
        previous: Option<&Self>,
    ) -> Result<Self, String> {
        let mut documents: BTreeMap<(String, String), Vec<Document>> = BTreeMap::new();
        let mut files = BTreeMap::new();
        let mut issues = inventory.issues.clone();
        let mut total = 0;
        // Cold reads are dominated by per-file open latency on Windows; read changed files in
        // parallel, then index them in the same deterministic order as before.
        let pending: Vec<&String> = inventory
            .files
            .iter()
            .filter(|(relative, stamp)| !previous.and_then(|repo| repo.files.get(*relative)).is_some_and(|cached| cached.stamp.reusable(stamp)))
            .map(|(relative, _)| relative)
            .collect();
        let workers = std::thread::available_parallelism().map_or(4, |count| count.get()).clamp(2, 12);
        let chunk = pending.len().div_ceil(workers).max(1);
        let mut fresh: BTreeMap<String, Result<Arc<GameSource>, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = pending
                .chunks(chunk)
                .map(|group| scope.spawn(move || group.iter().map(|relative| ((*relative).clone(), read_source(root, relative).map(Arc::new))).collect::<Vec<_>>()))
                .collect();
            handles.into_iter().flat_map(|handle| handle.join().unwrap_or_default()).collect()
        });
        for (relative, stamp) in inventory.files {
            let source = match fresh.remove(&relative) {
                Some(read) => read,
                None => previous
                    .and_then(|repo| repo.files.get(&relative))
                    .filter(|cached| cached.stamp.reusable(&stamp))
                    .map(|cached| cached.source.clone())
                    .unwrap_or_else(|| read_source(root, &relative).map(Arc::new)),
            };
            match &source {
                Ok(source) => {
                    total += source.json.to_string().len();
                    if total > MAX_BYTES {
                        return Err("关卡配置总量超出本次读取上限。".into());
                    }
                    // A parent ID is a reference, not a second definition. In particular,
                    // SubLocation.ZoneId must never register the location as another Zone.
                    let directory=relative.strip_prefix(&format!("{CONFIG_ROOT}/")).and_then(|path|path.split('/').next());
                    let definition=match directory {
                        Some("Zones")=>Some(("ZoneId","zone")),
                        Some("SubLocations")=>Some(("SubLocationId","location")),
                        Some("Contents")=>Some(("ContentId","content")),
                        Some("Battles")=>Some(("BattleId","battle")),
                        Some("Events")=>Some(("EventId","event")),
                        Some("Rest"|"Rests")=>Some(("RestId","rest")),
                        Some("Shop"|"Shops")=>Some(("ShopId","shop")),
                        Some("Treasure"|"Treasures")=>Some(("TreasureId","treasure")),
                        Some("Dungeons")=>Some(("Id","dungeon")),
                        Some("LootTables")=>Some(("Id","loot")),
                        _=>None,
                    };
                    if let Some((field,kind))=definition {
                        let id = string(&source.json, field);
                        if valid_id(&id) {
                            documents
                                .entry((kind.into(), id))
                                .or_default()
                                .push(Document {
                                    source: source.clone(),
                                });
                        }
                    }
                }
                Err(message) => issues.push(GameIssue {
                    severity: "error".into(),
                    message: message.clone(),
                    path: relative.clone(),
                }),
            }
            files.insert(relative, CachedSource { stamp, source });
        }
        Ok(Self {
            documents,
            issues,
            files,
            inventory_issues: inventory.issues,
        })
    }
    fn document(&self, kind: &str, id: &str) -> Result<Option<&Document>, String> {
        let found = self.documents.get(&(kind.into(), id.into()));
        match found {
            Some(list) if list.len() == 1 => Ok(list.first()),
            Some(_) => Err(format!("配置 ID 重复：{id}")),
            None => Ok(None),
        }
    }
    /// One uniquely defined source of a kind, e.g. `dungeon` or `loot`.
    pub fn source(&self, kind: &str, id: &str) -> Result<Option<Arc<GameSource>>, String> {
        Ok(self.document(kind, id)?.map(|doc| doc.source.clone()))
    }
    /// Every uniquely defined source of a kind. Duplicate definitions stay out, as in views.
    pub fn sources_of(&self, kind: &str) -> Vec<(String, Arc<GameSource>)> {
        self.documents
            .iter()
            .filter(|((found, _), docs)| found == kind && docs.len() == 1)
            .map(|((_, id), docs)| (id.clone(), docs[0].source.clone()))
            .collect()
    }
    pub fn duplicate_ids(&self, kind: &str) -> Vec<String> {
        self.documents
            .iter()
            .filter(|((found, _), docs)| found == kind && docs.len() > 1)
            .map(|((_, id), _)| id.clone())
            .collect()
    }
    fn loot_point(
        &self,
        point: &Value,
        sources: &mut BTreeMap<String, Arc<GameSource>>,
        issues: &mut Vec<GameIssue>,
        owner: &str,
    ) -> GameLootPoint {
        let table = string(point, "LootTableId");
        let found = if table.is_empty() { Ok(None) } else { self.document("loot", &table) };
        let doc = match found {
            Ok(doc) => doc,
            Err(message) => {
                issues.push(GameIssue { severity: "error".into(), message, path: owner.into() });
                None
            }
        };
        if let Some(doc) = doc {
            sources.insert(doc.source.path.clone(), doc.source.clone());
        } else if !table.is_empty() {
            issues.push(GameIssue { severity: "warning".into(), message: format!("掉落表不在关卡配置目录中：{table}"), path: owner.into() });
        }
        GameLootPoint {
            id: string(point, "PointId"),
            name: string(point, "DisplayName"),
            kind: string(point, "LootableType"),
            loot_table_name: doc.map(|doc| name_field(&doc.source.json, &table)),
            category: doc.map(|doc| string(&doc.source.json, "Category")).filter(|value| !value.is_empty()),
            unlock_condition: point["UnlockCondition"].as_str().map(str::to_string),
            missing: doc.is_none(),
            path: doc.map(|doc| doc.source.path.clone()),
            loot_table_id: table,
        }
    }
    pub fn zones(&self) -> Vec<GameZoneSummary> {
        self.documents
            .iter()
            .filter(|((kind, _), _)| kind == "zone")
            .flat_map(|((_, id), docs)| docs.iter().map(move |doc| Self::summary(id, doc)))
            .collect()
    }
    fn summary(id: &str, doc: &Document) -> GameZoneSummary {
        GameZoneSummary {
            id: id.into(),
            name: name(&doc.source.json, id),
            locations: doc.source.json["SubLocationRefs"]
                .as_array()
                .map_or(0, Vec::len),
            routes: doc.source.json["SubLocationRoutes"]
                .as_array()
                .map_or(0, Vec::len),
            path: doc.source.path.clone(),
        }
    }
    pub fn zone(&self, id: &str) -> Result<GameZoneView, String> {
        if !valid_id(id) {
            return Err("Zone ID 不合法。".into());
        }
        let doc = self
            .document("zone", id)?
            .ok_or("找不到这个 Zone 的配置。")?;
        let value = &doc.source.json;
        let summary = Self::summary(id, doc);
        if summary.locations > 250 || summary.routes > 1000 {
            return Err("这个 Zone 过大，请先按地点分段处理。".into());
        }
        let mut sources = BTreeMap::from([(doc.source.path.clone(), doc.source.clone())]);
        let mut issues = self.issues.clone();
        let mut locations = Vec::new();
        let mut ids = BTreeSet::new();
        let empty = Vec::new();
        for (index, reference) in value["SubLocationRefs"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .enumerate()
        {
            let location_id = string(reference, "SubLocationId");
            if !valid_id(&location_id) || !ids.insert(location_id.clone()) {
                issues.push(GameIssue {
                    severity: "error".into(),
                    message: format!("地点 ID 非法或重复：{location_id}"),
                    path: doc.source.path.clone(),
                });
                continue;
            }
            let found = match self.document("location", &location_id) {
                Ok(v) => v,
                Err(message) => {
                    issues.push(GameIssue {
                        severity: "error".into(),
                        message,
                        path: doc.source.path.clone(),
                    });
                    None
                }
            };
            let blank = Value::Null;
            let data = found.map_or(&blank, |d| &d.source.json);
            if let Some(found) = found {
                sources.insert(found.source.path.clone(), found.source.clone());
            } else {
                issues.push(GameIssue {
                    severity: "error".into(),
                    message: format!("缺少地点配置：{location_id}"),
                    path: doc.source.path.clone(),
                });
            }
            let first = data["FirstEntryContent"]["ContentId"]
                .as_str()
                .unwrap_or("");
            let gate = data["BossGateContentId"].as_str().unwrap_or("");
            let mut candidate_ids: BTreeSet<String> = data["ContentPoolIds"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            for extra in [first, gate] {
                if !extra.is_empty() {
                    candidate_ids.insert(extra.into());
                }
            }
            if candidate_ids.len() > 128 {
                return Err(format!("地点的候选数量过多：{location_id}"));
            }
            let mut candidates = Vec::new();
            for content in candidate_ids {
                candidates.push(self.candidate(
                    "content",
                    &content,
                    data["ContentPoolWeights"][&content].as_f64(),
                    content == first,
                    content == gate,
                    &mut sources,
                    &mut issues,
                ));
            }
            let shop = string(data, "ShopConfigId");
            if data["IsShop"].as_bool() == Some(true) && !shop.is_empty() {
                candidates.push(self.candidate(
                    "shop",
                    &shop,
                    None,
                    false,
                    false,
                    &mut sources,
                    &mut issues,
                ));
            }
            let rest = data["IsRestPoint"].as_bool() == Some(true);
            let rest_content = string(data, "RestContentId");
            if rest && !rest_content.is_empty() && !candidates.iter().any(|candidate| candidate.id == rest_content) {
                candidates.push(self.candidate("content", &rest_content, None, false, false, &mut sources, &mut issues));
            }
            let owner = found.map(|d| d.source.path.clone()).unwrap_or_else(|| doc.source.path.clone());
            let loot_points: Vec<GameLootPoint> = data["LootPoints"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .take(64)
                .map(|point| self.loot_point(point, &mut sources, &mut issues, &owner))
                .collect();
            locations.push(GameLocation {
                id: location_id.clone(),
                name: name(data, &location_id),
                description: string(data, "Description"),
                x: reference["Position"]["x"]
                    .as_f64()
                    .unwrap_or((index % 3) as f64 * 220.0),
                y: reference["Position"]["y"]
                    .as_f64()
                    .unwrap_or((index / 3) as f64 * 150.0),
                role: if data["IsBossGate"].as_bool() == Some(true) {
                    "gate"
                } else if data["IsShop"].as_bool() == Some(true) {
                    "shop"
                } else {
                    "location"
                }
                .into(),
                missing: found.is_none(),
                path: found.map(|d| d.source.path.clone()),
                unlocks_zone: data["UnlocksZoneId"].as_str().map(str::to_string),
                candidates,
                loot_points,
                rest,
                unlock_cost: data.get("UnlockCost").filter(|value| !value.is_null()).cloned(),
            });
        }
        let entry = string(value, "EntrySubLocationId");
        let mut routes = Vec::new();
        let mut seen = BTreeSet::new();
        for route in value["SubLocationRoutes"].as_array().unwrap_or(&empty) {
            let from = string(route, "FromSubLocationId");
            let to = string(route, "ToSubLocationId");
            if !ids.contains(&from) || !ids.contains(&to) || from == to {
                issues.push(GameIssue {
                    severity: "error".into(),
                    message: format!("路线端点无效：{from} → {to}"),
                    path: doc.source.path.clone(),
                });
                continue;
            }
            let key = if from < to {
                (from.clone(), to.clone())
            } else {
                (to.clone(), from.clone())
            };
            if seen.insert(key) {
                routes.push(GameRoute { from, to });
            } else {
                issues.push(GameIssue {
                    severity: "error".into(),
                    message: format!("重复的无向路线：{from} ↔ {to}"),
                    path: doc.source.path.clone(),
                });
            }
        }
        if routes.is_empty() {
            issues.push(GameIssue {
                severity: "warning".into(),
                message: "未声明有效空间路线；不能按地点列表顺序推断邻接。".into(),
                path: doc.source.path.clone(),
            });
        }
        if !ids.contains(&entry) {
            issues.push(GameIssue {
                severity: "error".into(),
                message: "入口地点缺失或不在当前 Zone 中。".into(),
                path: doc.source.path.clone(),
            });
        } else if !routes.is_empty() {
            let mut reached = BTreeSet::from([entry.clone()]);
            let mut queue = VecDeque::from([entry.clone()]);
            while let Some(current) = queue.pop_front() {
                for route in &routes {
                    let next = if route.from == current {
                        Some(&route.to)
                    } else if route.to == current {
                        Some(&route.from)
                    } else {
                        None
                    };
                    if let Some(next) = next {
                        if reached.insert(next.clone()) {
                            queue.push_back(next.clone());
                        }
                    }
                }
            }
            for unreachable in ids.difference(&reached) {
                issues.push(GameIssue {
                    severity: "error".into(),
                    message: format!("从入口不可达：{unreachable}"),
                    path: doc.source.path.clone(),
                });
            }
        }
        let sources: Vec<_> = sources
            .into_values()
            .map(|source| (*source).clone())
            .collect();
        let revision = serde_json::to_vec(
            &sources
                .iter()
                .map(|s| (&s.path, &s.hash))
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string())?;
        Ok(GameZoneView {
            zone: summary,
            dungeon_id: string(value, "DungeonId"),
            description: string(value, "Description"),
            entry,
            locations,
            routes,
            sources,
            issues,
            source_revision: format!("{:x}", Sha256::digest(revision)),
            runtime_verified: false,
        })
    }
    fn candidate(
        &self,
        kind: &str,
        id: &str,
        weight: Option<f64>,
        first_entry: bool,
        gate: bool,
        sources: &mut BTreeMap<String, Arc<GameSource>>,
        issues: &mut Vec<GameIssue>,
    ) -> GameCandidate {
        let found = self.document(kind, id).unwrap_or_else(|message| {
            issues.push(GameIssue {
                severity: "error".into(),
                message,
                path: String::new(),
            });
            None
        });
        let mut result = GameCandidate {
            id: id.into(),
            name: id.into(),
            kind: kind.into(),
            description: String::new(),
            weight,
            first_entry,
            gate,
            missing: found.is_none(),
            associated_id: None,
            associated_name: None,
            enemies: vec![],
            enemy_ids: vec![],
            loot_table_id: None,
            loot_table_name: None,
            paths: vec![],
        };
        let Some(doc) = found else {
            issues.push(GameIssue {
                severity: "error".into(),
                message: format!("缺少候选配置：{id}"),
                path: String::new(),
            });
            return result;
        };
        sources.insert(doc.source.path.clone(), doc.source.clone());
        result.paths.push(doc.source.path.clone());
        let value = &doc.source.json;
        result.name = name(value, id);
        result.description = string(value, "Description");
        let content_type = string(value, "Type");
        if !content_type.is_empty() {
            result.kind = content_type.clone();
        }
        let associated = string(value, "AssociatedDataId");
        if !associated.is_empty() {
            result.associated_id = Some(associated.clone());
            // VESPERIX ContentDataPackage loads BossGate encounters from Battle configs.
            let associated_kind = content_type.to_lowercase();
            let associated_kind = if associated_kind == "bossgate" {
                "battle"
            } else {
                &associated_kind
            };
            match self.document(associated_kind, &associated) {
                Ok(Some(data)) => {
                    result.associated_name = Some(name(&data.source.json, &associated));
                    result.enemies = data.source.json["Enemies"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .map(|enemy| {
                                    format!(
                                        "{} · Lv {}",
                                        string(enemy, "TemplateId"),
                                        enemy["Level"]
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    result.enemy_ids = data.source.json["Enemies"]
                        .as_array()
                        .map(|items| items.iter().map(|enemy| string(enemy, "TemplateId")).filter(|id| !id.is_empty()).collect())
                        .unwrap_or_default();
                    result.paths.push(data.source.path.clone());
                    sources.insert(data.source.path.clone(), data.source.clone());
                    let table = string(&data.source.json, "LootTableId");
                    if !table.is_empty() {
                        result.loot_table_id = Some(table.clone());
                        match self.document("loot", &table) {
                            Ok(Some(loot)) => {
                                result.loot_table_name = Some(name_field(&loot.source.json, &table));
                                result.paths.push(loot.source.path.clone());
                                sources.insert(loot.source.path.clone(), loot.source.clone());
                            }
                            Ok(None) => issues.push(GameIssue { severity: "warning".into(),
                                message: format!("奖励表不在关卡配置目录中：{table}"), path: data.source.path.clone() }),
                            Err(message) => issues.push(GameIssue { severity: "error".into(), message, path: data.source.path.clone() }),
                        }
                    }
                }
                other => issues.push(GameIssue {
                    severity: "warning".into(),
                    message: other
                        .err()
                        .unwrap_or_else(|| format!("关联数据尚未解析：{associated}")),
                    path: doc.source.path.clone(),
                }),
            }
        }
        result
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("spellcast-index-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join(CONFIG_ROOT)).unwrap();
            let fixture = Self(fs::canonicalize(root).unwrap());
            fixture.write("a", json!({"SubLocationId":"a","DisplayName":"One"}));
            fixture.write("b", json!({"SubLocationId":"b","DisplayName":"Two"}));
            fixture
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(CONFIG_ROOT).join(if name=="zone" {"Zones"} else {"SubLocations"}).join(format!("{name}.json"))
        }
        fn write(&self, name: &str, value: Value) {
            fs::create_dir_all(self.path(name).parent().unwrap()).unwrap();
            fs::write(self.path(name), serde_json::to_vec(&value).unwrap()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(temp) = fs::canonicalize(std::env::temp_dir()) {
                if self.0.parent() == Some(temp.as_path())
                    && self
                        .0
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("spellcast-index-")
                {
                    let _ = fs::remove_dir_all(&self.0);
                }
            }
        }
    }
    fn source(repository: &Repository, id: &str) -> Arc<GameSource> {
        repository
            .document("location", id)
            .unwrap()
            .unwrap()
            .source
            .clone()
    }

    #[test]
    fn unchanged_and_concurrent_reads_share_the_index_and_changes_reuse_other_sources() {
        let fixture = Fixture::new();
        let cache = RepositoryCache::default();
        let first = cache.read(&fixture.0, false).unwrap();
        let readers = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| cache.read(&fixture.0, false).unwrap()))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(readers.iter().all(|next| Arc::ptr_eq(&first, next)));
        fixture.write(
            "a",
            json!({"SubLocationId":"a","DisplayName":"Changed entry"}),
        );
        let changed = cache.read(&fixture.0, false).unwrap();
        assert_eq!(source(&changed, "a").json["DisplayName"], "Changed entry");
        assert!(!Arc::ptr_eq(&source(&first, "a"), &source(&changed, "a")));
        assert!(Arc::ptr_eq(&source(&first, "b"), &source(&changed, "b")));
        fixture.write("zone", json!({"ZoneId":"new_zone"}));
        assert_eq!(cache.read(&fixture.0, false).unwrap().zones().len(), 1);
        fs::remove_file(fixture.path("zone")).unwrap();
        assert!(cache.read(&fixture.0, false).unwrap().zones().is_empty());
        fs::remove_file(fixture.path("b")).unwrap();
        assert!(cache
            .read(&fixture.0, false)
            .unwrap()
            .document("location", "b")
            .unwrap()
            .is_none());
    }

    #[test]
    fn explicit_refresh_and_uncached_reads_detect_edits_with_preserved_metadata() {
        let fixture = Fixture::new();
        let cache = RepositoryCache::default();
        let before = cache.read(&fixture.0, false).unwrap();
        let path = fixture.path("a");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fixture.write("a", json!({"SubLocationId":"a","DisplayName":"New"}));
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(Arc::ptr_eq(
            &before,
            &cache.read(&fixture.0, false).unwrap()
        ));
        assert_eq!(
            source(&Repository::read(&fixture.0).unwrap(), "a").json["DisplayName"],
            "New"
        );
        let refreshed = cache.read(&fixture.0, true).unwrap();
        assert_eq!(source(&refreshed, "a").json["DisplayName"], "New");
        assert_ne!(source(&before, "a").hash, source(&refreshed, "a").hash);
        assert!(Arc::ptr_eq(
            &refreshed,
            &cache.read(&fixture.0, false).unwrap()
        ));
    }

    #[test]
    fn cached_sources_do_not_hide_invalid_or_unavailable_paths() {
        let fixture = Fixture::new();
        let cache = RepositoryCache::default();
        cache.read(&fixture.0, false).unwrap();
        fs::write(fixture.path("a"), b"not JSON").unwrap();
        let broken = cache.read(&fixture.0, false).unwrap();
        assert!(broken.document("location", "a").unwrap().is_none());
        assert!(broken
            .issues
            .iter()
            .any(|issue| issue.path.ends_with("a.json")));
        let moved = fixture.0.join("moved");
        fs::rename(fixture.0.join(CONFIG_ROOT), &moved).unwrap();
        assert!(cache.read(&fixture.0, false).is_err());
    }

    #[test]
    fn cache_separates_roots_and_evicts_older_projects() {
        let cache = RepositoryCache::default();
        let fixtures: Vec<_> = (0..5).map(|_| Fixture::new()).collect();
        let first = cache.read(&fixtures[0].0, false).unwrap();
        for fixture in fixtures.iter().skip(1) {
            cache.read(&fixture.0, false).unwrap();
        }
        assert_eq!(cache.entries.lock().unwrap().len(), 4);
        assert!(!Arc::ptr_eq(
            &first,
            &cache.read(&fixtures[0].0, false).unwrap()
        ));
    }

    #[test]
    fn parent_zone_ids_do_not_register_location_files_as_zones() {
        let fixture=Fixture::new();
        fixture.write("zone",json!({"ZoneId":"new_zone"}));
        fixture.write("a",json!({"SubLocationId":"a","ZoneId":"new_zone","DisplayName":"Location"}));
        let repository=Repository::read(&fixture.0).unwrap();
        assert_eq!(repository.zones().len(),1);
        assert!(repository.zone("new_zone").is_ok());
        assert_eq!(source(&repository,"a").json["DisplayName"],"Location");
    }
}

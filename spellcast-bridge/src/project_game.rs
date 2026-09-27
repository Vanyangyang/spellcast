//! Explicit repository connections and object-scoped user requests.
use crate::{
    game_config::{self, GameSource, GameZoneView, Repository},
    project_api::{owner, Fail},
    project_records::*,
    Bridge,
};
use axum::{
    extract::{Path as RoutePath, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellcast_core::{inbox::now_ms, types::SayRequest, SpellcastError};
use std::{path::PathBuf, sync::Arc};

pub(crate) fn init_schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS spellcast_project_game_connections(project_id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS spellcast_project_game_requests(project_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,request_hash TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(project_id,id));").map_err(|e|e.to_string())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameConnection {
    pub project_id: String,
    pub adapter: String,
    pub root: String,
    pub revision: u64,
    pub connected_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectGame {
    pub request_id: String,
    pub expected_revision: u64,
    pub root: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameAction {
    pub request_id: String,
    pub zone_id: String,
    #[serde(default)]
    pub location_id: Option<String>,
    pub expected_source_revision: String,
    pub intent: String,
    pub prompt: String,
    pub source_id: String,
    pub target_thread_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreparedAction {
    record_id: String,
    object_id: String,
    object_name: String,
    fields: RecordFields,
    context: Value,
    request: GameAction,
}

fn fail(e: impl ToString) -> SpellcastError {
    SpellcastError::user(e.to_string())
}
fn bad(e: impl ToString) -> Fail {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":e.to_string()})),
    )
}
fn fingerprint(value: &impl Serialize) -> Result<String, SpellcastError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(fail)?)
    ))
}
pub fn object_id(zone: &str, location: Option<&str>) -> String {
    format!(
        "game-vesperix-{}",
        &format!(
            "{:x}",
            Sha256::digest(format!("{zone}\0{}", location.unwrap_or("")))
        )[..32]
    )
}
fn same_root(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.trim_start_matches("\\\\?\\")
            .replace('\\', "/")
            .trim_end_matches('/')
            .eq_ignore_ascii_case(
                b.trim_start_matches("\\\\?\\")
                    .replace('\\', "/")
                    .trim_end_matches('/'),
            )
    }
    #[cfg(not(windows))]
    {
        a.trim_end_matches('/') == b.trim_end_matches('/')
    }
}

impl Bridge {
    pub fn game_connection(&self, project: &str) -> Result<Option<GameConnection>, SpellcastError> {
        let store = self.project_store()?;
        store.project_get(project).map_err(fail)?;
        let value: Option<String> = store
            .connection
            .query_row(
                "SELECT value FROM spellcast_project_game_connections WHERE project_id=?1",
                [project],
                |row| row.get(0),
            )
            .optional()
            .map_err(fail)?;
        value
            .map(|value| serde_json::from_str(&value).map_err(fail))
            .transpose()
    }
    pub fn connect_game(
        &self,
        project: &str,
        request: ConnectGame,
    ) -> Result<GameConnection, SpellcastError> {
        spellcast_core::reply::validate_id(&request.request_id)?;
        let hash = fingerprint(&request)?;
        if let Some(value) = self.game_request(project, &request.request_id, "connect", &hash)? {
            return serde_json::from_value(value).map_err(fail);
        }
        let root = game_config::connect_root(&request.root).map_err(fail)?;
        let mut store = self.project_store()?;
        if store.project_get(project).map_err(fail)?.archived {
            return Err(fail("请先恢复已归档项目。"));
        }
        let tx = store.connection.transaction().map_err(fail)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT value FROM spellcast_project_game_connections WHERE project_id=?1",
                [project],
                |row| row.get(0),
            )
            .optional()
            .map_err(fail)?;
        let current: Option<GameConnection> = current
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(fail)?;
        if current.as_ref().map_or(0, |c| c.revision) != request.expected_revision {
            return Err(fail("项目连接已变化，请刷新后重试。"));
        }
        let connection = GameConnection {
            project_id: project.into(),
            adapter: "vesperix".into(),
            root: game_config::display_path(&root),
            revision: request.expected_revision + 1,
            connected_at_ms: now_ms(),
        };
        let value = serde_json::to_string(&connection).map_err(fail)?;
        tx.execute("INSERT INTO spellcast_project_game_connections(project_id,value) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET value=excluded.value",params![project,value]).map_err(fail)?;
        tx.execute("INSERT INTO spellcast_project_game_requests(project_id,id,kind,request_hash,value) VALUES(?1,?2,'connect',?3,?4)",params![project,request.request_id,hash,value]).map_err(fail)?;
        tx.commit().map_err(fail)?;
        Ok(connection)
    }
    fn game_request(
        &self,
        project: &str,
        id: &str,
        kind: &str,
        hash: &str,
    ) -> Result<Option<Value>, SpellcastError> {
        let store = self.project_store()?;
        store.project_get(project).map_err(fail)?;
        let existing:Option<(String,String,String)>=store.connection.query_row("SELECT kind,request_hash,value FROM spellcast_project_game_requests WHERE project_id=?1 AND id=?2",params![project,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?;
        match existing {
            Some((k, h, v)) if k == kind && h == hash => {
                Ok(Some(serde_json::from_str(&v).map_err(fail)?))
            }
            Some(_) => Err(fail("request_id 已用于不同操作，未覆盖原请求。")),
            None => Ok(None),
        }
    }
    fn connected_root(&self, project: &str) -> Result<(GameConnection, PathBuf), SpellcastError> {
        let connection = self
            .game_connection(project)?
            .ok_or_else(|| fail("先明确连接游戏项目目录；目录别名不会自动授权读取。"))?;
        let root = game_config::connect_root(&connection.root).map_err(fail)?;
        Ok((connection, root))
    }
    pub fn game_zones(&self, project: &str) -> Result<Value, SpellcastError> {
        let (connection, root) = self.connected_root(project)?;
        let repository = self.game_repositories.read(&root, false).map_err(fail)?;
        Ok(json!({"connection":connection,"zones":repository.zones()}))
    }
    pub fn game_zone(&self, project: &str, zone: &str) -> Result<Value, SpellcastError> {
        let (connection, root) = self.connected_root(project)?;
        let repository = self.game_repositories.read(&root, false).map_err(fail)?;
        let view = repository.zone(zone).map_err(fail)?;
        let relations = self.game_relations(&root, &repository, &view, false);
        self.game_view_response(project, connection, view, relations)
    }
    /// Relations beyond level configuration. A projection failure never hides the zone itself.
    fn game_relations(&self, root: &std::path::Path, repository: &Repository, view: &GameZoneView, refresh: bool) -> Value {
        match self.game_indexes.read(root, refresh) {
            Ok(indexes) => crate::game_projection::zone_relations(repository, &indexes, view),
            Err(error) => json!({"error": error}),
        }
    }
    /// Game at a glance for the workspace home, from the connected repository only.
    pub fn game_overview(&self, project: &str, refresh: bool) -> Result<Value, SpellcastError> {
        let (connection, root) = self.connected_root(project)?;
        let repository = self.game_repositories.read(&root, refresh).map_err(fail)?;
        let indexes = self.game_indexes.read(&root, refresh).map_err(fail)?;
        let mut overview = crate::game_projection::overview(&repository, &indexes);
        overview["connection"] = json!(connection);
        Ok(overview)
    }
    /// Read a Markdown document only if it belongs to the connected repository's bounded index.
    pub fn game_document(&self, project: &str, path: &str) -> Result<Value, SpellcastError> {
        let (_, root) = self.connected_root(project)?;
        let indexes = self.game_indexes.read(&root, false).map_err(fail)?;
        indexes.document(path).map_err(fail)
    }
    /// One coherent repository snapshot for both the picker and selected Zone.
    pub fn game_view(
        &self,
        project: &str,
        preferred: Option<&str>,
        refresh: bool,
    ) -> Result<Value, SpellcastError> {
        let (connection, root) = self.connected_root(project)?;
        let repository = self.game_repositories.read(&root, refresh).map_err(fail)?;
        let zones = repository.zones();
        let selected = preferred
            .and_then(|id| zones.iter().find(|zone| zone.id == id))
            .or_else(|| {
                zones
                    .iter()
                    .find(|zone| zone.id == "zone_forest_shrine_outer")
            })
            .or_else(|| zones.iter().find(|zone| zone.routes > 0))
            .or_else(|| zones.first());
        let mut response = match selected.map(|selected| repository.zone(&selected.id)) {
            Some(Ok(view)) => {
                let relations = self.game_relations(&root, &repository, &view, refresh);
                self.game_view_response(project, connection, view, relations)?
            }
            detail => {
                let error = detail.and_then(Result::err);
                json!({"connection":connection,"view":null,"view_error":error,"records":[],"targets":[],"zone_object_id":null,"object_ids":[]})
            }
        };
        response["selected_zone_id"] = json!(selected.map(|zone| &zone.id));
        response["zones"] = json!(zones);
        Ok(response)
    }
    fn game_view_response(
        &self,
        project: &str,
        connection: GameConnection,
        view: GameZoneView,
        relations: Value,
    ) -> Result<Value, SpellcastError> {
        let zone = &view.zone.id;
        let records = self
            .project_store()?
            .project_records(project, "", None, true)
            .map_err(fail)?;
        let targets: Vec<_> = self
            .feedback_state(None)
            .bindings
            .into_iter()
            .filter(|b| same_root(&b.cwd, &connection.root))
            .collect();
        let object_ids: Vec<_> = view
            .locations
            .iter()
            .map(|l| json!({"location_id":l.id,"object_id":object_id(zone,Some(&l.id))}))
            .collect();
        Ok(
            json!({"connection":connection,"view":view,"relations":relations,"records":records,"targets":targets,"zone_object_id":object_id(zone,None),"object_ids":object_ids}),
        )
    }
    pub fn game_source(&self, project: &str, path: &str) -> Result<GameSource, SpellcastError> {
        let (_, root) = self.connected_root(project)?;
        game_config::read_source(&root, path).map_err(fail)
    }
    pub fn game_source_path(&self, project: &str, path: &str) -> Result<PathBuf, SpellcastError> {
        self.game_source(project, path)?;
        let (_, root) = self.connected_root(project)?;
        Ok(root.join(path))
    }
    fn prepare_game_action(
        &self,
        project: &str,
        request: GameAction,
    ) -> Result<PreparedAction, SpellcastError> {
        uuid::Uuid::parse_str(&request.request_id).map_err(|_| fail("请求需要稳定的 UUID。"))?;
        if !matches!(request.intent.as_str(), "modify" | "verify")
            || request.prompt.trim().is_empty()
            || request.prompt.chars().count() > 1500
        {
            return Err(fail("请选择修改或验证，并填写 1 至 1500 字的具体要求。"));
        }
        let hash = fingerprint(&request)?;
        if let Some(value) = self.game_request(project, &request.request_id, "action", &hash)? {
            return serde_json::from_value(value).map_err(fail);
        }
        let (connection, root) = self.connected_root(project)?;
        let view = Repository::read(&root)
            .and_then(|repo| repo.zone(&request.zone_id))
            .map_err(fail)?;
        if view.source_revision != request.expected_source_revision {
            return Err(fail(
                "配置已在查看后变化，请先刷新对象再发送。你的要求仍可保留。",
            ));
        }
        let target = self
            .feedback_state(None)
            .bindings
            .into_iter()
            .find(|binding| {
                binding.source_id == request.source_id
                    && binding.thread_id == request.target_thread_id
                    && same_root(&binding.cwd, &connection.root)
            })
            .ok_or_else(|| {
                fail("接收任务不是该游戏目录的当前关联任务，请重新选择或复制上下文。")
            })?;
        let location = request
            .location_id
            .as_deref()
            .map(|id| {
                view.locations
                    .iter()
                    .find(|node| node.id == id)
                    .ok_or_else(|| fail("所选地点不在当前 Zone 中。"))
            })
            .transpose()?;
        let selected_name = location.map_or(view.zone.name.clone(), |node| {
            format!("{} / {}", view.zone.name, node.name)
        });
        let object_id = object_id(&request.zone_id, request.location_id.as_deref());
        let sources = selected_sources(&view, location.map(|node| node.id.as_str()));
        if sources.len() > 96 {
            return Err(fail("这个对象包含的来源过多，请选择一个更小的地点再发送。"));
        }
        let references: Vec<_> = sources
            .iter()
            .map(|source| SourceReference {
                label: source
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&source.path)
                    .into(),
                uri: game_config::source_uri(&connection.root, &source.path),
                version: source.hash.clone(),
            })
            .collect();
        let label = if request.intent == "modify" {
            "修改"
        } else {
            "验证"
        };
        let fields:RecordFields=serde_json::from_value(json!({"object_id":object_id,"title":format!("{label} · {selected_name}"),"goal":request.prompt.trim(),"scope":format!("项目目录：{}\nZone：{}\n地点：{}",connection.root,request.zone_id,request.location_id.as_deref().unwrap_or("整个 Zone")),"status":"planned","result":"","boundaries":"由对象视图提交的请求，尚未得到执行或运行时验证结果。配置内容是候选，不代表本 Run 实际抽取。","next_step":"接收任务先核对当前项目约束与源文件版本；按用户要求完成工作后更新实际结果、未验证边界和下一步。","references":references})).map_err(fail)?;
        let context = json!({"project_id":project,"record_id":request.request_id,"object_id":object_id,"project_root":connection.root,"zone_id":request.zone_id,"location_id":request.location_id,"intent":request.intent,"source_revision":view.source_revision,"runtime_verified":false,"sources":sources.iter().map(|s|json!({"path":s.path,"hash":s.hash})).collect::<Vec<_>>(),"target_thread_id":target.thread_id});
        let prepared = PreparedAction {
            record_id: request.request_id.clone(),
            object_id,
            object_name: selected_name,
            fields,
            context,
            request,
        };
        let value = serde_json::to_string(&prepared).map_err(fail)?;
        let store = self.project_store()?;
        store.connection.execute("INSERT INTO spellcast_project_game_requests(project_id,id,kind,request_hash,value) VALUES(?1,?2,'action',?3,?4)",params![project,prepared.request.request_id,hash,value]).map_err(fail)?;
        Ok(prepared)
    }
    pub fn game_action(&self, project: &str, request: GameAction) -> Result<Value, SpellcastError> {
        let prepared = self.prepare_game_action(project, request)?;
        let existing = self
            .project_store()?
            .project_objects(project)
            .map_err(fail)?
            .into_iter()
            .find(|o| o.id == prepared.object_id);
        if let Some(object) = existing {
            if object.kind != "game_object" {
                return Err(fail("开发对象标识已有其他用途；未覆盖。"));
            }
        } else {
            self.project_user_mutate(serde_json::from_value(json!({"project_id":project,"request_id":format!("game-object-{}",prepared.object_id),"op":"put_object","id":prepared.object_id,"expected_revision":0,"name":prepared.object_name,"kind":"game_object","archived":false})).map_err(fail)?)?;
        }
        self.project_user_mutate(serde_json::from_value(json!({"project_id":project,"request_id":format!("game-record-{}",prepared.request.request_id),"op":"put_record","id":prepared.record_id,"expected_revision":0,"fields":prepared.fields})).map_err(fail)?)?;
        let event = self.say_with_project_context(
            SayRequest {
                text: prepared.request.prompt.clone(),
                request_id: Some(format!("game-task-{}", prepared.request.request_id)),
                source_id: Some(prepared.request.source_id.clone()),
                target_thread_id: Some(prepared.request.target_thread_id.clone()),
                ..Default::default()
            },
            Some(prepared.context),
        )?;
        let delivery = self
            .feedback_state(Some(&prepared.request.source_id))
            .deliveries
            .into_iter()
            .find(|receipt| receipt.event.seq == event.seq);
        Ok(
            json!({"record_id":prepared.record_id,"object_id":prepared.object_id,"event":event,"delivery":delivery}),
        )
    }
}
fn selected_sources(view: &GameZoneView, location: Option<&str>) -> Vec<GameSource> {
    let mut paths = std::collections::BTreeSet::from([view.zone.path.clone()]);
    if let Some(id) = location {
        if let Some(node) = view.locations.iter().find(|node| node.id == id) {
            if let Some(path) = &node.path {
                paths.insert(path.clone());
            }
            for candidate in &node.candidates {
                paths.extend(candidate.paths.clone());
            }
        }
    } else {
        paths.extend(view.sources.iter().map(|s| s.path.clone()));
    }
    view.sources
        .iter()
        .filter(|source| paths.contains(&source.path))
        .cloned()
        .collect()
}

pub(crate) fn router() -> Router<Arc<Bridge>> {
    Router::new()
        .route(
            "/api/projects/:project/game/connection",
            get(connection).post(connect),
        )
        .route("/api/projects/:project/game/zones", get(zones))
        .route("/api/projects/:project/game/view", get(view))
        .route("/api/projects/:project/game/overview", get(overview))
        .route("/api/projects/:project/game/document", get(document))
        .route("/api/projects/:project/game/zones/:zone", get(zone))
        .route("/api/projects/:project/game/source", get(source))
        .route("/api/projects/:project/game/actions", post(action))
}
async fn connection(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    b.game_connection(&project)
        .map(|c| Json(json!({"connection":c})))
        .map_err(bad)
}
async fn connect(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    headers: HeaderMap,
    Json(request): Json<ConnectGame>,
) -> Result<Json<GameConnection>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.connect_game(&project, request))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}
async fn zones(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.game_zones(&project))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}
#[derive(Deserialize)]
struct ViewQuery {
    zone_id: Option<String>,
    #[serde(default)]
    refresh: bool,
}
async fn view(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    Query(query): Query<ViewQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || {
        b.game_view(&project, query.zone_id.as_deref(), query.refresh)
    })
    .await
    .map_err(bad)?
    .map(Json)
    .map_err(bad)
}
#[derive(Deserialize)]
struct OverviewQuery {
    #[serde(default)]
    refresh: bool,
}
async fn overview(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    Query(query): Query<OverviewQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.game_overview(&project, query.refresh))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}
async fn document(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    Query(query): Query<SourceQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.game_document(&project, &query.path))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}
async fn zone(
    State(b): State<Arc<Bridge>>,
    RoutePath((project, zone)): RoutePath<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.game_zone(&project, &zone))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}
#[derive(Deserialize)]
struct SourceQuery {
    path: String,
}
async fn source(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    Query(query): Query<SourceQuery>,
    headers: HeaderMap,
) -> Result<Json<GameSource>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.game_source(&project, &query.path))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}
async fn action(
    State(b): State<Arc<Bridge>>,
    RoutePath(project): RoutePath<String>,
    headers: HeaderMap,
    Json(request): Json<GameAction>,
) -> Result<Json<Value>, Fail> {
    owner(&headers, &b)?;
    tokio::task::spawn_blocking(move || b.game_action(&project, request))
        .await
        .map_err(bad)?
        .map(Json)
        .map_err(bad)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{project_workspace::ProjectQuery, Headless};
    use axum::{body::Body, http::Request};
    use std::fs;
    use tower::ServiceExt;

    fn write(root: &std::path::Path, relative: &str, value: Value) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
    fn fixture() -> (PathBuf, PathBuf, Bridge, String) {
        let directory =
            std::env::temp_dir().join(format!("spellcast-game-{}", uuid::Uuid::new_v4()));
        let root = directory.join("game");
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(
            root.join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: fixture",
        )
        .unwrap();
        write(
            &root,
            &format!("{}/Zones/zone_fixture.json", game_config::CONFIG_ROOT),
            json!({"ZoneId":"zone_fixture","DisplayName":"Fixture zone","EntrySubLocationId":"location_a","SubLocationRefs":[{"SubLocationId":"location_a","Position":{"x":0,"y":0}},{"SubLocationId":"location_b","Position":{"x":100,"y":50}}],"SubLocationRoutes":[{"FromSubLocationId":"location_a","ToSubLocationId":"location_b"}]}),
        );
        write(
            &root,
            &format!("{}/SubLocations/location_a.json", game_config::CONFIG_ROOT),
            json!({"SubLocationId":"location_a","DisplayName":"Entry","FirstEntryContent":{"ContentId":"content_fixture"},"ContentPoolIds":["content_fixture"],"ContentPoolWeights":{"content_fixture":40}}),
        );
        write(
            &root,
            &format!("{}/SubLocations/location_b.json", game_config::CONFIG_ROOT),
            json!({"SubLocationId":"location_b","DisplayName":"Exit","IsBossGate":true,"UnlocksZoneId":"zone_next","BossGateContentId":"content_gate"}),
        );
        write(
            &root,
            &format!("{}/Contents/content_fixture.json", game_config::CONFIG_ROOT),
            json!({"ContentId":"content_fixture","DisplayName":"Encounter candidate","Type":"Battle","AssociatedDataId":"battle_fixture"}),
        );
        write(
            &root,
            &format!("{}/Contents/content_gate.json", game_config::CONFIG_ROOT),
            json!({"ContentId":"content_gate","DisplayName":"Gate candidate","Type":"BossGate","AssociatedDataId":"battle_fixture"}),
        );
        write(
            &root,
            &format!("{}/Battles/battle_fixture.json", game_config::CONFIG_ROOT),
            json!({"BattleId":"battle_fixture","DisplayName":"Battle data","Enemies":[{"TemplateId":"enemy_fixture","Level":2}]}),
        );
        let db = directory.join("state.sqlite3");
        let bridge = Bridge::open(Headless, 0, &db).unwrap();
        let project = uuid::Uuid::new_v4().to_string();
        bridge.project_user_mutate(serde_json::from_value(json!({"request_id":"create","project_id":project,"op":"create_project","name":"Game fixture","aliases":[root.to_string_lossy()]})).unwrap()).unwrap();
        (root, db, bridge, project)
    }
    fn connect(bridge: &Bridge, project: &str, root: &std::path::Path) -> GameConnection {
        bridge
            .connect_game(
                project,
                ConnectGame {
                    request_id: "connect".into(),
                    expected_revision: 0,
                    root: root.to_string_lossy().into_owned(),
                },
            )
            .unwrap()
    }
    #[test]
    fn explicit_connection_projects_real_references_and_is_not_portable_permission() {
        let (root, db, bridge, project) = fixture();
        assert!(
            bridge.game_zones(&project).is_err(),
            "alias must not authorize source reads"
        );
        let connection = connect(&bridge, &project, &root);
        assert_eq!(connection.revision, 1);
        assert_eq!(connect(&bridge, &project, &root).revision, 1);
        let data = bridge.game_zone(&project, "zone_fixture").unwrap();
        let combined = bridge
            .game_view(&project, Some("removed_zone"), false)
            .unwrap();
        assert_eq!(combined["view"], data["view"]);
        assert_eq!(combined["zones"][0]["id"], "zone_fixture");
        assert_eq!(data["view"]["locations"].as_array().unwrap().len(), 2);
        assert_eq!(data["view"]["routes"].as_array().unwrap().len(), 1);
        assert_eq!(data["view"]["runtime_verified"], false);
        let candidate = &data["view"]["locations"][0]["candidates"][0];
        assert_eq!(candidate["name"], "Encounter candidate");
        assert_eq!(candidate["associated_name"], "Battle data");
        assert_eq!(candidate["weight"], 40.0);
        assert_eq!(candidate["first_entry"], true);
        assert!(candidate["enemies"][0]
            .as_str()
            .unwrap()
            .contains("enemy_fixture"));
        let gate = &data["view"]["locations"][1]["candidates"][0];
        assert_eq!(gate["kind"], "BossGate");
        assert_eq!(gate["gate"], true);
        assert_eq!(gate["associated_name"], "Battle data");
        assert!(data["view"]["issues"].as_array().unwrap().is_empty());
        assert!(bridge
            .game_source(
                &project,
                &format!("{}/../../../state.sqlite3", game_config::CONFIG_ROOT)
            )
            .is_err());
        assert!(bridge
            .game_source(&project, "ProjectSettings/ProjectVersion.txt")
            .is_err());
        let export = bridge
            .project_query(ProjectQuery {
                view: "export".into(),
                project_id: project.clone(),
                ..Default::default()
            })
            .unwrap();
        let imported = uuid::Uuid::new_v4().to_string();
        bridge.project_user_mutate(serde_json::from_value(json!({"request_id":"import","project_id":imported,"op":"import_project","bundle":export,"name":"Imported fixture"})).unwrap()).unwrap();
        assert!(bridge.game_connection(&imported).unwrap().is_none());
        assert!(bridge.game_zones(&imported).is_err());
        drop(bridge);
        let _ = fs::remove_file(db);
    }
    #[test]
    fn missing_and_malformed_sources_are_visible_and_revisions_change() {
        let (root, db, bridge, project) = fixture();
        connect(&bridge, &project, &root);
        let before = bridge.game_zone(&project, "zone_fixture").unwrap();
        let path = root.join(format!(
            "{}/Contents/content_fixture.json",
            game_config::CONFIG_ROOT
        ));
        fs::write(path, b"not JSON").unwrap();
        let after = bridge.game_zone(&project, "zone_fixture").unwrap();
        assert_ne!(
            before["view"]["source_revision"],
            after["view"]["source_revision"]
        );
        assert_eq!(
            after["view"]["locations"][0]["candidates"][0]["missing"],
            true
        );
        assert!(!after["view"]["issues"].as_array().unwrap().is_empty());
        let duplicate = format!("{}/Zones/duplicate.json", game_config::CONFIG_ROOT);
        write(&root, &duplicate, json!({"ZoneId":"zone_fixture"}));
        let broken_view = bridge
            .game_view(&project, Some("zone_fixture"), false)
            .unwrap();
        assert!(broken_view["view"].is_null());
        assert_eq!(broken_view["zones"].as_array().unwrap().len(), 2);
        assert!(broken_view["view_error"].as_str().unwrap().contains("重复"));
        fs::remove_file(root.join(duplicate)).unwrap();
        fs::remove_file(root.join(format!(
            "{}/Zones/zone_fixture.json",
            game_config::CONFIG_ROOT
        )))
        .unwrap();
        let empty = bridge.game_view(&project, None, false).unwrap();
        assert!(empty["view"].is_null());
        assert!(empty["zones"].as_array().unwrap().is_empty());
        drop(bridge);
        let _ = fs::remove_file(db);
    }
    #[test]
    fn actions_reject_stale_sources_and_retry_with_one_record_and_one_delivery_after_restart() {
        let (root, db, bridge, project) = fixture();
        let connection = connect(&bridge, &project, &root);
        let thread = uuid::Uuid::new_v4().to_string();
        let source = format!("codex:{thread}");
        // Simulate only an already-verified binding. No delivery worker or real task is started.
        bridge
            .update(|state| {
                state.bindings.push(crate::codex::CodexBinding {
                    source_id: source.clone(),
                    thread_id: thread.clone(),
                    cwd: connection.root,
                    label: "Fixture task".into(),
                    executable: "fixture".into(),
                    protocol_agent: "fixture".into(),
                    bound_at_ms: now_ms(),
                });
                Ok(())
            })
            .unwrap();
        let view = bridge.game_zone(&project, "zone_fixture").unwrap();
        let mut request = GameAction {
            request_id: uuid::Uuid::new_v4().to_string(),
            zone_id: "zone_fixture".into(),
            location_id: Some("location_a".into()),
            expected_source_revision: "stale".into(),
            intent: "verify".into(),
            prompt: "Check the selected location only.".into(),
            source_id: source.clone(),
            target_thread_id: thread.clone(),
        };
        assert!(bridge.game_action(&project, request.clone()).is_err());
        assert!(bridge
            .project_store()
            .unwrap()
            .project_records(&project, "", None, true)
            .unwrap()
            .is_empty());
        request.expected_source_revision = view["view"]["source_revision"].as_str().unwrap().into();
        // A new action must read bytes even when an external editor preserves metadata.
        let source_path = root.join(format!(
            "{}/SubLocations/location_a.json",
            game_config::CONFIG_ROOT
        ));
        let modified = fs::metadata(&source_path).unwrap().modified().unwrap();
        let original = fs::read_to_string(&source_path).unwrap();
        fs::write(&source_path, original.replace("\"Entry\"", "\"Other\"")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&source_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            bridge.game_zone(&project, "zone_fixture").unwrap()["view"]["source_revision"],
            request.expected_source_revision
        );
        assert!(bridge
            .game_action(&project, request.clone())
            .unwrap_err()
            .to_string()
            .contains("配置已在查看后变化"));
        request.expected_source_revision = bridge
            .game_view(&project, Some("zone_fixture"), true)
            .unwrap()["view"]["source_revision"]
            .as_str()
            .unwrap()
            .into();
        let first = bridge.game_action(&project, request.clone()).unwrap();
        let seq = first["event"]["seq"].as_u64().unwrap();
        assert_eq!(first["delivery"]["phase"], "waiting");
        assert_eq!(
            first["event"]["project_context"]["location_id"],
            "location_a"
        );
        assert_eq!(
            bridge.game_action(&project, request.clone()).unwrap()["event"]["seq"],
            seq
        );
        let mut changed = request.clone();
        changed.prompt = "Different payload".into();
        assert!(bridge.game_action(&project, changed).is_err());
        write(
            &root,
            &format!("{}/SubLocations/location_a.json", game_config::CONFIG_ROOT),
            json!({"SubLocationId":"location_a","DisplayName":"Changed after submission"}),
        );
        assert_eq!(
            bridge.game_action(&project, request.clone()).unwrap()["event"]["seq"],
            seq
        );
        drop(bridge);
        let bridge = Bridge::open(Headless, 0, &db).unwrap();
        assert_eq!(
            bridge.game_action(&project, request.clone()).unwrap()["event"]["seq"],
            seq
        );
        assert_eq!(bridge.feedback_state(Some(&source)).deliveries.len(), 1);
        assert_eq!(
            bridge
                .project_store()
                .unwrap()
                .project_history(&project, "record", &request.request_id)
                .unwrap()
                .len(),
            1
        );
        bridge
            .update(|state| {
                state.bindings[0].thread_id = uuid::Uuid::new_v4().to_string();
                Ok(())
            })
            .unwrap();
        let replay = bridge.game_action(&project, request).unwrap();
        assert_eq!(replay["event"]["target_thread_id"], thread);
        drop(bridge);
        let _ = fs::remove_file(db);
    }
    #[tokio::test]
    async fn repository_routes_require_owner_credentials() {
        let (root, db, bridge, project) = fixture();
        connect(&bridge, &project, &root);
        let bridge = Arc::new(bridge);
        let app = crate::api::router(bridge.clone());
        let blocked_view = app
            .clone()
            .oneshot(
                Request::get(format!("/api/projects/{project}/game/view"))
                    .header("origin", "http://tauri.localhost")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked_view.status(), StatusCode::FORBIDDEN);
        let uri = format!("/api/projects/{project}/game/connection");
        for with_origin in [false, true] {
            let mut request = Request::get(&uri);
            if with_origin {
                request = request.header("origin", "http://tauri.localhost");
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let response = app
            .clone()
            .oneshot(
                Request::get(&uri)
                    .header("origin", "http://tauri.localhost")
                    .header("x-spellcast-window", bridge.project_window_key())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/api/projects/{project}/game/view?zone_id=zone_fixture&refresh=true"
                ))
                .header("origin", "http://tauri.localhost")
                .header("x-spellcast-window", bridge.project_window_key())
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        drop(app);
        drop(bridge);
        let _ = fs::remove_file(db);
    }
}

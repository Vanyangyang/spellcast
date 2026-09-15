//! Immutable local Web bundles. Only explicitly published files enter the renderer.
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path};

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spellcast_core::{BoardReply, ReplyBlock, ReplyRequest, SpellcastError};

use crate::Bridge;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactPortType { Number, String, Boolean, Null }

impl ArtifactPortType {
    pub(crate) fn accepts(self, value: &serde_json::Value) -> bool {
        match self {
            Self::Number => value.as_f64().is_some_and(f64::is_finite),
            Self::String => value.as_str().is_some_and(|s| s.len() <= 16_000),
            Self::Boolean => value.is_boolean(),
            Self::Null => value.is_null(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactIO {
    #[serde(default)]
    pub inputs: BTreeMap<String, ArtifactPortType>,
    #[serde(default)]
    pub outputs: BTreeMap<String, ArtifactPortType>,
}

impl ArtifactIO {
    fn validate(&self) -> Result<(), SpellcastError> {
        if self.inputs.len() > 32 || self.outputs.len() > 32 {
            return Err(SpellcastError::user("作品最多声明 32 个输入和 32 个输出。"));
        }
        for port in self.inputs.keys().chain(self.outputs.keys()) {
            spellcast_core::reply::validate_id(port)?;
            if matches!(port.as_str(), "__proto__" | "constructor" | "prototype") {
                return Err(SpellcastError::user("这个接口名称是保留名称。"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactFileInfo {
    pub name: String,
    pub media_type: String,
    pub bytes: usize,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactBundle {
    pub id: String,
    pub source_id: String,
    pub reply_id: String,
    pub block_id: String,
    pub entry: String,
    pub files: Vec<ArtifactFileInfo>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub io: ArtifactIO,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactEdit {
    #[serde(default)]
    pub object_id: Option<String>,
    #[serde(default)]
    pub reply_id: String,
    pub block_id: String,
    pub bundle_id: String,
    pub expected_revision: u64,
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PublishArtifact {
    pub source_id: String,
    #[serde(default)]
    pub source_label: Option<String>,
    /// Stable reply id. Existing replies require expected_revision.
    pub reply_id: String,
    pub block_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Absolute directory containing only the work's distributable files and source.
    pub directory: String,
    /// Relative HTML entry point; all dependencies and media must be included locally.
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub feedback_sequences: Vec<u64>,
    /// Finite data ports exposed to the canvas; separate from the work's saved state.
    #[serde(default)]
    pub io: ArtifactIO,
}

fn default_entry() -> String {
    "index.html".into()
}
fn error(err: impl std::fmt::Display) -> SpellcastError {
    SpellcastError::user(err.to_string())
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 512
        && !name.contains(['\\', ':', '?', '#', '%', '\0'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.starts_with('.'))
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn mime(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" | "gltf" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "glb" => "model/gltf-binary",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "txt" | "md" | "ts" | "csv" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

type BundleFiles = Vec<(ArtifactFileInfo, Vec<u8>)>;

fn collect(
    root: &Path,
    directory: &Path,
    files: &mut BundleFiles,
    total: &mut usize,
    visited: &mut HashSet<std::path::PathBuf>,
) -> Result<(), SpellcastError> {
    if !visited.insert(directory.to_path_buf()) {
        return Err(SpellcastError::user("资源目录包含循环或重复链接。"));
    }
    for entry in std::fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        let metadata = entry.file_type().map_err(error)?;
        let path = entry.path();
        let name = path
            .strip_prefix(root)
            .map_err(error)?
            .to_string_lossy()
            .replace('\\', "/");
        if !valid_name(&name) || metadata.is_symlink() {
            return Err(SpellcastError::user(format!(
                "不能导入隐藏路径、链接或无效资源名：{name}"
            )));
        }
        let canonical = path.canonicalize().map_err(error)?;
        if !canonical.starts_with(root) {
            return Err(SpellcastError::user("资源超出了发布目录。"));
        }
        if metadata.is_dir() {
            collect(root, &canonical, files, total, visited)?;
        } else if metadata.is_file() {
            let len = entry.metadata().map_err(error)?.len();
            if len > 128 * 1024 * 1024
                || *total as u64 + len > 256 * 1024 * 1024
                || files.len() >= 2048
            {
                return Err(SpellcastError::user(
                    "作品最多 2048 个文件、合计 256 MiB、单文件 128 MiB。",
                ));
            }
            // Read a bounded stream as the build may still be modifying its output.
            use std::io::Read;
            let mut bytes = Vec::new();
            std::fs::File::open(&canonical)
                .map_err(error)?
                .take(128 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(error)?;
            *total += bytes.len();
            if bytes.len() > 128 * 1024 * 1024 || *total > 256 * 1024 * 1024 {
                return Err(SpellcastError::user("资源在导入时增长到大小限制之外。"));
            }
            files.push((
                ArtifactFileInfo {
                    media_type: mime(&name).into(),
                    name,
                    bytes: bytes.len(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                },
                bytes,
            ));
        } else {
            return Err(SpellcastError::user("只能发布普通文件。"));
        }
    }
    Ok(())
}

impl Bridge {
    pub fn publish_artifact(&self, req: PublishArtifact) -> Result<BoardReply, SpellcastError> {
        req.io.validate()?;
        spellcast_core::reply::validate_id(&req.source_id)?;
        spellcast_core::reply::validate_id(&req.reply_id)?;
        spellcast_core::reply::validate_id(&req.block_id)?;
        if !valid_name(&req.entry) || !mime(&req.entry).starts_with("text/html") {
            return Err(SpellcastError::user("入口需要是发布目录内的 HTML 文件。"));
        }
        if !Path::new(&req.directory).is_absolute() {
            return Err(SpellcastError::user("发布目录需要绝对路径。"));
        }
        let root = Path::new(&req.directory).canonicalize().map_err(error)?;
        if !root.is_dir() {
            return Err(SpellcastError::user("发布路径不是目录。"));
        }
        let mut files = Vec::new();
        collect(&root, &root, &mut files, &mut 0, &mut HashSet::new())?;
        if files.iter().any(|(file, _)| file.name == "__spellcast.js") {
            return Err(SpellcastError::user(
                "__spellcast.js 是作品通信使用的保留文件名。",
            ));
        }
        let runtime = include_bytes!("artifact-runtime.js").to_vec();
        files.push((
            ArtifactFileInfo {
                name: "__spellcast.js".into(),
                media_type: "text/javascript; charset=utf-8".into(),
                bytes: runtime.len(),
                sha256: format!("{:x}", Sha256::digest(&runtime)),
            },
            runtime,
        ));
        files.sort_by(|a, b| a.0.name.cmp(&b.0.name));
        if !files
            .iter()
            .any(|(file, bytes)| file.name == req.entry && std::str::from_utf8(bytes).is_ok())
        {
            return Err(SpellcastError::user("没有找到 UTF-8 HTML 入口文件。"));
        }
        let bundle = ArtifactBundle {
            id: spellcast_core::new_id(),
            source_id: req.source_id.clone(),
            entry: req.entry,
            reply_id: req.reply_id.clone(),
            block_id: req.block_id.clone(),
            files: files.iter().map(|(file, _)| file.clone()).collect(),
            created_at_ms: spellcast_core::inbox::now_ms(),
            io: req.io,
        };
        let block = ReplyBlock::Artifact {
            id: req.block_id,
            title: req.title.clone(),
            description: req.description,
            bundle_id: bundle.id.clone(),
            state: serde_json::Value::Null,
            state_revision: 0,
        };
        block.validate()?;
        let existing = self
            .board()
            .replies
            .into_iter()
            .find(|reply| reply.id == req.reply_id);
        if let Some(reply) = &existing {
            if reply.source_id != req.source_id || Some(reply.revision) != req.expected_revision {
                return Err(SpellcastError::user(
                    "任务来源或内容版本不匹配，请先读取最新回复。",
                ));
            }
        } else if req.expected_revision.is_some_and(|revision| revision != 0) {
            return Err(SpellcastError::user("要更新的回复不存在。"));
        }
        // Save immutable bytes before referencing them. Failed content updates never destroy an older bundle.
        self.store
            .as_ref()
            .ok_or_else(|| SpellcastError::user("发布作品需要已打开的本地状态库。"))?
            .lock()
            .unwrap()
            .save_artifact(&bundle, &files)
            .map_err(error)?;
        let mut blocks = existing
            .as_ref()
            .map(|r| r.blocks.clone())
            .unwrap_or_default();
        if let Some(old) = blocks.iter_mut().find(|b| b.id() == block.id()) {
            *old = block;
        } else {
            blocks.push(block);
        }
        let result = self.write_reply_for_feedback(
            ReplyRequest {
                id: Some(req.reply_id),
                source_id: req.source_id,
                source_label: req.source_label,
                origin_node_id: existing.as_ref().and_then(|r| r.origin_node_id.clone()),
                title: existing.map(|r| r.title).unwrap_or(req.title),
                blocks,
                expected_revision: req.expected_revision,
            },
            &req.feedback_sequences,
        );
        self.finish_artifact(&bundle.id, result)
    }

    pub fn artifact(&self, id: &str) -> Result<ArtifactBundle, SpellcastError> {
        self.store
            .as_ref()
            .ok_or_else(|| SpellcastError::user("本地状态库未打开。"))?
            .lock()
            .unwrap()
            .artifact(id)
            .map_err(error)?
            .ok_or_else(|| SpellcastError::user("作品资源不存在。"))
    }

    pub fn artifact_file(&self, id: &str, name: &str) -> Result<(String, Vec<u8>), SpellcastError> {
        if !valid_name(name) {
            return Err(SpellcastError::user("无效资源名。"));
        }
        self.store
            .as_ref()
            .ok_or_else(|| SpellcastError::user("本地状态库未打开。"))?
            .lock()
            .unwrap()
            .artifact_file(id, name)
            .map_err(error)?
            .ok_or_else(|| SpellcastError::user("作品资源不存在。"))
    }

    pub(crate) fn validate_artifacts(
        &self,
        source: &str,
        blocks: &[ReplyBlock],
    ) -> Result<(), SpellcastError> {
        for block in blocks {
            if let ReplyBlock::Artifact { bundle_id, .. } = block {
                if self.artifact(bundle_id)?.source_id != source {
                    return Err(SpellcastError::user("作品资源属于另一个任务。"));
                }
            }
        }
        Ok(())
    }

    pub fn save_artifact_state(
        &self,
        req: spellcast_core::ArtifactStatePatch,
    ) -> Result<BoardReply, SpellcastError> {
        let reply = self.update(|state| state.session.patch_artifact_state(req))?;
        self.surface.board_changed();
        Ok(reply)
    }

    pub fn artifact_history(&self, id: &str) -> Result<Vec<ArtifactBundle>, SpellcastError> {
        let bundle = self.artifact(id)?;
        self.store
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .artifact_history(&bundle.reply_id, &bundle.block_id)
            .map_err(error)
    }

    pub fn edit_artifact(&self, mut req: ArtifactEdit) -> Result<BoardReply, SpellcastError> {
        let hash = crate::feedback::fingerprint("artifact-edit", &req)?;
        {
            let state = self.state.lock().unwrap();
            req.reply_id = state.session.canvas_reply_id(req.object_id.as_deref(), &req.reply_id)?;
            if self
                .replay_request(&state, req.request_id.as_deref(), &hash)?
                .is_some()
            {
                return state
                    .session
                    .board
                    .replies
                    .iter()
                    .find(|r| r.id == req.reply_id)
                    .cloned()
                    .ok_or_else(|| SpellcastError::user("修改已保存，但原回复已被删除。"));
            }
        }
        if req.name == "__spellcast.js"
            || !valid_name(&req.name)
            || req.text.len() > 2 * 1024 * 1024
        {
            return Err(SpellcastError::user("不能修改运行接口，文本文件限 2 MiB。"));
        }
        let reply = self
            .board()
            .replies
            .into_iter()
            .find(|r| r.id == req.reply_id)
            .ok_or_else(|| SpellcastError::user("回复不存在。"))?;
        let mut block = reply
            .blocks
            .iter()
            .find(|b| b.id() == req.block_id)
            .cloned()
            .ok_or_else(|| SpellcastError::user("作品不存在。"))?;
        let ReplyBlock::Artifact { bundle_id, .. } = &mut block else {
            return Err(SpellcastError::user("这不是开放作品。"));
        };
        if *bundle_id != req.bundle_id || reply.revision != req.expected_revision {
            return Err(SpellcastError::user(
                "作品已经更新；你的源码草稿没有覆盖新版本。",
            ));
        }
        let mut bundle = self.artifact(bundle_id)?;
        let mut files = Vec::new();
        let mut found = false;
        for file in &mut bundle.files {
            let bytes = if file.name == req.name {
                found = true;
                req.text.as_bytes().to_vec()
            } else {
                self.artifact_file(&bundle.id, &file.name)?.1
            };
            file.bytes = bytes.len();
            file.sha256 = format!("{:x}", Sha256::digest(&bytes));
            files.push((file.clone(), bytes));
        }
        if !found {
            return Err(SpellcastError::user("这个源文件已经不存在。"));
        }
        if files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() > 256 * 1024 * 1024 {
            return Err(SpellcastError::user("作品总大小超过 256 MiB。"));
        }
        bundle.id = spellcast_core::new_id();
        bundle.created_at_ms = spellcast_core::inbox::now_ms();
        self.store
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .save_artifact(&bundle, &files)
            .map_err(error)?;
        *bundle_id = bundle.id.clone();
        let result = self.patch_reply_inner(
            spellcast_core::ReplyPatchRequest {
                object_id: req.object_id,
                reply_id: req.reply_id,
                request_id: req.request_id,
                expected_revision: req.expected_revision,
                block,
                layout_only: false,
            },
            None,
            &[],
            Some(hash),
        );
        self.finish_artifact(&bundle.id, result)
    }

    fn finish_artifact(
        &self,
        id: &str,
        result: Result<BoardReply, SpellcastError>,
    ) -> Result<BoardReply, SpellcastError> {
        let refers = |reply: &BoardReply| {
            reply.blocks.iter().any(
                |block| matches!(block, ReplyBlock::Artifact { bundle_id, .. } if bundle_id == id),
            )
        };
        if !result.as_ref().is_ok_and(refers) {
            let state = self.state.lock().unwrap();
            if !state.session.board.replies.iter().any(refers) {
                // Roll back only this unpublished bundle; previously committed versions are retained.
                if let Some(store) = &self.store {
                    if let Err(error) = store.lock().unwrap().discard_artifact(id) {
                        tracing::warn!(%error, "could not remove unpublished artifact");
                    }
                }
            }
        }
        result
    }
}

/// Opaque-frame resources get CORS, while the control API retains its trusted-origin guard.
pub fn resource_response(
    b: &Bridge,
    bundle: &str,
    name: &str,
    range: Option<&str>,
    host: &str,
) -> Response {
    let Ok((mime, mut bytes)) = b.artifact_file(bundle, name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap());
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    let base = format!("http://{host}/artifacts/{bundle}/");
    let policy = format!("sandbox allow-scripts allow-forms allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {base} blob:; style-src 'unsafe-inline' {base}; img-src {base} data: blob:; font-src {base} data:; media-src {base} data: blob:; connect-src {base}; worker-src {base} blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&policy).unwrap(),
    );
    let length = bytes.len();
    if mime.starts_with("text/html") {
        // The first doctype preserves standards mode, including entries without an explicit head.
        let mut document = format!(
            "<!doctype html><script src=\"/artifacts/{bundle}/__spellcast.js\"></script>\n"
        )
        .into_bytes();
        document.extend(bytes);
        bytes = document;
    } else if let Some(range) = range {
        let Some((start, end)) = parse_range(range, length) else {
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{length}")).unwrap(),
            );
            return (StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response();
        };
        bytes = bytes[start..=end].to_vec();
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{length}")).unwrap(),
        );
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        return (StatusCode::PARTIAL_CONTENT, headers, bytes).into_response();
    }
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    (headers, bytes).into_response()
}

fn parse_range(range: &str, length: usize) -> Option<(usize, usize)> {
    let (a, b) = range.strip_prefix("bytes=")?.split_once('-')?;
    if length == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        (length.saturating_sub(b.parse::<usize>().ok()?), length - 1)
    } else {
        (
            a.parse::<usize>().ok()?,
            if b.is_empty() {
                length - 1
            } else {
                b.parse::<usize>().ok()?.min(length - 1)
            },
        )
    };
    (start <= end && start < length).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use serde_json::json;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn fixture() -> (std::path::PathBuf, std::path::PathBuf, Bridge) {
        let root = std::env::temp_dir().join(format!(
            "spellcast-artifact-test-{}",
            spellcast_core::new_id()
        ));
        std::fs::create_dir_all(root.join("work")).unwrap();
        std::fs::write(
            root.join("work/index.html"),
            "<!doctype html><title>Original</title><p>保留原作</p>",
        )
        .unwrap();
        std::fs::write(root.join("work/tone.wav"), [0, 1, 2, 3, 4, 5, 6, 7]).unwrap();
        let db = root.join("state.sqlite3");
        let bridge = Bridge::open(crate::Headless, 47194, &db).unwrap();
        (root, db, bridge)
    }
    fn publish(root: &Path, revision: Option<u64>) -> PublishArtifact {
        PublishArtifact {
            source_id: "codex:artifact".into(),
            source_label: None,
            reply_id: "artifact-reply".into(),
            block_id: "work".into(),
            title: "可运行作品".into(),
            description: "保存文件与选择".into(),
            directory: root.join("work").to_string_lossy().into(),
            entry: "index.html".into(),
            expected_revision: revision,
            feedback_sequences: vec![],
            io: ArtifactIO::default(),
        }
    }
    fn bundle(reply: &BoardReply) -> &str {
        let ReplyBlock::Artifact { bundle_id, .. } = &reply.blocks[0] else {
            panic!()
        };
        bundle_id
    }
    fn cleanup(root: std::path::PathBuf) {
        let resolved = root.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("spellcast-artifact-test-"));
        std::fs::remove_dir_all(resolved).unwrap();
    }

    #[tokio::test]
    async fn canvas_remove_restore_and_explicit_delete_preserve_identity_and_artifact_history() {
        let (root, db, bridge) = fixture();
        let reply = bridge.publish_artifact(publish(&root, None)).unwrap();
        let bundle_id = bundle(&reply).to_string();
        let node = bridge
            .add_node(spellcast_core::NodeDraft::default())
            .unwrap();
        let kept = bridge
            .add_node(spellcast_core::NodeDraft::default())
            .unwrap();
        bridge
            .update(|state| {
                state.kept.insert("delete-test".into(), node.id.clone());
                state.session.board.edges.push(spellcast_core::BoardEdge {
                    id: "delete-test-edge".into(),
                    from: node.id.clone(),
                    to: kept.id.clone(),
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap();
        let before = bridge.board();
        assert!(bridge
            .remove_canvas_item(&format!("reply:{}", reply.id), reply.revision + 1)
            .is_err());
        assert!(bridge
            .remove_canvas_item(&format!("node:{}", node.id), node.revision + 1)
            .is_err());
        assert!(bridge.remove_canvas_item("other:invalid", 0).is_err());
        assert_eq!(
            serde_json::to_value(&bridge.board()).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        {
            let bridge = Arc::new(bridge);
            let app = crate::api::router(bridge.clone());
            for (item_id, revision) in [
                (format!("reply:{}", reply.id), reply.revision),
                (format!("node:{}", node.id), node.revision),
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        axum::http::Request::builder()
                            .method("DELETE")
                            .uri("/api/canvas")
                            .header("Origin", "http://tauri.localhost")
                            .header("Content-Type", "application/json")
                            .body(axum::body::Body::from(
                                json!({"item_id":item_id,"expected_revision":revision}).to_string(),
                            ))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::OK);
                let bytes = response.into_body().collect().await.unwrap().to_bytes();
                let snapshot: spellcast_core::BoardSnapshot =
                    serde_json::from_slice(&bytes).unwrap();
                let object = snapshot.canvas.objects.iter().find(|object| object.content.legacy_id().as_deref() == Some(item_id.as_str())).unwrap();
                assert!(snapshot.canvas.items.iter().find(|item| item.item_id == object.id).unwrap().removed);
                // Legacy retries hide the same presentation without deleting its content.
                bridge.remove_canvas_item(&item_id, revision).unwrap();
            }
            assert!(bridge
                .state
                .lock()
                .unwrap()
                .kept
                .contains_key("delete-test"));
            assert_eq!(serde_json::to_value(&bridge.board().edges).unwrap(), serde_json::to_value(&before.edges).unwrap());
            assert_eq!(
                bridge.artifact_file(&bundle_id, "tone.wav").unwrap().1,
                vec![0, 1, 2, 3, 4, 5, 6, 7]
            );
        }
        let reopened = Bridge::open(crate::Headless, 47194, &db).unwrap();
        let after = reopened.board();
        assert_eq!(serde_json::to_value(&after.replies).unwrap(), serde_json::to_value(&before.replies).unwrap());
        assert_eq!(serde_json::to_value(&after.nodes).unwrap(), serde_json::to_value(&before.nodes).unwrap());
        assert_eq!(after.canvas.objects, before.canvas.objects);
        assert_eq!(after.canvas.items.iter().filter(|item| item.removed).count(), 2);
        for removed in after.canvas.items.iter().filter(|item| item.removed) {
            let restored = reopened.restore_canvas_item(&removed.item_id, removed.revision).unwrap();
            let current = restored.canvas.items.iter().find(|item| item.item_id == removed.item_id).unwrap();
            let old = before.canvas.items.iter().find(|item| item.item_id == removed.item_id).unwrap();
            assert!(!current.removed);
            assert_eq!((current.x, current.y, current.width, current.height, current.z), (old.x, old.y, old.width, old.height, old.z));
        }
        let object = after.canvas.object_for(&spellcast_core::CanvasContent::Reply { id: reply.id.clone() }).unwrap();
        let saved = reopened.save_artifact_state(spellcast_core::ArtifactStatePatch {
            object_id: Some(object.id.clone()), reply_id: String::new(), block_id: reply.blocks[0].id().into(),
            bundle_id: bundle_id.clone(), expected_state_revision: 0, state: json!({"amount": 42}),
        }).unwrap();
        let (_, event) = reopened.reply_action(spellcast_core::ReplyActionInput {
            object_id: Some(object.id.clone()), reply_id: String::new(), request_id: None,
            block_id: reply.blocks[0].id().into(), action: spellcast_core::ReplyAction::Ask,
            option_id: None, text: Some("继续这个对象".into()), artifact_context: None,
        }).unwrap();
        assert_eq!(event.object_id.as_deref(), Some(object.id.as_str()));
        assert_eq!(event.object_revision, Some(saved.revision));
        assert_eq!(event.artifact_context.as_ref().unwrap()["state"]["amount"], 42);
        let node_object = after.canvas.object_for(&spellcast_core::CanvasContent::Node { id: node.id.clone() }).unwrap();
        let purged = reopened.delete_canvas_content(&node_object.id, node_object.content_revision, vec![]).unwrap();
        assert_eq!(purged.nodes.len(), 1);
        assert_eq!(purged.nodes[0].id, kept.id);
        assert!(purged.edges.is_empty());
        assert!(!reopened.state.lock().unwrap().kept.contains_key("delete-test"));
        assert!(purged.canvas.object(&node_object.id).is_none());
        assert_eq!(reopened.artifact_history(&bundle_id).unwrap().len(), 1);
        drop(reopened);
        cleanup(root);
    }

    #[test]
    fn source_versions_preserve_parameters_and_restart_rejects_foreign_and_stale_writes() {
        let (root, db, bridge) = fixture();
        let first = bridge.publish_artifact(publish(&root, None)).unwrap();
        let id = bundle(&first).to_string();
        let state = json!({"speed":3,"selection":{"ids":["rotor"],"label":"转子"}});
        let request = spellcast_core::ArtifactStatePatch {
            object_id: None,
            reply_id: first.id.clone(),
            block_id: "work".into(),
            bundle_id: id.clone(),
            expected_state_revision: 0,
            state: state.clone(),
        };
        let changed = bridge.save_artifact_state(request.clone()).unwrap();
        assert_eq!(changed.revision, 1);
        assert!(bridge.pending_feedback(None).is_empty());
        assert!(bridge.save_artifact_state(request).is_err());
        let second = bridge.publish_artifact(publish(&root, Some(1))).unwrap();
        assert_ne!(bundle(&second), id);
        let ReplyBlock::Artifact {
            state: preserved,
            state_revision,
            ..
        } = &second.blocks[0]
        else {
            panic!()
        };
        assert_eq!(preserved, &state);
        assert_eq!(*state_revision, 1);
        let mut foreign = publish(&root, Some(2));
        foreign.source_id = "codex:other".into();
        assert!(bridge.publish_artifact(foreign).is_err());
        assert!(bridge.publish_artifact(publish(&root, Some(1))).is_err());
        assert!(bridge
            .patch_reply_from_source(
                "codex:other",
                spellcast_core::ReplyPatchRequest {
                    object_id: None,
                    request_id: None,
                    reply_id: first.id.clone(),
                    expected_revision: 2,
                    block: second.blocks[0].clone(),
                    layout_only: false
                }
            )
            .is_err());
        drop(bridge);
        std::fs::write(root.join("work/index.html"), "changed outside the store").unwrap();
        let bridge = Bridge::open(crate::Headless, 47194, db).unwrap();
        assert!(
            String::from_utf8(bridge.artifact_file(&id, "index.html").unwrap().1)
                .unwrap()
                .contains("Original")
        );
        let ReplyBlock::Artifact { state: actual, .. } = &bridge.board().replies[0].blocks[0]
        else {
            panic!()
        };
        assert_eq!(actual, &state);
        assert_eq!(bridge.artifact_history(&id).unwrap().len(), 2);
        drop(bridge);
        cleanup(root);
    }

    #[test]
    fn source_edit_retry_is_one_request_and_feedback_keeps_the_exact_selected_version() {
        let (root, db, bridge) = fixture();
        let first = bridge.publish_artifact(publish(&root, None)).unwrap();
        let original = bundle(&first).to_string();
        let edit = || ArtifactEdit {
            object_id: None,
            reply_id: first.id.clone(),
            block_id: "work".into(),
            bundle_id: original.clone(),
            expected_revision: 1,
            name: "index.html".into(),
            text: "<!doctype html><title>Edited</title>".into(),
            request_id: Some("edit-once".into()),
        };
        let changed = bridge.edit_artifact(edit()).unwrap();
        assert_eq!(
            bridge.edit_artifact(edit()).unwrap().revision,
            changed.revision
        );
        assert!(bridge.pending_feedback(None).is_empty(), "Saving the artifact source is local until explicit send.");
        let selected = json!({"selection":{"region":{"x":0.1,"y":0.2,"width":0.3,"height":0.4},"label":"原版左上角"}});
        let (_, event) = bridge
            .reply_action(spellcast_core::ReplyActionInput {
                object_id: None,
                reply_id: first.id.clone(),
                request_id: Some("ask-once".into()),
                block_id: "work".into(),
                action: spellcast_core::ReplyAction::Ask,
                option_id: None,
                text: Some("修改这里".into()),
                artifact_context: Some(spellcast_core::ArtifactFeedback {
                    bundle_id: original.clone(),
                    state: selected.clone(),
                    state_revision: None,
                    inputs: None,
                }),
            })
            .unwrap();
        assert_eq!(
            event.artifact_context.as_ref().unwrap()["bundle_id"],
            original
        );
        assert_eq!(event.artifact_context.as_ref().unwrap()["state"], selected);
        drop(bridge);
        let bridge = Bridge::open(crate::Headless, 47194, db).unwrap();
        assert_eq!(
            bridge.edit_artifact(edit()).unwrap().revision,
            changed.revision
        );
        assert_eq!(bridge.pending_feedback(None).len(), 1);
        let mut misuse = edit();
        misuse.text = "different payload same key".into();
        assert!(bridge.edit_artifact(misuse).is_err());
        drop(bridge);
        cleanup(root);
    }

    #[tokio::test]
    async fn opaque_frames_read_only_their_resources_and_media_ranges_are_real_bytes() {
        let (root, _, bridge) = fixture();
        let reply = bridge.publish_artifact(publish(&root, None)).unwrap();
        let id = bundle(&reply).to_string();
        let bridge = Arc::new(bridge);
        let app = crate::api::router(bridge.clone());
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/artifacts/{id}/index.html"))
                    .header("Host", "127.0.0.1:47194")
                    .header("Origin", "null")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(csp.contains(&format!("http://127.0.0.1:47194/artifacts/{id}/")));
        let content = response.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&content).contains("__spellcast.js"));
        for (name, value) in [("Origin", "null"), ("Sec-Fetch-Site", "cross-site")] {
            let response = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri("/api/board")
                        .header(name, value)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/artifacts/{id}/tone.wav"))
                    .header("Range", "bytes=2-4")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-4/8");
        assert_eq!(
            &response.into_body().collect().await.unwrap().to_bytes()[..],
            &[2, 3, 4]
        );
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/api/artifacts/{id}/file?name=index.html"))
                    .header("Origin", "http://tauri.localhost")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&bytes).contains("__spellcast.js"));
        // The delivery worker owns an Arc until this runtime shuts down; preserve its temp database.
        drop(bridge);
    }

    #[test]
    fn paths_and_media_ranges_are_bounded() {
        for bad in [
            "../x",
            "a/../x",
            "/x",
            "C:/x",
            "a\\x",
            "a//x",
            "a/.secret",
            "a%2fx",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(valid_name("模型/part 1.glb"));
        assert_eq!(parse_range("bytes=2-4", 8), Some((2, 4)));
        assert_eq!(parse_range("bytes=-3", 8), Some((5, 7)));
        assert_eq!(parse_range("bytes=5-", 8), Some((5, 7)));
        assert_eq!(parse_range("bytes=9-", 8), None);
        assert_eq!(parse_range("bytes=1-2,5-6", 8), None);
    }
}

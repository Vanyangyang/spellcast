//! Native-only grant UI and bounded local pipe. No changes to network/Origin/key
//! rules; no HTTP, MCP, generic IPC, URL forwarding or credential handoff.
use serde::Serialize;
use spellcast_bridge::{
    client_access::{
        ClientError, ClientGrant, ClientIdentity, ClientReply, ClientRequest, ClientScopes,
        OsClient, MAX_FRAME, MAX_REPLY,
    },
    Bridge,
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
pub struct Candidate {
    pub id: String,
    pub identity: ClientIdentity,
    pub process_id: u32,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant: Option<ClientGrant>,
}
struct Seen {
    peer: OsClient,
    seen: Instant,
}
#[derive(Serialize)]
pub struct ClientAccessList {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub candidates: Vec<Candidate>,
    pub grants: Vec<ClientGrant>,
}

pub struct ClientAuthorization {
    bridge: Arc<Bridge>,
    candidates: Mutex<BTreeMap<String, Seen>>,
    available: AtomicBool,
    error: Mutex<Option<&'static str>>,
    stopped: AtomicBool,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl ClientAuthorization {
    pub fn new(bridge: Arc<Bridge>) -> Arc<Self> {
        Arc::new(Self {
            bridge,
            candidates: Mutex::new(BTreeMap::new()),
            available: AtomicBool::new(false),
            error: Mutex::new(None),
            stopped: AtomicBool::new(false),
            task: Mutex::new(None),
        })
    }
    fn unavailable(&self, code: &'static str) {
        self.available.store(false, Ordering::SeqCst);
        *self.error.lock().unwrap() = Some(code);
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.available.store(false, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
    }
    pub fn start(self: &Arc<Self>, database: &Path) {
        #[cfg(windows)]
        {
            let result = crate::client_identity::secure_storage(database)
                .and_then(|_| crate::client_identity::current_sid())
                .and_then(|sid| {
                    let name = pipe_name(&sid);
                    create_pipe(&name, &sid, true).map(|pipe| (name, sid, pipe))
                });
            let (name, sid, mut listener) = match result {
                Ok(v) => v,
                Err(e) => {
                    self.unavailable(e.code());
                    return;
                }
            };
            self.available.store(true, Ordering::SeqCst);
            let owner = self.clone();
            let task = tauri::async_runtime::spawn(async move {
                let slots = Arc::new(tokio::sync::Semaphore::new(8));
                loop {
                    if owner.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    if listener.connect().await.is_err() {
                        owner.unavailable("pipe_unavailable");
                        break;
                    }
                    // Keep one listening/connected handle alive while creating the next
                    // instance. A squatter cannot steal the name between connections.
                    let next = match create_pipe(&name, &sid, false) {
                        Ok(next) => next,
                        Err(e) => {
                            owner.unavailable(e.code());
                            break;
                        }
                    };
                    let pipe = std::mem::replace(&mut listener, next);
                    let permit = match slots.clone().try_acquire_owned() {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    let owner = owner.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(10),
                            handle_pipe(owner, pipe, permit),
                        )
                        .await;
                    });
                }
            });
            *self.task.lock().unwrap() = Some(task);
        }
        #[cfg(not(windows))]
        {
            let _ = database;
            self.unavailable("unsupported_platform");
        }
    }
    fn observe(&self, peer: &OsClient) {
        let mut candidates = self.candidates.lock().unwrap();
        candidates.retain(|_, v| v.seen.elapsed() < Duration::from_secs(300));
        let id = peer.process_stamp();
        if candidates.len() < 64 || candidates.contains_key(&id) {
            candidates.insert(
                id,
                Seen {
                    peer: peer.clone(),
                    seen: Instant::now(),
                },
            );
        }
    }
    pub fn list(&self) -> Result<ClientAccessList, String> {
        let grants = self
            .bridge
            .client_grants()
            .map_err(|e| e.code().to_string())?;
        let mut candidates = self
            .candidates
            .lock()
            .map_err(|_| "storage_unavailable".to_string())?;
        candidates.retain(|_, v| v.seen.elapsed() < Duration::from_secs(300));
        // UI timestamps use safe Unix milliseconds; process stamps retain the
        // exact kernel FILETIME ticks and never round through JavaScript numbers.
        let rows = candidates
            .iter()
            .map(|(id, v)| Candidate {
                id: id.clone(),
                identity: v.peer.identity().clone(),
                process_id: v.peer.process_id(),
                created_at: (v.peer.created_at() / 10_000).saturating_sub(11_644_473_600_000),
                grant: grants
                    .iter()
                    .find(|g| {
                        g.identity.sid == v.peer.identity().sid
                            && g.identity
                                .path
                                .eq_ignore_ascii_case(&v.peer.identity().path)
                    })
                    .cloned(),
            })
            .collect();
        Ok(ClientAccessList {
            available: self.available.load(Ordering::SeqCst),
            error_code: self.error.lock().unwrap().map(str::to_string),
            candidates: rows,
            grants,
        })
    }
    pub fn approve(
        &self,
        candidate_id: &str,
        expected_revision: u64,
        scopes: ClientScopes,
    ) -> Result<ClientGrant, String> {
        if !self.available.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return Err("pipe_unavailable".into());
        }
        let peer = {
            let candidates = self
                .candidates
                .lock()
                .map_err(|_| "storage_unavailable".to_string())?;
            let seen = candidates
                .get(candidate_id)
                .filter(|v| v.seen.elapsed() < Duration::from_secs(300))
                .ok_or("identity_unknown")?;
            seen.peer.clone()
        };
        #[cfg(windows)]
        {
            let proof = crate::client_identity::query_process(peer.process_id())
                .map_err(|e| e.code().to_string())?;
            let verified = proof.client().map_err(|e| e.code().to_string())?;
            if verified.process_stamp() != peer.process_stamp() {
                return Err("identity_changed".into());
            }
            self.bridge
                .client_approve(&verified, expected_revision, scopes)
                .map_err(|e| e.code().to_string())
        }
        #[cfg(not(windows))]
        {
            let _ = (peer, expected_revision, scopes);
            Err("unsupported_platform".into())
        }
    }
    pub fn revoke(&self, id: &str, revision: u64) -> Result<ClientGrant, String> {
        self.bridge
            .client_revoke(id, revision)
            .map_err(|e| e.code().to_string())
    }
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("main_window_required".into())
    }
}
fn require_confirmation(window: &tauri::WebviewWindow) -> Result<(), String> {
    require_main(window.label())?;
    if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
        return Err("visible_main_window_required".into());
    }
    Ok(())
}
#[tauri::command]
pub fn client_access_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<ClientAuthorization>>,
) -> Result<ClientAccessList, String> {
    require_main(window.label())?;
    state.list()
}
#[tauri::command]
pub fn client_access_approve(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<ClientAuthorization>>,
    candidate_id: String,
    expected_revision: u64,
    scopes: ClientScopes,
) -> Result<ClientGrant, String> {
    require_confirmation(&window)?;
    state.approve(&candidate_id, expected_revision, scopes)
}
#[tauri::command]
pub fn client_access_revoke(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<ClientAuthorization>>,
    grant_id: String,
    expected_revision: u64,
) -> Result<ClientGrant, String> {
    require_confirmation(&window)?;
    state.revoke(&grant_id, expected_revision)
}

#[cfg(windows)]
pub fn pipe_name(sid: &str) -> String {
    format!("\\\\.\\pipe\\Spellcast.ClientWrite.v1.{sid}")
}
#[cfg(windows)]
fn create_pipe(
    name: &str,
    sid: &str,
    first: bool,
) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, crate::client_identity::NativeError> {
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    let descriptor = crate::client_identity::Descriptor::for_pipe(sid)?;
    let mut security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.raw(),
        bInheritHandle: 0,
    };
    unsafe {
        tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(16)
            .in_buffer_size(4096)
            .out_buffer_size(4096)
            .create_with_security_attributes_raw(
                name,
                (&mut security as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
    .map_err(|_| crate::client_identity::NativeError::PipeUnavailable)
}
#[cfg(windows)]
async fn handle_pipe(
    owner: Arc<ClientAuthorization>,
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), ()> {
    use std::os::windows::io::AsRawHandle;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let size = pipe.read_u32_le().await.map_err(|_| ())? as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(());
    }
    let mut bytes = vec![0u8; size];
    pipe.read_exact(&mut bytes).await.map_err(|_| ())?;
    // The pipe remains owned/alive until this blocking, bounded OS verification
    // and transaction completes. Never cancel/resend a save after dispatch.
    let (mut pipe,reply)=tauri::async_runtime::spawn_blocking(move || {
        // Own BOTH the pipe handle and admission slot until the transaction ends,
        // including when the async waiter times out/disconnects. No raw handle
        // can be closed/reused under an uncancellable blocking save.
        let _permit=permit;
        let handle=pipe.as_raw_handle();
        let reply=(|| {
        if owner.stopped.load(Ordering::SeqCst) || !owner.available.load(Ordering::SeqCst) { return ClientReply::failure(ClientError::StaleSession); }
        let proof=match crate::client_identity::query_pipe_peer(handle,false) { Ok(p)=>p,Err(e)=>return ClientReply::failure(e.into()) };
        let peer=match proof.client() { Ok(p)=>p,Err(e)=>return ClientReply::failure(e.into()) };
        let request=match ClientRequest::decode(&bytes) { Ok(v)=>v,Err(e)=>return ClientReply::failure(e) };
        if matches!(&request,ClientRequest::Status { protocol } if *protocol == spellcast_bridge::client_access::PROTOCOL) { owner.observe(&peer); }
        if proof.assert_live().is_err() || owner.stopped.load(Ordering::SeqCst) { return ClientReply::failure(ClientError::IdentityChanged); }
        owner.bridge.client_handle(&peer,request)
        })();
        (pipe,reply)
    }).await.map_err(|_|())?;
    let bytes = serde_json::to_vec(&reply).map_err(|_| ())?;
    if bytes.len() > MAX_REPLY {
        return Err(());
    }
    pipe.write_u32_le(bytes.len() as u32)
        .await
        .map_err(|_| ())?;
    pipe.write_all(&bytes).await.map_err(|_| ())?;
    // No FlushFileBuffers: it may wait indefinitely for a disconnected reader.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_main_window_has_grant_controls() {
        assert!(require_main("main").is_ok());
        for label in ["", "bubble-1", "preview", "ccgui", "main-other"] {
            assert!(require_main(label).is_err());
        }
    }
    #[test]
    fn native_manager_starts_without_authority_or_candidates() {
        let manager =
            ClientAuthorization::new(Arc::new(Bridge::new(spellcast_bridge::Headless, 47194)));
        assert!(!manager.available.load(Ordering::SeqCst));
        assert!(manager.candidates.lock().unwrap().is_empty());
        assert!(manager
            .approve(
                "forged",
                0,
                ClientScopes {
                    records: true,
                    sigil_drafts: true
                }
            )
            .is_err());
        manager.stop();
        assert!(manager.stopped.load(Ordering::SeqCst));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn native_unique_probe_pipe_checks_both_kernel_pids_and_rejects_squatting() {
        use std::os::windows::io::AsRawHandle;
        let sid = crate::client_identity::current_sid().unwrap();
        let name = format!(
            "\\\\.\\pipe\\Spellcast.ClientWrite.TEST.{}",
            uuid::Uuid::new_v4()
        );
        let server = create_pipe(&name, &sid, true).unwrap();
        assert!(create_pipe(&name, &sid, true).is_err());
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&name)
            .unwrap();
        server.connect().await.unwrap();
        let client_proof =
            crate::client_identity::query_pipe_peer(server.as_raw_handle(), false).unwrap();
        let server_proof =
            crate::client_identity::query_pipe_peer(client.as_raw_handle(), true).unwrap();
        assert_eq!(client_proof.pid, std::process::id());
        assert_eq!(server_proof.pid, std::process::id());
        assert_eq!(client_proof.identity, server_proof.identity);
        assert_eq!(client_proof.created_at, server_proof.created_at);
        assert!(
            client_proof.client().is_err(),
            "a test executable is NOT a CCGUI application"
        );
        let mut wrong = server_proof.identity.clone();
        wrong.sha256 = "0".repeat(64);
        assert!(crate::client_identity::verify_server(client.as_raw_handle(), &wrong).is_err());
        assert!(
            crate::client_identity::verify_server(client.as_raw_handle(), &server_proof.identity)
                .is_err(),
            "a test executable is NOT installed Spellcast"
        );
        // No production pipe, Bridge, grant, record, or service was created.
    }
}

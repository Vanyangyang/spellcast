mod configure;
mod desktop;

use std::sync::Arc;

use spellcast_bridge::{api, Bridge, Status, Surface, DEFAULT_PORT};
use spellcast_core::types::{
    forms, BoardNode, BoardSnapshot, ImportRequest, NodeDraft, NodePatch, PresentResult,
    SayRequest, SetFormRequest, ThrownBubble,
};
use spellcast_core::AgentEvent;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

/// The real desktop: bubbles are OS windows, the board is the main window.
struct Desktop {
    app: AppHandle,
}

impl Surface for Desktop {
    fn agent_seen(&self, client: &str) {
        let _ = self.app.emit_to("main", "spellcast-agent", client);
    }

    fn throw(&self, bubbles: &[ThrownBubble]) -> Result<usize, String> {
        let mut thrown = 0;
        for bubble in bubbles.iter().take(3) {
            let app = self.app.clone();
            let item = bubble.clone();
            let delay = u64::from(item.delay_ms);
            let spawn = move || {
                let app2 = app.clone();
                let failed = item.clone();
                let scheduled =
                    app.run_on_main_thread(move || {
                        if let Some(state) = app2.try_state::<AppState>() {
                            let status = state.bridge.status();
                            if status.paused || (status.surface == "focus" && status.board_focused)
                            {
                                let _ = state.bridge.user_event(AgentEvent::new("not_shown")
                                .bubble(item.id.clone()).source(item.source_id.clone())
                                .text("Desktop bubbles are paused while the board is in focus."));
                                return;
                            }
                        }
                        if let Err(err) = desktop::spawn_bubble(&app2, item.clone()) {
                            eprintln!("bubble window failed: {err}");
                            if let Some(state) = app2.try_state::<AppState>() {
                                let _ = state.bridge.user_event(
                                    AgentEvent::new("not_shown")
                                        .bubble(item.id.clone())
                                        .source(item.source_id.clone())
                                        .text(err),
                                );
                            }
                        } else {
                            let _ = app2.emit_to("main", "spellcast-thrown", &item);
                        }
                    });
                if let Err(err) = scheduled {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.bridge.user_event(
                            AgentEvent::new("not_shown")
                                .bubble(failed.id)
                                .source(failed.source_id)
                                .text(err.to_string()),
                        );
                    }
                }
            };
            if delay == 0 {
                spawn();
            } else {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    spawn();
                });
            }
            thrown += 1;
        }
        Ok(thrown)
    }

    fn presented(&self, result: &PresentResult) {
        let _ = self.app.emit_to("main", "spellcast-present", result);
    }

    fn board_changed(&self) {
        let _ = self.app.emit_to("main", "spellcast-board", ());
    }

    fn close_bubbles(&self) {
        let app = self.app.clone();
        let _ = self
            .app
            .run_on_main_thread(move || desktop::close_bubbles(&app));
    }

    fn focus(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit_to("main", "spellcast-focus", ());
        });
    }

    fn screen_count(&self) -> u32 {
        desktop::list_screens(&self.app)
            .map(|s| s.len() as u32)
            .unwrap_or(1)
            .max(1)
    }

    fn board_is_focused(&self) -> bool {
        self.app.get_webview_window("main").is_some_and(|win| {
            win.is_focused().unwrap_or(false)
                && win.is_visible().unwrap_or(false)
                && !win.is_minimized().unwrap_or(false)
        })
    }
}

struct AppState {
    bridge: Arc<Bridge>,
}

fn err_string(err: impl ToString) -> String {
    err.to_string()
}

#[tauri::command]
fn get_board(state: State<'_, AppState>) -> BoardSnapshot {
    state.bridge.board()
}

#[tauri::command]
fn reset_board(state: State<'_, AppState>) -> Result<BoardSnapshot, String> {
    state.bridge.reset_by_user().map_err(err_string)
}

#[tauri::command]
fn set_form(state: State<'_, AppState>, req: SetFormRequest) -> Result<BoardSnapshot, String> {
    state.bridge.set_form(req).map_err(err_string)
}

#[tauri::command]
fn list_forms() -> serde_json::Value {
    serde_json::json!({ "forms": forms() })
}

#[tauri::command]
fn add_node(state: State<'_, AppState>, draft: NodeDraft) -> Result<BoardNode, String> {
    state.bridge.add_node(draft).map_err(err_string)
}

#[tauri::command]
fn patch_node(
    state: State<'_, AppState>,
    id: String,
    patch: NodePatch,
) -> Result<BoardNode, String> {
    state.bridge.patch_node(&id, patch).map_err(err_string)
}

#[tauri::command]
fn remove_node(state: State<'_, AppState>, id: String) -> Result<BoardSnapshot, String> {
    state.bridge.remove_node(&id).map_err(err_string)
}

#[tauri::command]
fn import_transcript(
    state: State<'_, AppState>,
    req: ImportRequest,
) -> Result<BoardSnapshot, String> {
    state.bridge.import_transcript(req).map_err(err_string)
}

#[tauri::command]
fn say(state: State<'_, AppState>, req: SayRequest) -> Result<AgentEvent, String> {
    state.bridge.say(req).map_err(err_string)
}

#[tauri::command]
fn dismiss_bubble(state: State<'_, AppState>, bubble_id: String) -> Result<AgentEvent, String> {
    state.bridge.dismiss(&bubble_id).map_err(err_string)
}

#[tauri::command]
fn keep_bubble(
    state: State<'_, AppState>,
    bubble: ThrownBubble,
) -> Result<serde_json::Value, String> {
    state
        .bridge
        .keep(&bubble)
        .map(|(node, event)| serde_json::json!({ "node": node, "event": event }))
        .map_err(err_string)
}

#[tauri::command]
fn set_surface(state: State<'_, AppState>, surface: String) -> Status {
    state.bridge.set_surface(&surface)
}

#[tauri::command]
fn unkeep_bubble(
    state: State<'_, AppState>,
    bubble: ThrownBubble,
) -> Result<serde_json::Value, String> {
    state
        .bridge
        .unkeep(&bubble)
        .map(|(removed, event)| {
            serde_json::json!({ "removed": removed, "node_id": event.node_id.clone(), "event": event })
        })
        .map_err(err_string)
}

#[tauri::command]
fn bridge_status(state: State<'_, AppState>) -> Status {
    state.bridge.status()
}

#[tauri::command]
fn mcp_config(
    state: State<'_, AppState>,
    client: String,
    url: Option<String>,
) -> Result<configure::ClientConfig, String> {
    configure::describe(&client, state.bridge.status().port, url.as_deref())
}

#[tauri::command]
fn configure_client(
    state: State<'_, AppState>,
    client: String,
    url: Option<String>,
) -> Result<configure::ClientConfig, String> {
    configure::write(&client, state.bridge.status().port, url.as_deref())
}

#[tauri::command]
fn install_client_skill(client: String) -> Result<configure::SkillInstall, String> {
    configure::install_skill(&client)
}

#[tauri::command]
fn list_desktop_screens(app: AppHandle) -> Result<Vec<desktop::DesktopScreen>, String> {
    desktop::list_screens(&app)
}

#[tauri::command]
fn close_bubbles(state: State<'_, AppState>) {
    state.bridge.close_bubbles();
}

fn serve(bridge: Arc<Bridge>, port: u16) {
    tauri::async_runtime::spawn(async move {
        let app = api::router(bridge);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if let Err(err) = axum::serve(listener, app).await {
                    eprintln!("Spellcast bridge stopped: {err}");
                }
            }
            Err(err) => eprintln!("Spellcast bridge could not bind {addr}: {err}"),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port: u16 = std::env::var("SPELLCAST_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if state.bridge.board_in_focus() {
                        state.bridge.close_bubbles();
                    }
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            // Shared bridge state keeps board, feedback, and explicit memory in one transaction.
            let data_path = std::env::var_os("SPELLCAST_STATE_FILE")
                .map(std::path::PathBuf::from)
                .unwrap_or(
                    app.path()
                        .app_data_dir()
                        .map_err(|err| {
                            std::io::Error::other(format!("找不到 Spellcast 数据目录：{err}"))
                        })?
                        .join("spellcast.sqlite3"),
                );
            let bridge = Arc::new(
                Bridge::open(
                    Desktop {
                        app: handle.clone(),
                    },
                    port,
                    data_path,
                )
                .map_err(|err| std::io::Error::other(format!("Spellcast 状态恢复失败：{err}")))?,
            );
            app.manage(AppState {
                bridge: bridge.clone(),
            });

            // Bubble windows report back through Tauri events; the agent reads them from the inbox.
            let b = bridge.clone();
            handle.listen_any("spellcast-poke", move |event| {
                if let Ok(item) = serde_json::from_str::<ThrownBubble>(event.payload()) {
                    if let Err(err) = b.poke(&item) {
                        eprintln!("could not save poke: {err}");
                    }
                }
            });
            let b = bridge.clone();
            handle.listen_any("spellcast-ready", move |event| {
                if let Ok(id) = serde_json::from_str::<String>(event.payload()) {
                    if let Err(err) = b.user_event(AgentEvent::new("ready").bubble(id)) {
                        eprintln!("could not save bubble readiness: {err}");
                    }
                }
            });
            let b = bridge.clone();
            handle.listen_any("spellcast-expired", move |event| {
                if let Ok(id) = serde_json::from_str::<String>(event.payload()) {
                    if let Err(err) = b.expired(&id) {
                        eprintln!("could not save expiration: {err}");
                    }
                }
            });

            serve(bridge, port);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_board,
            reset_board,
            set_form,
            list_forms,
            add_node,
            patch_node,
            remove_node,
            import_transcript,
            say,
            dismiss_bubble,
            keep_bubble,
            unkeep_bubble,
            set_surface,
            bridge_status,
            mcp_config,
            configure_client,
            install_client_skill,
            list_desktop_screens,
            desktop::drag_bubble,
            close_bubbles
        ])
        .run(tauri::generate_context!())
        .expect("Spellcast failed to start");
}

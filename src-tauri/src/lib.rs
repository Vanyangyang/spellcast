mod complete_setup;
mod claude_setup;
#[cfg(desktop)]
mod instance;
mod configure;
mod desktop;
mod display_target;
mod completion_hook;
mod completion_read;
mod completions;
mod completion_sound;
mod completion_speech;
mod completion_title;
mod claude_process;
mod ccgui_window;
mod ui_theme;
mod autostart;
mod new_chat;
mod state_path;
mod project_api_key;
mod client_authorization;
#[cfg(windows)]
pub mod client_identity;
mod observer_runtime;

/// Headless notification mode runs before Tauri, so completed tasks never launch the board.
pub fn handle_completion_command() -> bool {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--migrate-state-from") => {
            let result = args.get(2).filter(|_| args.len() == 3)
                .ok_or_else(|| "Usage: spellcast --migrate-state-from <database>".to_string())
                .and_then(|source| state_path::import_default(std::path::Path::new(source)));
            match result {
                Ok(path) => println!("{}", path.display()),
                Err(err) => { eprintln!("{err}"); std::process::exit(1); }
            }
            true
        }
        Some("--codex-notify") => {
            if let (Some(root), Some(raw)) = (args.get(2), args.get(3)) {
                completion_hook::notify(std::path::Path::new(root), raw);
            }
            true
        }
        Some("--install-completion-hook") => {
            let result = (|| completion_hook::install(&completion_hook::codex_home()?, &completion_hook::root()?,
                &std::env::current_exe().map_err(|e| e.to_string())?))();
            match result { Ok(note) => println!("{note}"), Err(err) => { eprintln!("{err}"); std::process::exit(1); } }
            true
        }
        Some("--uninstall-completion-hook") => {
            let result = (|| completion_hook::uninstall(&completion_hook::codex_home()?, &completion_hook::root()?))();
            match result { Ok(note) => println!("{note}"), Err(err) => { eprintln!("{err}"); std::process::exit(1); } }
            true
        }
        Some("--grok-notify") => {
            if let Some(root) = args.get(2) {
                completion_hook::grok_notify(std::path::Path::new(root));
            }
            true
        }
        Some("--install-grok-completion-hook") => {
            let result = (|| completion_hook::install_grok(&completion_hook::grok_home()?, &completion_hook::root()?,
                &std::env::current_exe().map_err(|e| e.to_string())?))();
            match result { Ok(note) => println!("{note}"), Err(err) => { eprintln!("{err}"); std::process::exit(1); } }
            true
        }
        Some("--uninstall-grok-completion-hook") => {
            let result = (|| completion_hook::uninstall_grok(&completion_hook::grok_home()?))();
            match result { Ok(note) => println!("{note}"), Err(err) => { eprintln!("{err}"); std::process::exit(1); } }
            true
        }
        Some("--claude-notify") => {
            // The hook entry carries the inbox; fall back to the default one for a hand-written command.
            if let Some(root) = args.get(2).map(std::path::PathBuf::from).or_else(|| completion_hook::root().ok()) {
                completion_hook::claude_notify(&root);
            }
            true
        }
        Some("--install-claude-completion-hook") => {
            let result = (|| completion_hook::install_claude(&completion_hook::claude_home()?, &completion_hook::root()?,
                &std::env::current_exe().map_err(|e| e.to_string())?))();
            match result { Ok(note) => println!("{note}"), Err(err) => { eprintln!("{err}"); std::process::exit(1); } }
            true
        }
        Some("--uninstall-claude-completion-hook") => {
            let result = (|| completion_hook::uninstall_claude(&completion_hook::claude_home()?))();
            match result { Ok(note) => println!("{note}"), Err(err) => { eprintln!("{err}"); std::process::exit(1); } }
            true
        }
        _ => false,
    }
}

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

    /// Sigil progress refreshes only that sigil's cards, never the whole board.
    fn sigil_changed(&self, sigil_id: &str) {
        let _ = self.app.emit_to("main", "spellcast-sigil", serde_json::json!({ "sigil_id": sigil_id }));
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
            instance::restore_main(&app);
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
    handoff_root: std::path::PathBuf,
    host_link_key: String,
}

fn err_string(err: impl ToString) -> String {
    err.to_string()
}

#[tauri::command]
fn get_board(state: State<'_, AppState>) -> BoardSnapshot {
    state.bridge.board()
}

#[tauri::command]
fn project_window_key(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<String, String> {
    if window.label() != "main" { return Err("项目管理仅限主窗口。".into()); }
    Ok(state.bridge.project_window_key())
}

#[tauri::command]
fn host_link_key(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<String, String> {
    if window.label() != "main" { return Err("宿主连接仅限主窗口。".into()); }
    Ok(state.host_link_key.clone())
}

#[tauri::command]
fn open_project_game_source(window:tauri::WebviewWindow,state:State<'_,AppState>,project_id:String,path:String)->Result<(),String>{
    use tauri_plugin_opener::OpenerExt;
    if window.label()!="main" {return Err("仅限主窗口打开已连接项目的来源文件。".into());}
    let source=state.bridge.game_source_path(&project_id,&path).map_err(err_string)?;
    window.app_handle().opener().open_path(source.to_string_lossy().to_string(),None::<&str>).map_err(|e|e.to_string())
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
    if client == "grok" {
        return Err("Grok Build 将在未来版本加入。".into());
    }
    configure::write(&client, state.bridge.status().port, url.as_deref())
}

#[tauri::command]
fn install_client_skill(client: String) -> Result<configure::SkillInstall, String> {
    if client == "grok" {
        return Err("Grok Build 将在未来版本加入。".into());
    }
    configure::install_skill(&client)
}

fn complete_setup_paths(app: &AppHandle) -> Result<complete_setup::SetupPaths, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "找不到用户目录。".to_string())?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("找不到随包插件资源：{err}"))?;
    let resource_root = ["codex-plugin", "resources/codex-plugin"]
        .into_iter()
        .map(|rel| resource_dir.join(rel))
        .find(|path| path.join("integrity.json").is_file())
        .unwrap_or_else(|| resource_dir.join("codex-plugin"));
    complete_setup::default_paths(home, resource_root)
}

fn claude_setup_paths(app: &AppHandle) -> Result<claude_setup::ClaudePaths, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "找不到用户目录。".to_string())?;
    let resources = app.path().resource_dir().map_err(|err| format!("找不到随包插件资源：{err}"))?;
    let mut paths = claude_setup::default_paths(home, &resources);
    // Pre-pairs the CC GUI send-back plugin; the key goes only into CC GUI's own plugin storage.
    paths.host_link_key = app.try_state::<AppState>().map(|state| state.host_link_key.clone());
    Ok(paths)
}

#[tauri::command]
fn open_claude_plugin_folder(window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if window.label() != "main" { return Err("Claude 插件目录仅限主窗口打开。".into()); }
    let paths = claude_setup_paths(window.app_handle())?;
    let folder = claude_setup::ccgui_plugin_path(&paths)?;
    window.app_handle().opener().open_path(folder.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn complete_setup_status(
    app: AppHandle,
    client: String,
    url: Option<String>,
) -> Result<complete_setup::SetupReport, String> {
    if client == "grok" {
        return Ok(complete_setup::grok_deferred());
    }
    if client == "claude-code" {
        let paths = claude_setup_paths(&app)?;
        return tauri::async_runtime::spawn_blocking(move || claude_setup::status(url.as_deref(), &paths))
            .await.map_err(|err| format!("Claude 状态查询中断：{err}"));
    }
    let paths = complete_setup_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if client == "codex" {
            complete_setup::codex_direct_status(&client, url.as_deref(), &paths)
        } else {
            complete_setup::status(&client, url.as_deref(), &paths)
        }
    })
    .await
    .map_err(|err| format!("状态查询中断：{err}"))
}

#[tauri::command]
async fn complete_setup_install(
    app: AppHandle,
    client: String,
    url: Option<String>,
) -> Result<complete_setup::SetupReport, String> {
    if client == "grok" {
        return Ok(complete_setup::grok_deferred());
    }
    if client == "claude-code" {
        let paths = claude_setup_paths(&app)?;
        return tauri::async_runtime::spawn_blocking(move || claude_setup::install(url.as_deref(), &paths))
            .await.map_err(|err| format!("Claude 安装中断：{err}"));
    }
    let paths = complete_setup_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if client == "codex" {
            complete_setup::codex_direct_install(&client, url.as_deref(), &paths)
        } else {
            complete_setup::status(&client, url.as_deref(), &paths)
        }
    })
    .await
    .map_err(|err| format!("安装中断：{err}"))
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

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(instance::plugin());

    let result = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(autostart::plugin())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Hidden notification and single-instance windows must not keep the app alive.
                    // Let Tauri exit the entire app and clean up every window and background task.
                    api.prevent_close();
                    window.app_handle().exit(0);
                    return;
                }
            }
            if window.label().starts_with("bubble-") && matches!(event, tauri::WindowEvent::Focused(true)) {
                if let Err(err) = completions::keep_in_front(window.app_handle()) {
                    eprintln!("Completion window Z order: {err}");
                }
            }
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
            let data_path = state_path::resolve(|| app.path().app_data_dir().map_err(|e| e.to_string()))
                .map_err(std::io::Error::other)?;
            let local_project_key=project_api_key::load_or_create(&data_path);
            let host_link_key=project_api_key::load_or_create_named(&data_path, "host-link.key")
                .map_err(std::io::Error::other)?;
            let handoff_root=data_path.parent().ok_or_else(||std::io::Error::other("数据目录无效"))?.join("new-chat-context");
            let mut bridge = Bridge::open(
                    Desktop {
                        app: handle.clone(),
                    },
                    port,
                    &data_path,
                )
                .map_err(|err| std::io::Error::other(format!("Spellcast 状态恢复失败：{err}")))?;
            match local_project_key {
                Ok(key) => { bridge=bridge.with_project_local_key(key).map_err(std::io::Error::other)?; }
                Err(error) => { eprintln!("本机项目 API 未启用：{error}"); }
            }
            bridge.configure_host_bootstrap_secret(&host_link_key).map_err(std::io::Error::other)?;
            let bridge=Arc::new(bridge);
            let client_authorization=client_authorization::ClientAuthorization::new(bridge.clone());
            client_authorization.start(&data_path);
            app.manage(client_authorization);
            observer_runtime::configure(&handle, &bridge);
            app.manage(AppState {
                bridge: bridge.clone(),
                handoff_root,
                host_link_key,
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

            display_target::start(handle.clone());
            completions::start(handle.clone());
            serve(bridge, port);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_board,
            project_window_key,
            host_link_key,
            client_authorization::client_access_list,
            client_authorization::client_access_approve,
            client_authorization::client_access_revoke,
            open_project_game_source,
            new_chat::codex_workspaces,
            new_chat::open_canvas_new_chat,
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
            complete_setup_status,
            complete_setup_install,
            open_claude_plugin_folder,
            list_desktop_screens,
            desktop::drag_bubble,
            completions::get_completions,
            completions::open_completed_task,
            completions::dismiss_completion,
            completions::get_completion_voice,
            completions::set_completion_voice,
            completions::set_ui_locale,
            ui_theme::get_theme_preference,
            ui_theme::set_theme_preference,
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled,
            display_target::display_target_report,
            display_target::set_display_target,
            close_bubbles
        ])
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = handle.try_state::<Arc<client_authorization::ClientAuthorization>>() { state.stop(); }
                if let Some(state) = handle.try_state::<AppState>() {
                    state.bridge.shutdown_observers();
                }
            }
        }),
        Err(error) => {
            state_path::report_startup_error(&error.to_string());
            std::process::exit(1);
        }
    }
}

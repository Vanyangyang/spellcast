mod desktop;

use orbit_core::types::{
    catalog, forms, BoardNode, BoardSnapshot, ChatRequest, ChatResponse, ImportRequest, NodeDraft,
    NodePatch, SetFormRequest, StageForm, ThrownBubble,
};
use orbit_core::Session;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

struct AppState {
    session: Mutex<Session>,
}

#[tauri::command]
async fn get_board(state: State<'_, AppState>) -> Result<BoardSnapshot, String> {
    Ok(state.session.lock().await.snapshot())
}

#[tauri::command]
async fn reset_board(state: State<'_, AppState>) -> Result<BoardSnapshot, String> {
    let mut session = state.session.lock().await;
    session.reset();
    Ok(session.snapshot())
}

#[tauri::command]
async fn set_form(state: State<'_, AppState>, req: SetFormRequest) -> Result<BoardSnapshot, String> {
    let mut session = state.session.lock().await;
    session.set_form(StageForm::parse(&req.form));
    Ok(session.snapshot())
}

#[tauri::command]
fn list_providers() -> serde_json::Value {
    serde_json::json!({ "providers": catalog() })
}

#[tauri::command]
fn list_forms() -> serde_json::Value {
    serde_json::json!({ "forms": forms() })
}

#[tauri::command]
async fn chat(state: State<'_, AppState>, req: ChatRequest) -> Result<ChatResponse, String> {
    let mut session = state.session.lock().await;
    session.chat(req).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_node(state: State<'_, AppState>, draft: NodeDraft) -> Result<BoardNode, String> {
    Ok(state.session.lock().await.add_node(draft))
}

#[tauri::command]
async fn patch_node(
    state: State<'_, AppState>,
    id: String,
    patch: NodePatch,
) -> Result<BoardNode, String> {
    state
        .session
        .lock()
        .await
        .patch_node(&id, patch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_node(state: State<'_, AppState>, id: String) -> Result<BoardSnapshot, String> {
    let mut session = state.session.lock().await;
    session.remove_node(&id).map_err(|e| e.to_string())?;
    Ok(session.snapshot())
}

#[tauri::command]
async fn import_transcript(
    state: State<'_, AppState>,
    req: ImportRequest,
) -> Result<BoardSnapshot, String> {
    let mut session = state.session.lock().await;
    session
        .import_transcript(&req.transcript)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_desktop_screens(app: AppHandle) -> Result<Vec<desktop::DesktopScreen>, String> {
    desktop::list_screens(&app)
}

#[tauri::command]
fn spawn_bubble(app: AppHandle, item: ThrownBubble) -> Result<(), String> {
    desktop::spawn_bubble(&app, item)
}

#[tauri::command]
fn close_bubbles(app: AppHandle) {
    desktop::close_bubbles(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            session: Mutex::new(Session::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_board,
            reset_board,
            set_form,
            list_providers,
            list_forms,
            chat,
            import_transcript,
            add_node,
            patch_node,
            remove_node,
            list_desktop_screens,
            spawn_bubble,
            close_bubbles
        ])
        .run(tauri::generate_context!())
        .expect("Spellcast failed to start");
}

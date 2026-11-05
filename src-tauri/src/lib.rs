pub mod terminal;

use std::sync::Mutex;
use tauri::{Manager, State};
use terminal::{SessionManager, ShellKind, TerminalInfo};

#[tauri::command]
fn create_terminal(
    app: tauri::AppHandle,
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
    shell: ShellKind,
    working_directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    manager.lock().map_err(|_| "Terminal manager is unavailable".to_owned())?
        .create(app, session_id, shell, working_directory, cols, rows)
}

#[tauri::command]
fn write_terminal(
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("Terminal input chunk is too large".to_owned());
    }
    manager.lock().map_err(|_| "Terminal manager is unavailable".to_owned())?
        .write(&session_id, &data)
}

#[tauri::command]
fn resize_terminal(
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.lock().map_err(|_| "Terminal manager is unavailable".to_owned())?
        .resize(&session_id, cols, rows)
}

#[tauri::command]
fn close_terminal(
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.lock().map_err(|_| "Terminal manager is unavailable".to_owned())?
        .close(&session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(SessionManager::default()))
        .invoke_handler(tauri::generate_handler![create_terminal, write_terminal, resize_terminal, close_terminal])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(manager) = window.app_handle().try_state::<Mutex<SessionManager>>() {
                    if let Ok(mut manager) = manager.lock() { manager.close_all(); }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run yerminal");
}

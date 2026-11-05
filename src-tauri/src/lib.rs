pub mod git;
pub mod terminal;

use git::{CommitFileChange, CommitInfo, FileChange, RepositoryInfo};
use std::sync::Mutex;
use tauri::{Manager, State};
use terminal::{AgentProfileInfo, SessionManager, ShellKind, TerminalInfo};

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
    manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
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
    manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
        .write(&session_id, &data)
}

#[tauri::command]
fn resize_terminal(
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
        .resize(&session_id, cols, rows)
}

#[tauri::command]
fn close_terminal(
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
        .close(&session_id)
}

#[tauri::command]
fn list_agent_profiles(app: tauri::AppHandle) -> Result<Vec<AgentProfileInfo>, String> {
    terminal::agent_profile_list(&app)
}

#[tauri::command]
fn create_agent_terminal(
    app: tauri::AppHandle,
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
    profile_id: String,
    working_directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
        .create_agent(app, session_id, &profile_id, working_directory, cols, rows)
}

#[tauri::command]
fn git_repository_info(path: String) -> Result<RepositoryInfo, String> {
    git::repository_info(&path)
}

#[tauri::command]
fn git_status(path: String) -> Result<Vec<FileChange>, String> {
    git::status(&path)
}

#[tauri::command]
fn git_diff(path: String, file_path: String, staged: bool) -> Result<String, String> {
    git::diff(&path, &file_path, staged)
}

#[tauri::command]
fn git_history(path: String, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    git::history(&path, skip, limit)
}

#[tauri::command]
fn git_commit_files(path: String, commit_id: String) -> Result<Vec<CommitFileChange>, String> {
    git::commit_files(&path, &commit_id)
}

#[tauri::command]
fn git_commit_file_diff(
    path: String,
    commit_id: String,
    file_path: String,
) -> Result<String, String> {
    git::commit_file_diff(&path, &commit_id, &file_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(SessionManager::default()))
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            create_agent_terminal,
            list_agent_profiles,
            write_terminal,
            resize_terminal,
            close_terminal,
            git_repository_info,
            git_status,
            git_diff,
            git_history,
            git_commit_files,
            git_commit_file_diff
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(manager) = window.app_handle().try_state::<Mutex<SessionManager>>() {
                    if let Ok(mut manager) = manager.lock() {
                        manager.close_all();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run yerminal");
}

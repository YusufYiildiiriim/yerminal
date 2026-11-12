pub mod git;
pub mod terminal;
pub mod workspace_fs;
pub mod workspace_watch;

use git::{CommitFileChange, CommitFileContent, CommitInfo, FileChange, RepositoryInfo};
use std::sync::Mutex;
use tauri::{Manager, State};
use terminal::{
    AgentProfileInfo, SessionManager, ShellKind, TerminalInfo, TerminalOutputSnapshot,
    TerminalResourceMonitor, TerminalResourceUsage,
};
use workspace_fs::WorkspaceEntry;

#[tauri::command]
fn terminal_resource_usage(
    manager: State<'_, Mutex<SessionManager>>,
    monitor: State<'_, Mutex<TerminalResourceMonitor>>,
    session_ids: Vec<String>,
) -> Result<Vec<TerminalResourceUsage>, String> {
    let roots = manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
        .process_roots(&session_ids)?;
    monitor
        .lock()
        .map_err(|_| "Terminal resource monitor is unavailable".to_owned())
        .map(|mut monitor| monitor.collect(roots))
}

#[tauri::command]
fn terminal_output_snapshot(
    manager: State<'_, Mutex<SessionManager>>,
    session_id: String,
) -> Result<TerminalOutputSnapshot, String> {
    manager
        .lock()
        .map_err(|_| "Terminal manager is unavailable".to_owned())?
        .output_snapshot(&session_id)
}

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
fn git_stage_file(path: String, file_path: String) -> Result<(), String> {
    git::stage_file(&path, &file_path)
}

#[tauri::command]
fn git_unstage_file(path: String, file_path: String) -> Result<(), String> {
    git::unstage_file(&path, &file_path)
}

#[tauri::command]
fn git_discard_worktree_file(path: String, file_path: String) -> Result<(), String> {
    git::discard_worktree_file(&path, &file_path)
}

#[tauri::command]
fn git_commit_staged(path: String, message: String) -> Result<String, String> {
    git::commit_staged(&path, &message)
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

#[tauri::command]
fn git_commit_file_content(
    path: String,
    commit_id: String,
    file_path: String,
) -> Result<CommitFileContent, String> {
    git::commit_file_content(&path, &commit_id, &file_path)
}

#[tauri::command]
fn list_workspace_directory(root: String, path: String) -> Result<Vec<WorkspaceEntry>, String> {
    workspace_fs::list_directory(&root, &path)
}

#[tauri::command]
async fn search_workspace_files(
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<WorkspaceEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_fs::search_files(&root, &query, limit))
        .await
        .map_err(|error| format!("Workspace search failed: {error}"))?
}

#[tauri::command]
fn read_workspace_text_file(root: String, path: String) -> Result<String, String> {
    workspace_fs::read_text_file(&root, &path)
}

#[tauri::command]
fn write_workspace_text_file(
    root: String,
    path: String,
    content: String,
    expected_content: String,
) -> Result<(), String> {
    workspace_fs::write_text_file(&root, &path, &content, &expected_content)
}

#[tauri::command]
fn create_workspace_directory(root: String, path: String) -> Result<(), String> {
    workspace_fs::create_directory(&root, &path)
}

#[tauri::command]
fn watch_workspace_roots(
    app: tauri::AppHandle,
    roots: Vec<String>,
    state: State<'_, workspace_watch::WorkspaceWatchState>,
) -> Result<(), String> {
    workspace_watch::sync_roots(&app, state.inner(), roots)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(SessionManager::default()))
        .manage(Mutex::new(TerminalResourceMonitor::default()))
        .manage(workspace_watch::WorkspaceWatchState::default())
        .invoke_handler(tauri::generate_handler![
            create_terminal,
            create_agent_terminal,
            list_agent_profiles,
            write_terminal,
            resize_terminal,
            close_terminal,
            terminal_resource_usage,
            terminal_output_snapshot,
            git_repository_info,
            git_status,
            git_stage_file,
            git_unstage_file,
            git_discard_worktree_file,
            git_commit_staged,
            git_diff,
            git_history,
            git_commit_files,
            git_commit_file_diff,
            git_commit_file_content,
            list_workspace_directory,
            search_workspace_files,
            read_workspace_text_file,
            write_workspace_text_file,
            create_workspace_directory,
            watch_workspace_roots
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

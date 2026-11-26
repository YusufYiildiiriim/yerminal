pub mod agent_usage;
pub mod app_panel;
pub mod git;
pub mod git_gate;
pub mod git_remote;
pub mod terminal;
pub mod workspace_fs;
pub mod workspace_watch;

use git_remote::RemoteState;
use git::{BranchInfo, MergeOutcome, CommitFileChange, CommitFileContent, CommitInfo, FileChange, RepositoryInfo};
use std::sync::{Arc, Mutex};
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

/// Local agent usage summary. `enabled` is the frontend's copy of the "Agent usage"
/// setting (stored in the webview's localStorage); the backend cannot read that
/// store, so it only gates on this flag: when it is false no log file is opened.
#[tauri::command]
async fn agent_usage_snapshot(
    app: tauri::AppHandle,
    cache: State<'_, Arc<Mutex<agent_usage::AgentUsageCache>>>,
    enabled: bool,
) -> Result<agent_usage::AgentUsageSnapshot, String> {
    let cache = cache.inner().clone();
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Home folder is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let roots = agent_usage::UsageRoots::from_home(&home);
        agent_usage::snapshot_with(&cache, enabled, &roots, chrono::Local::now())
    })
    .await
    .map_err(|_| "Agent usage task failed".to_owned())?
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

/// Used before a restored terminal starts: a missing folder is reported, not spawned.
#[tauri::command]
fn check_terminal_directory(path: String) -> Result<(), String> {
    terminal::validate_terminal_directory(&path)
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
    terminal::write_to_session(&manager, &session_id, &data)
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

/// Shared by every Git read: at most `git_gate::GIT_READ_LIMIT` run at once, first come first served.
static GIT_READS: git_gate::ReadGate = git_gate::ReadGate::new(git_gate::GIT_READ_LIMIT);

/// Runs a Git read on a blocking worker, so the main thread never waits for git2.
async fn git_read<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || GIT_READS.run(work))
        .await
        .map_err(|error| error.to_string())?
}

/// Runs a Git write on a blocking worker. Writes are user actions and are not queued behind reads.
async fn git_write<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_repository_info(path: String) -> Result<RepositoryInfo, String> {
    git_read(move || git::repository_info(&path)).await
}

#[tauri::command]
async fn git_status(path: String) -> Result<Vec<FileChange>, String> {
    git_read(move || git::status(&path)).await
}

#[tauri::command]
async fn git_stage_file(path: String, file_path: String) -> Result<(), String> {
    git_write(move || git::stage_file(&path, &file_path)).await
}

#[tauri::command]
async fn git_unstage_file(path: String, file_path: String) -> Result<(), String> {
    git_write(move || git::unstage_file(&path, &file_path)).await
}

#[tauri::command]
async fn git_discard_worktree_file(path: String, file_path: String) -> Result<(), String> {
    git_write(move || git::discard_worktree_file(&path, &file_path)).await
}

#[tauri::command]
async fn git_commit_staged(path: String, message: String) -> Result<String, String> {
    git_write(move || git::commit_staged(&path, &message)).await
}

#[tauri::command]
async fn git_diff(path: String, file_path: String, staged: bool) -> Result<String, String> {
    git_read(move || git::diff(&path, &file_path, staged)).await
}

#[tauri::command]
async fn git_history(path: String, skip: usize, limit: usize, branch: Option<String>) -> Result<Vec<CommitInfo>, String> {
    git_read(move || match branch.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => git::branch_history(&path, name, skip, limit),
        None => git::history(&path, skip, limit),
    }).await
}

#[tauri::command]
async fn git_outgoing_commits(path: String) -> Result<Vec<CommitInfo>, String> {
    git_read(move || git::outgoing_commits(&path)).await
}

#[tauri::command]
async fn git_pushed_history(path: String, skip: usize, limit: usize) -> Result<git::HistoryPage, String> {
    git_read(move || git::pushed_history(&path, skip, limit)).await
}

#[tauri::command]
async fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    git_read(move || git::branches(&path)).await
}

#[tauri::command]
async fn git_commit_files(path: String, commit_id: String) -> Result<Vec<CommitFileChange>, String> {
    git_read(move || git::commit_files(&path, &commit_id)).await
}

#[tauri::command]
async fn git_commit_file_diff(
    path: String,
    commit_id: String,
    file_path: String,
) -> Result<String, String> {
    git_read(move || git::commit_file_diff(&path, &commit_id, &file_path)).await
}

#[tauri::command]
async fn git_diff_versions(path: String, file_path: String, staged: bool) -> Result<git::DiffVersions, String> {
    git_read(move || git::diff_versions(&path, &file_path, staged)).await
}

#[tauri::command]
async fn git_commit_file_versions(
    path: String,
    commit_id: String,
    file_path: String,
) -> Result<git::DiffVersions, String> {
    git_read(move || git::commit_file_versions(&path, &commit_id, &file_path)).await
}

#[tauri::command]
async fn git_commit_file_content(
    path: String,
    commit_id: String,
    file_path: String,
) -> Result<CommitFileContent, String> {
    git_read(move || git::commit_file_content(&path, &commit_id, &file_path)).await
}


#[tauri::command]
async fn git_remote_state(path: String) -> Result<RemoteState, String> {
    git_read(move || git_remote::remote_state(&path)).await
}

#[tauri::command]
async fn git_fetch(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_remote::fetch(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_remote::pull(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_remote::push(&path))
        .await
        .map_err(|error| error.to_string())?
}

/// Adds a remote from a typed URL and publishes the current branch to it. A user action, so it is a write.
#[tauri::command]
async fn git_add_remote_publish(path: String, name: String, url: String) -> Result<String, String> {
    git_write(move || git_remote::add_remote_and_publish(&path, &name, &url)).await
}

/// Whether the GitHub CLI is installed and signed in, and the account. Never signs in.
#[tauri::command]
async fn git_github_status() -> Result<git_remote::GithubStatus, String> {
    tauri::async_runtime::spawn_blocking(git_remote::github_status)
        .await
        .map_err(|error| error.to_string())
}

/// Creates a GitHub repository with `gh` from the typed name, then publishes the current branch to it.
#[tauri::command]
async fn git_create_github_repo(path: String, name: String, public: bool) -> Result<String, String> {
    git_write(move || git_remote::create_github_repo(&path, &name, public)).await
}

#[tauri::command]
async fn git_checkout_branch(path: String, name: String) -> Result<RepositoryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git::checkout_branch(&path, &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_create_branch(
    path: String,
    name: String,
    from: Option<String>,
    checkout: bool,
) -> Result<RepositoryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git::create_branch(&path, &name, from.as_deref(), checkout))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_delete_branch(path: String, name: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::delete_branch(&path, &name, force))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_rename_branch(path: String, old_name: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::rename_branch(&path, &old_name, &new_name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_merge_branch(path: String, name: String) -> Result<MergeOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || git::merge_branch(&path, &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_merge_abort(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git::merge_abort(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_merge_message(path: String) -> Result<String, String> {
    git_read(move || git::merge_message(&path)).await
}

#[tauri::command]
async fn git_resolve_conflict(path: String, file_path: String, side: String) -> Result<(), String> {
    git_write(move || git::resolve_conflict(&path, &file_path, &side)).await
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
    app_panel::install_panic_release();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(SessionManager::default()))
        .manage(Mutex::new(TerminalResourceMonitor::default()))
        .manage(workspace_watch::WorkspaceWatchState::default())
        .manage(Arc::new(Mutex::new(agent_usage::AgentUsageCache::default())))
        .invoke_handler(tauri::generate_handler![
            check_terminal_directory,
            create_terminal,
            create_agent_terminal,
            list_agent_profiles,
            write_terminal,
            resize_terminal,
            close_terminal,
            terminal_resource_usage,
            agent_usage_snapshot,
            app_panel::app_panel_open,
            app_panel::app_panel_place,
            app_panel::app_panel_close,
            app_panel::app_panel_activate,
            app_panel::app_panel_set_visible,
            app_panel::app_panel_snapshot,
            app_panel::app_panel_state,
            terminal_output_snapshot,
            git_repository_info,
            git_status,
            git_stage_file,
            git_unstage_file,
            git_discard_worktree_file,
            git_commit_staged,
            git_diff,
            git_history,
            git_outgoing_commits,
            git_pushed_history,
            git_branches,
            git_remote_state,
            git_fetch,
            git_pull,
            git_push,
            git_add_remote_publish,
            git_github_status,
            git_create_github_repo,
            git_checkout_branch,
            git_create_branch,
            git_delete_branch,
            git_rename_branch,
            git_merge_branch,
            git_merge_abort,
            git_merge_message,
            git_resolve_conflict,
            git_commit_files,
            git_commit_file_diff,
            git_commit_file_content,
            git_diff_versions,
            git_commit_file_versions,
            list_workspace_directory,
            search_workspace_files,
            read_workspace_text_file,
            write_workspace_text_file,
            create_workspace_directory,
            watch_workspace_roots
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            app_panel::debug_autoopen(_app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if should_close_sessions(event) {
                // The main window is being destroyed: give hosted app windows back before their parent goes.
                app_panel::release_all();
                close_all_sessions(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build yerminal")
        .run(|app, event| {
            // Safety net for exits that do not destroy the window first.
            if let tauri::RunEvent::Exit = event {
                app_panel::release_all();
                close_all_sessions(app);
            }
        });
}

/// Whether a window event means the terminals should be shut down. Only
/// `Destroyed` qualifies: `CloseRequested` fires before the frontend's
/// unsaved-changes guard, which may still cancel the close.
fn should_close_sessions(event: &tauri::WindowEvent) -> bool {
    matches!(event, tauri::WindowEvent::Destroyed)
}

fn close_all_sessions(app: &tauri::AppHandle) {
    if let Some(manager) = app.try_state::<Mutex<SessionManager>>() {
        if let Ok(mut manager) = manager.lock() {
            manager.close_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_close_only_when_the_window_is_destroyed() {
        assert!(should_close_sessions(&tauri::WindowEvent::Destroyed));
        assert!(!should_close_sessions(&tauri::WindowEvent::Focused(false)));
        assert!(!should_close_sessions(&tauri::WindowEvent::Moved(
            tauri::PhysicalPosition::new(0, 0)
        )));
        assert!(!should_close_sessions(&tauri::WindowEvent::Resized(
            tauri::PhysicalSize::new(800, 600)
        )));
    }
}

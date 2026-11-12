use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const WORKSPACE_FS_CHANGED_EVENT: &str = "workspace-fs-changed";
const DRAIN_INTERVAL: Duration = Duration::from_millis(250);
const MAX_QUEUED_PATHS: usize = 1_000;

type EventQueue = Arc<Mutex<Vec<String>>>;

#[derive(Default)]
pub struct WorkspaceWatchState {
    queue: EventQueue,
    watcher: Mutex<Option<RecommendedWatcher>>,
    drain_running: Mutex<bool>,
}

/// Keeps one recursive watcher alive for the current set of workspace roots.
/// Rebuilding the watcher on every call keeps the bookkeeping trivial: the
/// frontend invokes this whenever the workspace folder list changes.
pub fn sync_roots(
    app: &AppHandle,
    state: &WorkspaceWatchState,
    roots: Vec<String>,
) -> Result<(), String> {
    start_drain(app, state)?;

    let mut watcher = create_watcher(state.queue.clone())?;
    let mut watched_any = false;
    for root in &roots {
        if root.trim().is_empty() {
            continue;
        }
        // A root may already be gone (deleted while the app was closed);
        // skip it instead of failing the whole sync.
        if watcher.watch(Path::new(root), RecursiveMode::Recursive).is_ok() {
            watched_any = true;
        }
    }

    let mut slot = state
        .watcher
        .lock()
        .map_err(|_| "Workspace watcher is unavailable".to_owned())?;
    *slot = watched_any.then_some(watcher);
    Ok(())
}

fn start_drain(app: &AppHandle, state: &WorkspaceWatchState) -> Result<(), String> {
    let mut running = state
        .drain_running
        .lock()
        .map_err(|_| "Workspace watcher is unavailable".to_owned())?;
    if *running {
        return Ok(());
    }
    *running = true;
    let queue = state.queue.clone();
    let handle = app.clone();
    std::thread::spawn(move || drain_loop(handle, queue));
    Ok(())
}

fn create_watcher(queue: EventQueue) -> Result<RecommendedWatcher, String> {
    notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        let Ok(event) = result else { return };
        let Ok(mut pending) = queue.lock() else { return };
        for path in event.paths {
            let path = path.to_string_lossy().into_owned();
            if is_ignored_watch_path(&path) || pending.contains(&path) {
                continue;
            }
            pending.push(path);
            if pending.len() > MAX_QUEUED_PATHS {
                pending.remove(0);
            }
        }
    })
    .map_err(|error| format!("Cannot watch workspace folders: {error}"))
}

/// Batches raw file-system events into at most one `workspace-fs-changed`
/// event per drain interval, so bursts (builds, dependency installs) cannot
/// flood the webview with IPC traffic.
fn drain_loop(app: AppHandle, queue: EventQueue) {
    loop {
        std::thread::sleep(DRAIN_INTERVAL);
        let batch = {
            let Ok(mut pending) = queue.lock() else { continue };
            if pending.is_empty() {
                continue;
            }
            std::mem::take(&mut *pending)
        };
        let _ = app.emit(WORKSPACE_FS_CHANGED_EVENT, batch);
    }
}

/// Changes inside build/dependency folders are noise for the explorer tree;
/// skipping them keeps the event queue (and refreshes) cheap.
fn is_ignored_watch_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized
        .split('/')
        .any(|segment| {
            matches!(
                segment.to_ascii_lowercase().as_str(),
                ".git" | "node_modules" | "target" | "dist" | "build" | "coverage" | ".next" | ".turbo" | ".venv" | "venv"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for_queue_entry(queue: &EventQueue, needle: &str) -> Option<String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(pending) = queue.lock() {
                if let Some(entry) = pending.iter().find(|entry| entry.contains(needle)) {
                    return Some(entry.clone());
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }

    #[test]
    fn create_watcher_enqueues_external_changes() {
        let dir = tempfile::tempdir().expect("create temp directory");
        let queue: EventQueue = Arc::new(Mutex::new(Vec::new()));
        let mut watcher = create_watcher(queue.clone()).expect("create watcher");
        watcher
            .watch(dir.path(), RecursiveMode::Recursive)
            .expect("watch temp directory");

        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(dir.path().join("new-file.txt"), "hello").expect("write file");

        let entry = wait_for_queue_entry(&queue, "new-file.txt");
        drop(watcher);
        assert!(entry.is_some(), "watcher never reported the new file");
    }

    #[test]
    fn is_ignored_watch_path_matches_ignored_segments() {
        assert!(is_ignored_watch_path("C:\\repo\\node_modules\\lib\\a.js"));
        assert!(is_ignored_watch_path("C:\\repo\\.git\\objects\\ab"));
        assert!(is_ignored_watch_path("C:\\repo\\target\\debug\\bin.exe"));
        assert!(!is_ignored_watch_path("C:\\repo\\src\\lib.rs"));
        assert!(!is_ignored_watch_path("C:\\repo\\notes.target.txt"));
    }

    #[test]
    fn create_watcher_rejects_missing_roots() {
        let queue: EventQueue = Arc::new(Mutex::new(Vec::new()));
        let mut watcher = create_watcher(queue.clone()).expect("create watcher");
        let missing = std::env::temp_dir().join("yerminal-missing-root-does-not-exist");
        assert!(
            watcher.watch(&missing, RecursiveMode::Recursive).is_err(),
            "watching a missing root should fail"
        );
    }
}

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
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

    let roots: Vec<PathBuf> = roots
        .iter()
        .filter(|root| !root.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    let mut watcher = create_watcher(state.queue.clone(), roots.clone())?;
    let mut watched_any = false;
    for root in &roots {
        // A root may already be gone (deleted while the app was closed);
        // skip it instead of failing the whole sync.
        if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
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

fn create_watcher(queue: EventQueue, roots: Vec<PathBuf>) -> Result<RecommendedWatcher, String> {
    notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        let Ok(event) = result else { return };
        let Ok(mut pending) = queue.lock() else { return };
        for path in event.paths {
            if is_ignored_watch_path(&path, &roots) {
                continue;
            }
            let path = path.to_string_lossy().into_owned();
            if pending.contains(&path) {
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
/// skipping them keeps the event queue (and refreshes) cheap. Only the part
/// of the path below the watched root is checked, so a workspace that itself
/// lives under e.g. `.../build/project` still reports its own changes.
fn is_ignored_watch_path(path: &Path, roots: &[PathBuf]) -> bool {
    let relative = roots
        .iter()
        .filter_map(|root| path.strip_prefix(root).ok())
        .min_by_key(|relative| relative.components().count())
        .unwrap_or(path);
    let normalized = relative.to_string_lossy().replace('\\', "/");
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
        let mut watcher = create_watcher(queue.clone(), Vec::new()).expect("create watcher");
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
    fn create_watcher_reports_changes_for_roots_inside_ignored_folder_names() {
        let dir = tempfile::tempdir().expect("create temp directory");
        let root = dir.path().join("build").join("project");
        std::fs::create_dir_all(&root).expect("create nested root");
        let queue: EventQueue = Arc::new(Mutex::new(Vec::new()));
        let mut watcher = create_watcher(queue.clone(), vec![root.clone()]).expect("create watcher");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch nested root");

        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(root.join("inside-build.txt"), "hello").expect("write file");

        let entry = wait_for_queue_entry(&queue, "inside-build.txt");
        drop(watcher);
        assert!(entry.is_some(), "changes under a root inside `build` were dropped");
    }

    #[test]
    fn is_ignored_watch_path_matches_ignored_segments() {
        let ignored = |path: &str| is_ignored_watch_path(Path::new(path), &[]);
        assert!(ignored("C:\\repo\\node_modules\\lib\\a.js"));
        assert!(ignored("C:\\repo\\.git\\objects\\ab"));
        assert!(ignored("C:\\repo\\target\\debug\\bin.exe"));
        assert!(!ignored("C:\\repo\\src\\lib.rs"));
        assert!(!ignored("C:\\repo\\notes.target.txt"));
    }

    #[test]
    fn is_ignored_watch_path_only_checks_segments_below_the_root() {
        let base = std::env::temp_dir();
        let root = base.join("build").join("project");
        let roots = vec![root.clone()];

        assert!(!is_ignored_watch_path(&root.join("src").join("main.rs"), &roots));
        assert!(!is_ignored_watch_path(&root, &roots));
        assert!(is_ignored_watch_path(&root.join("build").join("out.js"), &roots));
        assert!(is_ignored_watch_path(
            &root.join("node_modules").join("a.js"),
            &roots
        ));
        // Paths outside every root fall back to checking the whole path.
        assert!(is_ignored_watch_path(&base.join("build").join("x.txt"), &roots));
        // With nested roots the closest one decides.
        let nested = vec![base.join("build"), root.clone()];
        assert!(!is_ignored_watch_path(&root.join("a.txt"), &nested));
    }

    #[test]
    fn create_watcher_rejects_missing_roots() {
        let queue: EventQueue = Arc::new(Mutex::new(Vec::new()));
        let mut watcher = create_watcher(queue.clone(), Vec::new()).expect("create watcher");
        let missing = std::env::temp_dir().join("yerminal-missing-root-does-not-exist");
        assert!(
            watcher.watch(&missing, RecursiveMode::Recursive).is_err(),
            "watching a missing root should fail"
        );
    }
}

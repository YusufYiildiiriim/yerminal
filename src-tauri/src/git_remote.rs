//! Remote operations (fetch / pull / push) run through the system `git` executable so the user's
//! Git Credential Manager, SSH agent and global config work exactly as they do in a terminal.
//! Arguments are always passed as an array (no shell) and prompts on the terminal are disabled.

use crate::git::open_repository;
use git2::{BranchType, RepositoryState};
use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const PULL_TIMEOUT: Duration = Duration::from_secs(180);
const PUSH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote: bool,
}

pub fn remote_state(path: &str) -> Result<RemoteState, String> {
    let repo = open_repository(path)?;
    let has_remote = repo
        .remotes()
        .map(|remotes| !remotes.is_empty())
        .unwrap_or(false);
    let mut state = RemoteState { branch: None, upstream: None, ahead: 0, behind: 0, has_remote };
    let Ok(head) = repo.head() else {
        return Ok(state);
    };
    if !head.is_branch() {
        return Ok(state);
    }
    let Some(name) = head.shorthand().map(str::to_owned) else {
        return Ok(state);
    };
    state.branch = Some(name.clone());
    if let Ok(branch) = repo.find_branch(&name, BranchType::Local) {
        if let Ok(upstream) = branch.upstream() {
            state.upstream = upstream.name().ok().flatten().map(str::to_owned);
            if let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) {
                if let Ok((ahead, behind)) = repo.graph_ahead_behind(local, remote) {
                    state.ahead = ahead as u32;
                    state.behind = behind as u32;
                }
            }
        }
    }
    Ok(state)
}

/// Runs `git <args>` in `workdir`, killing it after `timeout`. Returns the trimmed combined output.
pub fn run_git(workdir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Git is not installed or is not on PATH".to_owned()
        } else {
            format!("Could not start git: {error}")
        }
    })?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(stream) = stdout.as_mut() {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            buffer = String::from_utf8_lossy(&bytes).into_owned();
        }
        buffer
    });
    let err_reader = thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(stream) = stderr.as_mut() {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            buffer = String::from_utf8_lossy(&bytes).into_owned();
        }
        buffer
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {} timed out after {} seconds",
                        args.first().copied().unwrap_or(""),
                        timeout.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => return Err(format!("Could not wait for git: {error}")),
        }
    };
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    let combined = [out.trim(), err.trim()]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    if status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("git {} failed", args.first().copied().unwrap_or("")))
    } else {
        Err(combined)
    }
}

fn workdir_of(path: &str) -> Result<std::path::PathBuf, String> {
    let repo = open_repository(path)?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or_else(|| "This repository has no working directory".to_owned())
}

pub fn fetch(path: &str) -> Result<String, String> {
    let workdir = workdir_of(path)?;
    if !remote_state(path)?.has_remote {
        return Err("This repository has no remote configured".to_owned());
    }
    let output = run_git(&workdir, &["fetch", "--all", "--prune"], FETCH_TIMEOUT)?;
    Ok(if output.is_empty() { "Already up to date".to_owned() } else { output })
}

pub fn pull(path: &str) -> Result<String, String> {
    let workdir = workdir_of(path)?;
    let state = remote_state(path)?;
    if state.branch.is_none() {
        return Err("Check out a branch before pulling".to_owned());
    }
    if state.upstream.is_none() {
        return Err("This branch has no upstream yet. Publish it first".to_owned());
    }
    match run_git(&workdir, &["pull", "--no-rebase", "--no-edit"], PULL_TIMEOUT) {
        Ok(output) => Ok(if output.is_empty() { "Already up to date".to_owned() } else { output }),
        Err(message) => {
            let merging = open_repository(path)
                .map(|repo| repo.state() == RepositoryState::Merge)
                .unwrap_or(false);
            if merging {
                Ok("Pull stopped with merge conflicts. Resolve them in Git Changes".to_owned())
            } else {
                Err(message)
            }
        }
    }
}

pub fn push(path: &str) -> Result<String, String> {
    let workdir = workdir_of(path)?;
    let state = remote_state(path)?;
    let Some(branch) = state.branch.clone() else {
        return Err("Check out a branch before pushing".to_owned());
    };
    if branch.starts_with('-') {
        return Err("Invalid branch name".to_owned());
    }
    if state.upstream.is_some() {
        let output = run_git(&workdir, &["push"], PUSH_TIMEOUT)?;
        return Ok(if output.is_empty() { "Pushed".to_owned() } else { output });
    }
    let repo = open_repository(path)?;
    let remotes = repo
        .remotes()
        .map_err(|error| format!("Could not list remotes: {error}"))?;
    let remote = if remotes.iter().flatten().any(|name| name == "origin") {
        "origin".to_owned()
    } else {
        remotes
            .iter()
            .flatten()
            .next()
            .map(str::to_owned)
            .ok_or_else(|| "This repository has no remote configured".to_owned())?
    };
    let output = run_git(&workdir, &["push", "--set-upstream", &remote, &branch], PUSH_TIMEOUT)?;
    Ok(if output.is_empty() { format!("Published {branch} to {remote}") } else { output })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const T: Duration = Duration::from_secs(60);

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut full = vec!["-c", "user.name=Yerminal Test", "-c", "user.email=test@yerminal.local", "-c", "core.autocrlf=false"];
        full.extend_from_slice(args);
        run_git(dir, &full, T).unwrap_or_else(|error| panic!("git {args:?} failed: {error}"))
    }

    /// A bare "remote", one clone that has pushed `main`, and a second clone of the same remote.
    fn remote_with_two_clones() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = tempfile::tempdir().expect("temp dir");
        let remote = root.path().join("remote.git");
        let first = root.path().join("first");
        let second = root.path().join("second");
        fs::create_dir_all(&remote).unwrap();
        fs::create_dir_all(&first).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]);
        git(&first, &["init", "-b", "main"]);
        fs::write(first.join("a.txt"), "one\n").unwrap();
        git(&first, &["add", "."]);
        git(&first, &["commit", "-m", "first"]);
        git(&first, &["remote", "add", "origin", remote.to_str().unwrap()]);
        (root, first, second)
    }

    #[test]
    fn publishing_sets_the_upstream_and_pushes() {
        let (_root, first, _) = remote_with_two_clones();
        let path = first.to_string_lossy().into_owned();
        let before = remote_state(&path).unwrap();
        assert_eq!(before.branch.as_deref(), Some("main"));
        assert!(before.upstream.is_none());
        assert!(before.has_remote);

        push(&path).expect("publish branch");
        let after = remote_state(&path).unwrap();
        assert_eq!(after.upstream.as_deref(), Some("origin/main"));
        assert_eq!((after.ahead, after.behind), (0, 0));
    }

    #[test]
    fn fetch_reports_behind_and_pull_fast_forwards() {
        let (root, first, second) = remote_with_two_clones();
        let first_path = first.to_string_lossy().into_owned();
        push(&first_path).unwrap();
        let remote = root.path().join("remote.git");
        git(root.path(), &["clone", remote.to_str().unwrap(), second.to_str().unwrap()]);
        fs::write(second.join("b.txt"), "two\n").unwrap();
        git(&second, &["add", "."]);
        git(&second, &["commit", "-m", "second"]);
        git(&second, &["push"]);

        fetch(&first_path).expect("fetch");
        let state = remote_state(&first_path).unwrap();
        assert_eq!((state.ahead, state.behind), (0, 1));

        pull(&first_path).expect("pull");
        assert!(first.join("b.txt").exists());
        let state = remote_state(&first_path).unwrap();
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn push_sends_local_commits_and_pull_requires_an_upstream() {
        let (_root, first, _) = remote_with_two_clones();
        let path = first.to_string_lossy().into_owned();
        let error = pull(&path).unwrap_err();
        assert!(error.contains("no upstream"), "{error}");
        push(&path).unwrap();

        fs::write(first.join("c.txt"), "three\n").unwrap();
        git(&first, &["add", "."]);
        git(&first, &["commit", "-m", "third"]);
        assert_eq!(remote_state(&path).unwrap().ahead, 1);
        push(&path).expect("push");
        assert_eq!(remote_state(&path).unwrap().ahead, 0);
    }

    #[test]
    fn pull_with_diverged_conflicting_history_stops_in_a_merge_state() {
        let (root, first, second) = remote_with_two_clones();
        let first_path = first.to_string_lossy().into_owned();
        push(&first_path).unwrap();
        let remote = root.path().join("remote.git");
        git(root.path(), &["clone", remote.to_str().unwrap(), second.to_str().unwrap()]);
        fs::write(second.join("a.txt"), "remote change\n").unwrap();
        git(&second, &["commit", "-am", "remote edit"]);
        git(&second, &["push"]);
        fs::write(first.join("a.txt"), "local change\n").unwrap();
        git(&first, &["commit", "-am", "local edit"]);

        let message = pull(&first_path).expect("pull reports conflicts instead of failing");
        assert!(message.contains("merge conflicts"), "{message}");
        assert_eq!(open_repository(&first_path).unwrap().state(), RepositoryState::Merge);
    }

    #[test]
    fn fetch_without_a_remote_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]);
        let error = fetch(&dir.path().to_string_lossy()).unwrap_err();
        assert!(error.contains("no remote"), "{error}");
    }
}

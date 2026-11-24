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
const REMOTE_ADD_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_NAME_MAX: usize = 64;
const REMOTE_URL_MAX: usize = 2048;
const GH_TIMEOUT: Duration = Duration::from_secs(120);
/// The GitHub CLI executable is missing. The Publish dialog shows this and falls back to a URL.
pub const GH_NOT_INSTALLED: &str = "GitHub CLI (gh) is not installed or is not on PATH";

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
    run_program("git", workdir, args, timeout)
}

/// Runs `program <args>` in `workdir` with terminal prompts disabled, killing it after `timeout`.
/// Returns the trimmed combined output. `gh` and `git` share this runner.
fn run_program(program: &str, workdir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
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
            if program == "gh" {
                GH_NOT_INSTALLED.to_owned()
            } else {
                "Git is not installed or is not on PATH".to_owned()
            }
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
                        "{program} {} timed out after {} seconds",
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
        Err(format!("{program} {} failed", args.first().copied().unwrap_or("")))
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
    publish(&workdir, &branch, &remote)
}

/// Pushes `branch` to `remote` and sets that remote branch as the upstream.
fn publish(workdir: &Path, branch: &str, remote: &str) -> Result<String, String> {
    let output = run_git(workdir, &["push", "--set-upstream", remote, branch], PUSH_TIMEOUT)?;
    Ok(if output.is_empty() { format!("Published {branch} to {remote}") } else { output })
}

/// A remote name is a plain word: letters, digits, `.`, `_` or `-`, starting with a letter or digit.
pub fn validate_remote_name(name: &str) -> Result<(), String> {
    let plain = !name.is_empty()
        && name.len() <= REMOTE_NAME_MAX
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !name.contains("..");
    if plain {
        Ok(())
    } else {
        Err("Remote name: use letters, digits, '.', '_' or '-', starting with a letter or digit".to_owned())
    }
}

fn starts_alphanumeric(text: &str) -> bool {
    text.as_bytes().first().is_some_and(|byte| byte.is_ascii_alphanumeric())
}

fn is_host(text: &str) -> bool {
    starts_alphanumeric(text) && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn is_user(text: &str) -> bool {
    starts_alphanumeric(text) && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `host[:port]/path`: the part of an https or ssh URL after the scheme (and user).
fn is_authority_and_path(rest: &str) -> bool {
    let Some((authority, path)) = rest.split_once('/') else {
        return false;
    };
    if path.is_empty() {
        return false;
    }
    let host = match authority.split_once(':') {
        Some((host, port)) => {
            let port_ok = !port.is_empty() && port.len() <= 5 && port.bytes().all(|byte| byte.is_ascii_digit());
            if !port_ok {
                return false;
            }
            host
        }
        None => authority,
    };
    is_host(host)
}

/// True for `https://host/path`, `ssh://[user@]host[:port]/path` and scp-style `user@host:path` (e.g. `git@host:path`).
fn has_supported_shape(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        is_authority_and_path(rest)
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        match rest.split_once('@') {
            Some((user, after)) => is_user(user) && is_authority_and_path(after),
            None => is_authority_and_path(rest),
        }
    } else {
        url.split_once('@').is_some_and(|(user, after)| {
            is_user(user) && after.split_once(':').is_some_and(|(host, path)| is_host(host) && !path.is_empty())
        })
    }
}

/// Rejects empty, oversized, whitespace or control-character values, anything starting with `-` (it would be read as
/// a git option), and every form other than https, ssh:// or scp-style.
pub fn validate_remote_url(url: &str) -> Result<(), String> {
    let plain = !url.is_empty()
        && url.len() <= REMOTE_URL_MAX
        && !url.starts_with('-')
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && has_supported_shape(url);
    if plain {
        Ok(())
    } else {
        Err("Remote URL: use https://host/path, ssh://[user@]host[:port]/path or git@host:path".to_owned())
    }
}

/// Adds `name` as a remote and publishes the current branch to it in one step. Both values are validated first and
/// reach git as separate arguments (no shell). If the push fails, the remote stays configured, so the next Publish
/// pushes through the normal path instead of adding the remote again.
pub fn add_remote_and_publish(path: &str, name: &str, url: &str) -> Result<String, String> {
    validate_remote_name(name)?;
    validate_remote_url(url)?;
    publish_new_remote(path, name, url)
}

fn publish_new_remote(path: &str, name: &str, url: &str) -> Result<String, String> {
    let workdir = workdir_of(path)?;
    let state = remote_state(path)?;
    let Some(branch) = state.branch else {
        return Err("Check out a branch before publishing".to_owned());
    };
    if branch.starts_with('-') {
        return Err("Invalid branch name".to_owned());
    }
    run_git(&workdir, &["remote", "add", name, url], REMOTE_ADD_TIMEOUT)?;
    publish(&workdir, &branch, name)
        .map_err(|message| format!("Remote {name} was added, but publishing failed: {message}"))
}

/// GitHub repository names: ASCII letters, digits, `.`, `_`, `-`. Not `.` or `..`, not starting with `-`.
pub fn validate_repo_name(name: &str) -> Result<(), String> {
    let plain = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name != "."
        && name != ".."
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if plain {
        Ok(())
    } else {
        Err("Repository name: use letters, digits, '.', '_' or '-' (no spaces or '/')".to_owned())
    }
}

/// A `gh` call: the arguments only. The real one runs `gh` in the repository, tests pass a fake.
type GhRunner<'a> = &'a dyn Fn(&[&str]) -> Result<String, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub logged_in: bool,
    /// The signed-in account, when `gh api user` could be read.
    pub login: Option<String>,
}

pub fn github_status() -> GithubStatus {
    let home = std::env::temp_dir();
    github_status_with(&|args: &[&str]| run_program("gh", &home, args, GH_TIMEOUT))
}

/// Reads `gh auth status` and the login. Never signs in; a missing login is reported as `None`.
pub fn github_status_with(gh: GhRunner) -> GithubStatus {
    match gh(&["auth", "status"]) {
        Err(message) if message == GH_NOT_INSTALLED => GithubStatus { installed: false, logged_in: false, login: None },
        Err(_) => GithubStatus { installed: true, logged_in: false, login: None },
        Ok(_) => {
            let login = gh(&["api", "user", "--jq", ".login"])
                .ok()
                .map(|login| login.trim().to_owned())
                .filter(|login| !login.is_empty());
            GithubStatus { installed: true, logged_in: true, login }
        }
    }
}

/// Creates a GitHub repository from the current repository with `gh`, adds it as `origin`, then publishes the branch.
/// Private unless `public`. Validated first; `gh` receives an argument array only.
pub fn create_github_repo(path: &str, name: &str, public: bool) -> Result<String, String> {
    let workdir = workdir_of(path)?;
    let gh = |args: &[&str]| run_program("gh", &workdir, args, GH_TIMEOUT);
    create_github_repo_with(path, name, public, &gh)
}

fn create_github_repo_with(path: &str, name: &str, public: bool, gh: GhRunner) -> Result<String, String> {
    validate_repo_name(name)?;
    let workdir = workdir_of(path)?;
    let state = remote_state(path)?;
    let Some(branch) = state.branch else {
        return Err("Check out a branch before publishing".to_owned());
    };
    if branch.starts_with('-') {
        return Err("Invalid branch name".to_owned());
    }
    if state.has_remote {
        return Err("This repository already has a remote".to_owned());
    }
    let source = workdir
        .to_str()
        .ok_or_else(|| "The repository path is not valid text".to_owned())?
        .to_owned();
    let visibility = if public { "--public" } else { "--private" };
    gh(&["repo", "create", name, visibility, "--source", &source, "--remote", "origin"])?;
    publish(&workdir, &branch, "origin").map_err(|message| {
        format!("Repository created on GitHub and origin added, but publishing failed: {message}")
    })?;
    Ok(format!("Created {name} on GitHub and published {branch}"))
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
        // `pull` runs plain `git`, which needs a committer identity for the merge commit (CI runners have none).
        git(&first, &["config", "user.name", "Yerminal Test"]);
        git(&first, &["config", "user.email", "test@yerminal.local"]);
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

    /// A local repository with one commit on `main` and no remote.
    fn repo_without_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        git(dir.path(), &["init", "-b", "main"]);
        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "first"]);
        dir
    }

    #[test]
    fn publishing_without_a_remote_adds_it_and_sets_the_upstream() {
        let dir = repo_without_remote();
        let remote_root = tempfile::tempdir().unwrap();
        let remote = remote_root.path().join("remote.git");
        fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]);
        let path = dir.path().to_string_lossy().into_owned();
        assert!(!remote_state(&path).unwrap().has_remote);

        publish_new_remote(&path, "origin", remote.to_str().unwrap()).expect("publish");
        let state = remote_state(&path).unwrap();
        assert!(state.has_remote);
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        assert_eq!((state.ahead, state.behind), (0, 0));
    }

    #[test]
    fn publishing_rejects_urls_that_are_not_https_ssh_or_scp_style_and_adds_nothing() {
        let dir = repo_without_remote();
        let path = dir.path().to_string_lossy().into_owned();
        let rejected = [
            "",
            "   ",
            "not a url",
            "ftp://example.com/repo.git",
            "https://",
            "https://example.com/with space.git",
            "--upload-pack=touch x",
            "-oProxyCommand=calc",
            "ssh://-oProxyCommand=calc/repo.git",
            "git@-host:repo.git",
        ];
        for url in rejected {
            let error = add_remote_and_publish(&path, "origin", url).unwrap_err();
            assert!(!error.is_empty(), "{url:?} must be rejected");
        }
        assert!(!remote_state(&path).unwrap().has_remote);
    }

    #[test]
    fn remote_urls_in_https_ssh_and_scp_form_are_accepted() {
        for url in [
            "https://github.com/owner/repo.git",
            "https://gitlab.example.com:8443/group/sub/repo",
            "ssh://git@github.com/owner/repo.git",
            "ssh://git@example.com:2222/owner/repo.git",
            "git@github.com:owner/repo.git",
        ] {
            assert!(validate_remote_url(url).is_ok(), "{url} must be accepted");
        }
    }

    #[test]
    fn publishing_rejects_a_remote_name_that_is_not_a_plain_name() {
        let dir = repo_without_remote();
        let path = dir.path().to_string_lossy().into_owned();
        for name in ["", "-x", "--all", "a b", "origin/x", "a..b"] {
            let error = add_remote_and_publish(&path, name, "https://github.com/owner/repo.git").unwrap_err();
            assert!(!error.is_empty(), "{name:?} must be rejected");
        }
        assert!(!remote_state(&path).unwrap().has_remote);
    }

    #[test]
    fn publishing_on_a_detached_head_is_rejected_before_adding_a_remote() {
        let dir = repo_without_remote();
        let path = dir.path().to_string_lossy().into_owned();
        git(dir.path(), &["checkout", "--detach"]);
        let error = add_remote_and_publish(&path, "origin", "https://github.com/owner/repo.git").unwrap_err();
        assert!(error.contains("Check out a branch"), "{error}");
        assert!(!remote_state(&path).unwrap().has_remote);
    }

    #[test]
    fn a_failed_push_keeps_the_remote_that_was_added() {
        let dir = repo_without_remote();
        let path = dir.path().to_string_lossy().into_owned();
        // Port 1 refuses connections at once, so the push fails without network access.
        let error = add_remote_and_publish(&path, "origin", "https://127.0.0.1:1/none.git").unwrap_err();
        assert!(error.contains("was added"), "{error}");
        let state = remote_state(&path).unwrap();
        assert!(state.has_remote, "the remote stays configured for the next Publish");
        assert!(state.upstream.is_none());
    }

    /// Records every `gh` call. `repo create` behaves like `gh repo create --remote origin`: it adds `origin` and nothing else.
    fn fake_gh_creating<'a>(local: &'a Path, remote_url: &'a str, calls: &'a std::cell::RefCell<Vec<Vec<String>>>) -> impl Fn(&[&str]) -> Result<String, String> + 'a {
        move |args: &[&str]| {
            calls.borrow_mut().push(args.iter().map(|arg| arg.to_string()).collect());
            if args.first() == Some(&"repo") {
                git(local, &["remote", "add", "origin", remote_url]);
                Ok(String::new())
            } else {
                Err(format!("unexpected gh call {args:?}"))
            }
        }
    }

    #[test]
    fn github_repo_names_must_be_plain_names() {
        for ok in ["yerminal", "my-repo", "my.repo_2"] {
            assert!(validate_repo_name(ok).is_ok(), "{ok} must be accepted");
        }
        for bad in ["", "  ", "a b", "owner/repo", "-x", ".", "..", "naïve", "x\ty"] {
            assert!(validate_repo_name(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn creating_a_private_github_repo_runs_gh_with_argv_then_publishes_to_origin() {
        let (root, local, _) = remote_with_two_clones();
        let bare = root.path().join("remote.git");
        let bare_url = bare.to_str().unwrap().to_owned();
        // The local clone has no remote of its own here: the fake gh adds `origin` the way gh does.
        git(&local, &["remote", "remove", "origin"]);
        let path = local.to_string_lossy().into_owned();
        let calls = std::cell::RefCell::new(Vec::new());
        let gh = fake_gh_creating(&local, &bare_url, &calls);

        create_github_repo_with(&path, "my-repo", false, &gh).expect("create and publish");

        let calls = calls.borrow();
        assert_eq!(calls.len(), 1, "gh is called once: {calls:?}");
        let call = &calls[0];
        assert_eq!(&call[..3], ["repo", "create", "my-repo"]);
        assert_eq!(call[3], "--private");
        assert_eq!(call[4], "--source");
        assert!(Path::new(&call[5]).canonicalize().unwrap() == local.canonicalize().unwrap());
        assert_eq!(&call[6..], ["--remote", "origin"]);
        let state = remote_state(&path).unwrap();
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn creating_a_public_github_repo_passes_public() {
        let (root, local, _) = remote_with_two_clones();
        let bare_url = root.path().join("remote.git").to_str().unwrap().to_owned();
        git(&local, &["remote", "remove", "origin"]);
        let path = local.to_string_lossy().into_owned();
        let calls = std::cell::RefCell::new(Vec::new());
        let gh = fake_gh_creating(&local, &bare_url, &calls);
        create_github_repo_with(&path, "my-repo", true, &gh).expect("create public");
        assert_eq!(calls.borrow()[0][3], "--public");
    }

    #[test]
    fn a_gh_failure_is_reported_and_nothing_is_published() {
        let (_root, local, _) = remote_with_two_clones();
        git(&local, &["remote", "remove", "origin"]);
        let path = local.to_string_lossy().into_owned();
        let gh = |_: &[&str]| -> Result<String, String> { Err("Name already exists on this account".to_owned()) };
        let error = create_github_repo_with(&path, "my-repo", false, &gh).unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert!(!remote_state(&path).unwrap().has_remote);
    }

    #[test]
    fn a_push_failure_after_creating_the_repo_says_what_succeeded() {
        let (_root, local, _) = remote_with_two_clones();
        git(&local, &["remote", "remove", "origin"]);
        let path = local.to_string_lossy().into_owned();
        let calls = std::cell::RefCell::new(Vec::new());
        // Port 1 refuses connections at once, so the push fails without network access.
        let gh = fake_gh_creating(&local, "https://127.0.0.1:1/none.git", &calls);
        let error = create_github_repo_with(&path, "my-repo", false, &gh).unwrap_err();
        assert!(error.contains("created on GitHub"), "{error}");
        assert!(error.contains("publishing failed"), "{error}");
        let state = remote_state(&path).unwrap();
        assert!(state.has_remote, "origin stays configured so the next Publish can retry");
        assert!(state.upstream.is_none());
    }

    #[test]
    fn creating_a_github_repo_is_refused_before_gh_runs_when_a_remote_exists_or_the_name_is_bad() {
        let (_root, first, _) = remote_with_two_clones();
        let path = first.to_string_lossy().into_owned();
        let never = |_: &[&str]| -> Result<String, String> { panic!("gh must not run") };
        let error = create_github_repo_with(&path, "my-repo", false, &never).unwrap_err();
        assert!(error.contains("already has a remote"), "{error}");

        let dir = repo_without_remote();
        let path = dir.path().to_string_lossy().into_owned();
        let error = create_github_repo_with(&path, "-x", false, &never).unwrap_err();
        assert!(!error.is_empty());
        git(dir.path(), &["checkout", "--detach"]);
        let error = create_github_repo_with(&path, "my-repo", false, &never).unwrap_err();
        assert!(error.contains("Check out a branch"), "{error}");
    }

    #[test]
    fn github_status_reports_a_missing_cli_a_signed_out_user_and_the_login() {
        let missing = |_: &[&str]| -> Result<String, String> { Err(GH_NOT_INSTALLED.to_owned()) };
        let status = github_status_with(&missing);
        assert!(!status.installed && !status.logged_in && status.login.is_none());

        let signed_out = |_: &[&str]| -> Result<String, String> { Err("You are not logged into any GitHub hosts".to_owned()) };
        let status = github_status_with(&signed_out);
        assert!(status.installed && !status.logged_in && status.login.is_none());

        let signed_in = |args: &[&str]| -> Result<String, String> {
            Ok(if args.contains(&"api") { "octocat\n".to_owned() } else { String::new() })
        };
        let status = github_status_with(&signed_in);
        assert!(status.installed && status.logged_in);
        assert_eq!(status.login.as_deref(), Some("octocat"));
    }
}

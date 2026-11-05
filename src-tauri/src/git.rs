use std::path::Path;
use git2::{BranchType, DiffFormat, DiffOptions, Repository, RepositoryState, Status, StatusOptions};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub root: String,
    pub branch: String,
    pub state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub branches: Vec<String>,
}

fn open_repository(path: &str) -> Result<Repository, String> {
    let path = Path::new(path).canonicalize().map_err(|error| format!("Cannot open folder: {error}"))?;
    Repository::discover(path).map_err(|error| format!("No Git repository found: {error}"))
}

pub fn repository_info(path: &str) -> Result<RepositoryInfo, String> {
    let repo = open_repository(path)?;
    let root = repo.workdir().unwrap_or_else(|| repo.path()).to_string_lossy().into_owned();
    let branch = repo.head().ok().and_then(|head| head.shorthand().map(str::to_owned)).unwrap_or_else(|| "(detached HEAD)".to_owned());
    let state = match repo.state() {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge in progress",
        RepositoryState::Revert => "revert in progress",
        RepositoryState::RevertSequence => "revert sequence in progress",
        RepositoryState::CherryPick => "cherry-pick in progress",
        RepositoryState::CherryPickSequence => "cherry-pick sequence in progress",
        RepositoryState::Bisect => "bisect in progress",
        RepositoryState::Rebase => "rebase in progress",
        RepositoryState::RebaseInteractive => "interactive rebase in progress",
        RepositoryState::RebaseMerge => "rebase merge in progress",
        RepositoryState::ApplyMailbox => "mailbox apply in progress",
        RepositoryState::ApplyMailboxOrRebase => "mailbox apply or rebase in progress",
    }.to_owned();
    Ok(RepositoryInfo { root, branch, state })
}

pub fn status(path: &str) -> Result<Vec<FileChange>, String> {
    let repo = open_repository(path)?;
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false).renames_head_to_index(true).renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut options)).map_err(|error| format!("Could not read Git status: {error}"))?;
    let mut changes = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let Some(path) = entry.path() else { continue };
        let status = entry.status();
        let staged = status.intersects(Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED | Status::INDEX_RENAMED | Status::INDEX_TYPECHANGE);
        let unstaged = status.intersects(Status::WT_NEW | Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE);
        let kind = if status.contains(Status::WT_NEW) && !staged { "untracked" }
            else if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) { "deleted" }
            else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) { "renamed" }
            else if status.intersects(Status::INDEX_NEW | Status::WT_NEW) { "added" }
            else if status.intersects(Status::INDEX_MODIFIED | Status::WT_MODIFIED | Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE) { "modified" }
            else { "changed" };
        changes.push(FileChange { path: path.to_owned(), kind: kind.to_owned(), staged, unstaged });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

pub fn diff(path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    if file_path.is_empty() || Path::new(file_path).is_absolute() || file_path.split(['/', '\\']).any(|part| part == "..") {
        return Err("Invalid repository-relative file path".to_owned());
    }
    let repo = open_repository(path)?;
    let mut options = DiffOptions::new();
    options.pathspec(file_path).include_untracked(!staged).show_untracked_content(!staged).context_lines(3);
    let diff = if staged {
        let head = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        repo.diff_tree_to_index(head.as_ref(), None, Some(&mut options))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut options))
    }.map_err(|error| format!("Could not create diff: {error}"))?;
    let mut output = String::new();
    diff.print(DiffFormat::Patch, |_, _, line| {
        output.push_str(&String::from_utf8_lossy(line.content()));
        true
    }).map_err(|error| format!("Could not read diff: {error}"))?;
    Ok(output)
}

pub fn history(path: &str, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open_repository(path)?;
    let mut walk = repo.revwalk().map_err(|error| format!("Could not open commit history: {error}"))?;
    walk.push_head().map_err(|error| format!("Could not read repository HEAD: {error}"))?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME).map_err(|error| format!("Could not sort commit history: {error}"))?;
    let branches = branch_labels(&repo);
    let mut commits = Vec::new();
    for oid in walk.skip(skip).take(limit.clamp(1, 100)) {
        let oid = oid.map_err(|error| format!("Could not read commit: {error}"))?;
        let commit = repo.find_commit(oid).map_err(|error| format!("Could not read commit {oid}: {error}"))?;
        let id = oid.to_string();
        commits.push(CommitInfo {
            short_id: id.chars().take(8).collect(),
            branches: branches.get(&id).cloned().unwrap_or_default(),
            id,
            message: commit.summary().unwrap_or("(no message)").to_owned(),
            author: commit.author().name().unwrap_or("Unknown author").to_owned(),
            timestamp: commit.time().seconds(),
            parents: commit.parent_ids().map(|parent| parent.to_string()).collect(),
        });
    }
    Ok(commits)
}

fn branch_labels(repo: &Repository) -> std::collections::HashMap<String, Vec<String>> {
    let mut labels = std::collections::HashMap::<String, Vec<String>>::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for branch in branches.flatten() {
            let (branch, _) = branch;
            let Some(name) = branch.name().ok().flatten() else { continue };
            let Some(oid) = branch.get().target() else { continue };
            labels.entry(oid.to_string()).or_default().push(name.to_owned());
        }
    }
    labels
}

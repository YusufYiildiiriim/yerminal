use git2::{
    BranchType, Delta, DiffFormat, DiffOptions, IndexEntry, IndexTime, Oid, Repository,
    RepositoryState, Status, StatusOptions,
};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub root: String,
    pub branch: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileContent {
    pub content: String,
    pub source_label: String,
}

fn open_repository(path: &str) -> Result<Repository, String> {
    let path = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Cannot open folder: {error}"))?;
    Repository::discover(path).map_err(|error| format!("No Git repository found: {error}"))
}

pub fn repository_info(path: &str) -> Result<RepositoryInfo, String> {
    let repo = open_repository(path)?;
    let root = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .into_owned();
    let branch = head_label(&repo);
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
    }
    .to_owned();
    Ok(RepositoryInfo {
        root,
        branch,
        state,
    })
}

/// Branch label for HEAD: the branch name (also for an unborn branch with no
/// commits yet), or "(detached HEAD)" when HEAD points directly at a commit.
fn head_label(repo: &Repository) -> String {
    const DETACHED: &str = "(detached HEAD)";
    if repo.head_detached().unwrap_or(false) {
        return DETACHED.to_owned();
    }
    let Ok(head) = repo.find_reference("HEAD") else {
        return DETACHED.to_owned();
    };
    match head.symbolic_target() {
        Some(target) => target
            .strip_prefix("refs/heads/")
            .unwrap_or(target)
            .to_owned(),
        None => DETACHED.to_owned(),
    }
}

pub fn status(path: &str) -> Result<Vec<FileChange>, String> {
    let repo = open_repository(path)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|error| format!("Could not read Git status: {error}"))?;
    let mut changes = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let status = entry.status();
        // `StatusEntry::path` is the old side of a rename; report the new path
        // so the entry can be diffed, staged and opened at its current location.
        let renamed_path = if status.contains(Status::INDEX_RENAMED) {
            entry
                .head_to_index()
                .and_then(|delta| delta.new_file().path().map(Path::to_path_buf))
        } else if status.contains(Status::WT_RENAMED) {
            entry
                .index_to_workdir()
                .and_then(|delta| delta.new_file().path().map(Path::to_path_buf))
        } else {
            None
        };
        let path = match renamed_path {
            Some(renamed_path) => renamed_path.to_string_lossy().replace('\\', "/"),
            None => match entry.path() {
                Some(path) => path.to_owned(),
                None => continue,
            },
        };
        let path = path.as_str();
        let staged = status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        );
        let unstaged = status.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        );
        let kind = if status.contains(Status::WT_NEW) && !staged {
            "untracked"
        } else if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
            "deleted"
        } else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
            "renamed"
        } else if status.intersects(Status::INDEX_NEW | Status::WT_NEW) {
            "added"
        } else if status.intersects(
            Status::INDEX_MODIFIED
                | Status::WT_MODIFIED
                | Status::INDEX_TYPECHANGE
                | Status::WT_TYPECHANGE,
        ) {
            "modified"
        } else {
            "changed"
        };
        changes.push(FileChange {
            path: path.to_owned(),
            kind: kind.to_owned(),
            staged,
            unstaged,
        });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

pub fn diff(path: &str, file_path: &str, staged: bool) -> Result<String, String> {
    if file_path.is_empty()
        || Path::new(file_path).is_absolute()
        || file_path.split(['/', '\\']).any(|part| part == "..")
    {
        return Err("Invalid repository-relative file path".to_owned());
    }
    let repo = open_repository(path)?;
    let mut options = DiffOptions::new();
    options
        .pathspec(file_path)
        .disable_pathspec_match(true)
        .include_untracked(!staged)
        .show_untracked_content(!staged)
        .context_lines(3);
    let diff = if staged {
        let head = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        repo.diff_tree_to_index(head.as_ref(), None, Some(&mut options))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut options))
    }
    .map_err(|error| format!("Could not create diff: {error}"))?;
    let mut output = String::new();
    diff.print(DiffFormat::Patch, |_, _, line| {
        output.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|error| format!("Could not read diff: {error}"))?;
    Ok(output)
}

fn validated_worktree_path(repo: &Repository, file_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(file_path);
    let components: Vec<_> = relative.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid repository-relative file path".to_owned());
    }
    if components.iter().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
    }) {
        return Err("Git metadata files cannot be changed from Git Changes".to_owned());
    }

    let root = repo
        .workdir()
        .ok_or_else(|| "Git worktree is unavailable".to_owned())?
        .canonicalize()
        .map_err(|error| format!("Could not resolve Git worktree: {error}"))?;
    let mut parent = root.clone();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        if let Component::Normal(part) = component {
            parent.push(part);
        }
        if parent.exists() {
            parent = parent
                .canonicalize()
                .map_err(|error| format!("Could not resolve file path: {error}"))?;
            if !parent.starts_with(&root) {
                return Err("File path escapes the Git worktree".to_owned());
            }
            if !parent.is_dir() {
                return Err("A parent component is not a directory".to_owned());
            }
        }
    }

    Ok(relative.to_path_buf())
}

pub fn stage_file(path: &str, file_path: &str) -> Result<(), String> {
    let repo = open_repository(path)?;
    let relative = validated_worktree_path(&repo, file_path)?;
    let worktree_file = repo
        .workdir()
        .ok_or_else(|| "Git worktree is unavailable".to_owned())?
        .join(&relative);
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;

    match fs::symlink_metadata(&worktree_file) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => index
            .add_path(&relative)
            .map_err(|error| format!("Could not stage file: {error}"))?,
        Ok(_) => return Err("Only individual files can be staged".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if index.get_path(&relative, 0).is_some() {
                index
                    .remove_path(&relative)
                    .map_err(|error| format!("Could not stage file deletion: {error}"))?;
            } else {
                return Err("File no longer exists; refresh Git Changes".to_owned());
            }
        }
        Err(error) => return Err(format!("Could not inspect file: {error}")),
    }

    index
        .write()
        .map_err(|error| format!("Could not write Git index: {error}"))
}

pub fn unstage_file(path: &str, file_path: &str) -> Result<(), String> {
    let repo = open_repository(path)?;
    let relative = validated_worktree_path(&repo, file_path)?;
    let head = match repo.head() {
        Ok(head) => Some(
            head.peel_to_commit()
                .map_err(|error| format!("Could not read HEAD commit: {error}"))?,
        ),
        Err(error)
            if error.code() == git2::ErrorCode::UnbornBranch
                || error.code() == git2::ErrorCode::NotFound =>
        {
            None
        }
        Err(error) => return Err(format!("Could not read HEAD: {error}")),
    };

    // Reset the single index entry by hand: `Repository::reset_default` treats
    // its paths as glob pathspecs, so `app/[id]/page.tsx` would also unstage
    // `app/i/page.tsx`.
    let head_entry = match head {
        Some(head) => {
            let tree = head
                .tree()
                .map_err(|error| format!("Could not read HEAD tree: {error}"))?;
            match tree.get_path(&relative) {
                Ok(entry) => Some((entry.id(), entry.filemode())),
                Err(error) if error.code() == git2::ErrorCode::NotFound => None,
                Err(error) => return Err(format!("Could not read HEAD entry: {error}")),
            }
        }
        None => None,
    };
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;
    match head_entry {
        Some((id, mode)) => {
            let path = relative.to_string_lossy().replace('\\', "/").into_bytes();
            let file_size = repo
                .find_blob(id)
                .map(|blob| blob.size() as u32)
                .unwrap_or(0);
            index
                .add(&IndexEntry {
                    ctime: IndexTime::new(0, 0),
                    mtime: IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: mode as u32,
                    uid: 0,
                    gid: 0,
                    file_size,
                    id,
                    flags: path.len().min(0xfff) as u16,
                    flags_extended: 0,
                    path,
                })
                .map_err(|error| format!("Could not unstage file: {error}"))?;
        }
        None => {
            if index.get_path(&relative, 0).is_some() {
                index
                    .remove_path(&relative)
                    .map_err(|error| format!("Could not unstage file: {error}"))?;
            }
        }
    }
    index
        .write()
        .map_err(|error| format!("Could not write Git index: {error}"))
}

pub fn discard_worktree_file(path: &str, file_path: &str) -> Result<(), String> {
    let repo = open_repository(path)?;
    let relative = validated_worktree_path(&repo, file_path)?;
    let worktree_file = repo
        .workdir()
        .ok_or_else(|| "Git worktree is unavailable".to_owned())?
        .join(&relative);
    let index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;

    if index.get_path(&relative, 0).is_some() {
        let mut options = git2::build::CheckoutBuilder::new();
        options
            .force()
            .disable_pathspec_match(true)
            .path(&relative);
        repo.checkout_index(None, Some(&mut options))
            .map_err(|error| format!("Could not restore working tree file: {error}"))
    } else {
        match fs::symlink_metadata(&worktree_file) {
            Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
                // Only delete files Git itself reports as untracked; ignored
                // files (e.g. `.env`) are never shown in Git Changes.
                let file_status = repo
                    .status_file(&relative)
                    .map_err(|error| format!("Could not read file status: {error}"))?;
                if !file_status.contains(Status::WT_NEW) || file_status.contains(Status::IGNORED)
                {
                    return Err("Only untracked files can be discarded this way".to_owned());
                }
                fs::remove_file(&worktree_file)
                    .map_err(|error| format!("Could not discard untracked file: {error}"))
            }
            Ok(_) => Err("Only individual files can be discarded".to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not inspect file: {error}")),
        }
    }
}

pub fn commit_staged(path: &str, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() || message.len() > 64 * 1024 {
        return Err("Enter a commit message of at most 64 KiB".to_owned());
    }
    let repo = open_repository(path)?;
    if repo.state() != RepositoryState::Clean {
        return Err("Finish the current Git operation before committing".to_owned());
    }
    if !status(path)?.iter().any(|change| change.staged) {
        return Err("There are no staged changes to commit".to_owned());
    }

    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;
    if index.has_conflicts() {
        return Err("Resolve all merge conflicts before committing".to_owned());
    }
    let tree_id = index
        .write_tree()
        .map_err(|error| format!("Could not write staged tree: {error}"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|error| format!("Could not read staged tree: {error}"))?;
    let parent = match repo.head() {
        Ok(head) => Some(
            head.peel_to_commit()
                .map_err(|error| format!("Could not read HEAD commit: {error}"))?,
        ),
        Err(error)
            if error.code() == git2::ErrorCode::UnbornBranch
                || error.code() == git2::ErrorCode::NotFound =>
        {
            None
        }
        Err(error) => return Err(format!("Could not read HEAD: {error}")),
    };
    if parent
        .as_ref()
        .and_then(|commit| commit.tree().ok())
        .is_some_and(|parent_tree| parent_tree.id() == tree_id)
    {
        return Err("There are no staged changes to commit".to_owned());
    }
    let signature = repo.signature().map_err(|error| {
        format!("Configure user.name and user.email before committing: {error}")
    })?;
    let parents: Vec<_> = parent.iter().collect();
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .map_err(|error| format!("Could not create commit: {error}"))?;
    Ok(oid.to_string())
}

pub fn history(path: &str, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open_repository(path)?;
    let mut walk = repo
        .revwalk()
        .map_err(|error| format!("Could not open commit history: {error}"))?;
    walk.push_head()
        .map_err(|error| format!("Could not read repository HEAD: {error}"))?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|error| format!("Could not sort commit history: {error}"))?;
    let branches = branch_labels(&repo);
    let mut commits = Vec::new();
    for oid in walk.skip(skip).take(limit.clamp(1, 100)) {
        let oid = oid.map_err(|error| format!("Could not read commit: {error}"))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|error| format!("Could not read commit {oid}: {error}"))?;
        let id = oid.to_string();
        commits.push(CommitInfo {
            short_id: id.chars().take(8).collect(),
            branches: branches.get(&id).cloned().unwrap_or_default(),
            id,
            message: commit.summary().unwrap_or("(no message)").to_owned(),
            author: commit
                .author()
                .name()
                .unwrap_or("Unknown author")
                .to_owned(),
            timestamp: commit.time().seconds(),
            parents: commit
                .parent_ids()
                .map(|parent| parent.to_string())
                .collect(),
        });
    }
    Ok(commits)
}

pub fn commit_files(path: &str, commit_id: &str) -> Result<Vec<CommitFileChange>, String> {
    let repo = open_repository(path)?;
    let commit = find_commit(&repo, commit_id)?;
    let diff = commit_diff(&repo, &commit, None)?;
    let mut files = diff
        .deltas()
        .filter_map(|delta| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())?;
            let kind = match delta.status() {
                Delta::Added => "added",
                Delta::Deleted => "deleted",
                Delta::Renamed => "renamed",
                Delta::Copied => "copied",
                Delta::Typechange => "typechanged",
                _ => "modified",
            };
            Some(CommitFileChange {
                path: path.to_string_lossy().into_owned(),
                kind: kind.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn commit_file_diff(path: &str, commit_id: &str, file_path: &str) -> Result<String, String> {
    if !is_repo_relative_path(file_path) {
        return Err("Invalid repository-relative file path".to_owned());
    }
    let repo = open_repository(path)?;
    let commit = find_commit(&repo, commit_id)?;
    let diff = commit_diff(&repo, &commit, Some(file_path))?;
    let mut output = String::new();
    diff.print(DiffFormat::Patch, |_, _, line| {
        output.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|error| format!("Could not read commit diff: {error}"))?;
    Ok(output)
}

pub fn commit_file_content(
    path: &str,
    commit_id: &str,
    file_path: &str,
) -> Result<CommitFileContent, String> {
    if !is_repo_relative_path(file_path) {
        return Err("Invalid repository-relative file path".to_owned());
    }
    let repo = open_repository(path)?;
    let commit = find_commit(&repo, commit_id)?;
    let commit_tree = commit
        .tree()
        .map_err(|error| format!("Could not read commit tree: {error}"))?;
    let requested_path = Path::new(file_path);

    let short_id = commit.id().to_string();
    let short_id = &short_id[..short_id.len().min(8)];
    let (tree, source_label) = if commit_tree.get_path(requested_path).is_ok() {
        (commit_tree, format!("Commit {short_id} snapshot"))
    } else {
        let parent = commit
            .parent(0)
            .map_err(|_| "The file does not exist in this commit or its parent".to_owned())?;
        let parent_tree = parent
            .tree()
            .map_err(|error| format!("Could not read parent commit tree: {error}"))?;
        if parent_tree.get_path(requested_path).is_err() {
            return Err("The file does not exist in this commit or its parent".to_owned());
        }
        (
            parent_tree,
            format!("Parent of {short_id} · deleted in commit"),
        )
    };

    let entry = tree
        .get_path(requested_path)
        .map_err(|error| format!("Could not find file in commit tree: {error}"))?;
    let object = entry
        .to_object(&repo)
        .map_err(|error| format!("Could not read commit file: {error}"))?;
    let blob = object
        .peel_to_blob()
        .map_err(|_| "This commit entry is not a regular text file".to_owned())?;
    if blob.size() as u64 > crate::workspace_fs::MAX_PREVIEW_BYTES {
        return Err("File is too large to preview (maximum 1 MiB)".to_owned());
    }
    let bytes = blob.content();
    if bytes.contains(&0) {
        return Err("Binary file preview is unavailable".to_owned());
    }
    let content = String::from_utf8(bytes.to_vec())
        .map_err(|_| "This file is not valid UTF-8 text".to_owned())?;
    Ok(CommitFileContent {
        content,
        source_label,
    })
}

fn find_commit<'repo>(
    repo: &'repo Repository,
    commit_id: &str,
) -> Result<git2::Commit<'repo>, String> {
    let oid = Oid::from_str(commit_id).map_err(|error| format!("Invalid commit ID: {error}"))?;
    repo.find_commit(oid)
        .map_err(|error| format!("Could not read commit {commit_id}: {error}"))
}

fn commit_diff<'repo>(
    repo: &'repo Repository,
    commit: &git2::Commit<'repo>,
    file_path: Option<&str>,
) -> Result<git2::Diff<'repo>, String> {
    let commit_tree = commit
        .tree()
        .map_err(|error| format!("Could not read commit tree: {error}"))?;
    let parent_tree = if commit.parent_count() == 0 {
        None
    } else {
        Some(
            commit
                .parent(0)
                .and_then(|parent| parent.tree())
                .map_err(|error| format!("Could not read parent commit tree: {error}"))?,
        )
    };
    let mut options = DiffOptions::new();
    options.context_lines(3);
    if let Some(file_path) = file_path {
        options.pathspec(file_path).disable_pathspec_match(true);
    }
    repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut options))
        .map_err(|error| format!("Could not create commit diff: {error}"))
}

fn is_repo_relative_path(file_path: &str) -> bool {
    !file_path.is_empty()
        && !Path::new(file_path).is_absolute()
        && !file_path.split(['/', '\\']).any(|part| part == "..")
}

fn branch_labels(repo: &Repository) -> std::collections::HashMap<String, Vec<String>> {
    let mut labels = std::collections::HashMap::<String, Vec<String>>::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for branch in branches.flatten() {
            let (branch, _) = branch;
            let Some(name) = branch.name().ok().flatten() else {
                continue;
            };
            let Some(oid) = branch.get().target() else {
                continue;
            };
            labels
                .entry(oid.to_string())
                .or_default()
                .push(name.to_owned());
        }
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("create temp directory");
        let repo = git2::Repository::init(dir.path()).expect("init repository");
        let mut config = repo.config().expect("read repository config");
        config
            .set_str("user.name", "Yerminal Test")
            .expect("set user.name");
        config
            .set_str("user.email", "test@yerminal.local")
            .expect("set user.email");
        config.set_bool("core.autocrlf", false).ok();
        drop(config);
        drop(repo);
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    fn add_file(root: &std::path::Path, relative: &str, contents: &str) -> std::path::PathBuf {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent directory");
        }
        fs::write(&path, contents).expect("write fixture file");
        path
    }

    fn add_bytes(root: &std::path::Path, relative: &str, contents: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }

    fn stage_and_commit(root: &str, relative: &str, message: &str) -> String {
        stage_file(root, relative).expect("stage file");
        commit_staged(root, message).expect("commit staged changes")
    }

    fn find_change<'a>(changes: &'a [FileChange], path: &str) -> &'a FileChange {
        changes
            .iter()
            .find(|change| change.path == path)
            .unwrap_or_else(|| panic!("missing change for {path}: {changes:?}"))
    }

    fn assert_change(changes: &[FileChange], path: &str, kind: &str, staged: bool, unstaged: bool) {
        let change = find_change(changes, path);
        assert_eq!(change.kind, kind, "kind for {path}");
        assert_eq!(change.staged, staged, "staged for {path}");
        assert_eq!(change.unstaged, unstaged, "unstaged for {path}");
    }

    fn absolute_fixture_path() -> &'static str {
        if cfg!(windows) {
            r"C:\outside-yerminal.txt"
        } else {
            "/outside-yerminal.txt"
        }
    }

    fn normalize_path_text(path: &str) -> String {
        #[cfg(windows)]
        {
            let path = path
                .strip_prefix(r"\\?\UNC\")
                .map(|rest| format!(r"\\{rest}"))
                .unwrap_or_else(|| {
                    path.strip_prefix(r"\\?\")
                        .map(str::to_owned)
                        .unwrap_or_else(|| path.to_owned())
                });
            path.replace('/', "\\")
                .trim_end_matches(['/', '\\'])
                .to_owned()
        }
        #[cfg(not(windows))]
        {
            path.trim_end_matches('/').to_owned()
        }
    }

    #[test]
    fn repository_info_reports_root_branch_and_clean_state() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "readme.md", "# repo");
        stage_and_commit(&path, "readme.md", "initial commit");

        let info = repository_info(&path).expect("repository info");

        let root = normalize_path_text(&info.root);
        let expected_root = normalize_path_text(&dir.path().to_string_lossy());
        #[cfg(windows)]
        assert!(
            root.eq_ignore_ascii_case(&expected_root),
            "root {root} != {expected_root}"
        );
        #[cfg(not(windows))]
        assert_eq!(root, expected_root);

        assert!(
            info.branch == "master" || info.branch == "main",
            "unexpected branch: {}",
            info.branch
        );
        assert_eq!(info.state, "clean");
    }

    #[test]
    fn repository_info_reports_unborn_head_and_rejects_non_repositories() {
        let (dir, path) = init_repo();
        let info = repository_info(&path).expect("repository info");
        let expected = git2::Repository::open(dir.path())
            .unwrap()
            .find_reference("HEAD")
            .unwrap()
            .symbolic_target()
            .unwrap()
            .trim_start_matches("refs/heads/")
            .to_owned();
        assert_eq!(info.branch, expected, "unborn HEAD reports its branch name");
        assert_eq!(info.state, "clean");

        let outside = tempfile::tempdir().expect("create outside temp directory");
        let plain = outside.path().join("plain");
        fs::create_dir_all(&plain).expect("create plain directory");
        let error = repository_info(plain.to_string_lossy().as_ref()).unwrap_err();
        assert!(error.contains("No Git repository found"), "{error}");

        let _ = dir;
    }

    #[test]
    fn repository_info_labels_detached_head() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "readme.md", "# repo");
        let oid = stage_and_commit(&path, "readme.md", "initial commit");
        let repo = git2::Repository::open(dir.path()).unwrap();
        repo.set_head_detached(git2::Oid::from_str(&oid).unwrap())
            .expect("detach HEAD");

        let info = repository_info(&path).expect("repository info");
        assert_eq!(info.branch, "(detached HEAD)");
    }

    #[test]
    fn status_classifies_untracked_modified_and_deleted_changes() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "tracked.txt", "one\n");
        add_file(dir.path(), "remove_me.txt", "bye\n");
        stage_and_commit(&path, "tracked.txt", "add tracked");
        stage_and_commit(&path, "remove_me.txt", "add remove me");

        add_file(dir.path(), "fresh.txt", "new\n");
        assert_change(
            &status(&path).unwrap(),
            "fresh.txt",
            "untracked",
            false,
            true,
        );

        add_file(dir.path(), "tracked.txt", "one\ntwo\n");
        assert_change(
            &status(&path).unwrap(),
            "tracked.txt",
            "modified",
            false,
            true,
        );

        stage_file(&path, "tracked.txt").expect("stage modification");
        assert_change(
            &status(&path).unwrap(),
            "tracked.txt",
            "modified",
            true,
            false,
        );

        fs::remove_file(dir.path().join("remove_me.txt")).expect("delete fixture file");
        assert_change(
            &status(&path).unwrap(),
            "remove_me.txt",
            "deleted",
            false,
            true,
        );
    }

    #[test]
    fn status_reports_newly_staged_files_as_added() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "new.txt", "hello\n");
        stage_file(&path, "new.txt").expect("stage new file");

        assert_change(&status(&path).unwrap(), "new.txt", "added", true, false);

        let _ = dir;
    }

    #[test]
    fn status_reports_the_new_path_of_staged_renames() {
        let (dir, path) = init_repo();
        let content = "line one\nline two\nline three\nline four\n";
        add_file(dir.path(), "old.txt", content);
        stage_and_commit(&path, "old.txt", "add old");

        fs::rename(dir.path().join("old.txt"), dir.path().join("new.txt"))
            .expect("rename fixture file");
        let unstaged = status(&path).unwrap();
        assert_change(&unstaged, "new.txt", "renamed", false, true);

        stage_file(&path, "old.txt").expect("stage removal of old path");
        stage_file(&path, "new.txt").expect("stage new path");

        let changes = status(&path).unwrap();
        assert_change(&changes, "new.txt", "renamed", true, false);
        assert!(
            changes.iter().all(|change| change.path != "old.txt"),
            "{changes:?}"
        );
        let patch = diff(&path, "new.txt", true).expect("staged rename diff");
        assert!(patch.contains("new.txt"), "{patch}");
    }

    #[test]
    fn status_is_sorted_and_clean_repositories_are_empty() {
        let (dir, path) = init_repo();
        assert!(status(&path).expect("clean status").is_empty());

        add_file(dir.path(), "zeta.txt", "z");
        add_file(dir.path(), "alpha.txt", "a");
        let changes = status(&path).expect("status");
        let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
        assert_eq!(paths, vec!["alpha.txt", "zeta.txt"]);
    }

    #[test]
    fn stage_file_removes_deleted_tracked_files_from_index() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "gone.txt", "value\n");
        stage_and_commit(&path, "gone.txt", "add gone");

        fs::remove_file(dir.path().join("gone.txt")).expect("delete fixture file");
        stage_file(&path, "gone.txt").expect("stage deletion");

        assert_change(&status(&path).unwrap(), "gone.txt", "deleted", true, false);
    }

    #[test]
    fn stage_file_validates_paths_and_entries() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "real.txt", "ok\n");
        fs::create_dir_all(dir.path().join("subdir")).expect("create fixture directory");

        let missing_error = stage_file(&path, "missing.txt").unwrap_err();
        assert!(
            missing_error.contains("File no longer exists"),
            "{missing_error}"
        );

        let directory_error = stage_file(&path, "subdir").unwrap_err();
        assert!(
            directory_error.contains("Only individual files"),
            "{directory_error}"
        );

        for invalid in ["sub/../real.txt", absolute_fixture_path(), ""] {
            let error = stage_file(&path, invalid).unwrap_err();
            assert!(
                error.contains("Invalid repository-relative file path"),
                "{invalid}: {error}"
            );
        }

        let _ = dir;
    }

    #[test]
    fn unstage_file_returns_modifications_to_the_worktree() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "original\n");
        stage_and_commit(&path, "file.txt", "add file");

        add_file(dir.path(), "file.txt", "changed\n");
        stage_file(&path, "file.txt").expect("stage modification");
        assert_change(&status(&path).unwrap(), "file.txt", "modified", true, false);

        unstage_file(&path, "file.txt").expect("unstage modification");
        assert_change(&status(&path).unwrap(), "file.txt", "modified", false, true);

        let _ = dir;
    }

    #[test]
    fn unstage_file_removes_staged_entries_without_head() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "new.txt", "hello\n");
        stage_file(&path, "new.txt").expect("stage new file");
        assert_change(&status(&path).unwrap(), "new.txt", "added", true, false);

        unstage_file(&path, "new.txt").expect("unstage new file");
        assert_change(&status(&path).unwrap(), "new.txt", "untracked", false, true);

        let _ = dir;
    }

    #[test]
    fn discard_restores_tracked_files_to_head_content() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "original\n");
        stage_and_commit(&path, "file.txt", "add file");

        add_file(dir.path(), "file.txt", "changed\n");
        discard_worktree_file(&path, "file.txt").expect("discard modification");

        let restored = fs::read_to_string(dir.path().join("file.txt")).unwrap();
        assert_eq!(restored, "original\n");
    }

    #[test]
    fn discard_removes_untracked_files() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "untracked.txt", "scratch\n");

        discard_worktree_file(&path, "untracked.txt").expect("discard untracked file");

        assert!(!dir.path().join("untracked.txt").exists());
        assert!(status(&path).expect("status").is_empty());
    }

    #[test]
    fn write_operations_reject_git_internal_paths() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "real.txt", "ok\n");
        stage_and_commit(&path, "real.txt", "add real");
        let head_before = fs::read_to_string(dir.path().join(".git/HEAD")).unwrap();

        for internal in [".git/HEAD", ".GIT/HEAD", ".git/config", ".git"] {
            let discard = discard_worktree_file(&path, internal).unwrap_err();
            assert!(discard.contains("Git metadata"), "{internal}: {discard}");
            let stage = stage_file(&path, internal).unwrap_err();
            assert!(stage.contains("Git metadata"), "{internal}: {stage}");
            let unstage = unstage_file(&path, internal).unwrap_err();
            assert!(unstage.contains("Git metadata"), "{internal}: {unstage}");
        }

        assert_eq!(
            fs::read_to_string(dir.path().join(".git/HEAD")).unwrap(),
            head_before
        );
        assert!(dir.path().join(".git/config").exists());
    }

    #[test]
    fn discard_keeps_ignored_files() {
        let (dir, path) = init_repo();
        add_file(dir.path(), ".gitignore", ".env\n");
        stage_and_commit(&path, ".gitignore", "ignore env");
        add_file(dir.path(), ".env", "SECRET=1\n");

        let error = discard_worktree_file(&path, ".env").unwrap_err();
        assert!(error.contains("untracked"), "{error}");
        assert_eq!(
            fs::read_to_string(dir.path().join(".env")).unwrap(),
            "SECRET=1\n"
        );
    }

    #[test]
    fn discard_restores_the_staged_version_of_a_file() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "v1\n");
        stage_and_commit(&path, "file.txt", "add v1");
        add_file(dir.path(), "file.txt", "v2\n");
        stage_file(&path, "file.txt").expect("stage v2");
        add_file(dir.path(), "file.txt", "v3\n");

        discard_worktree_file(&path, "file.txt").expect("discard worktree change");

        assert_eq!(
            fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "v2\n"
        );
        assert_change(&status(&path).unwrap(), "file.txt", "modified", true, false);
    }

    #[test]
    fn discard_ignores_missing_files_and_rejects_directories_and_bad_paths() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "real.txt", "ok\n");
        stage_and_commit(&path, "real.txt", "add real");
        fs::create_dir_all(dir.path().join("subdir")).expect("create fixture directory");

        discard_worktree_file(&path, "missing.txt").expect("missing file is a no-op");

        let directory_error = discard_worktree_file(&path, "subdir").unwrap_err();
        assert!(
            directory_error.contains("Only individual files can be discarded"),
            "{directory_error}"
        );

        for invalid in ["", "sub/../real.txt", absolute_fixture_path()] {
            let error = discard_worktree_file(&path, invalid).unwrap_err();
            assert!(
                error.contains("Invalid repository-relative file path"),
                "{invalid}: {error}"
            );
        }

        let _ = dir;
    }

    #[test]
    fn commit_staged_creates_history_with_message() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "content\n");

        let oid = stage_and_commit(&path, "file.txt", "test commit message");

        assert_eq!(oid.len(), 40);
        assert!(oid.chars().all(|character| character.is_ascii_hexdigit()));

        let commits = history(&path, 0, 10).expect("history");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].id, oid);
        assert_eq!(commits[0].message, "test commit message");
        assert_eq!(commits[0].author, "Yerminal Test");
        assert!(commits[0].parents.is_empty());

        assert!(dir.path().join(".git").exists());
    }

    #[test]
    fn commit_staged_rejects_empty_messages_and_missing_staged_changes() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "untracked.txt", "not staged\n");

        let empty_error = commit_staged(&path, "").unwrap_err();
        assert!(empty_error.contains("commit message"), "{empty_error}");

        let blank_error = commit_staged(&path, "   ").unwrap_err();
        assert!(blank_error.contains("commit message"), "{blank_error}");

        let no_change_error = commit_staged(&path, "nothing staged").unwrap_err();
        assert!(
            no_change_error.contains("There are no staged changes to commit"),
            "{no_change_error}"
        );

        let _ = dir;
    }

    #[test]
    fn diff_unstaged_shows_added_and_removed_lines() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\nthree\n");
        stage_and_commit(&path, "code.txt", "base commit");

        add_file(dir.path(), "code.txt", "one\nTWO\nthree\nplus\n");
        let patch = diff(&path, "code.txt", false).expect("unstaged diff");

        assert!(
            patch.contains("diff --git a/code.txt b/code.txt"),
            "{patch}"
        );
        assert!(patch.contains("@@"), "{patch}");
        assert!(patch.contains("TWO"), "new line missing:\n{patch}");
        assert!(patch.contains("two"), "old line missing:\n{patch}");
        assert!(patch.contains("plus"), "added line missing:\n{patch}");
        let _ = dir;
    }

    #[test]
    fn diff_staged_shows_the_same_patch_shape() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\nthree\n");
        stage_and_commit(&path, "code.txt", "base commit");

        add_file(dir.path(), "code.txt", "one\nTWO\nthree\nplus\n");
        stage_file(&path, "code.txt").expect("stage modification");
        let patch = diff(&path, "code.txt", true).expect("staged diff");

        assert!(
            patch.contains("diff --git a/code.txt b/code.txt"),
            "{patch}"
        );
        assert!(patch.contains("@@"), "{patch}");
        assert!(patch.contains("TWO"), "new line missing:\n{patch}");
        assert!(patch.contains("two"), "old line missing:\n{patch}");
        assert!(patch.contains("plus"), "added line missing:\n{patch}");
        let _ = dir;
    }

    const BRACKET_PATH: &str = "app/[id]/page.tsx";
    const GLOB_TWIN_PATH: &str = "app/i/page.tsx";

    fn commit_bracket_fixture() -> (tempfile::TempDir, String) {
        let (dir, path) = init_repo();
        add_file(dir.path(), BRACKET_PATH, "bracket v1\n");
        add_file(dir.path(), GLOB_TWIN_PATH, "twin v1\n");
        stage_file(&path, BRACKET_PATH).expect("stage bracket path");
        stage_file(&path, GLOB_TWIN_PATH).expect("stage twin path");
        commit_staged(&path, "add routes").expect("commit routes");
        (dir, path)
    }

    #[test]
    fn diff_treats_bracket_paths_literally() {
        let (dir, path) = commit_bracket_fixture();
        add_file(dir.path(), BRACKET_PATH, "bracket v2\n");
        add_file(dir.path(), GLOB_TWIN_PATH, "twin v2\n");

        let unstaged = diff(&path, BRACKET_PATH, false).expect("unstaged diff");
        assert!(unstaged.contains("bracket v2"), "{unstaged}");
        assert!(!unstaged.contains("twin"), "{unstaged}");

        stage_file(&path, BRACKET_PATH).expect("stage bracket path");
        stage_file(&path, GLOB_TWIN_PATH).expect("stage twin path");
        let staged = diff(&path, BRACKET_PATH, true).expect("staged diff");
        assert!(staged.contains("bracket v2"), "{staged}");
        assert!(!staged.contains("twin"), "{staged}");
    }

    #[test]
    fn discard_and_unstage_treat_bracket_paths_literally() {
        let (dir, path) = commit_bracket_fixture();
        add_file(dir.path(), BRACKET_PATH, "bracket v2\n");
        add_file(dir.path(), GLOB_TWIN_PATH, "twin v2\n");

        discard_worktree_file(&path, BRACKET_PATH).expect("discard bracket path");
        assert_eq!(
            fs::read_to_string(dir.path().join(BRACKET_PATH)).unwrap(),
            "bracket v1\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(GLOB_TWIN_PATH)).unwrap(),
            "twin v2\n"
        );

        add_file(dir.path(), BRACKET_PATH, "bracket v3\n");
        stage_file(&path, BRACKET_PATH).expect("stage bracket path");
        stage_file(&path, GLOB_TWIN_PATH).expect("stage twin path");
        unstage_file(&path, BRACKET_PATH).expect("unstage bracket path");
        let changes = status(&path).unwrap();
        assert_change(&changes, BRACKET_PATH, "modified", false, true);
        assert_change(&changes, GLOB_TWIN_PATH, "modified", true, false);
    }

    #[test]
    fn unstage_file_reverts_staged_deletions_and_additions_with_head() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "kept.txt", "kept\n");
        stage_and_commit(&path, "kept.txt", "add kept");

        fs::remove_file(dir.path().join("kept.txt")).expect("delete fixture file");
        stage_file(&path, "kept.txt").expect("stage deletion");
        add_file(dir.path(), "new.txt", "new\n");
        stage_file(&path, "new.txt").expect("stage addition");

        unstage_file(&path, "kept.txt").expect("unstage deletion");
        unstage_file(&path, "new.txt").expect("unstage addition");

        let changes = status(&path).unwrap();
        assert_change(&changes, "kept.txt", "deleted", false, true);
        assert_change(&changes, "new.txt", "untracked", false, true);
        assert!(diff(&path, "kept.txt", true).unwrap().is_empty());
    }

    #[test]
    fn commit_file_diff_treats_bracket_paths_literally() {
        let (dir, path) = commit_bracket_fixture();
        add_file(dir.path(), BRACKET_PATH, "bracket v2\n");
        add_file(dir.path(), GLOB_TWIN_PATH, "twin v2\n");
        stage_file(&path, BRACKET_PATH).expect("stage bracket path");
        stage_file(&path, GLOB_TWIN_PATH).expect("stage twin path");
        let commit_id = commit_staged(&path, "edit routes").expect("commit");

        let patch = commit_file_diff(&path, &commit_id, BRACKET_PATH).expect("commit diff");
        assert!(patch.contains("bracket v2"), "{patch}");
        assert!(!patch.contains("twin"), "{patch}");
    }

    #[test]
    fn diff_rejects_invalid_file_paths() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\n");
        stage_and_commit(&path, "code.txt", "base commit");

        for invalid in ["", "code/../code.txt", absolute_fixture_path()] {
            for staged in [false, true] {
                let error = diff(&path, invalid, staged).unwrap_err();
                assert!(
                    error.contains("Invalid repository-relative file path"),
                    "staged={staged} {invalid}: {error}"
                );
            }
        }

        let _ = dir;
    }

    #[test]
    fn history_paginates_clamps_and_labels_branches() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a\n");
        let first = stage_and_commit(&path, "a.txt", "first commit");
        add_file(dir.path(), "b.txt", "b\n");
        let second = stage_and_commit(&path, "b.txt", "second commit");
        add_file(dir.path(), "c.txt", "c\n");
        let _third = stage_and_commit(&path, "c.txt", "third commit");

        let commits = history(&path, 0, 2).expect("history page");
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].message, "third commit");
        assert_eq!(commits[1].message, "second commit");
        assert_eq!(commits[1].id, second);
        assert_eq!(commits[1].parents, vec![first.clone()]);
        assert_eq!(commits[1].short_id, second[..8]);
        assert_eq!(commits[0].parents, vec![second.clone()]);

        let branch = repository_info(&path).expect("repository info").branch;
        assert_eq!(commits[0].branches, vec![branch]);
        assert!(commits[1].branches.is_empty());

        let skipped = history(&path, 2, 10).expect("skipped history");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].message, "first commit");
        assert!(skipped[0].parents.is_empty());

        assert_eq!(history(&path, 0, 0).expect("clamped low").len(), 1);
        assert_eq!(history(&path, 0, 1000).expect("clamped high").len(), 3);

        let _ = dir;
    }

    #[test]
    fn history_requires_commits() {
        let (_dir, path) = init_repo();
        let error = history(&path, 0, 10).unwrap_err();
        assert!(error.contains("HEAD"), "{error}");
    }

    #[test]
    fn commit_files_maps_kinds_and_sorts_paths() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "beta.txt", "old\n");
        add_file(dir.path(), "gamma.txt", "same\n");
        stage_and_commit(&path, "beta.txt", "add beta");
        stage_and_commit(&path, "gamma.txt", "add gamma");

        add_file(dir.path(), "alpha.txt", "new\n");
        fs::remove_file(dir.path().join("beta.txt")).expect("delete fixture file");
        add_file(dir.path(), "gamma.txt", "changed\n");
        stage_file(&path, "alpha.txt").expect("stage addition");
        stage_file(&path, "beta.txt").expect("stage deletion");
        stage_file(&path, "gamma.txt").expect("stage modification");
        let commit_id = commit_staged(&path, "mixed changes").expect("commit");

        let files = commit_files(&path, &commit_id).expect("commit files");
        let pairs: Vec<(String, String)> = files
            .iter()
            .map(|file| (file.path.clone(), file.kind.clone()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("alpha.txt".to_owned(), "added".to_owned()),
                ("beta.txt".to_owned(), "deleted".to_owned()),
                ("gamma.txt".to_owned(), "modified".to_owned()),
            ]
        );

        let _ = dir;
    }

    #[test]
    fn commit_files_rejects_invalid_commit_ids() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a\n");
        stage_and_commit(&path, "a.txt", "initial");

        let malformed = commit_files(&path, "not-a-hash").unwrap_err();
        assert!(malformed.contains("Invalid commit ID"), "{malformed}");

        let unknown = commit_files(&path, &"0".repeat(40)).unwrap_err();
        assert!(unknown.contains("Could not read commit"), "{unknown}");

        let _ = dir;
    }

    #[test]
    fn commit_file_diff_returns_a_patch_for_the_changed_file() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\n");
        stage_and_commit(&path, "code.txt", "base commit");

        add_file(dir.path(), "code.txt", "one\nTWO\n");
        stage_file(&path, "code.txt").expect("stage modification");
        let commit_id = commit_staged(&path, "edit code").expect("commit");

        let patch = commit_file_diff(&path, &commit_id, "code.txt").expect("commit file diff");

        assert!(
            patch.contains("diff --git a/code.txt b/code.txt"),
            "{patch}"
        );
        assert!(patch.contains("@@"), "{patch}");
        assert!(patch.contains("TWO"), "new line missing:\n{patch}");
        assert!(patch.contains("two"), "old line missing:\n{patch}");

        let _ = dir;
    }

    #[test]
    fn commit_file_diff_rejects_invalid_paths_and_commits() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\n");
        stage_and_commit(&path, "code.txt", "base commit");

        for invalid in ["", "x/../code.txt", absolute_fixture_path()] {
            let error = commit_file_diff(&path, "aaaaaaaa", invalid).unwrap_err();
            assert!(
                error.contains("Invalid repository-relative file path"),
                "{invalid}: {error}"
            );
        }

        let malformed = commit_file_diff(&path, "zzz", "code.txt").unwrap_err();
        assert!(malformed.contains("Invalid commit ID"), "{malformed}");

        let _ = dir;
    }

    #[test]
    fn commit_file_content_reads_files_added_in_the_commit() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "hello.txt", "hello world\n");

        let commit_id = stage_and_commit(&path, "hello.txt", "add hello");
        let content = commit_file_content(&path, &commit_id, "hello.txt").expect("commit content");

        assert_eq!(content.content, "hello world\n");
        let short_id = &commit_id[..8];
        assert_eq!(content.source_label, format!("Commit {short_id} snapshot"));

        let _ = dir;
    }

    #[test]
    fn commit_file_content_falls_back_to_parent_for_deleted_files() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "gone.txt", "kept from parent\n");
        stage_and_commit(&path, "gone.txt", "add gone");

        fs::remove_file(dir.path().join("gone.txt")).expect("delete fixture file");
        stage_file(&path, "gone.txt").expect("stage deletion");
        let commit_id = commit_staged(&path, "delete gone").expect("commit");

        let content = commit_file_content(&path, &commit_id, "gone.txt").expect("parent content");
        assert_eq!(content.content, "kept from parent\n");
        assert!(
            content.source_label.contains("deleted in commit"),
            "{content:?}"
        );

        let missing = commit_file_content(&path, &commit_id, "never.txt").unwrap_err();
        assert!(
            missing.contains("does not exist in this commit or its parent"),
            "{missing}"
        );

        let _ = dir;
    }

    #[test]
    fn commit_file_content_rejects_binary_non_utf8_and_large_blobs() {
        let (dir, path) = init_repo();
        add_bytes(dir.path(), "binary.txt", b"text\0more");
        add_bytes(dir.path(), "not_utf8.txt", &[b'x', 0xC3, 0x28, b'y']);
        add_bytes(
            dir.path(),
            "big.txt",
            "a".repeat(crate::workspace_fs::MAX_PREVIEW_BYTES as usize + 1)
                .as_bytes(),
        );
        stage_file(&path, "binary.txt").expect("stage binary");
        stage_file(&path, "not_utf8.txt").expect("stage non-utf8");
        stage_file(&path, "big.txt").expect("stage big");
        let commit_id = commit_staged(&path, "add asset files").expect("commit");

        let binary = commit_file_content(&path, &commit_id, "binary.txt").unwrap_err();
        assert!(binary.contains("Binary file preview"), "{binary}");

        let non_utf8 = commit_file_content(&path, &commit_id, "not_utf8.txt").unwrap_err();
        assert!(non_utf8.contains("not valid UTF-8"), "{non_utf8}");

        let large = commit_file_content(&path, &commit_id, "big.txt").unwrap_err();
        assert!(large.contains("too large to preview"), "{large}");

        let _ = dir;
    }

    #[test]
    fn commit_file_content_rejects_invalid_paths() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\n");
        stage_and_commit(&path, "code.txt", "base commit");

        for invalid in ["", "a/../code.txt", absolute_fixture_path()] {
            let error = commit_file_content(&path, "aaaaaaaa", invalid).unwrap_err();
            assert!(
                error.contains("Invalid repository-relative file path"),
                "{invalid}: {error}"
            );
        }

        let _ = dir;
    }
}

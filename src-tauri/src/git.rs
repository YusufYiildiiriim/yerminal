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

pub(crate) fn open_repository(path: &str) -> Result<Repository, String> {
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
        let conflicted = status.contains(Status::CONFLICTED);
        let kind = if conflicted {
            "conflicted"
        } else if status.contains(Status::WT_NEW) && !staged {
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
            staged: staged && !conflicted,
            unstaged: unstaged && !conflicted,
        });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

/// libgit2 hands each patch line without its marker; put back "+", "-" or " " so the
/// patch text matches `git diff` and context lines are not read as changes.
fn push_patch_line(output: &mut String, line: &git2::DiffLine<'_>) {
    let origin = line.origin();
    if matches!(origin, '+' | '-' | ' ') {
        output.push(origin);
    }
    output.push_str(&String::from_utf8_lossy(line.content()));
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
        push_patch_line(&mut output, &line);
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
    if components
        .iter()
        .any(|component| is_git_directory_alias(&component.as_os_str().to_string_lossy()))
    {
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

/// True for names Windows resolves to the `.git` directory: any case, with
/// trailing dots/spaces (`.git.`, `.git `) stripped by Win32, or the 8.3
/// short name `GIT~1`, including NTFS stream forms (`.git::$INDEX_ALLOCATION`,
/// `.git:x`) where everything from the first `:` names a stream of the same
/// directory. Git's own `core.protectNTFS` rejects the same names on every
/// platform, so they are refused everywhere.
fn is_git_directory_alias(name: &str) -> bool {
    let base = name.split(':').next().unwrap_or(name);
    let trimmed = base.trim_end_matches(['.', ' ']);
    trimmed.eq_ignore_ascii_case(".git") || trimmed.eq_ignore_ascii_case("git~1")
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
                Ok(entry) if entry.kind() == Some(git2::ObjectType::Blob) => {
                    Some((entry.id(), entry.filemode()))
                }
                Ok(_) => return Err("Only individual files can be unstaged".to_owned()),
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
            // The index stores the low 32 bits of the size, as git does
            // (`sd_size = (unsigned int)st_size`); the zeroed stat data makes
            // the next status re-hash the file either way.
            let file_size = repo
                .find_blob(id)
                .map(|blob| (blob.size() as u64 & u64::from(u32::MAX)) as u32)
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
    let mut repo = open_repository(path)?;
    // A merge in progress is concluded by a commit with the merged branch as an extra parent.
    let merging = repo.state() == RepositoryState::Merge;
    let mut merge_heads = Vec::new();
    if merging {
        repo.mergehead_foreach(|oid| {
            merge_heads.push(*oid);
            true
        })
        .map_err(|error| format!("Could not read merge heads: {error}"))?;
    }
    if repo.state() != RepositoryState::Clean && !merging {
        return Err("Finish the current Git operation before committing".to_owned());
    }
    if !merging && !status(path)?.iter().any(|change| change.staged) {
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
    if !merging
        && parent
            .as_ref()
            .and_then(|commit| commit.tree().ok())
            .is_some_and(|parent_tree| parent_tree.id() == tree_id)
    {
        return Err("There are no staged changes to commit".to_owned());
    }
    let signature = repo.signature().map_err(|error| {
        format!("Configure user.name and user.email before committing: {error}")
    })?;
    let mut parents: Vec<_> = parent.iter().cloned().collect();
    for oid in merge_heads {
        parents.push(
            repo.find_commit(oid)
                .map_err(|error| format!("Could not read merged commit: {error}"))?,
        );
    }
    let parents: Vec<&git2::Commit<'_>> = parents.iter().collect();
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
    if merging {
        repo.cleanup_state()
            .map_err(|error| format!("Could not finish the merge: {error}"))?;
    }
    Ok(oid.to_string())
}

pub fn history(path: &str, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open_repository(path)?;
    let mut walk = repo
        .revwalk()
        .map_err(|error| format!("Could not open commit history: {error}"))?;
    walk.push_head()
        .map_err(|error| format!("Could not read repository HEAD: {error}"))?;
    collect_history(&repo, walk, skip, limit)
}

/// History reachable from one local or remote-tracking branch (e.g. "main", "origin/main").
pub fn branch_history(path: &str, branch: &str, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open_repository(path)?;
    let found = repo
        .find_branch(branch, BranchType::Local)
        .or_else(|_| repo.find_branch(branch, BranchType::Remote))
        .map_err(|_| format!("Branch not found: {branch}"))?;
    let target = found
        .get()
        .peel_to_commit()
        .map_err(|error| format!("Could not read branch {branch}: {error}"))?
        .id();
    let mut walk = repo
        .revwalk()
        .map_err(|error| format!("Could not open commit history: {error}"))?;
    walk.push(target)
        .map_err(|error| format!("Could not read branch {branch}: {error}"))?;
    collect_history(&repo, walk, skip, limit)
}

/// Commits the checked-out branch has that its upstream does not (`git log @{u}..HEAD`), newest first.
/// Empty when HEAD is detached or unborn, has no upstream, or is not ahead.
pub fn outgoing_commits(path: &str) -> Result<Vec<CommitInfo>, String> {
    const OUTGOING_LIMIT: usize = 100;
    let repo = open_repository(path)?;
    let Ok(head) = repo.head() else { return Ok(Vec::new()) };
    if !head.is_branch() {
        return Ok(Vec::new());
    }
    let local = git2::Branch::wrap(head);
    let Ok(upstream) = local.upstream() else { return Ok(Vec::new()) };
    let (Some(local_target), Some(upstream_target)) = (local.get().target(), upstream.get().target()) else {
        return Ok(Vec::new());
    };
    let mut walk = repo
        .revwalk()
        .map_err(|error| format!("Could not open commit history: {error}"))?;
    walk.push(local_target)
        .map_err(|error| format!("Could not read branch history: {error}"))?;
    walk.hide(upstream_target)
        .map_err(|error| format!("Could not compare with upstream: {error}"))?;
    collect_history(&repo, walk, 0, OUTGOING_LIMIT)
}

fn collect_history(repo: &Repository, mut walk: git2::Revwalk, skip: usize, limit: usize) -> Result<Vec<CommitInfo>, String> {
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|error| format!("Could not sort commit history: {error}"))?;
    let branches = branch_labels(repo);
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
        push_patch_line(&mut output, &line);
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
    if let Ok(branches) = repo.branches(None) {
        for branch in branches.flatten() {
            let (branch, _) = branch;
            let Some(name) = branch.name().ok().flatten() else {
                continue;
            };
            if name.ends_with("/HEAD") {
                continue;
            }
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

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    pub upstream: Option<String>,
}

/// Local branches first, then remote-tracking branches, each sorted by name.
/// Local branches with an upstream report ahead/behind counts against it.
pub fn branches(path: &str) -> Result<Vec<BranchInfo>, String> {
    let repo = open_repository(path)?;
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let listed = repo
        .branches(None)
        .map_err(|error| format!("Could not list branches: {error}"))?;
    for entry in listed {
        let (branch, branch_type) = entry.map_err(|error| format!("Could not read branch: {error}"))?;
        let Some(name) = branch.name().ok().flatten().map(str::to_owned) else {
            continue;
        };
        match branch_type {
            BranchType::Local => {
                let is_head = branch.is_head();
                let (ahead, behind) = match (branch.get().target(), branch.upstream().ok()) {
                    (Some(local_oid), Some(upstream)) => match upstream.get().target() {
                        Some(upstream_oid) => repo
                            .graph_ahead_behind(local_oid, upstream_oid)
                            .map(|(ahead, behind)| (Some(ahead), Some(behind)))
                            .unwrap_or((None, None)),
                        None => (None, None),
                    },
                    _ => (None, None),
                };
                let upstream = branch.upstream().ok().and_then(|upstream| upstream.name().ok().flatten().map(str::to_owned));
                local.push(BranchInfo { name, is_remote: false, is_head, ahead, behind, upstream });
            }
            BranchType::Remote => {
                if name.ends_with("/HEAD") {
                    continue;
                }
                remote.push(BranchInfo { name, is_remote: true, is_head: false, ahead: None, behind: None, upstream: None });
            }
        }
    }
    local.sort_by(|a, b| a.name.cmp(&b.name));
    remote.sort_by(|a, b| a.name.cmp(&b.name));
    local.extend(remote);
    Ok(local)
}


fn validate_branch_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Branch name cannot be empty".to_owned());
    }
    if trimmed != name || name.starts_with('-') || !git2::Branch::name_is_valid(name).unwrap_or(false) {
        return Err(format!("'{name}' is not a valid branch name"));
    }
    Ok(())
}

fn require_clean_state(repo: &Repository, action: &str) -> Result<(), String> {
    if repo.state() == RepositoryState::Clean {
        Ok(())
    } else {
        Err(format!("Finish the operation in progress before {action}"))
    }
}

fn checkout_commit_tree(repo: &Repository, commit: &git2::Commit<'_>) -> Result<(), String> {
    let mut options = git2::build::CheckoutBuilder::new();
    options.safe();
    repo.checkout_tree(commit.as_object(), Some(&mut options)).map_err(|error| {
        if error.code() == git2::ErrorCode::Conflict {
            "Your local changes would be overwritten. Commit or stash them first".to_owned()
        } else {
            format!("Could not check out: {error}")
        }
    })
}

/// Switches to a local branch. A remote-tracking name such as `origin/feature` creates (or reuses)
/// the matching local branch. The checkout is "safe": it refuses instead of overwriting local changes.
pub fn checkout_branch(path: &str, name: &str) -> Result<RepositoryInfo, String> {
    let repo = open_repository(path)?;
    require_clean_state(&repo, "switching branches")?;
    let local_name = if repo.find_branch(name, BranchType::Local).is_ok() {
        name.to_owned()
    } else {
        let remote = repo
            .find_branch(name, BranchType::Remote)
            .map_err(|_| format!("Branch '{name}' was not found"))?;
        let short = name.split_once('/').map(|(_, rest)| rest).unwrap_or(name).to_owned();
        if repo.find_branch(&short, BranchType::Local).is_err() {
            let commit = remote
                .get()
                .peel_to_commit()
                .map_err(|error| format!("Could not read '{name}': {error}"))?;
            let mut created = repo
                .branch(&short, &commit, false)
                .map_err(|error| format!("Could not create '{short}': {error}"))?;
            created.set_upstream(Some(name)).ok();
        }
        short
    };
    let branch = repo
        .find_branch(&local_name, BranchType::Local)
        .map_err(|error| format!("Could not find '{local_name}': {error}"))?;
    let reference_name = branch
        .get()
        .name()
        .ok_or_else(|| "Branch name is not valid UTF-8".to_owned())?
        .to_owned();
    let commit = branch
        .get()
        .peel_to_commit()
        .map_err(|error| format!("Could not read '{local_name}': {error}"))?;
    checkout_commit_tree(&repo, &commit)?;
    repo.set_head(&reference_name)
        .map_err(|error| format!("Could not move HEAD: {error}"))?;
    repository_info(path)
}

/// Creates a branch from `from` (a branch name or commit id; HEAD when absent), optionally checking it out.
pub fn create_branch(path: &str, name: &str, from: Option<&str>, checkout: bool) -> Result<RepositoryInfo, String> {
    validate_branch_name(name)?;
    let repo = open_repository(path)?;
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(format!("Branch '{name}' already exists"));
    }
    let commit = match from.map(str::trim).filter(|value| !value.is_empty()) {
        Some(revision) => repo
            .revparse_single(revision)
            .and_then(|object| object.peel_to_commit())
            .map_err(|_| format!("Could not find '{revision}'"))?,
        None => repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(|_| "Make a first commit before creating branches".to_owned())?,
    };
    repo.branch(name, &commit, false)
        .map_err(|error| format!("Could not create '{name}': {error}"))?;
    if checkout {
        return checkout_branch(path, name);
    }
    repository_info(path)
}

/// Deletes a local branch. The checked-out branch is never deleted; an unmerged branch needs `force`.
pub fn delete_branch(path: &str, name: &str, force: bool) -> Result<(), String> {
    let repo = open_repository(path)?;
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|_| format!("Local branch '{name}' was not found"))?;
    if branch.is_head() {
        return Err("Cannot delete the checked-out branch".to_owned());
    }
    if !force {
        let tip = branch.get().target();
        let head = repo.head().ok().and_then(|head| head.target());
        let merged = match (tip, head) {
            (Some(tip), Some(head)) => tip == head || repo.graph_descendant_of(head, tip).unwrap_or(false),
            _ => false,
        };
        if !merged {
            return Err(format!("Branch '{name}' is not fully merged"));
        }
    }
    branch
        .delete()
        .map_err(|error| format!("Could not delete '{name}': {error}"))
}

pub fn rename_branch(path: &str, old_name: &str, new_name: &str) -> Result<(), String> {
    validate_branch_name(new_name)?;
    let repo = open_repository(path)?;
    let mut branch = repo
        .find_branch(old_name, BranchType::Local)
        .map_err(|_| format!("Local branch '{old_name}' was not found"))?;
    branch
        .rename(new_name, false)
        .map(|_| ())
        .map_err(|error| format!("Could not rename '{old_name}': {error}"))
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// "upToDate", "fastForward", "merged" or "conflicts".
    pub result: String,
    pub conflicts: Vec<String>,
}

fn conflicted_paths(repo: &Repository) -> Result<Vec<String>, String> {
    let index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;
    let mut paths = Vec::new();
    let conflicts = index
        .conflicts()
        .map_err(|error| format!("Could not read conflicts: {error}"))?;
    for conflict in conflicts {
        let conflict = conflict.map_err(|error| format!("Could not read conflict: {error}"))?;
        let entry = conflict.our.or(conflict.their).or(conflict.ancestor);
        if let Some(entry) = entry {
            paths.push(String::from_utf8_lossy(&entry.path).replace('\\', "/"));
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn finish_merge_commit(repo: &mut Repository, fallback_message: &str) -> Result<(), String> {
    let mut merge_heads = Vec::new();
    repo.mergehead_foreach(|oid| {
        merge_heads.push(*oid);
        true
    })
    .map_err(|error| format!("Could not read merge heads: {error}"))?;
    let message = repo
        .message()
        .ok()
        .map(|message| message.trim().to_owned())
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| fallback_message.to_owned());
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;
    let tree_id = index
        .write_tree()
        .map_err(|error| format!("Could not write merged tree: {error}"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|error| format!("Could not read merged tree: {error}"))?;
    let signature = repo.signature().map_err(|error| {
        format!("Configure user.name and user.email before merging: {error}")
    })?;
    let head = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|error| format!("Could not read HEAD commit: {error}"))?;
    let mut parents = vec![head];
    for oid in merge_heads {
        parents.push(
            repo.find_commit(oid)
                .map_err(|error| format!("Could not read merged commit: {error}"))?,
        );
    }
    let parents: Vec<&git2::Commit<'_>> = parents.iter().collect();
    repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &parents)
        .map_err(|error| format!("Could not create merge commit: {error}"))?;
    repo.cleanup_state()
        .map_err(|error| format!("Could not finish the merge: {error}"))
}

/// Merges a local or remote-tracking branch into the checked-out branch. Fast-forwards when possible,
/// otherwise creates a merge commit. On conflicts the repository is left in the merge state so the
/// conflicts can be resolved (or the merge aborted).
pub fn merge_branch(path: &str, name: &str) -> Result<MergeOutcome, String> {
    let mut repo = open_repository(path)?;
    require_clean_state(&repo, "merging")?;
    if repo.head_detached().unwrap_or(false) {
        return Err("Switch to a branch before merging".to_owned());
    }
    if status(path)?.iter().any(|change| change.staged) {
        return Err("Commit or unstage your staged changes before merging".to_owned());
    }
    let branch = repo
        .find_branch(name, BranchType::Local)
        .or_else(|_| repo.find_branch(name, BranchType::Remote))
        .map_err(|_| format!("Branch '{name}' was not found"))?;
    let their_commit = branch
        .get()
        .peel_to_commit()
        .map_err(|error| format!("Could not read '{name}': {error}"))?;
    let annotated = repo
        .reference_to_annotated_commit(branch.get())
        .map_err(|error| format!("Could not prepare merge: {error}"))?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|error| format!("Could not analyse merge: {error}"))?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome { result: "upToDate".to_owned(), conflicts: Vec::new() });
    }
    if analysis.is_fast_forward() {
        checkout_commit_tree(&repo, &their_commit)?;
        repo.head()
            .and_then(|mut head| head.set_target(their_commit.id(), &format!("merge {name}: fast-forward")))
            .map_err(|error| format!("Could not fast-forward: {error}"))?;
        return Ok(MergeOutcome { result: "fastForward".to_owned(), conflicts: Vec::new() });
    }
    if !analysis.is_normal() {
        return Err(format!("Cannot merge '{name}' into this branch"));
    }

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe().allow_conflicts(true).conflict_style_merge(true);
    repo.merge(&[&annotated], None, Some(&mut checkout)).map_err(|error| {
        if error.code() == git2::ErrorCode::Conflict {
            "Your local changes would be overwritten. Commit or stash them first".to_owned()
        } else {
            format!("Could not merge '{name}': {error}")
        }
    })?;
    let conflicts = conflicted_paths(&repo)?;
    if !conflicts.is_empty() {
        return Ok(MergeOutcome { result: "conflicts".to_owned(), conflicts });
    }
    drop(annotated);
    drop(their_commit);
    drop(branch);
    finish_merge_commit(&mut repo, &format!("Merge branch '{name}'"))?;
    Ok(MergeOutcome { result: "merged".to_owned(), conflicts: Vec::new() })
}

/// Cancels a merge in progress and restores the checked-out branch to its pre-merge state.
pub fn merge_abort(path: &str) -> Result<(), String> {
    let repo = open_repository(path)?;
    if repo.state() != RepositoryState::Merge {
        return Err("There is no merge in progress".to_owned());
    }
    let head = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|error| format!("Could not read HEAD commit: {error}"))?;
    repo.reset(head.as_object(), git2::ResetType::Hard, None)
        .map_err(|error| format!("Could not restore the branch: {error}"))?;
    repo.cleanup_state()
        .map_err(|error| format!("Could not clear the merge state: {error}"))
}

/// The prepared merge message (`MERGE_MSG`) while a merge is in progress, otherwise empty.
pub fn merge_message(path: &str) -> Result<String, String> {
    let repo = open_repository(path)?;
    if repo.state() != RepositoryState::Merge {
        return Ok(String::new());
    }
    Ok(repo.message().unwrap_or_default().trim().to_owned())
}

/// Resolves one conflicted file. `ours` and `theirs` take that side's version (or its deletion);
/// `merged` accepts the file as edited and refuses while conflict markers remain.
pub fn resolve_conflict(path: &str, file_path: &str, side: &str) -> Result<(), String> {
    let repo = open_repository(path)?;
    let relative = validated_worktree_path(&repo, file_path)?;
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open Git index: {error}"))?;
    let wanted = relative.to_string_lossy().replace('\\', "/");
    let conflict = index
        .conflicts()
        .map_err(|error| format!("Could not read conflicts: {error}"))?
        .filter_map(Result::ok)
        .find(|conflict| {
            [&conflict.our, &conflict.their, &conflict.ancestor]
                .into_iter()
                .flatten()
                .any(|entry| String::from_utf8_lossy(&entry.path).replace('\\', "/") == wanted)
        })
        .ok_or_else(|| "This file has no merge conflict".to_owned())?;
    let worktree_file = repo
        .workdir()
        .ok_or_else(|| "Git worktree is unavailable".to_owned())?
        .join(&relative);

    match side {
        "ours" | "theirs" => {
            let entry = if side == "ours" { conflict.our } else { conflict.their };
            match entry {
                Some(entry) => {
                    let blob = repo
                        .find_blob(entry.id)
                        .map_err(|error| format!("Could not read the {side} version: {error}"))?;
                    fs::write(&worktree_file, blob.content())
                        .map_err(|error| format!("Could not write the file: {error}"))?;
                    index
                        .add_path(&relative)
                        .map_err(|error| format!("Could not stage the file: {error}"))?;
                }
                None => {
                    // That side deleted the file.
                    if worktree_file.exists() {
                        fs::remove_file(&worktree_file)
                            .map_err(|error| format!("Could not remove the file: {error}"))?;
                    }
                    index
                        .remove_path(&relative)
                        .map_err(|error| format!("Could not stage the deletion: {error}"))?;
                }
            }
        }
        "merged" => {
            if worktree_file.exists() {
                let text = fs::read(&worktree_file)
                    .map_err(|error| format!("Could not read the file: {error}"))?;
                let text = String::from_utf8_lossy(&text);
                if text.lines().any(|line| line.starts_with("<<<<<<< ") || line == "=======" || line.starts_with(">>>>>>> ")) {
                    return Err("Conflict markers are still in the file".to_owned());
                }
                index
                    .add_path(&relative)
                    .map_err(|error| format!("Could not stage the file: {error}"))?;
            } else {
                index
                    .remove_path(&relative)
                    .map_err(|error| format!("Could not stage the deletion: {error}"))?;
            }
        }
        other => return Err(format!("Unknown conflict resolution '{other}'")),
    }
    index
        .write()
        .map_err(|error| format!("Could not write Git index: {error}"))
}
/// Full text of both sides of one file's change, for the Monaco diff editor.
/// An absent side (new or deleted file) is an empty string.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffVersions {
    pub original: String,
    pub modified: String,
    pub binary: bool,
    pub too_large: bool,
}

enum Side {
    Absent,
    Text(String),
    Binary,
    TooLarge,
}

fn classify_bytes(bytes: &[u8]) -> Side {
    if bytes.len() as u64 > crate::workspace_fs::MAX_PREVIEW_BYTES {
        return Side::TooLarge;
    }
    if bytes.contains(&0) {
        return Side::Binary;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Side::Text(text.to_owned()),
        Err(_) => Side::Binary,
    }
}

fn blob_side(repo: &Repository, oid: Oid) -> Result<Side, String> {
    let blob = repo
        .find_blob(oid)
        .map_err(|error| format!("Could not read file content: {error}"))?;
    if blob.size() as u64 > crate::workspace_fs::MAX_PREVIEW_BYTES {
        return Ok(Side::TooLarge);
    }
    Ok(classify_bytes(blob.content()))
}

fn tree_side(repo: &Repository, tree: Option<&git2::Tree>, file_path: &str) -> Result<Side, String> {
    let Some(tree) = tree else {
        return Ok(Side::Absent);
    };
    match tree.get_path(Path::new(file_path)) {
        Ok(entry) if entry.kind() == Some(git2::ObjectType::Blob) => blob_side(repo, entry.id()),
        Ok(_) => Ok(Side::Binary),
        Err(_) => Ok(Side::Absent),
    }
}

fn index_side(repo: &Repository, file_path: &str) -> Result<Side, String> {
    let index = repo
        .index()
        .map_err(|error| format!("Could not read Git index: {error}"))?;
    match index.get_path(Path::new(file_path), 0) {
        Some(entry) => blob_side(repo, entry.id),
        None => Ok(Side::Absent),
    }
}

fn worktree_side(repo: &Repository, file_path: &str) -> Result<Side, String> {
    let relative = validated_worktree_path(repo, file_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Git worktree is unavailable".to_owned())?;
    let full = workdir.join(relative);
    // A symlink inside the worktree may point at any file on disk; never read through it.
    match fs::symlink_metadata(&full) {
        Ok(link) if link.file_type().is_symlink() => {
            return Err("Symbolic links cannot be previewed in Git Changes".to_owned());
        }
        Ok(_) => {}
        Err(_) => return Ok(Side::Absent),
    }
    let metadata = match fs::metadata(&full) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(Side::Absent),
    };
    if !metadata.is_file() {
        return Ok(Side::Binary);
    }
    if metadata.len() > crate::workspace_fs::MAX_PREVIEW_BYTES {
        return Ok(Side::TooLarge);
    }
    let bytes = fs::read(&full).map_err(|error| format!("Could not read file: {error}"))?;
    Ok(classify_bytes(&bytes))
}

fn versions_from_sides(original: Side, modified: Side) -> DiffVersions {
    let binary = matches!(original, Side::Binary) || matches!(modified, Side::Binary);
    let too_large = matches!(original, Side::TooLarge) || matches!(modified, Side::TooLarge);
    let text = |side: Side| match side {
        Side::Text(text) => text,
        _ => String::new(),
    };
    DiffVersions {
        original: text(original),
        modified: text(modified),
        binary,
        too_large,
    }
}

/// Unstaged compares the index with the worktree; staged compares HEAD with the index.
pub fn diff_versions(path: &str, file_path: &str, staged: bool) -> Result<DiffVersions, String> {
    if !is_repo_relative_path(file_path) {
        return Err("Invalid repository-relative file path".to_owned());
    }
    let repo = open_repository(path)?;
    let (original, modified) = if staged {
        let head = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        (
            tree_side(&repo, head.as_ref(), file_path)?,
            index_side(&repo, file_path)?,
        )
    } else {
        (index_side(&repo, file_path)?, worktree_side(&repo, file_path)?)
    };
    Ok(versions_from_sides(original, modified))
}

/// A commit's file compared with its first parent (an empty side for a root commit).
pub fn commit_file_versions(
    path: &str,
    commit_id: &str,
    file_path: &str,
) -> Result<DiffVersions, String> {
    if !is_repo_relative_path(file_path) {
        return Err("Invalid repository-relative file path".to_owned());
    }
    let repo = open_repository(path)?;
    let commit = find_commit(&repo, commit_id)?;
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
    Ok(versions_from_sides(
        tree_side(&repo, parent_tree.as_ref(), file_path)?,
        tree_side(&repo, Some(&commit_tree), file_path)?,
    ))
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

        // Resolve both through the file system: a temp dir can be reported with its 8.3 short
        // name (C:\Users\RUNNER~1\...) while libgit2 returns the long one (runneradmin).
        let resolve = |path: &Path| {
            path.canonicalize()
                .map(|resolved| resolved.to_string_lossy().into_owned())
                .unwrap_or_else(|_| path.to_string_lossy().into_owned())
        };
        let root = normalize_path_text(&resolve(Path::new(&info.root)));
        let expected_root = normalize_path_text(&resolve(dir.path()));
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
    fn git_directory_alias_detection_handles_ntfs_streams() {
        for alias in [
            ".git",
            ".git::$INDEX_ALLOCATION",
            ".GIT:x",
            ".git. :stream",
            "git~1:",
        ] {
            assert!(is_git_directory_alias(alias), "{alias}");
        }
        for name in [".github", "x.git", ".gitx:y", "git~2", ".gi:t"] {
            assert!(!is_git_directory_alias(name), "{name}");
        }
    }

    #[test]
    fn write_operations_reject_windows_aliases_of_the_git_directory() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "real.txt", "ok\n");
        stage_and_commit(&path, "real.txt", "add real");
        let head_before = fs::read_to_string(dir.path().join(".git/HEAD")).unwrap();

        for alias in [
            ".git./HEAD",
            ".git../HEAD",
            ".git /HEAD",
            ".GIT. ./HEAD",
            "GIT~1/HEAD",
            "git~1/config",
            "sub/.git./config",
            ".git::$INDEX_ALLOCATION/HEAD",
            ".git:x/HEAD",
            "GIT~1:stream/config",
        ] {
            let discard = discard_worktree_file(&path, alias).unwrap_err();
            assert!(discard.contains("Git metadata"), "{alias}: {discard}");
            let stage = stage_file(&path, alias).unwrap_err();
            assert!(stage.contains("Git metadata"), "{alias}: {stage}");
            let unstage = unstage_file(&path, alias).unwrap_err();
            assert!(unstage.contains("Git metadata"), "{alias}: {unstage}");
        }

        assert_eq!(
            fs::read_to_string(dir.path().join(".git/HEAD")).unwrap(),
            head_before
        );
        // Ordinary names that merely contain "git" stay usable.
        add_file(dir.path(), ".github/workflow.yml", "on: push\n");
        add_file(dir.path(), "git~2.txt", "tilde\n");
        stage_file(&path, ".github/workflow.yml").expect("stage .github file");
        stage_file(&path, "git~2.txt").expect("stage tilde file");
    }

    #[test]
    fn unstage_file_rejects_directories_in_head() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "dir/a.txt", "a\n");
        stage_and_commit(&path, "dir/a.txt", "add dir");

        let error = unstage_file(&path, "dir").unwrap_err();
        assert!(error.contains("Only individual files"), "{error}");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let index = repo.index().unwrap();
        assert!(index.get_path(Path::new("dir"), 0).is_none(), "tree added to index");
        assert!(index.get_path(Path::new("dir/a.txt"), 0).is_some());
        assert!(status(&path).unwrap().is_empty());
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
    fn outgoing_commits_lists_only_commits_ahead_of_the_upstream() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        let pushed = stage_and_commit(&path, "a.txt", "already pushed");
        add_file(dir.path(), "b.txt", "two\n");
        let first_local = stage_and_commit(&path, "b.txt", "local first");
        add_file(dir.path(), "c.txt", "three\n");
        let second_local = stage_and_commit(&path, "c.txt", "local second");

        // Without an upstream there is nothing to push against.
        assert!(outgoing_commits(&path).expect("outgoing without upstream").is_empty());

        let repo = git2::Repository::open(dir.path()).expect("open repository");
        let branch = repo.head().expect("head").shorthand().expect("branch name").to_owned();
        repo.remote("origin", "https://example.invalid/yerminal-test.git").expect("add remote");
        repo.reference(&format!("refs/remotes/origin/{branch}"), Oid::from_str(&pushed).expect("oid"), true, "test upstream")
            .expect("create remote-tracking ref");
        {
            let mut config = repo.config().expect("repository config");
            config.set_str(&format!("branch.{branch}.remote"), "origin").expect("set remote");
            config.set_str(&format!("branch.{branch}.merge"), &format!("refs/heads/{branch}")).expect("set merge");
        }

        let outgoing = outgoing_commits(&path).expect("outgoing commits");
        let ids: Vec<&str> = outgoing.iter().map(|commit| commit.id.as_str()).collect();
        assert_eq!(ids, vec![second_local.as_str(), first_local.as_str()]);
        assert_eq!(outgoing[0].message, "local second");
        assert_eq!(outgoing[0].author, "Yerminal Test");
    }

    #[test]
    fn outgoing_commits_is_empty_when_the_branch_is_in_sync() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        let head = stage_and_commit(&path, "a.txt", "shared");
        let repo = git2::Repository::open(dir.path()).expect("open repository");
        let branch = repo.head().expect("head").shorthand().expect("branch name").to_owned();
        repo.remote("origin", "https://example.invalid/yerminal-test.git").expect("add remote");
        repo.reference(&format!("refs/remotes/origin/{branch}"), Oid::from_str(&head).expect("oid"), true, "test upstream")
            .expect("create remote-tracking ref");
        {
            let mut config = repo.config().expect("repository config");
            config.set_str(&format!("branch.{branch}.remote"), "origin").expect("set remote");
            config.set_str(&format!("branch.{branch}.merge"), &format!("refs/heads/{branch}")).expect("set merge");
        }

        assert!(outgoing_commits(&path).expect("outgoing commits").is_empty());
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
    fn commit_staged_rejects_oversized_messages() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "content\n");
        stage_file(&path, "file.txt").expect("stage file");

        let error = commit_staged(&path, &"m".repeat(64 * 1024 + 1)).unwrap_err();
        assert!(error.contains("at most 64 KiB"), "{error}");
        // Surrounding whitespace does not count towards the limit.
        let padded = format!("  {}  \n", "m".repeat(64 * 1024));
        commit_staged(&path, &padded).expect("message at the limit");
    }

    #[test]
    fn commit_staged_trims_the_message() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "content\n");
        let oid = stage_and_commit(&path, "file.txt", "\n  subject line\n\nbody text  \n\n");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let commit = repo.find_commit(git2::Oid::from_str(&oid).unwrap()).unwrap();
        assert_eq!(commit.message(), Some("subject line\n\nbody text"));
    }

    #[test]
    fn commit_staged_rejects_commits_during_other_operations() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "one\n");
        let base = stage_and_commit(&path, "file.txt", "base");
        add_file(dir.path(), "file.txt", "two\n");
        stage_file(&path, "file.txt").expect("stage change");
        fs::write(dir.path().join(".git/CHERRY_PICK_HEAD"), format!("{base}\n"))
            .expect("simulate cherry-pick in progress");

        assert_eq!(
            repository_info(&path).unwrap().state,
            "cherry-pick in progress"
        );
        let error = commit_staged(&path, "during merge").unwrap_err();
        assert!(error.contains("Finish the current Git operation"), "{error}");
        assert_eq!(history(&path, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn commit_staged_rejects_when_nothing_is_staged_after_a_commit() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "file.txt", "one\n");
        stage_and_commit(&path, "file.txt", "base");

        let clean = commit_staged(&path, "nothing").unwrap_err();
        assert!(clean.contains("no staged changes"), "{clean}");

        add_file(dir.path(), "file.txt", "two\n");
        let unstaged_only = commit_staged(&path, "worktree only").unwrap_err();
        assert!(unstaged_only.contains("no staged changes"), "{unstaged_only}");
        assert_eq!(history(&path, 0, 10).unwrap().len(), 1);
    }

    #[test]
    fn diff_of_untracked_file_includes_its_content() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "base.txt", "base\n");
        stage_and_commit(&path, "base.txt", "base");
        add_file(dir.path(), "fresh.txt", "brand new line\n");

        let patch = diff(&path, "fresh.txt", false).expect("untracked diff");
        assert!(patch.contains("fresh.txt"), "{patch}");
        assert!(patch.contains("brand new line"), "{patch}");
        assert!(diff(&path, "fresh.txt", true).unwrap().is_empty());
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
    fn history_lists_every_branch_pointing_at_a_commit() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a\n");
        let oid = stage_and_commit(&path, "a.txt", "first commit");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let commit = repo.find_commit(git2::Oid::from_str(&oid).unwrap()).unwrap();
        repo.branch("feature/x", &commit, false).expect("create branch");

        let commits = history(&path, 0, 10).expect("history");
        let mut branches = commits[0].branches.clone();
        branches.sort();
        let mut expected = vec![
            repository_info(&path).unwrap().branch,
            "feature/x".to_owned(),
        ];
        expected.sort();
        assert_eq!(branches, expected);
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
    fn commit_files_reports_root_commit_files_as_added() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "b.txt", "b\n");
        add_file(dir.path(), "nested/a.txt", "a\n");
        stage_file(&path, "b.txt").expect("stage b");
        stage_file(&path, "nested/a.txt").expect("stage nested a");
        let commit_id = commit_staged(&path, "root").expect("root commit");

        let files = commit_files(&path, &commit_id).expect("commit files");
        let pairs: Vec<(&str, &str)> = files
            .iter()
            .map(|file| (file.path.as_str(), file.kind.as_str()))
            .collect();
        assert_eq!(pairs, vec![("b.txt", "added"), ("nested/a.txt", "added")]);
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
    fn patches_keep_line_markers_so_context_added_and_removed_lines_are_distinct() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "note.md", "---\ntitle: x\n---\n\n# Head\n");
        stage_and_commit(&path, "note.md", "base commit");

        add_file(dir.path(), "note.md", "---\ntitle: x\n---\ndddddd\n# Head\n");
        let expected = "\n ---\n-\n+dddddd\n # Head\n";
        let worktree = diff(&path, "note.md", false).expect("unstaged diff");
        assert!(worktree.contains(expected), "markers missing:\n{worktree}");

        stage_file(&path, "note.md").expect("stage modification");
        let commit_id = commit_staged(&path, "edit note").expect("commit");
        let committed = commit_file_diff(&path, &commit_id, "note.md").expect("commit file diff");
        assert!(committed.contains(expected), "markers missing:\n{committed}");
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

    #[test]
    fn branches_lists_local_then_remote_with_head_and_upstream_counts() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a\n");
        let first = stage_and_commit(&path, "a.txt", "first commit");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let commit = repo.find_commit(git2::Oid::from_str(&first).unwrap()).unwrap();
        repo.branch("zeta", &commit, false).expect("create zeta");
        repo.branch("alpha", &commit, false).expect("create alpha");
        repo.remote("origin", "https://example.invalid/repo.git").expect("add origin");
        repo.reference("refs/remotes/origin/alpha", commit.id(), true, "remote")
            .expect("create remote ref");
        repo.reference("refs/remotes/origin/beta", commit.id(), true, "remote")
            .expect("create remote ref");
        repo.find_branch("alpha", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/alpha"))
            .expect("set upstream");
        add_file(dir.path(), "b.txt", "b\n");
        stage_and_commit(&path, "b.txt", "second commit");
        let head_name = repository_info(&path).expect("info").branch;

        let branches = branches(&path).expect("branches");
        let summary: Vec<(String, bool, bool)> = branches
            .iter()
            .map(|b| (b.name.clone(), b.is_remote, b.is_head))
            .collect();
        let mut local = vec!["alpha".to_owned(), "zeta".to_owned(), head_name.clone()];
        local.sort();
        local.dedup();
        let mut expected: Vec<(String, bool, bool)> = local
            .iter()
            .map(|name| (name.clone(), false, *name == head_name))
            .collect();
        expected.push(("origin/alpha".to_owned(), true, false));
        expected.push(("origin/beta".to_owned(), true, false));
        assert_eq!(summary, expected);

        let alpha = branches.iter().find(|b| b.name == "alpha").unwrap();
        assert_eq!((alpha.ahead, alpha.behind), (Some(0), Some(0)));
        let zeta = branches.iter().find(|b| b.name == "zeta").unwrap();
        assert_eq!((zeta.ahead, zeta.behind), (None, None));
        let remote = branches.iter().find(|b| b.name == "origin/alpha").unwrap();
        assert_eq!((remote.ahead, remote.behind), (None, None));
        let _ = dir;
    }

    #[test]
    fn branches_reports_ahead_and_behind_against_upstream() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a\n");
        let first = stage_and_commit(&path, "a.txt", "first commit");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let base = repo.find_commit(git2::Oid::from_str(&first).unwrap()).unwrap();
        let tree = base.tree().unwrap();
        let signature = repo.signature().unwrap();
        repo.branch("tracked", &base, false).expect("create tracked");
        repo.remote("origin", "https://example.invalid/repo.git").expect("add origin");
        repo.reference("refs/remotes/origin/tracked", base.id(), true, "remote")
            .expect("create remote ref");
        repo.find_branch("tracked", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/tracked"))
            .expect("set upstream");
        // Local tracked gets one commit the remote lacks; the remote gets one the local lacks.
        repo.commit(Some("refs/heads/tracked"), &signature, &signature, "local only", &tree, &[&base])
            .expect("local commit");
        repo.commit(Some("refs/remotes/origin/tracked"), &signature, &signature, "remote only", &tree, &[&base])
            .expect("remote commit");

        let branches = branches(&path).expect("branches");
        let tracked = branches.iter().find(|b| b.name == "tracked").unwrap();
        assert_eq!((tracked.ahead, tracked.behind), (Some(1), Some(1)));
        assert!(!tracked.is_head);
        let _ = dir;
    }

    #[test]
    fn branch_history_walks_from_the_named_branch_only() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a
");
        let base = stage_and_commit(&path, "a.txt", "base commit");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let base_commit = repo.find_commit(git2::Oid::from_str(&base).unwrap()).unwrap();
        repo.branch("feature", &base_commit, false).expect("create feature");
        add_file(dir.path(), "b.txt", "b
");
        stage_and_commit(&path, "b.txt", "head only commit");

        let feature = branch_history(&path, "feature", 0, 10).expect("feature history");
        assert_eq!(feature.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), vec!["base commit"]);
        let head = history(&path, 0, 10).expect("head history");
        assert_eq!(head[0].message, "head only commit");
        assert!(branch_history(&path, "missing", 0, 10).is_err());
        let _ = dir;
    }

    #[test]
    fn history_labels_remote_tracking_branches_but_not_origin_head() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "a.txt", "a\n");
        let oid = stage_and_commit(&path, "a.txt", "first commit");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let commit = repo.find_commit(git2::Oid::from_str(&oid).unwrap()).unwrap();
        repo.remote("origin", "https://example.invalid/repo.git").expect("add origin");
        repo.reference("refs/remotes/origin/develop", commit.id(), true, "remote")
            .expect("create remote ref");
        repo.reference("refs/remotes/origin/HEAD", commit.id(), true, "remote")
            .expect("create origin HEAD ref");

        let commits = history(&path, 0, 10).expect("history");
        assert!(commits[0].branches.contains(&"origin/develop".to_owned()), "{:?}", commits[0].branches);
        assert!(!commits[0].branches.iter().any(|name| name.ends_with("/HEAD")), "{:?}", commits[0].branches);
        let _ = dir;
    }

    fn head_branch(root: &str) -> String {
        repository_info(root).expect("repository info").branch
    }

    #[test]
    fn create_branch_switches_to_it_and_rejects_bad_or_duplicate_names() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);

        let info = create_branch(&root, "feature/login", None, true).expect("create and checkout");
        assert_eq!(info.branch, "feature/login");
        assert!(create_branch(&root, "feature/login", None, false).unwrap_err().contains("already exists"));
        for bad in ["", "has space", "-lead", "a..b", "end.lock", "tilde~x"] {
            assert!(create_branch(&root, bad, None, false).is_err(), "{bad:?} should be rejected");
        }
        let kept = create_branch(&root, "side", Some(&base), false).expect("create without checkout");
        assert_eq!(kept.branch, "feature/login");
        let names: Vec<String> = branches(&root).unwrap().into_iter().map(|b| b.name).collect();
        assert!(names.contains(&"side".to_owned()) && names.contains(&base));
    }

    #[test]
    fn checkout_branch_moves_head_and_working_tree() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);
        create_branch(&root, "other", None, true).unwrap();
        add_file(dir.path(), "b.txt", "only on other\n");
        stage_and_commit(&root, "b.txt", "second");

        checkout_branch(&root, &base).expect("back to base");
        assert_eq!(head_branch(&root), base);
        assert!(!dir.path().join("b.txt").exists(), "files of the other branch are removed");
        checkout_branch(&root, "other").expect("to other");
        assert!(dir.path().join("b.txt").exists());
        assert!(checkout_branch(&root, "missing").unwrap_err().contains("not found"));
    }

    #[test]
    fn checkout_refuses_instead_of_overwriting_local_changes() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);
        create_branch(&root, "other", None, true).unwrap();
        add_file(dir.path(), "a.txt", "changed on other\n");
        stage_and_commit(&root, "a.txt", "second");
        checkout_branch(&root, &base).unwrap();
        add_file(dir.path(), "a.txt", "dirty edit\n");

        let error = checkout_branch(&root, "other").unwrap_err();
        assert!(error.contains("local changes"), "{error}");
        assert_eq!(head_branch(&root), base);
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "dirty edit\n");
    }

    #[test]
    fn checkout_of_a_remote_branch_creates_a_tracking_local_branch() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let head = repo.head().unwrap().target().unwrap();
        repo.remote("origin", "https://example.invalid/repo.git").unwrap();
        repo.reference("refs/remotes/origin/feature", head, true, "test remote").unwrap();
        drop(repo);

        let info = checkout_branch(&root, "origin/feature").expect("checkout remote branch");
        assert_eq!(info.branch, "feature");
        let listed = branches(&root).unwrap();
        let local = listed.iter().find(|b| !b.is_remote && b.name == "feature").expect("local feature branch");
        assert_eq!(local.upstream.as_deref(), Some("origin/feature"));
    }

    #[test]
    fn delete_branch_protects_the_checked_out_and_unmerged_branches() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);
        create_branch(&root, "merged", None, false).unwrap();
        create_branch(&root, "unmerged", None, true).unwrap();
        add_file(dir.path(), "b.txt", "extra\n");
        stage_and_commit(&root, "b.txt", "extra");
        checkout_branch(&root, &base).unwrap();

        assert!(delete_branch(&root, &base, true).unwrap_err().contains("checked-out"));
        delete_branch(&root, "merged", false).expect("merged branch deletes without force");
        assert!(delete_branch(&root, "unmerged", false).unwrap_err().contains("not fully merged"));
        delete_branch(&root, "unmerged", true).expect("force deletes the unmerged branch");
        let names: Vec<String> = branches(&root).unwrap().into_iter().map(|b| b.name).collect();
        assert_eq!(names, vec![base]);
    }

    #[test]
    fn rename_branch_validates_and_renames() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        create_branch(&root, "old", None, true).unwrap();

        assert!(rename_branch(&root, "old", "bad name").is_err());
        rename_branch(&root, "old", "renamed").expect("rename");
        assert_eq!(head_branch(&root), "renamed");
        assert!(rename_branch(&root, "old", "x").unwrap_err().contains("not found"));
    }

    fn parent_count(root: &str) -> usize {
        let repo = git2::Repository::open(root).unwrap();
        let count = repo.head().unwrap().peel_to_commit().unwrap().parent_count();
        count
    }

    /// base has a.txt; `other` and base each change it differently, leaving the repo on base.
    fn conflicting_branches() -> (tempfile::TempDir, String, String) {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "line\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);
        create_branch(&root, "other", None, true).unwrap();
        add_file(dir.path(), "a.txt", "from other\n");
        stage_and_commit(&root, "a.txt", "other change");
        checkout_branch(&root, &base).unwrap();
        add_file(dir.path(), "a.txt", "from base\n");
        stage_and_commit(&root, "a.txt", "base change");
        (dir, root, base)
    }

    #[test]
    fn merge_fast_forwards_and_reports_up_to_date() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);
        create_branch(&root, "feature", None, true).unwrap();
        add_file(dir.path(), "b.txt", "new\n");
        stage_and_commit(&root, "b.txt", "feature work");
        checkout_branch(&root, &base).unwrap();

        let outcome = merge_branch(&root, "feature").expect("merge");
        assert_eq!(outcome.result, "fastForward");
        assert!(dir.path().join("b.txt").exists());
        assert_eq!(parent_count(&root), 1);
        assert_eq!(merge_branch(&root, "feature").unwrap().result, "upToDate");
    }

    #[test]
    fn merge_of_independent_changes_creates_a_two_parent_commit() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        let base = head_branch(&root);
        create_branch(&root, "feature", None, true).unwrap();
        add_file(dir.path(), "feature.txt", "f\n");
        stage_and_commit(&root, "feature.txt", "feature work");
        checkout_branch(&root, &base).unwrap();
        add_file(dir.path(), "base.txt", "b\n");
        stage_and_commit(&root, "base.txt", "base work");

        let outcome = merge_branch(&root, "feature").expect("merge");
        assert_eq!(outcome.result, "merged");
        assert_eq!(parent_count(&root), 2);
        assert!(dir.path().join("feature.txt").exists() && dir.path().join("base.txt").exists());
        assert_eq!(repository_info(&root).unwrap().state, "clean");
        assert!(status(&root).unwrap().is_empty());
    }

    #[test]
    fn conflicting_merge_stops_in_the_merge_state_and_lists_the_conflicts() {
        let (dir, root, _base) = conflicting_branches();
        let outcome = merge_branch(&root, "other").expect("merge");
        assert_eq!(outcome.result, "conflicts");
        assert_eq!(outcome.conflicts, vec!["a.txt".to_owned()]);
        assert_ne!(repository_info(&root).unwrap().state, "clean");
        let changes = status(&root).unwrap();
        let conflicted = find_change(&changes, "a.txt");
        assert_eq!(conflicted.kind, "conflicted");
        assert!(!conflicted.staged && !conflicted.unstaged);
        let content = fs::read_to_string(dir.path().join("a.txt")).unwrap();
        assert!(content.contains("<<<<<<<") && content.contains(">>>>>>>"), "{content}");
        assert!(merge_message(&root).unwrap().contains("other"));
        assert!(commit_staged(&root, "too early").unwrap_err().contains("conflicts"));
    }

    #[test]
    fn resolving_with_ours_then_committing_concludes_the_merge() {
        let (dir, root, _base) = conflicting_branches();
        merge_branch(&root, "other").unwrap();
        resolve_conflict(&root, "a.txt", "ours").expect("take ours");
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "from base\n");
        assert!(status(&root).unwrap().iter().all(|change| change.kind != "conflicted"), "conflict marker is gone once resolved");
        assert_eq!(repository_info(&root).unwrap().state, "merge in progress");

        commit_staged(&root, "Merge branch 'other'").expect("merge commit");
        assert_eq!(parent_count(&root), 2);
        assert_eq!(repository_info(&root).unwrap().state, "clean");
        assert!(status(&root).unwrap().is_empty());
    }

    #[test]
    fn resolving_with_theirs_takes_the_other_side() {
        let (dir, root, _base) = conflicting_branches();
        merge_branch(&root, "other").unwrap();
        resolve_conflict(&root, "a.txt", "theirs").expect("take theirs");
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "from other\n");
    }

    #[test]
    fn marking_a_file_resolved_refuses_while_conflict_markers_remain() {
        let (dir, root, _base) = conflicting_branches();
        merge_branch(&root, "other").unwrap();
        assert!(resolve_conflict(&root, "a.txt", "merged").unwrap_err().contains("markers"));
        add_file(dir.path(), "a.txt", "hand merged\n");
        resolve_conflict(&root, "a.txt", "merged").expect("accept edited file");
        commit_staged(&root, "Merge branch 'other'").expect("merge commit");
        assert_eq!(parent_count(&root), 2);
        assert!(resolve_conflict(&root, "a.txt", "ours").unwrap_err().contains("no merge conflict"));
    }

    #[test]
    fn merge_abort_restores_the_branch_before_the_merge() {
        let (dir, root, _base) = conflicting_branches();
        merge_branch(&root, "other").unwrap();
        merge_abort(&root).expect("abort");
        assert_eq!(repository_info(&root).unwrap().state, "clean");
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "from base\n");
        assert!(status(&root).unwrap().is_empty());
        assert!(merge_abort(&root).unwrap_err().contains("no merge"));
    }

    #[test]
    fn merge_refuses_with_staged_changes_or_an_unknown_branch() {
        let (dir, root) = init_repo();
        add_file(dir.path(), "a.txt", "one\n");
        stage_and_commit(&root, "a.txt", "first");
        add_file(dir.path(), "b.txt", "staged\n");
        stage_file(&root, "b.txt").unwrap();
        assert!(merge_branch(&root, "main").unwrap_err().contains("staged"));
        unstage_file(&root, "b.txt").unwrap();
        assert!(merge_branch(&root, "missing").unwrap_err().contains("not found"));
    }

    #[test]
    fn unstaged_versions_pair_index_with_worktree() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\n");
        stage_and_commit(&path, "code.txt", "base");
        add_file(dir.path(), "code.txt", "one\nTWO\n");
        stage_file(&path, "code.txt").unwrap();
        add_file(dir.path(), "code.txt", "worktree only\n");

        let versions = diff_versions(&path, "code.txt", false).expect("unstaged versions");
        assert_eq!(versions.original, "one\nTWO\n");
        assert_eq!(versions.modified, "worktree only\n");
        assert!(!versions.binary && !versions.too_large);
    }

    #[test]
    fn staged_versions_pair_head_with_index() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "one\ntwo\n");
        stage_and_commit(&path, "code.txt", "base");
        add_file(dir.path(), "code.txt", "one\nTWO\n");
        stage_file(&path, "code.txt").unwrap();
        add_file(dir.path(), "code.txt", "worktree only\n");

        let versions = diff_versions(&path, "code.txt", true).expect("staged versions");
        assert_eq!(versions.original, "one\ntwo\n");
        assert_eq!(versions.modified, "one\nTWO\n");
    }

    #[test]
    fn new_and_deleted_files_leave_the_missing_side_empty() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "gone.txt", "bye\n");
        stage_and_commit(&path, "gone.txt", "base");
        fs::remove_file(dir.path().join("gone.txt")).unwrap();
        let deleted = diff_versions(&path, "gone.txt", false).expect("deleted versions");
        assert_eq!(deleted.original, "bye\n");
        assert_eq!(deleted.modified, "");

        add_file(dir.path(), "fresh.txt", "new\n");
        let added = diff_versions(&path, "fresh.txt", false).expect("added versions");
        assert_eq!(added.original, "");
        assert_eq!(added.modified, "new\n");
    }

    #[test]
    fn commit_versions_compare_the_commit_with_its_parent() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "code.txt", "first\n");
        let first = stage_and_commit(&path, "code.txt", "first");
        add_file(dir.path(), "code.txt", "second\n");
        let second = stage_and_commit(&path, "code.txt", "second");

        let changed = commit_file_versions(&path, &second, "code.txt").expect("commit versions");
        assert_eq!(changed.original, "first\n");
        assert_eq!(changed.modified, "second\n");
        let created = commit_file_versions(&path, &first, "code.txt").expect("root commit versions");
        assert_eq!(created.original, "");
        assert_eq!(created.modified, "first\n");
    }

    #[test]
    fn binary_versions_are_flagged_and_invalid_paths_rejected() {
        let (dir, path) = init_repo();
        add_bytes(dir.path(), "data.bin", &[0, 1, 2, 3]);
        stage_and_commit(&path, "data.bin", "binary");
        add_bytes(dir.path(), "data.bin", &[0, 9, 9]);
        let versions = diff_versions(&path, "data.bin", false).expect("binary versions");
        assert!(versions.binary);
        assert!(versions.original.is_empty() && versions.modified.is_empty());

        assert!(diff_versions(&path, "../escape.txt", false).is_err());
        assert!(commit_file_versions(&path, "zzz", "data.bin").is_err());
    }

    fn make_file_symlink(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link)
        }
    }

    #[test]
    fn unstaged_versions_refuse_symlinks_that_point_outside_the_repository() {
        let (dir, path) = init_repo();
        add_file(dir.path(), "link.txt", "placeholder\n");
        stage_and_commit(&path, "link.txt", "base");
        fs::remove_file(dir.path().join("link.txt")).unwrap();
        let outside = tempfile::tempdir().expect("outside directory");
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "outside secret\n").unwrap();
        if let Err(error) = make_file_symlink(&secret, &dir.path().join("link.txt")) {
            eprintln!("symlink test skipped: cannot create symlink here ({error})");
            return;
        }

        let error = diff_versions(&path, "link.txt", false).unwrap_err();
        assert!(error.contains("symbolic link"), "{error}");
        assert!(!error.contains("outside secret"));
    }
}

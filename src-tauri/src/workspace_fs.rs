use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

pub const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub extension: Option<String>,
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|error| format!("Cannot open workspace folder: {error}"))?;
    if !path.is_dir() {
        return Err("Workspace root is not a folder".to_owned());
    }
    Ok(path)
}

fn same_component(left: &Component<'_>, right: &Component<'_>) -> bool {
    let left = left.as_os_str().to_string_lossy();
    let right = right.as_os_str().to_string_lossy();
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn is_within_root(root: &Path, path: &Path) -> bool {
    let mut root_parts = root.components();
    let mut path_parts = path.components();
    loop {
        match (root_parts.next(), path_parts.next()) {
            (None, _) => return true,
            (Some(_), None) => return false,
            (Some(root_part), Some(path_part)) if same_component(&root_part, &path_part) => {}
            _ => return false,
        }
    }
}

fn canonical_scoped_path(root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(requested_path)
        .canonicalize()
        .map_err(|error| format!("Cannot access workspace item: {error}"))?;
    if !is_within_root(root, &candidate) {
        return Err("Workspace item is outside the included folder".to_owned());
    }
    Ok(candidate)
}

pub fn list_directory(root: &str, path: &str) -> Result<Vec<WorkspaceEntry>, String> {
    let root = canonical_root(root)?;
    let requested_path = if path.trim().is_empty() {
        root.to_string_lossy().into_owned()
    } else {
        path.to_owned()
    };
    let directory = canonical_scoped_path(&root, &requested_path)?;
    if !directory.is_dir() {
        return Err("Workspace item is not a folder".to_owned());
    }

    let iterator = fs::read_dir(&directory)
        .map_err(|error| format!("Cannot read workspace folder: {error}"))?;
    let mut entries = Vec::new();
    for item in iterator {
        let item = item.map_err(|error| format!("Cannot read workspace entry: {error}"))?;
        let entry_path = match item.path().canonicalize() {
            Ok(path) if is_within_root(&root, &path) => path,
            _ => continue,
        };
        let metadata = match fs::metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_dir() && !metadata.is_file() {
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        let extension = entry_path
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase());
        entries.push(WorkspaceEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            extension,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

fn ignored_search_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | ".next"
            | ".turbo"
            | ".venv"
            | "venv"
    )
}

pub fn search_files(root: &str, query: &str, requested_limit: usize) -> Result<Vec<WorkspaceEntry>, String> {
    const MAX_DEPTH: usize = 64;
    const MAX_DIRECTORIES: usize = 5_000;
    const MAX_ENTRIES: usize = 250_000;
    const MAX_RESULTS: usize = 100;

    let root = canonical_root(root)?;
    let query = query.trim().replace('\\', "/").to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = requested_limit.clamp(1, MAX_RESULTS);
    let mut pending = vec![(root.clone(), 0usize)];
    let mut visited_directories = HashSet::new();
    let mut candidates: Vec<(u8, String, WorkspaceEntry)> = Vec::new();
    let mut directories_seen = 0usize;
    let mut entries_seen = 0usize;

    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_DEPTH || directories_seen >= MAX_DIRECTORIES || entries_seen >= MAX_ENTRIES {
            break;
        }
        let directory_key = directory.to_string_lossy().to_lowercase();
        if !visited_directories.insert(directory_key) {
            continue;
        }
        directories_seen += 1;
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for item in entries.flatten() {
            entries_seen += 1;
            if entries_seen >= MAX_ENTRIES {
                break;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            let path = match item.path().canonicalize() {
                Ok(path) if is_within_root(&root, &path) => path,
                _ => continue,
            };
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                if depth < MAX_DEPTH && !ignored_search_directory(&name) {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }

            let name_lower = name.to_lowercase();
            let relative_path = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let path_lower = relative_path.to_lowercase();
            let score = if name_lower == query {
                0
            } else if name_lower.starts_with(&query) {
                1
            } else if name_lower.contains(&query) {
                2
            } else if path_lower.contains(&query) {
                3
            } else {
                continue;
            };
            let extension = path
                .extension()
                .map(|value| value.to_string_lossy().to_ascii_lowercase());
            candidates.push((score, path_lower, WorkspaceEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                size: Some(metadata.len()),
                extension,
            }));

            if candidates.len() >= limit.saturating_mul(8).max(256) {
                candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
                candidates.truncate(limit.saturating_mul(4));
            }
        }
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    candidates.truncate(limit);
    Ok(candidates.into_iter().map(|(_, _, entry)| entry).collect())
}

pub fn read_text_file(root: &str, path: &str) -> Result<String, String> {
    let root = canonical_root(root)?;
    let file = canonical_scoped_path(&root, path)?;
    let metadata = fs::metadata(&file).map_err(|error| format!("Cannot read file: {error}"))?;
    if !metadata.is_file() {
        return Err("Workspace item is not a file".to_owned());
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("File is too large to preview (maximum 1 MiB)".to_owned());
    }
    let bytes = fs::read(&file).map_err(|error| format!("Cannot read file: {error}"))?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("File is too large to preview (maximum 1 MiB)".to_owned());
    }
    if bytes.contains(&0) {
        return Err("Binary file preview is unavailable".to_owned());
    }
    String::from_utf8(bytes).map_err(|_| "This file is not valid UTF-8 text".to_owned())
}

pub fn write_text_file(
    root: &str,
    path: &str,
    content: &str,
    expected_content: &str,
) -> Result<(), String> {
    let bytes = content.as_bytes();
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("File is too large to save (maximum 1 MiB)".to_owned());
    }
    if bytes.contains(&0) {
        return Err("Binary file editing is unavailable".to_owned());
    }

    let root = canonical_root(root)?;
    let file_path = canonical_scoped_path(&root, path)?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&file_path)
        .map_err(|error| format!("Cannot open workspace file for saving: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Cannot inspect workspace file: {error}"))?;
    if !metadata.is_file() {
        return Err("Workspace item is not a file".to_owned());
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("File is too large to save (maximum 1 MiB)".to_owned());
    }

    let mut existing_bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut existing_bytes)
        .map_err(|error| format!("Cannot read current workspace file: {error}"))?;
    if existing_bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("File is too large to save (maximum 1 MiB)".to_owned());
    }
    if existing_bytes.contains(&0) {
        return Err("Binary file editing is unavailable".to_owned());
    }
    let existing_content = String::from_utf8(existing_bytes)
        .map_err(|_| "Workspace file is not valid UTF-8 text".to_owned())?;
    if existing_content != expected_content {
        return Err("File changed on disk since it was opened. Reopen it to review the latest contents before saving.".to_owned());
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Cannot position workspace file for saving: {error}"))?;
    file.set_len(0)
        .map_err(|error| format!("Cannot truncate workspace file: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Cannot save workspace file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Cannot flush workspace file: {error}"))
}

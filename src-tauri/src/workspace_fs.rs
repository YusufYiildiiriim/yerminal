use serde::Serialize;
use std::fs;
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
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
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
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

pub const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
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
    let candidate = match Path::new(requested_path).canonicalize() {
        Ok(path) => path,
        // A missing item is not an access failure: the explorer silently drops
        // entries reported with this marker instead of showing an error banner
        // ("Workspace item no longer exists"). Access failures such as
        // permission errors keep the generic message and the Retry button.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("Workspace item no longer exists: {error}"))
        }
        Err(error) => return Err(format!("Cannot access workspace item: {error}")),
    };
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

    let iterator = match fs::read_dir(&directory) {
        Ok(iterator) => iterator,
        // The folder vanished between canonicalization and read_dir.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("Workspace item no longer exists: {error}"))
        }
        Err(error) => return Err(format!("Cannot read workspace folder: {error}")),
    };
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

pub fn search_files(
    root: &str,
    query: &str,
    requested_limit: usize,
) -> Result<Vec<WorkspaceEntry>, String> {
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
            let relative_path = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
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
            candidates.push((
                score,
                path_lower,
                WorkspaceEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    is_dir: false,
                    size: Some(metadata.len()),
                    extension,
                },
            ));

            if candidates.len() >= limit.saturating_mul(8).max(256) {
                candidates
                    .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
                candidates.truncate(limit.saturating_mul(4));
            }
        }
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    candidates.truncate(limit);
    Ok(candidates.into_iter().map(|(_, _, entry)| entry).collect())
}

pub fn create_directory(root: &str, path: &str) -> Result<(), String> {
    let root = canonical_root(root)?;
    let candidate = Path::new(path);
    let name = candidate
        .file_name()
        .ok_or_else(|| "Invalid workspace folder name".to_owned())?
        .to_string_lossy()
        .into_owned();
    validate_new_entry_name(&name)?;
    let parent = candidate_parent(&root, candidate)?;
    if !parent.is_dir() {
        return Err("Workspace item is not a folder".to_owned());
    }
    fs::create_dir(parent.join(&name)).map_err(|error| format!("Cannot create workspace folder: {error}"))
}

fn candidate_parent(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let parent = match candidate.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().into_owned(),
        _ => return Ok(root.to_path_buf()),
    };
    let parent = canonical_scoped_path(root, &parent)?;
    if !parent.is_dir() {
        return Err("Workspace item is not a folder".to_owned());
    }
    Ok(parent)
}

fn validate_new_entry_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed != name
        || trimmed == "."
        || trimmed == ".."
        || trimmed.ends_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || name.contains('\0')
    {
        return Err("Invalid workspace item name".to_owned());
    }
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|reserved| reserved.eq_ignore_ascii_case(stem)) {
        return Err("Invalid workspace item name".to_owned());
    }
    Ok(())
}

fn write_target_path(
    root: &Path,
    requested_path: &str,
    content: &str,
    expected_content: &str,
) -> Result<PathBuf, String> {
    match canonical_scoped_path(root, requested_path) {
        Ok(file_path) => Ok(file_path),
        Err(error) => {
            // Only brand-new, empty file creation may skip the canonicalized
            // path: the target does not exist yet, so validate its parent.
            if !content.is_empty() || !expected_content.is_empty() || fs::metadata(requested_path).is_ok() {
                return Err(error);
            }
            let candidate = Path::new(requested_path);
            let name = candidate
                .file_name()
                .ok_or_else(|| "Invalid workspace file name".to_owned())?
                .to_string_lossy()
                .into_owned();
            validate_new_entry_name(&name)?;
            let parent = candidate_parent(root, candidate)?;
            Ok(parent.join(name))
        }
    }
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
    let file_path = write_target_path(&root, path, content, expected_content)?;
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&file_path)
    {
        Ok(file) => file,
        Err(open_error) if open_error.kind() == std::io::ErrorKind::NotFound
            && expected_content.is_empty()
            && content.is_empty() =>
        {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&file_path)
                .map_err(|error| format!("Cannot create workspace file: {error}"))?
        }
        Err(error) => return Err(format!("Cannot open workspace file for saving: {error}")),
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("create temp directory");
        let root = dir.path().to_string_lossy().into_owned();
        (dir, root)
    }

    fn add_bytes(root: &Path, relative: &str, contents: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture parent directory");
        }
        fs::write(path, contents).expect("write fixture file");
    }

    fn add_file(root: &Path, relative: &str, contents: &str) {
        add_bytes(root, relative, contents.as_bytes());
    }

    fn fixture_path(dir: &tempfile::TempDir, relative: &str) -> String {
        dir.path().join(relative).to_string_lossy().into_owned()
    }

    #[test]
    fn list_directory_empty_path_lists_root() {
        let (dir, root) = temp_root();
        fs::create_dir_all(dir.path().join("zeta")).expect("create fixture directory");
        add_file(dir.path(), "alpha.txt", "a");
        add_file(dir.path(), "Beta.txt", "bb");
        add_file(dir.path(), "gamma.txt", "ccc");

        let entries = list_directory(&root, "").expect("list workspace root");

        let names: Vec<(String, bool)> = entries
            .iter()
            .map(|entry| (entry.name.clone(), entry.is_dir))
            .collect();
        assert_eq!(
            names,
            vec![
                ("zeta".to_owned(), true),
                ("alpha.txt".to_owned(), false),
                ("Beta.txt".to_owned(), false),
                ("gamma.txt".to_owned(), false),
            ]
        );
    }

    #[test]
    fn list_directory_reports_extensions_sizes_and_directory_flags() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "Report.TXT", "hello");
        fs::create_dir_all(dir.path().join("nested")).expect("create fixture directory");

        let entries = list_directory(&root, "").expect("list workspace root");

        let report = entries
            .iter()
            .find(|entry| entry.name == "Report.TXT")
            .expect("report entry");
        assert_eq!(report.extension.as_deref(), Some("txt"));
        assert_eq!(report.size, Some(5));
        assert!(!report.is_dir);

        let nested = entries
            .iter()
            .find(|entry| entry.name == "nested")
            .expect("nested entry");
        assert!(nested.is_dir);
        assert_eq!(nested.size, None);
        assert_eq!(nested.extension, None);
    }

    #[test]
    fn list_directory_rejects_paths_outside_root() {
        let (_dir, root) = temp_root();
        let outside = tempfile::tempdir().expect("create outside temp directory");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "sneaky").expect("write outside file");

        let error = list_directory(&root, outside_file.to_string_lossy().as_ref()).unwrap_err();
        assert!(error.contains("outside the included folder"), "{error}");
    }

    #[test]
    fn list_directory_rejects_files_and_missing_paths() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "keep.txt", "ok");

        let file_error = list_directory(&root, &fixture_path(&dir, "keep.txt")).unwrap_err();
        assert!(file_error.contains("not a folder"), "{file_error}");

        let missing_error =
            list_directory(&root, &fixture_path(&dir, "does-not-exist")).unwrap_err();
        assert!(
            missing_error.contains("Workspace item no longer exists"),
            "{missing_error}"
        );
    }

    #[test]
    fn list_directory_reports_missing_item_marker_for_deleted_entries() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "keep.txt", "ok");
        let deleted = fixture_path(&dir, "deleted-folder");
        fs::create_dir_all(&deleted).expect("create then remove fixture directory");
        fs::remove_dir(&deleted).expect("remove fixture directory");

        let error = list_directory(&root, &deleted).unwrap_err();
        assert!(
            error.starts_with("Workspace item no longer exists"),
            "{error}"
        );
        // The explorer drops entries carrying this marker silently; access
        // failures keep the generic message and the Retry button.
        assert!(!error.contains("Cannot access workspace item"), "{error}");
    }

    #[test]
    fn search_files_ranks_exact_prefix_contains_and_path_matches() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "report", "exact");
        add_file(dir.path(), "report2024.md", "prefix");
        add_file(dir.path(), "my_report_final.txt", "contains");
        add_file(dir.path(), "reports_old/summary.txt", "path");

        let results = search_files(&root, "REPORT", 10).expect("search files");

        let names: Vec<&str> = results.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "report",
                "report2024.md",
                "my_report_final.txt",
                "summary.txt"
            ]
        );
        let top = &results[0];
        assert_eq!(top.extension, None);
        assert!(!top.is_dir);
        assert!(top.size.is_some());
    }

    #[test]
    fn search_files_treats_backslashes_as_slashes() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "sub/note.md", "content");

        let results = search_files(&root, "sub\\note.md", 10).expect("search files");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "note.md");
        assert_eq!(results[0].extension.as_deref(), Some("md"));
    }

    #[test]
    fn search_files_empty_query_returns_no_results() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "anything.txt", "x");

        assert!(search_files(&root, "", 10).expect("empty query").is_empty());
        assert!(search_files(&root, "   \t", 10)
            .expect("blank query")
            .is_empty());
    }

    #[test]
    fn search_files_skips_ignored_directories() {
        let (dir, root) = temp_root();
        let ignored = [
            ".git",
            "node_modules",
            "target",
            "dist",
            "build",
            "coverage",
            ".next",
            ".turbo",
            ".venv",
            "venv",
        ];
        for name in ignored {
            add_file(dir.path(), &format!("{name}/ignored_marker.log"), "x");
        }

        let results = search_files(&root, "ignored_marker", 10).expect("search files");

        assert!(results.is_empty(), "unexpected results: {results:?}");
    }

    #[test]
    fn search_files_clamps_limit() {
        let (dir, root) = temp_root();
        for index in 1..=3 {
            add_file(dir.path(), &format!("item{index}.txt"), "x");
        }

        assert_eq!(search_files(&root, "item", 0).expect("limit zero").len(), 1);
        let limited = search_files(&root, "item", 2).expect("limit two");
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].name, "item1.txt");
        assert_eq!(limited[0].extension.as_deref(), Some("txt"));
        assert_eq!(
            search_files(&root, "item", 1000)
                .expect("limit large")
                .len(),
            3
        );
    }

    #[test]
    fn search_files_rejects_missing_root() {
        let error = search_files("does-not-exist-root-yerminal", "item", 10).unwrap_err();
        assert!(error.contains("Cannot open workspace folder"), "{error}");
    }

    #[test]
    fn read_text_file_roundtrips_valid_utf8() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "hello.txt", "héllo wörld 中文");

        let content =
            read_text_file(&root, &fixture_path(&dir, "hello.txt")).expect("read text file");

        assert_eq!(content, "héllo wörld 中文");
    }

    #[test]
    fn read_text_file_rejects_oversized_files() {
        let (dir, root) = temp_root();
        add_bytes(
            dir.path(),
            "big.txt",
            "a".repeat(MAX_PREVIEW_BYTES as usize + 1).as_bytes(),
        );

        let error = read_text_file(&root, &fixture_path(&dir, "big.txt")).unwrap_err();
        assert!(error.contains("too large to preview"), "{error}");
    }

    #[test]
    fn read_text_file_rejects_binary_and_invalid_utf8_files() {
        let (dir, root) = temp_root();
        add_bytes(dir.path(), "binary.bin", b"abc\0def");
        add_bytes(dir.path(), "not_utf8.txt", &[0xC3, 0x28, b'x']);

        let binary_error = read_text_file(&root, &fixture_path(&dir, "binary.bin")).unwrap_err();
        assert!(
            binary_error.contains("Binary file preview"),
            "{binary_error}"
        );

        let utf8_error = read_text_file(&root, &fixture_path(&dir, "not_utf8.txt")).unwrap_err();
        assert!(utf8_error.contains("not valid UTF-8"), "{utf8_error}");
    }

    #[test]
    fn read_text_file_rejects_paths_outside_root_and_directories() {
        let (dir, root) = temp_root();
        let outside = tempfile::tempdir().expect("create outside temp directory");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "sneaky").expect("write outside file");
        fs::create_dir_all(dir.path().join("folder")).expect("create fixture directory");

        let outside_error =
            read_text_file(&root, outside_file.to_string_lossy().as_ref()).unwrap_err();
        assert!(
            outside_error.contains("outside the included folder"),
            "{outside_error}"
        );

        let directory_error = read_text_file(&root, &fixture_path(&dir, "folder")).unwrap_err();
        assert!(directory_error.contains("not a file"), "{directory_error}");
    }

    #[test]
    fn create_directory_creates_folders_inside_root() {
        let (dir, root) = temp_root();
        fs::create_dir_all(dir.path().join("existing")).expect("create fixture directory");

        create_directory(&root, &fixture_path(&dir, "existing/new-folder"))
            .expect("create nested workspace folder");
        create_directory(&root, &fixture_path(&dir, "root-level"))
            .expect("create workspace folder at root");

        assert!(dir.path().join("existing/new-folder").is_dir());
        assert!(dir.path().join("root-level").is_dir());

        let exists_error = create_directory(&root, &fixture_path(&dir, "existing/new-folder")).unwrap_err();
        assert!(exists_error.contains("Cannot create workspace folder"), "{exists_error}");
    }

    #[test]
    fn create_directory_rejects_paths_outside_root() {
        let (dir, root) = temp_root();
        fs::create_dir_all(dir.path().join("sub")).expect("create fixture directory");
        let outside = tempfile::tempdir().expect("create outside temp directory");

        let outside_error =
            create_directory(&root, &fixture_path(&outside, "sneaky")).unwrap_err();
        assert!(
            outside_error.contains("outside the included folder"),
            "{outside_error}"
        );

        let escape = format!("{}\\..\\escape", dir.path().to_string_lossy());
        let escape_error = create_directory(&root, &escape).unwrap_err();
        assert!(
            escape_error.contains("outside the included folder"),
            "{escape_error}"
        );

        let parent_escape = format!("{}\\..", dir.path().to_string_lossy());
        let name_error = create_directory(&root, &parent_escape).unwrap_err();
        assert!(
            name_error.contains("Invalid workspace folder name"),
            "{name_error}"
        );
    }

    #[test]
    fn validate_new_entry_name_rejects_unsafe_names() {
        for name in ["", "  ", ".", "..", "a/b", "a\\b", "a:b", "na\0me", " name "] {
            assert!(validate_new_entry_name(name).is_err(), "{name}");
        }
        for name in ["notes.txt", "sub folder", "dots..inside"] {
            assert!(validate_new_entry_name(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn write_text_file_creates_missing_file_when_content_and_expected_are_empty() {
        let (dir, root) = temp_root();
        fs::create_dir_all(dir.path().join("notes")).expect("create fixture directory");

        write_text_file(&root, &fixture_path(&dir, "notes/new.txt"), "", "")
            .expect("create empty workspace file");
        assert_eq!(
            fs::read_to_string(dir.path().join("notes/new.txt")).unwrap(),
            ""
        );

        let content_error = write_text_file(
            &root,
            &fixture_path(&dir, "notes/other.txt"),
            "content",
            "",
        )
        .unwrap_err();
        assert!(
            content_error.contains("Workspace item no longer exists"),
            "{content_error}"
        );
    }

    #[test]
    fn write_text_file_rewrites_and_truncates_when_expected_matches() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "notes.txt", "oldest content here is longer");

        let notes = fixture_path(&dir, "notes.txt");

        write_text_file(&root, &notes, "short", "oldest content here is longer")
            .expect("write text file");
        assert_eq!(
            fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
            "short"
        );

        write_text_file(&root, &notes, "short", "short").expect("write same content");
        assert_eq!(
            fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
            "short"
        );
    }

    #[test]
    fn write_text_file_rejects_stale_expected_content() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "notes.txt", "current content");

        let error = write_text_file(
            &root,
            &fixture_path(&dir, "notes.txt"),
            "new content",
            "stale content",
        )
        .unwrap_err();
        assert!(error.contains("File changed on disk"), "{error}");
        assert_eq!(
            fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
            "current content"
        );
    }

    #[test]
    fn write_text_file_rejects_oversized_and_binary_content() {
        let (dir, root) = temp_root();
        add_file(dir.path(), "notes.txt", "existing");

        let oversized = "a".repeat(MAX_PREVIEW_BYTES as usize + 1);
        let size_error = write_text_file(
            &root,
            &fixture_path(&dir, "notes.txt"),
            &oversized,
            "existing",
        )
        .unwrap_err();
        assert!(size_error.contains("too large to save"), "{size_error}");

        let binary_error = write_text_file(
            &root,
            &fixture_path(&dir, "notes.txt"),
            "ab\0cd",
            "existing",
        )
        .unwrap_err();
        assert!(
            binary_error.contains("Binary file editing"),
            "{binary_error}"
        );
    }

    #[test]
    fn write_text_file_rejects_missing_files_and_paths_outside_root() {
        let (dir, root) = temp_root();
        add_file(dir.path(), " filler.txt", "keep root alive");
        let missing_error =
            write_text_file(&root, &fixture_path(&dir, "missing.txt"), "content", "").unwrap_err();
        assert!(
            missing_error.contains("Workspace item no longer exists"),
            "{missing_error}"
        );

        let outside = tempfile::tempdir().expect("create outside temp directory");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "sneaky").expect("write outside file");
        let outside_error = write_text_file(
            &root,
            outside_file.to_string_lossy().as_ref(),
            "content",
            "sneaky",
        )
        .unwrap_err();
        assert!(
            outside_error.contains("outside the included folder"),
            "{outside_error}"
        );
    }
}

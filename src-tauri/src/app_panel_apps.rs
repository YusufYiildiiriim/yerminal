//! Apps of the right dock: the ready-made catalog (browser `--app` windows) and the user's own
//! apps (any local `.exe`, added once with a name).
//!
//! Safety: the page never supplies an executable path or an argument. A custom app is added by
//! a native file picker that this side opens; the chosen path is checked here and kept here
//! (`Pending`), and the page only sends the display name afterwards. `app_panel_open` takes a
//! registered id and nothing else: a ready-made id launches its fixed url in the user's browser,
//! a custom id launches the stored path without any argument. The registry is a small JSON file
//! in the app data folder; entries that do not pass the path check are ignored when loaded, so a
//! hand-edited file cannot point the launcher at a relative, network or device path.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const STORE_FILE: &str = "app-panel-apps.json";
pub const MAX_NAME_LEN: usize = 60;
const CUSTOM_KIND: &str = "custom";
const CUSTOM_PREFIX: &str = "custom-";

/// A ready-made app: a site shown in the user's browser as an `--app` window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinApp {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// How the app's window title ends (or equals): picks the new window out of the ones a launch opens.
    pub title_hint: &'static str,
}

pub const BUILTIN_APPS: [BuiltinApp; 3] = [
    BuiltinApp { id: "youtube-music", name: "YouTube Music", url: "https://music.youtube.com", title_hint: "YouTube Music" },
    BuiltinApp { id: "youtube", name: "YouTube", url: "https://www.youtube.com", title_hint: "YouTube" },
    BuiltinApp { id: "x", name: "X", url: "https://x.com", title_hint: "X" },
];

pub fn builtin(id: &str) -> Option<&'static BuiltinApp> {
    BUILTIN_APPS.iter().find(|app| app.id == id)
}

/// A user app: a local executable started as it is, with no argument.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomApp {
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub kind: String,
}

/// What the page sees of an app: id, display name and kind (never the path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
}

/// What a registered id launches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Browser(&'static BuiltinApp),
    Custom(CustomApp),
}

pub fn list_all(custom: &[CustomApp]) -> Vec<AppInfo> {
    let ready = BUILTIN_APPS.iter().map(|a| AppInfo { id: a.id.to_owned(), name: a.name.to_owned(), kind: "builtin" });
    let own = custom.iter().map(|a| AppInfo { id: a.id.clone(), name: a.name.clone(), kind: CUSTOM_KIND });
    ready.chain(own).collect()
}

/// Registered ids only: a ready-made id or a saved custom id. Anything else (a path, a url) is refused.
pub fn resolve(id: &str, custom: &[CustomApp]) -> Result<Launch, String> {
    if let Some(app) = builtin(id) {
        return Ok(Launch::Browser(app));
    }
    custom
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .map(Launch::Custom)
        .ok_or_else(|| "Unknown app".to_owned())
}

// ---------------------------------------------------------------------------
// Path and name checks
// ---------------------------------------------------------------------------

/// Syntax of an acceptable executable path: absolute on a drive letter (`C:\` or `C:/`), no
/// network, device or `\\?\` form, no `.`/`..` segment, no stream suffix, no wildcard or control
/// character, and the file name ends in `.exe`.
pub fn check_exe_syntax(raw: &str) -> Result<(), String> {
    const NOT_ABSOLUTE: &str = "Choose an .exe file on a local drive";
    let bytes = raw.as_bytes();
    let drive_root = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');
    if !drive_root {
        return Err(NOT_ABSOLUTE.to_owned());
    }
    if raw.chars().any(|c| c.is_control() || "<>\"|?*".contains(c)) || raw[2..].contains(':') {
        return Err("The path contains characters that are not allowed".to_owned());
    }
    let segments: Vec<&str> = raw[3..].split(['\\', '/']).collect();
    if segments.iter().any(|s| *s == "." || *s == ".." || (!s.is_empty() && (s.ends_with(' ') || s.ends_with('.')))) {
        return Err("The path must not contain relative parts".to_owned());
    }
    let file = segments.last().copied().unwrap_or("");
    if file.len() <= 4 || !file.to_ascii_lowercase().ends_with(".exe") {
        return Err("Choose an .exe file".to_owned());
    }
    Ok(())
}

/// Full check of a picked path: syntax, a local (not network) drive, and the file exists.
pub fn validate_exe(raw: &str, exists: &dyn Fn(&Path) -> bool, is_remote: &dyn Fn(&Path) -> bool) -> Result<PathBuf, String> {
    check_exe_syntax(raw)?;
    let path = PathBuf::from(raw);
    if is_remote(&path) {
        return Err("Apps on a network drive cannot be added".to_owned());
    }
    if !exists(&path) {
        return Err("That file does not exist".to_owned());
    }
    Ok(path)
}

/// Check of a stored path right before it is started.
pub fn revalidate(raw: &str) -> Result<PathBuf, String> {
    validate_exe(raw, &|p| p.is_file(), &is_remote_drive)
}

/// Suggested display name: the file name without `.exe`.
pub fn default_name(exe_path: &str) -> String {
    Path::new(exe_path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Enter a name for the app".to_owned());
    }
    if name.chars().any(char::is_control) {
        return Err("The name contains characters that are not allowed".to_owned());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("The name is longer than {MAX_NAME_LEN} characters"));
    }
    Ok(name.to_owned())
}

fn same_exe(a: &str, b: &str) -> bool {
    crate::app_panel::same_path(a, b)
}

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

/// `seed` makes the id (the caller passes the clock); a taken id moves on to the next number.
fn new_id(existing: &[CustomApp], seed: u128) -> String {
    let mut n = seed;
    loop {
        let id = format!("{CUSTOM_PREFIX}{n:x}");
        if !existing.iter().any(|a| a.id == id) && builtin(&id).is_none() {
            return id;
        }
        n = n.wrapping_add(1);
    }
}

pub fn add(list: &mut Vec<CustomApp>, name: &str, exe_path: &str, seed: u128) -> Result<CustomApp, String> {
    let name = clean_name(name)?;
    check_exe_syntax(exe_path)?;
    if list.iter().any(|a| same_exe(&a.exe_path, exe_path)) {
        return Err("That app is already in the list".to_owned());
    }
    let app = CustomApp { id: new_id(list, seed), name, exe_path: exe_path.to_owned(), kind: CUSTOM_KIND.to_owned() };
    list.push(app.clone());
    Ok(app)
}

pub fn rename(list: &mut [CustomApp], id: &str, name: &str) -> Result<(), String> {
    let name = clean_name(name)?;
    let app = list.iter_mut().find(|a| a.id == id).ok_or("Unknown app")?;
    app.name = name;
    Ok(())
}

pub fn remove(list: &mut Vec<CustomApp>, id: &str) -> Result<CustomApp, String> {
    let index = list.iter().position(|a| a.id == id).ok_or("Unknown app")?;
    Ok(list.remove(index))
}

/// The path picked by the file dialog, waiting for the page to name it. Only the newest pick is kept.
#[derive(Debug, Default)]
pub struct Pending(Option<String>);

impl Pending {
    pub fn set(&mut self, path: String) {
        self.0 = Some(path);
    }

    pub fn take(&mut self) -> Option<String> {
        self.0.take()
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    apps: Vec<CustomApp>,
}

/// Entries that are not what this code would have written are dropped: wrong kind or id shape,
/// a repeated id or path, an unusable name or path.
fn sanitize(apps: Vec<CustomApp>) -> Vec<CustomApp> {
    let mut kept: Vec<CustomApp> = Vec::new();
    for mut app in apps {
        let Ok(name) = clean_name(&app.name) else { continue };
        let fine = app.kind == CUSTOM_KIND
            && app.id.starts_with(CUSTOM_PREFIX)
            && check_exe_syntax(&app.exe_path).is_ok()
            && !kept.iter().any(|k| k.id == app.id || same_exe(&k.exe_path, &app.exe_path));
        if fine {
            app.name = name;
            kept.push(app);
        }
    }
    kept
}

/// Missing file: empty. Broken file: empty, and the file is kept aside as `.corrupt` so the next
/// save does not destroy it silently.
pub fn load(path: &Path) -> Vec<CustomApp> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    match serde_json::from_slice::<StoreFile>(&bytes) {
        Ok(file) => sanitize(file.apps),
        Err(_) => {
            let _ = std::fs::rename(path, path.with_extension("json.corrupt"));
            Vec::new()
        }
    }
}

/// Through a temporary file and a rename, so a reader never sees half a file.
pub fn save(path: &Path, apps: &[CustomApp]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let file = StoreFile { version: 1, apps: apps.to_vec() };
    std::fs::write(&tmp, serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Serialises read-modify-write of the store and holds the pending pick.
static STORE_LOCK: Mutex<()> = Mutex::new(());
static PENDING: Mutex<Pending> = Mutex::new(Pending(None));

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map(|d| d.join(STORE_FILE)).map_err(|e| e.to_string())
}

/// Reads the store for `app_panel_open` (the registry decides what an id launches).
pub fn load_for(app: &tauri::AppHandle) -> Result<Vec<CustomApp>, String> {
    Ok(load(&store_path(app)?))
}

fn seed() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(1)
}

fn mutate(app: &tauri::AppHandle, change: impl FnOnce(&mut Vec<CustomApp>) -> Result<(), String>) -> Result<Vec<AppInfo>, String> {
    let path = store_path(app)?;
    let _one_at_a_time = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut list = load(&path);
    change(&mut list)?;
    save(&path, &list).map_err(|e| format!("Cannot save the app list: {e}"))?;
    Ok(list_all(&list))
}

#[cfg(windows)]
fn is_remote_drive(path: &Path) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    const DRIVE_REMOTE: u32 = 4;
    let Some(letter) = path.to_string_lossy().chars().next() else { return true };
    let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
}

#[cfg(not(windows))]
fn is_remote_drive(_path: &Path) -> bool {
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PickedApp {
    pub default_name: String,
}

#[tauri::command(async)]
pub fn app_panel_apps_list(app: tauri::AppHandle) -> Result<Vec<AppInfo>, String> {
    Ok(list_all(&load_for(&app)?))
}

/// Opens the native file picker (this side, on the page's request) and keeps the checked path
/// here. `None` when the picker was cancelled.
#[tauri::command(async)]
pub fn app_panel_app_pick(app: tauri::AppHandle) -> Result<Option<PickedApp>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(chosen) = app.dialog().file().set_title("Choose an app to add").add_filter("Programs", &["exe"]).blocking_pick_file() else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let path = validate_exe(&path.to_string_lossy(), &|p| p.is_file(), &is_remote_drive)?;
    let path = path.to_string_lossy().into_owned();
    let picked = PickedApp { default_name: default_name(&path) };
    PENDING.lock().unwrap_or_else(|p| p.into_inner()).set(path);
    Ok(Some(picked))
}

/// Saves the pending pick under the given name (empty: the file name). Needs a pick first; the
/// page cannot name a path.
#[tauri::command(async)]
pub fn app_panel_app_register(app: tauri::AppHandle, name: String) -> Result<Vec<AppInfo>, String> {
    let path = PENDING.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or("Choose an app first")?;
    let name = if name.trim().is_empty() { default_name(&path) } else { name };
    mutate(&app, |list| add(list, &name, &path, seed()).map(|_| ()))
}

#[tauri::command(async)]
pub fn app_panel_app_rename(app: tauri::AppHandle, id: String, name: String) -> Result<Vec<AppInfo>, String> {
    mutate(&app, |list| rename(list, &id, &name))
}

/// Removes the entry from the list only; an open window of that app is left alone.
#[tauri::command(async)]
pub fn app_panel_app_remove(app: tauri::AppHandle, id: String) -> Result<Vec<AppInfo>, String> {
    mutate(&app, |list| remove(list, &id).map(|_| ()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const CHARMAP: &str = r"C:\Windows\System32\charmap.exe";
    fn exists(_: &Path) -> bool {
        true
    }
    fn local(_: &Path) -> bool {
        false
    }

    #[test]
    fn a_plain_absolute_exe_path_is_accepted() {
        assert!(validate_exe(CHARMAP, &exists, &local).is_ok());
        assert!(validate_exe("D:/Tools/postman/Postman.EXE", &exists, &local).is_ok());
    }

    #[test]
    fn relative_unc_device_and_parent_paths_are_refused() {
        for bad in [
            "charmap.exe",
            r"Windows\System32\charmap.exe",
            r"\\server\share\x.exe",
            "//server/share/x.exe",
            r"\\?\C:\Windows\System32\charmap.exe",
            r"\\.\pipe\x.exe",
            r"C:\Tools\..\Windows\charmap.exe",
            r"C:Tools\x.exe",
            r"C:\Tools\x.exe:stream",
            r"C:\Tools\x?.exe",
            "",
        ] {
            assert!(validate_exe(bad, &exists, &local).is_err(), "should refuse {bad:?}");
        }
    }

    #[test]
    fn only_exe_files_that_exist_on_a_local_drive_are_accepted() {
        assert!(validate_exe(r"C:\Tools\run.bat", &exists, &local).is_err());
        assert!(validate_exe(r"C:\Tools\run.exe.txt", &exists, &local).is_err());
        assert!(validate_exe(r"C:\Tools\folder.exe\", &exists, &local).is_err());
        assert!(validate_exe(CHARMAP, &|_: &Path| false, &local).is_err());
        assert!(validate_exe(CHARMAP, &exists, &|_: &Path| true).is_err());
    }

    #[test]
    fn default_name_is_the_file_stem() {
        assert_eq!(default_name(CHARMAP), "charmap");
        assert_eq!(default_name("D:/Tools/Android Studio/bin/studio64.exe"), "studio64");
    }

    #[test]
    fn names_are_trimmed_and_must_be_short_and_printable() {
        assert_eq!(clean_name("  Postman ").unwrap(), "Postman");
        assert!(clean_name("   ").is_err());
        assert!(clean_name("a\nb").is_err());
        assert!(clean_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
        assert!(clean_name(&"x".repeat(MAX_NAME_LEN)).is_ok());
    }

    #[test]
    fn ids_are_generated_here_and_never_collide() {
        let mut list = Vec::new();
        let a = add(&mut list, "A", CHARMAP, 7).unwrap();
        let b = add(&mut list, "B", r"C:\Tools\b.exe", 7).unwrap();
        assert!(a.id.starts_with("custom-"));
        assert_ne!(a.id, b.id);
        assert_eq!(a.kind, "custom");
        assert!(builtin(&a.id).is_none());
    }

    #[test]
    fn the_same_exe_is_not_listed_twice() {
        let mut list = Vec::new();
        add(&mut list, "A", CHARMAP, 1).unwrap();
        assert!(add(&mut list, "B", &CHARMAP.to_lowercase().replace('\\', "/"), 2).is_err());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn rename_and_remove_work_on_custom_apps_only() {
        let mut list = Vec::new();
        let app = add(&mut list, "A", CHARMAP, 1).unwrap();
        rename(&mut list, &app.id, " Map ").unwrap();
        assert_eq!(list[0].name, "Map");
        assert!(rename(&mut list, &app.id, "").is_err());
        assert!(rename(&mut list, "youtube", "Y").is_err());
        assert!(remove(&mut list, "youtube").is_err());
        assert_eq!(remove(&mut list, &app.id).unwrap().exe_path, CHARMAP);
        assert!(list.is_empty());
    }

    #[test]
    fn the_catalog_lives_here_with_https_urls() {
        let ids: Vec<_> = BUILTIN_APPS.iter().map(|a| a.id).collect();
        assert_eq!(ids, ["youtube-music", "youtube", "x"]);
        assert!(BUILTIN_APPS.iter().all(|a| a.url.starts_with("https://") && !a.title_hint.is_empty()));
        assert_eq!(builtin("x").unwrap().name, "X");
    }

    #[test]
    fn listing_puts_ready_made_apps_first_then_the_saved_ones() {
        let mut list = Vec::new();
        add(&mut list, "Postman", CHARMAP, 1).unwrap();
        let infos = list_all(&list);
        assert_eq!(infos.len(), 4);
        assert_eq!((infos[0].id.as_str(), infos[0].kind), ("youtube-music", "builtin"));
        assert_eq!((infos[3].name.as_str(), infos[3].kind), ("Postman", "custom"));
    }

    #[test]
    fn resolve_knows_registered_ids_only() {
        let mut list = Vec::new();
        let app = add(&mut list, "A", CHARMAP, 1).unwrap();
        assert!(matches!(resolve("x", &list), Ok(Launch::Browser(a)) if a.id == "x"));
        assert!(matches!(resolve(&app.id, &list), Ok(Launch::Custom(a)) if a.exe_path == CHARMAP));
        assert!(resolve("C:/Windows/System32/cmd.exe", &list).is_err());
        assert!(resolve("custom-unknown", &list).is_err());
    }

    #[test]
    fn the_store_round_trips_and_a_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_FILE);
        assert!(load(&path).is_empty());
        let mut list = Vec::new();
        add(&mut list, "A", CHARMAP, 1).unwrap();
        save(&path, &list).unwrap();
        assert_eq!(load(&path), list);
        assert!(!dir.path().join("app-panel-apps.json.tmp").exists());
    }

    #[test]
    fn a_broken_store_falls_back_to_empty_and_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_FILE);
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load(&path).is_empty());
        assert!(dir.path().join("app-panel-apps.json.corrupt").exists());
    }

    #[test]
    fn tampered_entries_are_dropped_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STORE_FILE);
        std::fs::write(
            &path,
            r#"{"version":1,"apps":[
              {"id":"custom-1","name":"Ok","exe_path":"C:\\Windows\\System32\\charmap.exe","kind":"custom"},
              {"id":"custom-2","name":"Unc","exe_path":"\\\\evil\\share\\x.exe","kind":"custom"},
              {"id":"custom-3","name":"Rel","exe_path":"x.exe","kind":"custom"},
              {"id":"x","name":"Shadow","exe_path":"C:\\Tools\\x.exe","kind":"custom"},
              {"id":"custom-1","name":"Dup","exe_path":"C:\\Tools\\dup.exe","kind":"custom"}
            ]}"#,
        )
        .unwrap();
        let list = load(&path);
        assert_eq!(list.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["Ok"]);
    }

    #[test]
    fn a_picked_path_is_held_once_and_consumed_by_register() {
        let mut pending = Pending::default();
        assert!(pending.take().is_none());
        pending.set(CHARMAP.to_owned());
        pending.set(r"C:\Tools\b.exe".to_owned());
        assert_eq!(pending.take().as_deref(), Some(r"C:\Tools\b.exe"));
        assert!(pending.take().is_none());
    }
}

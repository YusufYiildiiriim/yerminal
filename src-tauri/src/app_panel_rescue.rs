//! Rescue of hosted app windows when yerminal dies without releasing them.
//!
//! A hosted window is clipped, may be hidden and has its system backdrop switched off. If yerminal
//! is killed or crashes, nobody gives it back. Two safety nets use one small state file (app data,
//! one per yerminal process, rewritten atomically whenever a window is placed or hidden):
//! - a watchdog: the same executable started as `--app-panel-watchdog <pid> <file>`. It opens no
//!   window and never starts Tauri; it sleeps on the owner process handle and, when that ends,
//!   gives every window in the file back to the desktop;
//! - the next yerminal start rescues files whose owner process is gone.
//!
//! A window is only touched when its handle still belongs to the recorded process and class.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const WATCHDOG_FLAG: &str = "--app-panel-watchdog";

/// One hosted window as it was before it was hosted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RescueWindow {
    pub hwnd: isize,
    /// Process that owns the window (the browser).
    pub pid: u32,
    pub class: String,
    /// Original outer rectangle in screen pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// System backdrop value to put back, when it was switched off.
    pub backdrop: Option<i32>,
    /// Hidden by yerminal at the time of writing (informational: every listed window is shown again).
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RescueFile {
    pub owner_pid: u32,
    /// Creation time of the owner process: tells a live owner from a reused process id.
    pub owner_started: u64,
    pub windows: Vec<RescueWindow>,
}

/// `[exe, --app-panel-watchdog, <pid>, <file>]` -> (pid, file).
pub fn parse_watchdog_args(args: &[String]) -> Option<(u32, PathBuf)> {
    if args.get(1).map(String::as_str) != Some(WATCHDOG_FLAG) {
        return None;
    }
    let pid = args.get(2)?.parse().ok()?;
    Some((pid, PathBuf::from(args.get(3)?)))
}

pub fn rescue_file_name(pid: u32) -> String {
    format!("app-panel-rescue-{pid}.json")
}

pub fn pid_from_file_name(name: &str) -> Option<u32> {
    name.strip_prefix("app-panel-rescue-")?.strip_suffix(".json")?.parse().ok()
}

/// Writes through a temporary file and renames, so a reader never sees half a file.
pub fn write_atomic(path: &Path, file: &RescueFile) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(file).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

pub fn read_file(path: &Path) -> Option<RescueFile> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// A handle can be reused after its window is gone: only the same process and class count.
/// (The title is not compared: it changes with the page.)
pub fn is_same_window(record: &RescueWindow, live_pid: u32, live_class: &str) -> bool {
    record.pid == live_pid && record.class == live_class
}

pub fn is_orphan(owner_alive: bool) -> bool {
    !owner_alive
}

/// Gives back every window of a state file, then deletes the file.
pub fn rescue_file(path: &Path) {
    if let Some(file) = read_file(path) {
        for window in &file.windows {
            platform::rescue_window(window);
        }
    }
    let _ = std::fs::remove_file(path);
}

/// Watchdog body: wait for the owner process to end, then rescue. Returns at once when the owner is gone.
pub fn run_watchdog(owner_pid: u32, path: &Path) {
    platform::wait_for_process(owner_pid);
    rescue_file(path);
}

/// Start-up fallback: rescues state files of yerminal processes that no longer exist.
pub fn rescue_orphans(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = pid_from_file_name(&name) else { continue };
        if pid == std::process::id() {
            continue;
        }
        let started = read_file(&entry.path()).map(|f| f.owner_started);
        let alive = started.is_some_and(|s| platform::process_alive(pid, s));
        if is_orphan(alive) {
            rescue_file(&entry.path());
        }
    }
}

/// Creation time of this process (0 when unknown).
pub fn own_start_time() -> u64 {
    platform::process_started(std::process::id()).unwrap_or(0)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HWND, TRUE, WAIT_TIMEOUT};
    use windows_sys::Win32::Graphics::Gdi::SetWindowRgn;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowThreadProcessId, IsWindow, SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOZORDER,
        SW_SHOWNOACTIVATE,
    };

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: HWND, attr: u32, value: *const i32, size: u32) -> i32;
    }

    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;

    pub fn wait_for_process(pid: u32) {
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return;
            }
            WaitForSingleObject(handle, INFINITE);
            CloseHandle(handle);
        }
    }

    pub fn process_started(pid: u32) -> Option<u64> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            CloseHandle(handle);
            (ok != 0).then(|| ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
        }
    }

    /// True when the process exists, is the same one (creation time) and has not ended.
    pub fn process_alive(pid: u32, started: u64) -> bool {
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            running && process_started(pid) == Some(started)
        }
    }

    pub fn rescue_window(record: &RescueWindow) {
        unsafe {
            let h = record.hwnd as HWND;
            if IsWindow(h) == 0 {
                return;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            let mut buf = [0u16; 256];
            let len = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
            if !is_same_window(record, pid, &String::from_utf16_lossy(&buf[..len])) {
                return;
            }
            SetWindowRgn(h, std::ptr::null_mut(), TRUE);
            if let Some(value) = record.backdrop {
                DwmSetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, &value, 4);
            }
            SetWindowPos(h, std::ptr::null_mut(), record.x, record.y, record.width, record.height, SWP_NOZORDER | SWP_NOACTIVATE);
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn wait_for_process(_pid: u32) {}
    pub fn process_started(_pid: u32) -> Option<u64> {
        None
    }
    pub fn process_alive(_pid: u32, _started: u64) -> bool {
        false
    }
    pub fn rescue_window(_record: &RescueWindow) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample() -> RescueFile {
        RescueFile {
            owner_pid: 42,
            owner_started: 1234,
            windows: vec![RescueWindow {
                hwnd: 0x1234,
                pid: 99,
                class: "Chrome_WidgetWin_1".to_owned(),
                x: 10,
                y: 20,
                width: 800,
                height: 600,
                backdrop: Some(2),
                hidden: true,
            }],
        }
    }

    #[test]
    fn watchdog_args_are_recognised() {
        let args: Vec<String> = ["yerminal.exe", "--app-panel-watchdog", "42", "C:/x/rescue-42.json"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(parse_watchdog_args(&args), Some((42, PathBuf::from("C:/x/rescue-42.json"))));
    }

    #[test]
    fn ordinary_start_is_not_the_watchdog() {
        let none: Vec<String> = vec!["yerminal.exe".to_owned()];
        assert_eq!(parse_watchdog_args(&none), None);
        let bad_pid: Vec<String> = ["y", "--app-panel-watchdog", "abc", "f"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_watchdog_args(&bad_pid), None);
        let short: Vec<String> = ["y", "--app-panel-watchdog", "42"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_watchdog_args(&short), None);
    }

    #[test]
    fn rescue_file_names_carry_the_owner_pid() {
        assert_eq!(rescue_file_name(4711), "app-panel-rescue-4711.json");
        assert_eq!(pid_from_file_name("app-panel-rescue-4711.json"), Some(4711));
        assert_eq!(pid_from_file_name("app-panel-rescue-x.json"), None);
        assert_eq!(pid_from_file_name("settings.json"), None);
    }

    #[test]
    fn state_file_round_trips_and_overwrites_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(rescue_file_name(42));
        let first = sample();
        write_atomic(&path, &first).unwrap();
        assert_eq!(read_file(&path), Some(first.clone()));
        let mut second = first;
        second.windows[0].hidden = false;
        write_atomic(&path, &second).unwrap();
        assert_eq!(read_file(&path), Some(second));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "no temporary file may stay behind");
    }

    #[test]
    fn unreadable_state_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        assert_eq!(read_file(&path), None);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(read_file(&path), None);
    }

    #[test]
    fn a_window_is_rescued_only_when_it_is_still_the_same_one() {
        let record = &sample().windows[0];
        assert!(is_same_window(record, 99, "Chrome_WidgetWin_1"));
        assert!(!is_same_window(record, 100, "Chrome_WidgetWin_1"), "handle reused by another process");
        assert!(!is_same_window(record, 99, "Notepad"), "handle reused by another window class");
    }

    #[test]
    fn only_dead_owners_leave_orphans() {
        assert!(is_orphan(false));
        assert!(!is_orphan(true));
    }
}

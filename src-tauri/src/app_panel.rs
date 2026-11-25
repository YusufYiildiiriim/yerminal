//! App panel spike: host an external application window inside a dock rectangle.
//! Geometry and window-selection helpers are portable and unit tested here; the
//! Win32 work lives behind `#[cfg(windows)]` and other platforms get an error stub.

use serde::Deserialize;
use std::process::Child;
use std::sync::Mutex;

/// Placeholder in launch arguments, replaced with the dock's own profile folder so a
/// Chromium-based app starts its own process (and so its own top-level window).
pub const PROFILE_PLACEHOLDER: &str = "{profile}";

/// Chromium's custom caption height at 100% scale, measured on Windows 11 (2026-11-26).
const CAPTION_HEIGHT_AT_100: f64 = 31.0;

/// Dock rectangle from the webview, in CSS (logical) pixels relative to the window client area.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct DockRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Device pixels, relative to the parent window client area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// One top-level window as seen by the enumeration (snapshot, no handles kept alive).
#[derive(Debug, Clone, PartialEq)]
pub struct TopWindow {
    pub hwnd: isize,
    pub pid: u32,
    pub class: String,
    pub title: String,
    pub visible: bool,
}

pub fn to_physical(rect: DockRect, scale: f64) -> PhysicalRect {
    PhysicalRect {
        x: (rect.x * scale).round() as i32,
        y: (rect.y * scale).round() as i32,
        width: (rect.width * scale).round() as i32,
        height: (rect.height * scale).round() as i32,
    }
}

/// Where the hosted window must sit so that its top caption band lies above the dock
/// and is clipped away: the window is moved up by the caption height and grows by it.
pub fn with_caption_hidden(dock: PhysicalRect, caption: i32) -> PhysicalRect {
    PhysicalRect {
        x: dock.x,
        y: dock.y - caption,
        width: dock.width,
        height: dock.height + caption,
    }
}

/// Caption height in device pixels for a given scale factor.
pub fn caption_height(scale: f64) -> i32 {
    (CAPTION_HEIGHT_AT_100 * scale).round() as i32
}

/// Launch arguments with the profile placeholder replaced.
pub fn expand_args(args: &[String], profile_dir: &str) -> Vec<String> {
    args.iter()
        .map(|arg| arg.replace(PROFILE_PLACEHOLDER, profile_dir))
        .collect()
}

/// The visible, titled top-level window of the launched process.
pub fn pick_owned_window(windows: &[TopWindow], pid: u32, class: &str) -> Option<isize> {
    windows
        .iter()
        .find(|w| w.pid == pid && w.visible && w.class == class && !w.title.is_empty())
        .map(|w| w.hwnd)
}

/// A visible, titled top-level window of `class` that did not exist before the launch.
/// Used when the launcher hands the request to an already running instance and exits.
pub fn pick_new_window(before: &[isize], after: &[TopWindow], class: &str) -> Option<isize> {
    after
        .iter()
        .find(|w| {
            w.visible && w.class == class && !w.title.is_empty() && !before.contains(&w.hwnd)
        })
        .map(|w| w.hwnd)
}

/// Hosted window class of Chromium-based browsers (Chrome, Edge, Brave).
pub const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// Launched application whose window is embedded in the main window.
struct Hosted {
    child: Child,
    hwnd: isize,
}

#[derive(Default)]
pub struct AppPanelState {
    hosted: Mutex<Option<Hosted>>,
}

#[tauri::command]
pub fn app_panel_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppPanelState>,
    exe: String,
    args: Vec<String>,
    rect: DockRect,
) -> Result<(), String> {
    imp::open(&app, &state, &exe, &args, rect)
}

#[tauri::command]
pub fn app_panel_place(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppPanelState>,
    rect: DockRect,
) -> Result<(), String> {
    imp::place(&app, &state, rect)
}

#[tauri::command]
pub fn app_panel_close(state: tauri::State<'_, AppPanelState>) -> Result<(), String> {
    imp::close(&state)
}

/// True while the hosted window still exists.
#[tauri::command]
pub fn app_panel_status(state: tauri::State<'_, AppPanelState>) -> Result<bool, String> {
    imp::status(&state)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, MoveWindow, PostMessageW,
        SetParent, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_CLOSE,
    };

    const WS_CHILD: isize = 0x4000_0000;
    const WS_POPUP: isize = 0x8000_0000_isize;
    const WS_CAPTION: isize = 0x00C0_0000;
    const WS_THICKFRAME: isize = 0x0004_0000;
    const WS_SYSMENU: isize = 0x0008_0000;
    const WS_MINIMIZEBOX: isize = 0x0002_0000;
    const WS_MAXIMIZEBOX: isize = 0x0001_0000;
    const FRAME_STYLES: isize = WS_CAPTION
        | WS_THICKFRAME
        | WS_SYSMENU
        | WS_MINIMIZEBOX
        | WS_MAXIMIZEBOX
        | WS_POPUP;

    fn window_exists(raw: isize) -> bool {
        unsafe { IsWindow(hwnd_of(raw)) != 0 }
    }

    fn hwnd_of(raw: isize) -> HWND {
        raw as HWND
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    fn window_title(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
        let list = &mut *(lparam as *mut Vec<TopWindow>);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        list.push(TopWindow {
            hwnd: hwnd as isize,
            pid,
            class: class_name(hwnd),
            title: window_title(hwnd),
            visible: IsWindowVisible(hwnd) != 0,
        });
        TRUE
    }

    fn top_windows() -> Vec<TopWindow> {
        let mut list: Vec<TopWindow> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), &mut list as *mut Vec<TopWindow> as LPARAM);
        }
        list
    }

    /// Makes `hwnd` a child of `parent` without its frame.
    fn embed(hwnd: isize, parent: isize) {
        let h = hwnd_of(hwnd);
        unsafe {
            SetParent(h, hwnd_of(parent));
            let style = GetWindowLongPtrW(h, GWL_STYLE);
            let next = (style & !FRAME_STYLES) | WS_CHILD;
            SetWindowLongPtrW(h, GWL_STYLE, next);
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }

    /// Moves the hosted window to `frame` and clips its top `caption` band away.
    fn place_window(hwnd: isize, frame: PhysicalRect, caption: i32) {
        let h = hwnd_of(hwnd);
        unsafe {
            MoveWindow(h, frame.x, frame.y, frame.width, frame.height, TRUE);
            let region = CreateRectRgn(0, caption, frame.width, frame.height);
            SetWindowRgn(h, region, TRUE);
        }
    }

    fn main_window(app: &AppHandle) -> Result<(isize, f64), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is missing".to_owned())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        Ok((hwnd, scale))
    }

    pub fn open(
        app: &AppHandle,
        state: &AppPanelState,
        exe: &str,
        args: &[String],
        rect: DockRect,
    ) -> Result<(), String> {
        let (main, scale) = main_window(app)?;
        let profile = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("app-panel")
            .join("profile");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;

        let mut slot = state
            .hosted
            .lock()
            .map_err(|_| "App panel is unavailable".to_owned())?;
        if let Some(mut old) = slot.take() {
            let _ = old.child.kill();
        }

        let before: Vec<isize> = top_windows().iter().map(|w| w.hwnd).collect();
        let profile_arg = profile.to_string_lossy().into_owned();
        let mut child = Command::new(exe)
            .args(expand_args(args, &profile_arg))
            .spawn()
            .map_err(|e| format!("Cannot start app: {e}"))?;
        let pid = child.id();

        let deadline = Instant::now() + Duration::from_secs(10);
        let hwnd = loop {
            let windows = top_windows();
            if let Some(found) = pick_owned_window(&windows, pid, CHROMIUM_WINDOW_CLASS) {
                break found;
            }
            let exited = child.try_wait().map_err(|e| e.to_string())?.is_some();
            if exited {
                if let Some(found) = pick_new_window(&before, &windows, CHROMIUM_WINDOW_CLASS) {
                    break found;
                }
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                return Err("App window did not appear within 10 seconds".to_owned());
            }
            std::thread::sleep(Duration::from_millis(100));
        };

        embed(hwnd, main);
        let caption = caption_height(scale);
        let frame = with_caption_hidden(to_physical(rect, scale), caption);
        place_window(hwnd, frame, caption);
        *slot = Some(Hosted { child, hwnd });
        Ok(())
    }

    pub fn place(app: &AppHandle, state: &AppPanelState, rect: DockRect) -> Result<(), String> {
        let (_, scale) = main_window(app)?;
        let slot = state
            .hosted
            .lock()
            .map_err(|_| "App panel is unavailable".to_owned())?;
        let hosted = slot.as_ref().ok_or_else(|| "No app is open".to_owned())?;
        let caption = caption_height(scale);
        let frame = with_caption_hidden(to_physical(rect, scale), caption);
        place_window(hosted.hwnd, frame, caption);
        Ok(())
    }

    pub fn close(state: &AppPanelState) -> Result<(), String> {
        let taken = state
            .hosted
            .lock()
            .map_err(|_| "App panel is unavailable".to_owned())?
            .take();
        let Some(mut hosted) = taken else {
            return Ok(());
        };
        unsafe {
            PostMessageW(hwnd_of(hosted.hwnd), WM_CLOSE, 0, 0);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && window_exists(hosted.hwnd) {
            std::thread::sleep(Duration::from_millis(50));
        }
        if matches!(hosted.child.try_wait(), Ok(None)) {
            let _ = hosted.child.kill();
        }
        Ok(())
    }

    pub fn status(state: &AppPanelState) -> Result<bool, String> {
        let mut slot = state
            .hosted
            .lock()
            .map_err(|_| "App panel is unavailable".to_owned())?;
        let alive = match slot.as_ref() {
            Some(hosted) => window_exists(hosted.hwnd),
            None => return Ok(false),
        };
        if !alive {
            *slot = None;
        }
        Ok(alive)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use tauri::AppHandle;

    const UNSUPPORTED: &str = "App panel is available on Windows only in this spike";

    pub fn open(
        _app: &AppHandle,
        _state: &AppPanelState,
        _exe: &str,
        _args: &[String],
        _rect: DockRect,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_owned())
    }

    pub fn place(_app: &AppHandle, _state: &AppPanelState, _rect: DockRect) -> Result<(), String> {
        Err(UNSUPPORTED.to_owned())
    }

    pub fn close(_state: &AppPanelState) -> Result<(), String> {
        Ok(())
    }

    pub fn status(_state: &AppPanelState) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(hwnd: isize, pid: u32, class: &str, title: &str, visible: bool) -> TopWindow {
        TopWindow { hwnd, pid, class: class.to_owned(), title: title.to_owned(), visible }
    }

    #[test]
    fn dock_rect_scales_css_pixels_to_physical_pixels() {
        let rect = DockRect { x: 100.0, y: 40.0, width: 300.0, height: 500.0 };
        assert_eq!(
            to_physical(rect, 1.5),
            PhysicalRect { x: 150, y: 60, width: 450, height: 750 }
        );
    }

    #[test]
    fn dock_rect_at_100_percent_is_unchanged() {
        let rect = DockRect { x: 560.0, y: 0.0, width: 340.0, height: 660.0 };
        assert_eq!(
            to_physical(rect, 1.0),
            PhysicalRect { x: 560, y: 0, width: 340, height: 660 }
        );
    }

    #[test]
    fn fractional_scale_rounds_to_the_nearest_pixel() {
        let rect = DockRect { x: 10.2, y: 0.0, width: 100.4, height: 50.0 };
        assert_eq!(
            to_physical(rect, 1.25),
            PhysicalRect { x: 13, y: 0, width: 126, height: 63 }
        );
    }

    #[test]
    fn owned_window_is_the_visible_titled_window_of_the_child_pid() {
        let windows = [
            window(1, 10, "Chrome_WidgetWin_1", "", true),
            window(2, 10, "Chrome_WidgetWin_1", "YouTube Music", true),
            window(3, 11, "Chrome_WidgetWin_1", "YouTube Music", true),
        ];
        assert_eq!(pick_owned_window(&windows, 10, "Chrome_WidgetWin_1"), Some(2));
    }

    #[test]
    fn owned_window_ignores_hidden_and_other_classes() {
        let windows = [
            window(1, 10, "Chrome_WidgetWin_1", "YouTube Music", false),
            window(2, 10, "Chrome_RenderWidgetHostHWND", "YouTube Music", true),
        ];
        assert_eq!(pick_owned_window(&windows, 10, "Chrome_WidgetWin_1"), None);
    }

    #[test]
    fn new_window_is_the_matching_top_level_window_absent_before_launch() {
        let before = [1, 2];
        let after = [
            window(1, 10, "Chrome_WidgetWin_1", "Other", true),
            window(2, 10, "Chrome_WidgetWin_1", "Other", true),
            window(5, 10, "Chrome_WidgetWin_1", "YouTube Music", true),
        ];
        assert_eq!(pick_new_window(&before, &after, "Chrome_WidgetWin_1"), Some(5));
    }

    #[test]
    fn new_window_is_none_when_nothing_new_appeared() {
        let before = [1];
        let after = [window(1, 10, "Chrome_WidgetWin_1", "Other", true)];
        assert_eq!(pick_new_window(&before, &after, "Chrome_WidgetWin_1"), None);
    }

    #[test]
    fn hosted_window_moves_up_by_the_hidden_caption_height() {
        let dock = PhysicalRect { x: 560, y: 131, width: 340, height: 660 };
        assert_eq!(
            with_caption_hidden(dock, 31),
            PhysicalRect { x: 560, y: 100, width: 340, height: 691 }
        );
    }

    #[test]
    fn caption_height_scales_with_the_display() {
        assert_eq!(caption_height(1.0), 31);
        assert_eq!(caption_height(1.5), 47);
    }

    #[test]
    fn profile_placeholder_is_replaced_in_each_argument() {
        let args = vec!["--app=https://music.youtube.com".to_owned(), "--user-data-dir={profile}".to_owned()];
        assert_eq!(
            expand_args(&args, "C:/data/app-panel/brave"),
            vec!["--app=https://music.youtube.com".to_owned(), "--user-data-dir=C:/data/app-panel/brave".to_owned()]
        );
    }
}

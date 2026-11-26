//! App panel: host an installed browser's `--app` window inside the right dock.
//!
//! The window belongs to the user's own browser process (default profile, accounts
//! signed in). Safety rules that everything below follows:
//! - the browser process is never killed; a hosted window is closed with WM_CLOSE only;
//! - every hosted window is released (`SetParent(NULL)`, original style, geometry and
//!   region restored) when a tab is dropped, when the main window is destroyed, when the
//!   app exits and from a panic hook, so the browser window survives yerminal.
//!
//! Geometry, window selection and bookkeeping are portable and unit tested; the Win32
//! work lives behind `#[cfg(windows)]` and other platforms get an error stub.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Chromium's custom caption height at 100% scale, measured on Windows 11 (2026-11-26).
const CAPTION_HEIGHT_AT_100: f64 = 31.0;

/// Hosted window class of Chromium-based browsers (Chrome, Edge, Brave).
pub const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

pub const NO_BROWSER_MESSAGE: &str = "No supported browser found. Install Brave or Microsoft Edge.";

/// Dock content box from the webview, in device pixels relative to the main window client area.
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
    pub has_owner: bool,
}

/// The page sends the dock box in device pixels (CSS pixels times window.devicePixelRatio,
/// which includes the webview zoom); only rounding is left to do.
pub fn round_rect(rect: DockRect) -> PhysicalRect {
    PhysicalRect {
        x: rect.x.round() as i32,
        y: rect.y.round() as i32,
        width: rect.width.round() as i32,
        height: rect.height.round() as i32,
    }
}

/// Gap between a hosted window's outer rectangle and its client area: Chromium keeps
/// invisible frame bands (7 px left, right and bottom at 100%) even without WS_THICKFRAME.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Insets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// `window` is the outer rectangle in screen pixels, `client_origin` the screen position of the
/// client area's top left corner and `client_size` its width and height.
pub fn measure_insets(window: PhysicalRect, client_origin: (i32, i32), client_size: (i32, i32)) -> Insets {
    let left = (client_origin.0 - window.x).max(0);
    let top = (client_origin.1 - window.y).max(0);
    Insets {
        left,
        top,
        right: (window.width - client_size.0 - left).max(0),
        bottom: (window.height - client_size.1 - top).max(0),
    }
}

/// Outer window rectangle (relative to the parent client area) and the visible region
/// (relative to the window) so that only the page area shows, exactly on `dock`: the window
/// grows by the insets and by the caption band Chromium draws at the top of its client area,
/// and the region cuts all of them away.
pub fn hosted_frame(dock: PhysicalRect, insets: Insets, caption: i32) -> (PhysicalRect, PhysicalRect) {
    let window = PhysicalRect {
        x: dock.x - insets.left,
        y: dock.y - insets.top - caption,
        width: dock.width + insets.left + insets.right,
        height: dock.height + insets.top + caption + insets.bottom,
    };
    let visible = PhysicalRect {
        x: insets.left,
        y: insets.top + caption,
        width: dock.width,
        height: dock.height,
    };
    (window, visible)
}

/// Caption height in device pixels for a given scale factor.
pub fn caption_height(scale: f64) -> i32 {
    (CAPTION_HEIGHT_AT_100 * scale).round() as i32
}

// ---------------------------------------------------------------------------
// Browser choice and launch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Browser {
    pub name: &'static str,
    pub exe: PathBuf,
}

/// Install locations in preference order: Brave first, then Edge (ships with Windows).
pub fn browser_candidates(
    program_files: Option<&str>,
    program_files_x86: Option<&str>,
    local_app_data: Option<&str>,
) -> Vec<Browser> {
    let brave = ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"];
    let edge = ["Microsoft", "Edge", "Application", "msedge.exe"];
    let join = |root: &str, parts: &[&str]| parts.iter().fold(PathBuf::from(root), |p, c| p.join(c));
    let mut list = Vec::new();
    for root in [program_files, program_files_x86, local_app_data].into_iter().flatten() {
        list.push(Browser { name: "Brave", exe: join(root, &brave) });
    }
    for root in [program_files_x86, program_files].into_iter().flatten() {
        list.push(Browser { name: "Edge", exe: join(root, &edge) });
    }
    list
}

pub fn pick_browser<'a>(candidates: &'a [Browser], exists: &dyn Fn(&Path) -> bool) -> Option<&'a Browser> {
    candidates.iter().find(|b| exists(&b.exe))
}

/// Default profile: no `--user-data-dir`, so the user's own accounts are used. When the
/// browser already runs, the launcher hands the request over and exits.
pub fn app_launch_args(url: &str) -> Vec<String> {
    vec![format!("--app={url}")]
}

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

/// Main browser windows carry a browser-name suffix; `--app` windows show the page title.
pub fn is_main_browser_title(title: &str) -> bool {
    let clean: String = title.chars().filter(|c| *c != '\u{200b}').collect();
    [" - Brave", " - Microsoft Edge", " - Google Chrome", " - Chromium"]
        .iter()
        .any(|suffix| clean.ends_with(suffix))
}

fn is_app_candidate(w: &TopWindow, class: &str) -> bool {
    w.visible
        && !w.has_owner
        && w.class == class
        && !w.title.is_empty()
        && !is_main_browser_title(&w.title)
}

/// A new top-level app window (not a main browser window) that did not exist before the
/// launch. Used because the launcher hands over to the running browser and exits, so the
/// window cannot be found by process id.
pub fn pick_new_window(before: &[isize], after: &[TopWindow], class: &str) -> Option<isize> {
    after
        .iter()
        .find(|w| is_app_candidate(w, class) && !before.contains(&w.hwnd))
        .map(|w| w.hwnd)
}

fn title_matches_hint(title: &str, hint: &str) -> bool {
    title == hint
        || title.ends_with(&format!(" - {hint}"))
        || title.ends_with(&format!(" / {hint}"))
}

/// An app window for the same site that already exists (the browser focuses it instead
/// of opening a second one). `skip` holds windows already hosted.
pub fn pick_existing_app_window(
    windows: &[TopWindow],
    hint: &str,
    class: &str,
    skip: &[isize],
) -> Option<isize> {
    windows
        .iter()
        .find(|w| {
            is_app_candidate(w, class) && !skip.contains(&w.hwnd) && title_matches_hint(&w.title, hint)
        })
        .map(|w| w.hwnd)
}

// ---------------------------------------------------------------------------
// Styles and geometry that make a window embeddable and restorable
// ---------------------------------------------------------------------------

pub const STYLE_CHILD: isize = 0x4000_0000;
const STYLE_POPUP: isize = 0x8000_0000_u32 as i32 as isize;
const STYLE_CAPTION: isize = 0x00C0_0000;
const STYLE_THICKFRAME: isize = 0x0004_0000;
const STYLE_SYSMENU: isize = 0x0008_0000;
const STYLE_MINIMIZEBOX: isize = 0x0002_0000;
const STYLE_MAXIMIZEBOX: isize = 0x0001_0000;
pub const FRAME_STYLE_BITS: isize = STYLE_CAPTION
    | STYLE_THICKFRAME
    | STYLE_SYSMENU
    | STYLE_MINIMIZEBOX
    | STYLE_MAXIMIZEBOX
    | STYLE_POPUP;

pub fn embedded_style(style: isize) -> isize {
    (style & !FRAME_STYLE_BITS) | STYLE_CHILD
}

/// What a window looked like before it was hosted; applied again on release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub style: isize,
}

pub fn restore_geometry(saved: &Saved) -> PhysicalRect {
    PhysicalRect { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
}

// ---------------------------------------------------------------------------
// Hosted window bookkeeping
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub hwnd: isize,
    pub saved: Saved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PanelState {
    pub apps: Vec<String>,
    pub active: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    entries: Vec<Entry>,
    active: Option<String>,
}

impl Registry {
    pub fn add(&mut self, entry: Entry) {
        self.active = Some(entry.id.clone());
        self.entries.push(entry);
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries.iter().any(|e| e.id == id)
    }

    pub fn activate(&mut self, id: &str) -> bool {
        if self.contains(id) {
            self.active = Some(id.to_owned());
            true
        } else {
            false
        }
    }

    pub fn active_id(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn hwnds(&self) -> Vec<isize> {
        self.entries.iter().map(|e| e.hwnd).collect()
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Removes an entry; if it was active, the previous neighbour (else the next) becomes active.
    pub fn remove(&mut self, id: &str) -> Option<Entry> {
        let index = self.entries.iter().position(|e| e.id == id)?;
        let removed = self.entries.remove(index);
        if self.active.as_deref() == Some(id) {
            let next = index.checked_sub(1).or(if self.entries.is_empty() { None } else { Some(0) });
            self.active = next.and_then(|i| self.entries.get(i)).map(|e| e.id.clone());
        }
        Some(removed)
    }

    pub fn drain(&mut self) -> Vec<Entry> {
        self.active = None;
        std::mem::take(&mut self.entries)
    }

    /// Drops entries whose window no longer exists.
    pub fn prune(&mut self, alive: impl Fn(isize) -> bool) {
        let gone: Vec<String> = self
            .entries
            .iter()
            .filter(|e| !alive(e.hwnd))
            .map(|e| e.id.clone())
            .collect();
        for id in gone {
            self.remove(&id);
        }
    }

    pub fn state(&self) -> PanelState {
        PanelState {
            apps: self.entries.iter().map(|e| e.id.clone()).collect(),
            active: self.active.clone(),
        }
    }
}

/// Process-wide so that the exit paths and the panic hook can release windows too.
struct Panel {
    registry: Registry,
    /// False while an HTML dialog or menu needs the area the native window covers.
    shown: bool,
}

static PANEL: Mutex<Panel> = Mutex::new(Panel {
    registry: Registry { entries: Vec::new(), active: None },
    shown: true,
});

fn lock_panel() -> std::sync::MutexGuard<'static, Panel> {
    PANEL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn app_panel_open(
    app: tauri::AppHandle,
    id: String,
    url: String,
    title_hint: String,
    rect: DockRect,
) -> Result<PanelState, String> {
    imp::open(&app, &id, &url, &title_hint, rect)
}

#[tauri::command(async)]
pub fn app_panel_activate(app: tauri::AppHandle, id: String, rect: DockRect) -> Result<PanelState, String> {
    imp::activate(&app, &id, rect)
}

#[tauri::command(async)]
pub fn app_panel_place(app: tauri::AppHandle, rect: DockRect) -> Result<(), String> {
    imp::place(&app, rect)
}

#[tauri::command(async)]
pub fn app_panel_close(app: tauri::AppHandle, id: String, rect: DockRect) -> Result<PanelState, String> {
    imp::close(&app, &id, rect)
}

/// Hides or shows the hosted window (an HTML dialog or menu must not end up under it).
#[tauri::command(async)]
pub fn app_panel_set_visible(visible: bool) -> Result<(), String> {
    imp::set_visible(visible)
}

/// Live hosted apps and the active one; entries whose window vanished are dropped.
#[tauri::command(async)]
pub fn app_panel_state() -> Result<PanelState, String> {
    Ok(imp::state())
}

/// Gives every hosted window back to the desktop (called on exit and from the panic hook).
pub fn release_all() {
    imp::release_all(false);
}

/// Panic hook: must never block, so the lock is only tried.
pub fn install_panic_release() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        imp::release_all(true);
        previous(info);
    }));
}

/// Debug builds only (experiment): opens `YERMINAL_APP_PANEL_DEBUG_OPEN=<url>` in the dock a few
/// seconds after start, on a fixed dock box, so the lifecycle can be measured without clicking.
#[cfg(debug_assertions)]
pub fn debug_autoopen(app: tauri::AppHandle) {
    let Ok(url) = std::env::var("YERMINAL_APP_PANEL_DEBUG_OPEN") else { return };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let rect = DockRect { x: 500.0, y: 150.0, width: 640.0, height: 420.0 };
        if std::env::var("YERMINAL_APP_PANEL_FOLLOW").is_ok() {
            eprintln!("[app-panel debug] follow -> {:?}", imp::follow(&app, &url, "Example Domain", rect));
            return;
        }
        let result = imp::open(&app, "debug", &url, "Example Domain", rect);
        eprintln!("[app-panel debug] open -> {:?}", result.map(|s| s.apps));
    });
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, MoveWindow, PostMessageW, SetParent,
        SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_STYLE, GW_OWNER, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_CLOSE,
    };

    fn hwnd_of(raw: isize) -> HWND {
        raw as HWND
    }

    fn window_exists(raw: isize) -> bool {
        unsafe { IsWindow(hwnd_of(raw)) != 0 }
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
            has_owner: !GetWindow(hwnd, GW_OWNER).is_null(),
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

    fn find_browser() -> Result<Browser, String> {
        let env = |name: &str| std::env::var(name).ok();
        let list = browser_candidates(
            env("ProgramFiles").as_deref(),
            env("ProgramFiles(x86)").as_deref(),
            env("LOCALAPPDATA").as_deref(),
        );
        pick_browser(&list, &|p| p.exists())
            .cloned()
            .ok_or_else(|| NO_BROWSER_MESSAGE.to_owned())
    }

    /// Captures the window's current state, then makes it a frameless child of `parent`.
    fn embed(hwnd: isize, parent: isize) -> Saved {
        let h = hwnd_of(hwnd);
        unsafe {
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(h, &mut r);
            let style = GetWindowLongPtrW(h, GWL_STYLE);
            let saved = Saved {
                x: r.left,
                y: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
                style,
            };
            SetParent(h, hwnd_of(parent));
            SetWindowLongPtrW(h, GWL_STYLE, embedded_style(style));
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            saved
        }
    }

    /// Gives the window back to the desktop: no clip region, no parent, original style and
    /// geometry, visible. Does nothing when the window is already gone.
    fn release(entry: &Entry) {
        if !window_exists(entry.hwnd) {
            return;
        }
        let h = hwnd_of(entry.hwnd);
        let g = restore_geometry(&entry.saved);
        unsafe {
            SetWindowRgn(h, std::ptr::null_mut(), TRUE);
            SetParent(h, std::ptr::null_mut());
            SetWindowLongPtrW(h, GWL_STYLE, entry.saved.style);
            MoveWindow(h, g.x, g.y, g.width, g.height, TRUE);
            SetWindowPos(
                h,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
    }

    fn measure(hwnd: isize) -> Option<Insets> {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;
        let h = hwnd_of(hwnd);
        unsafe {
            let mut w = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            let mut c = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            let mut origin = POINT { x: 0, y: 0 };
            if GetWindowRect(h, &mut w) == 0 || GetClientRect(h, &mut c) == 0 || ClientToScreen(h, &mut origin) == 0 {
                return None;
            }
            let window = PhysicalRect { x: w.left, y: w.top, width: w.right - w.left, height: w.bottom - w.top };
            Some(measure_insets(window, (origin.x, origin.y), (c.right, c.bottom)))
        }
    }

    /// Places the hosted window so that its page area covers `dock` exactly. The insets are
    /// read from the live window; if resizing changed them, the window is placed once more.
    fn place_window(hwnd: isize, dock: PhysicalRect, caption: i32) {
        let h = hwnd_of(hwnd);
        let mut insets = measure(hwnd).unwrap_or_default();
        let mut placed = hosted_frame(dock, insets, caption);
        unsafe { MoveWindow(h, placed.0.x, placed.0.y, placed.0.width, placed.0.height, TRUE) };
        if let Some(after) = measure(hwnd) {
            if after != insets {
                insets = after;
                placed = hosted_frame(dock, insets, caption);
                unsafe { MoveWindow(h, placed.0.x, placed.0.y, placed.0.width, placed.0.height, TRUE) };
            }
        }
        let v = placed.1;
        unsafe {
            let region = CreateRectRgn(v.x, v.y, v.x + v.width, v.y + v.height);
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

    /// Shows only the active window (when the dock is shown) and places it on the dock.
    fn sync(panel: &Panel, scale: f64, rect: DockRect) {
        let caption = caption_height(scale);
        let dock = round_rect(rect);
        for entry in panel.registry.entries() {
            let is_active = panel.registry.active_id() == Some(entry.id.as_str());
            let h = hwnd_of(entry.hwnd);
            if is_active && panel.shown {
                place_window(entry.hwnd, dock, caption);
                unsafe { ShowWindow(h, SW_SHOWNOACTIVATE) };
            } else {
                unsafe { ShowWindow(h, SW_HIDE) };
            }
        }
    }

    /// Waits for the launched app window, or reuses an existing one for the same site.
    fn obtain_window(url: &str, hint: &str, hosted: &[isize]) -> Result<isize, String> {
        let existing = top_windows();
        if let Some(found) = pick_existing_app_window(&existing, hint, CHROMIUM_WINDOW_CLASS, hosted) {
            return Ok(found);
        }
        let browser = find_browser()?;
        let before: Vec<isize> = existing.iter().map(|w| w.hwnd).collect();
        // The child handle is dropped on purpose: the launcher is either the user's browser
        // itself or a stub that hands over and exits. Neither is ever killed from here.
        #[allow(unused_mut)]
        let mut args = app_launch_args(url);
        // Debug builds only: lets an experiment use a throwaway profile (never set in production).
        #[cfg(debug_assertions)]
        if let Ok(dir) = std::env::var("YERMINAL_APP_PANEL_PROFILE_DIR") {
            args.insert(0, format!("--user-data-dir={dir}"));
        }
        Command::new(&browser.exe)
            .args(args)
            .spawn()
            .map_err(|e| format!("Cannot start {}: {e}", browser.name))?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let windows = top_windows();
            if let Some(found) = pick_new_window(&before, &windows, CHROMIUM_WINDOW_CLASS) {
                return Ok(found);
            }
            if Instant::now() >= deadline {
                return pick_existing_app_window(&windows, hint, CHROMIUM_WINDOW_CLASS, hosted)
                    .ok_or_else(|| "The app window did not appear within 15 seconds".to_owned());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// SPIKE (debug only): "follow" mode. The browser window stays top-level (no parent, no
    /// owner, original style) and a thread keeps it on the dock box and just above the main
    /// window in z-order. Nothing ties its lifetime to yerminal.
    #[cfg(debug_assertions)]
    pub fn follow(app: &AppHandle, url: &str, hint: &str, rect: DockRect) -> Result<(), String> {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsIconic};
        let (main, scale) = main_window(app)?;
        let hwnd = obtain_window(url, hint, &[])?;
        let dock = round_rect(rect);
        let caption = caption_height(scale);
        std::thread::spawn(move || {
            let (m, h) = (hwnd_of(main), hwnd_of(hwnd));
            let mut last = None;
            while window_exists(hwnd) && window_exists(main) {
                unsafe {
                    if IsIconic(m) != 0 {
                        ShowWindow(h, SW_HIDE);
                        last = None;
                    } else {
                        let mut origin = POINT { x: 0, y: 0 };
                        ClientToScreen(m, &mut origin);
                        if last != Some((origin.x, origin.y)) {
                            let screen = PhysicalRect { x: dock.x + origin.x, y: dock.y + origin.y, ..dock };
                            place_window(hwnd, screen, caption);
                            last = Some((origin.x, origin.y));
                        }
                        ShowWindow(h, SW_SHOWNOACTIVATE);
                        let fg = GetForegroundWindow();
                        if fg == m || fg == h {
                            // main sits directly below the app window
                            SetWindowPos(m, h, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            if window_exists(hwnd) {
                unsafe { SetWindowRgn(hwnd_of(hwnd), std::ptr::null_mut(), TRUE) };
            }
        });
        Ok(())
    }

    pub fn open(app: &AppHandle, id: &str, url: &str, hint: &str, rect: DockRect) -> Result<PanelState, String> {
        let (main, scale) = main_window(app)?;
        {
            let mut panel = lock_panel();
            if panel.registry.activate(id) {
                sync(&panel, scale, rect);
                return Ok(panel.registry.state());
            }
        }
        let hosted = lock_panel().registry.hwnds();
        let hwnd = obtain_window(url, hint, &hosted)?;
        let saved = embed(hwnd, main);
        let mut panel = lock_panel();
        panel.shown = true;
        panel.registry.add(Entry { id: id.to_owned(), hwnd, saved });
        sync(&panel, scale, rect);
        Ok(panel.registry.state())
    }

    pub fn activate(app: &AppHandle, id: &str, rect: DockRect) -> Result<PanelState, String> {
        let (_, scale) = main_window(app)?;
        let mut panel = lock_panel();
        panel.registry.prune(window_exists);
        panel.registry.activate(id);
        sync(&panel, scale, rect);
        Ok(panel.registry.state())
    }

    pub fn place(app: &AppHandle, rect: DockRect) -> Result<(), String> {
        let (_, scale) = main_window(app)?;
        let panel = lock_panel();
        sync(&panel, scale, rect);
        Ok(())
    }

    /// Closes one hosted window with WM_CLOSE. The browser process is not touched.
    pub fn close(app: &AppHandle, id: &str, rect: DockRect) -> Result<PanelState, String> {
        let (_, scale) = main_window(app)?;
        let removed = lock_panel().registry.remove(id);
        if let Some(entry) = removed {
            unsafe {
                PostMessageW(hwnd_of(entry.hwnd), WM_CLOSE, 0, 0);
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline && window_exists(entry.hwnd) {
                std::thread::sleep(Duration::from_millis(50));
            }
            if window_exists(entry.hwnd) {
                // The page vetoed the close (e.g. an unload prompt): hand it back instead of killing anything.
                release(&entry);
            }
        }
        let panel = lock_panel();
        sync(&panel, scale, rect);
        Ok(panel.registry.state())
    }

    pub fn set_visible(visible: bool) -> Result<(), String> {
        let mut panel = lock_panel();
        panel.shown = visible;
        for entry in panel.registry.entries() {
            let is_active = panel.registry.active_id() == Some(entry.id.as_str());
            let flag = if is_active && visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
            unsafe { ShowWindow(hwnd_of(entry.hwnd), flag) };
        }
        Ok(())
    }

    pub fn state() -> PanelState {
        let mut panel = lock_panel();
        panel.registry.prune(window_exists);
        panel.registry.state()
    }

    pub fn release_all(non_blocking: bool) {
        let drained = if non_blocking {
            match PANEL.try_lock() {
                Ok(mut panel) => panel.registry.drain(),
                Err(_) => return,
            }
        } else {
            lock_panel().registry.drain()
        };
        for entry in &drained {
            release(entry);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use tauri::AppHandle;

    const UNSUPPORTED: &str = "App panel is available on Windows only";

    pub fn open(_app: &AppHandle, _id: &str, _url: &str, _hint: &str, _rect: DockRect) -> Result<PanelState, String> {
        Err(UNSUPPORTED.to_owned())
    }

    pub fn activate(_app: &AppHandle, _id: &str, _rect: DockRect) -> Result<PanelState, String> {
        Err(UNSUPPORTED.to_owned())
    }

    #[cfg(debug_assertions)]
    pub fn follow(_app: &AppHandle, _url: &str, _hint: &str, _rect: DockRect) -> Result<(), String> {
        Err(UNSUPPORTED.to_owned())
    }

    pub fn place(_app: &AppHandle, _rect: DockRect) -> Result<(), String> {
        Ok(())
    }

    pub fn close(_app: &AppHandle, _id: &str, _rect: DockRect) -> Result<PanelState, String> {
        Ok(PanelState { apps: Vec::new(), active: None })
    }

    pub fn set_visible(_visible: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn state() -> PanelState {
        PanelState { apps: Vec::new(), active: None }
    }

    pub fn release_all(_non_blocking: bool) {}
}

#[cfg(test)]
#[path = "app_panel_tests.rs"]
mod tests;

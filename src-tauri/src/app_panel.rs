//! App panel: host an installed browser's `--app` window inside the right dock.
//!
//! The window belongs to the user's own browser process (default profile, accounts
//! signed in). Safety rules that everything below follows:
//! - the browser process is never killed; a hosted window is closed with WM_CLOSE only;
//! - every hosted window is released (clip region removed, original geometry restored) when a tab is dropped, when the main window is destroyed, when the app exits and from a panic hook;
//! - follow mode: the browser window stays top-level (no parent, no owner, style untouched). A
//!   40 ms loop keeps it on the dock box, hides it with the main window and keeps the main
//!   window directly below it in z-order.
//!
//! Geometry, window selection and bookkeeping are portable and unit tested; the Win32
//! work lives behind `#[cfg(windows)]` and other platforms get an error stub.

use crate::app_panel_rescue::{self, RescueFile, RescueWindow};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Chromium's custom caption height at 100% scale, measured on Windows 11 (2026-11-26).
const CAPTION_HEIGHT_AT_100: f64 = 31.0;

/// Hosted window class of Chromium-based browsers (Chrome, Edge, Brave).
/// Follow loop period: a few window queries per tick, placement only when something changed.
#[cfg(windows)]
const FOLLOW_INTERVAL_MS: u64 = 40;
/// Shortest time between two repairs of a window that changed behind our back.
const DRIFT_REPAIR_MIN_MS: u64 = 200;

pub const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

pub const NO_BROWSER_MESSAGE: &str = "No supported browser found. Install Brave or Microsoft Edge.";

/// Shown when the launch produced no new window (the browser may have only focused one that was already open).
pub const NO_NEW_WINDOW_MESSAGE: &str =
    "No new app window appeared. It is probably already open in your browser: close that window and try again.";

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
    /// Full path of the executable that owns the window (empty when it could not be read).
    pub exe: String,
    /// GWL_STYLE and GWL_EXSTYLE.
    pub style: u32,
    pub ex_style: u32,
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

/// Height of everything Chromium draws above the page inside its client area (caption, plus
/// infobars such as the first-run analytics notice). `content_offset` is where the page widget
/// (`Chrome_RenderWidgetHostHWND`) starts, relative to the top of the outer window rectangle;
/// without a plausible measurement the scaled caption height is used.
pub fn top_band(content_offset: Option<i32>, top_inset: i32, scale: f64) -> i32 {
    match content_offset.map(|offset| offset - top_inset) {
        Some(band) if band > 0 => band,
        _ => caption_height(scale),
    }
}

/// DWMWA_SYSTEMBACKDROP_TYPE value for "none".
pub const BACKDROP_NONE: i32 = 1;

/// The Windows 11 system backdrop is painted over the whole window rectangle and ignores the
/// clip region, so it has to be off while a window is hosted. `current` is the live value;
/// returns the value to set, or `None` when nothing needs to change.
pub fn backdrop_change(current: i32) -> Option<i32> {
    (current != BACKDROP_NONE).then_some(BACKDROP_NONE)
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

const WS_POPUP: u32 = 0x8000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;

/// Same file, whatever the case or slash style. An unknown (empty) path matches nothing.
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('/', "\\").to_lowercase();
    !a.is_empty() && norm(a) == norm(b)
}

/// A window the launched browser could have opened for an `--app` launch: it belongs to the browser
/// executable, is visible, has no owner, is a captioned top-level window (not a popup, tool window
/// or bubble) and is not a DevTools window. Other Chromium-class windows (VS Code, Electron apps)
/// never qualify, whatever their title.
fn is_app_candidate(w: &TopWindow, class: &str, browser: &str) -> bool {
    w.visible
        && !w.has_owner
        && w.class == class
        && same_path(&w.exe, browser)
        && w.style & WS_CAPTION == WS_CAPTION
        && w.style & WS_POPUP == 0
        && w.ex_style & WS_EX_TOOLWINDOW == 0
        && !w.title.is_empty()
        && !w.title.starts_with("DevTools")
        && !is_main_browser_title(&w.title)
}

/// The app window this launch caused: a top-level window (not a main browser window) that did not
/// exist before it. Windows that were already open are never taken, whatever their title, so the
/// user's own windows stay theirs. Among new windows the one titled like the app wins; any other
/// new window is taken as a fallback because the page may not have set its title yet. The launcher
/// hands over to the running browser and exits, so the window cannot be found by the process this
/// code started; it is recognised by the executable that owns it (`browser`) instead.
pub fn pick_new_window(before: &[isize], after: &[TopWindow], class: &str, hint: &str, browser: &str) -> Option<isize> {
    let mut fresh = after.iter().filter(|w| is_app_candidate(w, class, browser) && !before.contains(&w.hwnd));
    let first = fresh.next()?;
    let matching = std::iter::once(first).chain(fresh).find(|w| title_matches_hint(&w.title, hint));
    Some(matching.unwrap_or(first).hwnd)
}

fn title_matches_hint(title: &str, hint: &str) -> bool {
    title == hint
        || title.ends_with(&format!(" - {hint}"))
        || title.ends_with(&format!(" / {hint}"))
}

// ---------------------------------------------------------------------------
// Styles and geometry that make a window embeddable and restorable
// ---------------------------------------------------------------------------

/// Dock box (relative to the main client area) in screen pixels.
pub fn to_screen(dock: PhysicalRect, client_origin: (i32, i32)) -> PhysicalRect {
    PhysicalRect { x: dock.x + client_origin.0, y: dock.y + client_origin.1, ..dock }
}

/// What the follow loop wants right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wanted {
    pub hwnd: Option<isize>,
    /// False while an HTML dialog or menu needs the area, or the dock is collapsed.
    pub shown: bool,
    pub main_minimized: bool,
    /// Dock box in screen pixels, when the page has reported one.
    pub screen: Option<PhysicalRect>,
    /// The hosted window went full screen on its own (see `is_fullscreen`).
    pub fullscreen: bool,
    /// The hosted window as it is right now (None when it could not be read).
    pub live: Option<Live>,
}

/// What a hosted window looks like right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Live {
    /// Outer rectangle in screen pixels.
    pub outer: PhysicalRect,
    /// Bounding box of its clip region (relative to the window); None without a region.
    pub clip: Option<PhysicalRect>,
    /// The window is maximised (WS_MAXIMIZE); a placement cannot move such a window.
    pub zoomed: bool,
}

/// The outer rectangle and clip box read back right after a placement; what the window is
/// expected to look like until something changes it behind our back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placed {
    pub outer: PhysicalRect,
    pub clip: PhysicalRect,
}

/// What was last applied to the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Applied {
    pub hwnd: Option<isize>,
    pub visible: bool,
    pub rect: Option<PhysicalRect>,
    /// Placement, clipping and z-order are paused because the window is full screen.
    pub suspended: bool,
    /// How the window looked right after the last placement.
    pub placed: Option<Placed>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Plan {
    pub hide_others: bool,
    pub hide: bool,
    pub place: Option<PhysicalRect>,
    pub show: bool,
    /// Remove the clip region and leave the window exactly as it is (full screen).
    pub suspend: bool,
}

/// Tolerance for Chromium's invisible frame bands and rounding.
const FULLSCREEN_SLACK: i32 = 16;

/// True when `window` (outer rectangle, screen pixels) covers its whole `monitor`, which means
/// the page went full screen (a video's full screen button). `target` is the dock box the window
/// was asked to sit on: a dock that is itself monitor-sized never counts as full screen. A maximised
/// window (`zoomed`) overshoots the monitor just like a full screen one but is not: Chromium leaves
/// maximised state before it goes full screen.
pub fn is_fullscreen(window: PhysicalRect, monitor: PhysicalRect, target: Option<PhysicalRect>, zoomed: bool) -> bool {
    let covers = |r: PhysicalRect| {
        r.x <= monitor.x + FULLSCREEN_SLACK
            && r.y <= monitor.y + FULLSCREEN_SLACK
            && r.x + r.width >= monitor.x + monitor.width - FULLSCREEN_SLACK
            && r.y + r.height >= monitor.y + monitor.height - FULLSCREEN_SLACK
    };
    !zoomed && !target.is_some_and(covers) && covers(window)
}

/// Decides the minimum work for one tick, so an idle loop costs a few cheap queries only.
pub fn plan_follow(applied: &Applied, wanted: &Wanted) -> Plan {
    let visible = wanted.shown && !wanted.main_minimized && wanted.hwnd.is_some() && wanted.screen.is_some();
    let switched = applied.hwnd != wanted.hwnd;
    if !visible {
        return Plan { hide: applied.visible || switched, ..Plan::default() };
    }
    if wanted.fullscreen {
        // Leave the window exactly as the page made it; clear our clip once.
        let already = applied.suspended && !switched;
        return Plan { hide_others: switched, show: switched || !applied.visible, suspend: !already, ..Plan::default() };
    }
    // The window (or its clip) changed behind our back: Chromium resets the region on its own
    // resize handling and a maximised window ignores moves. A cached box must not hide that.
    let drifted = !switched
        && applied.visible
        && !applied.suspended
        && match (applied.placed, wanted.live) {
            (Some(placed), Some(live)) => live.zoomed || live.outer != placed.outer || live.clip != Some(placed.clip),
            _ => false,
        };
    Plan {
        hide_others: switched,
        hide: false,
        suspend: false,
        place: if switched || drifted || applied.rect != wanted.screen { wanted.screen } else { None },
        show: switched || !applied.visible,
    }
}

/// What to do about the stacking order of yerminal and the hosted app window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZAction {
    Keep,
    /// Put yerminal directly below the app window (the app window is in front, yerminal is behind it).
    MainBelowApp,
    /// Put the app window directly above yerminal: it goes under `after` (the window that is
    /// above yerminal, if any), or to the top when there is none. Yerminal does not move.
    AppAboveMain { after: Option<isize> },
}

/// Keeps the app window glued above yerminal without ever pushing yerminal behind another window.
/// Only reorders while yerminal or the app window is the one in use; with another application in
/// front, both stay under it. `main_prev` is the window directly above yerminal (None: on top).
pub fn z_action(foreground: isize, main: isize, app: isize, main_prev: Option<isize>) -> ZAction {
    if main_prev == Some(app) {
        return ZAction::Keep;
    }
    if foreground == app {
        ZAction::MainBelowApp
    } else if foreground == main {
        ZAction::AppAboveMain { after: main_prev }
    } else {
        ZAction::Keep
    }
}

/// What a window looked like before it was hosted; applied again on release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub fn restore_geometry(saved: &Saved) -> PhysicalRect {
    PhysicalRect { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
}

// ---------------------------------------------------------------------------
// Snapshot: a still image of the hosted window, shown while an HTML dialog needs the area
// ---------------------------------------------------------------------------

/// Crops a top-down BGRA image to `crop` (clamped to the image). None when nothing is left or
/// the buffer does not match the stated size.
pub fn crop_bgra(src: &[u8], src_w: i32, src_h: i32, crop: PhysicalRect) -> Option<(i32, i32, Vec<u8>)> {
    if src_w <= 0 || src_h <= 0 || src.len() != (src_w as usize) * (src_h as usize) * 4 {
        return None;
    }
    let x0 = crop.x.max(0);
    let y0 = crop.y.max(0);
    let x1 = crop.x.saturating_add(crop.width).min(src_w);
    let y1 = crop.y.saturating_add(crop.height).min(src_h);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (w, h) = (x1 - x0, y1 - y0);
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for y in y0..y1 {
        let start = ((y * src_w + x0) as usize) * 4;
        out.extend_from_slice(&src[start..start + (w as usize) * 4]);
    }
    Some((w, h, out))
}

/// A failed capture (GPU surface not readable) comes back all black: sample the image and
/// report it, so the panel shows its placeholder instead of a black rectangle.
pub fn looks_blank(pixels: &[u8]) -> bool {
    let count = pixels.len() / 4;
    if count == 0 {
        return true;
    }
    let step = (count / 4096).max(1);
    !(0..count).step_by(step).any(|i| pixels[i * 4] != 0 || pixels[i * 4 + 1] != 0 || pixels[i * 4 + 2] != 0)
}

/// Payload for the page: width and height as little-endian u32, then raw BGRA rows.
pub fn snapshot_bytes(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + pixels.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(pixels);
    out
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
///
/// Lock rules (a browser window that does not answer must never freeze yerminal):
/// - `PANEL` is held for bookkeeping only, never across a call into a foreign window;
/// - the window calls of one pass run under `DRIVER` alone (see `run_pass`), which also keeps
///   passes from overlapping; order is always `DRIVER` then `PANEL`;
/// - exit paths wait for either lock with a time limit (`try_lock_for`).
struct Panel {
    registry: Registry,
    /// False while an HTML dialog or menu needs the area the native window covers.
    shown: bool,
    /// Latest dock box from the page (client relative, device pixels): the follow loop's target.
    dock: Option<PhysicalRect>,
    main: isize,
    scale: f64,
    /// Copy of what the last pass applied (the driver owns the original); readers use this one.
    applied: Applied,
    /// True while the follow thread runs (it stops when the last window is gone).
    following: bool,
    /// App data folder that holds the rescue file (see `app_panel_rescue`).
    rescue_dir: Option<PathBuf>,
}

static PANEL: Mutex<Panel> = Mutex::new(Panel {
    registry: Registry { entries: Vec::new(), active: None },
    shown: true,
    dock: None,
    main: 0,
    scale: 1.0,
    applied: Applied { hwnd: None, visible: false, rect: None, suspended: false, placed: None },
    following: false,
    rescue_dir: None,
});

fn lock_panel() -> std::sync::MutexGuard<'static, Panel> {
    PANEL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// State that only the window passes use; whoever holds this lock is the one thread allowed to
/// touch the hosted windows.
struct Driver {
    applied: Applied,
    /// Band above the page that the last placement clipped away (device pixels).
    band: i32,
    /// When the last placement happened (drift repairs are rate limited).
    placed_at: Option<std::time::Instant>,
    /// What the rescue file contains right now (rewritten only when it changes).
    rescue_last: Option<RescueFile>,
    /// The watchdog process was started.
    watchdog: bool,
}

static DRIVER: Mutex<Driver> = Mutex::new(Driver {
    applied: Applied { hwnd: None, visible: false, rect: None, suspended: false, placed: None },
    band: 0,
    placed_at: None,
    rescue_last: None,
    watchdog: false,
});

fn lock_driver() -> std::sync::MutexGuard<'static, Driver> {
    DRIVER.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a pass needs from the panel, copied under the lock so the window calls can run without it.
#[derive(Debug, Clone)]
struct Inputs {
    main: isize,
    scale: f64,
    dock: Option<PhysicalRect>,
    shown: bool,
    active: Option<isize>,
    entries: Vec<Entry>,
    rescue_dir: Option<PathBuf>,
}

impl Inputs {
    fn capture(panel: &Panel) -> Inputs {
        let active = panel
            .registry
            .active_id()
            .and_then(|id| panel.registry.entries().iter().find(|e| e.id == id))
            .map(|e| e.hwnd);
        Inputs {
            main: panel.main,
            scale: panel.scale,
            dock: panel.dock,
            shown: panel.shown,
            active,
            entries: panel.registry.entries().to_vec(),
            rescue_dir: panel.rescue_dir.clone(),
        }
    }
}

/// One pass over the screen: copy the inputs (short `PANEL` lock), make the window calls with no
/// `PANEL` lock held, then publish what was applied (short lock again).
#[cfg_attr(not(windows), allow(dead_code))]
fn run_pass(exec: impl FnOnce(&Inputs, &mut Driver)) {
    let mut driver = lock_driver();
    let inputs = Inputs::capture(&lock_panel());
    exec(&inputs, &mut driver);
    lock_panel().applied = driver.applied;
}

/// The rescue file may be deleted only when the windows were given back and no earlier release was
/// abandoned (the exit path calls `release_all` twice; the second call finds nothing left to do).
#[cfg_attr(not(windows), allow(dead_code))]
fn rescue_file_may_go(finished: bool, abandoned_before: bool) -> bool {
    finished && !abandoned_before
}

/// `lock` with a time limit; `None` when somebody keeps it longer. Poisoning is ignored.
pub fn try_lock_for<T>(mutex: &'static Mutex<T>, limit: std::time::Duration) -> Option<std::sync::MutexGuard<'static, T>> {
    let deadline = std::time::Instant::now() + limit;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Runs `work` on its own thread and waits at most `limit` for the result. A call that never
/// returns (a hung browser window) is abandoned instead of freezing the caller.
pub fn run_bounded<T: Send + 'static>(limit: std::time::Duration, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    rx.recv_timeout(limit).ok()
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

/// One still frame of the active hosted window (the visible part only), taken just before the
/// window is hidden for a dialog. Raw bytes (see `snapshot_bytes`); an error means "no image".
#[tauri::command(async)]
pub fn app_panel_snapshot() -> Result<tauri::ipc::Response, String> {
    imp::snapshot().map(tauri::ipc::Response::new)
}

/// Live hosted apps and the active one; entries whose window vanished are dropped.
#[tauri::command(async)]
pub fn app_panel_state() -> Result<PanelState, String> {
    Ok(imp::state())
}

/// Start-up fallback for windows a dead yerminal left behind (see `app_panel_rescue`).
pub fn rescue_orphans(app: &tauri::AppHandle) {
    imp::rescue_orphans(app);
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
        let result = imp::open(&app, "debug", &url, "Example Domain", rect);
        eprintln!("[app-panel debug] open -> {:?}", result.map(|s| s.apps));
        // Capture measurement: three frames (cold, then warm) and the last one dumped as a raw file.
        if let Ok(dump) = std::env::var("YERMINAL_APP_PANEL_SNAPSHOT_DUMP") {
            std::thread::sleep(std::time::Duration::from_secs(4));
            for round in 0..3 {
                let started = std::time::Instant::now();
                let frame = imp::snapshot();
                eprintln!(
                    "[app-panel debug] snapshot {round}: {:?} in {:?}",
                    frame.as_ref().map(|b| b.len()),
                    started.elapsed()
                );
                if let (Ok(bytes), 2) = (frame, round) {
                    let _ = std::fs::write(&dump, bytes);
                }
            }
        }
    });
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateRectRgn, GetMonitorInfoW, GetWindowRgnBox, MonitorFromWindow, SetWindowRgn, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowRect, GetWindowTextW,
        GetWindowLongPtrW, GetWindowThreadProcessId, IsHungAppWindow, IsIconic, IsWindow, IsWindowVisible, IsZoomed, MoveWindow, PostMessageW,
        SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, GW_HWNDPREV, GW_OWNER, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SW_HIDE, SW_RESTORE, SW_SHOWNOACTIVATE, WM_CLOSE,
    };

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: HWND, attr: u32, value: *const i32, size: u32) -> i32;
        fn DwmGetWindowAttribute(hwnd: HWND, attr: u32, value: *mut i32, size: u32) -> i32;
    }

    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;

    /// Backdrop values of windows we switched off, restored on release.
    static BACKDROPS: Mutex<Vec<(isize, i32)>> = Mutex::new(Vec::new());

    /// Switches the system backdrop off (remembering the original), re-checked on every
    /// placement because the browser may set it again.
    fn flatten(hwnd: isize) {
        let h = hwnd_of(hwnd);
        let mut current = -1i32;
        let hr = unsafe { DwmGetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, &mut current, 4) };
        if hr != 0 {
            return;
        }
        if let Some(value) = backdrop_change(current) {
            let mut saved = BACKDROPS.lock().unwrap_or_else(|p| p.into_inner());
            if !saved.iter().any(|(w, _)| *w == hwnd) {
                saved.push((hwnd, current));
            }
            drop(saved);
            unsafe { DwmSetWindowAttribute(h, DWMWA_SYSTEMBACKDROP_TYPE, &value, 4) };
        }
    }

    fn restore_backdrop(hwnd: isize) {
        let original = {
            let mut saved = BACKDROPS.lock().unwrap_or_else(|p| p.into_inner());
            saved.iter().position(|(w, _)| *w == hwnd).map(|i| saved.remove(i).1)
        };
        if let Some(value) = original {
            unsafe { DwmSetWindowAttribute(hwnd_of(hwnd), DWMWA_SYSTEMBACKDROP_TYPE, &value, 4) };
        }
    }

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

    /// Full path of the executable of a process; empty when it cannot be read.
    fn process_image(pid: u32) -> String {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return String::new();
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..len as usize])
        }
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
        let list = &mut *(lparam as *mut Vec<TopWindow>);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let class = class_name(hwnd);
        // The owner's image path is only looked up for windows that could be a browser window.
        let exe = if class == CHROMIUM_WINDOW_CLASS { process_image(pid) } else { String::new() };
        list.push(TopWindow {
            hwnd: hwnd as isize,
            pid,
            class,
            title: window_title(hwnd),
            visible: IsWindowVisible(hwnd) != 0,
            has_owner: !GetWindow(hwnd, GW_OWNER).is_null(),
            exe,
            style: GetWindowLongPtrW(hwnd, GWL_STYLE) as u32,
            ex_style: GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
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

    /// Remembers where the window was. Follow mode never reparents or restyles it.
    fn capture(hwnd: isize) -> Saved {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(hwnd_of(hwnd), &mut r) };
        Saved { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
    }

    /// Gives the window back to the desktop: no clip region, original geometry, visible.
    /// Does nothing when the window is already gone.
    fn release(entry: &Entry) {
        if !window_exists(entry.hwnd) {
            return;
        }
        let h = hwnd_of(entry.hwnd);
        let g = restore_geometry(&entry.saved);
        unsafe {
            SetWindowRgn(h, std::ptr::null_mut(), TRUE);
            restore_backdrop(entry.hwnd);
            MoveWindow(h, g.x, g.y, g.width, g.height, TRUE);
            ShowWindow(h, SW_SHOWNOACTIVATE);
        }
    }

    /// Outer rectangle, clip box and maximised state of the window right now.
    fn live_state(hwnd: isize) -> Option<Live> {
        let h = hwnd_of(hwnd);
        unsafe {
            let mut w = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(h, &mut w) == 0 {
                return None;
            }
            let mut c = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            // 0 = error (no region), 1 = empty region, 2 and 3 = a region with a box.
            let clip = (GetWindowRgnBox(h, &mut c) > 0)
                .then_some(PhysicalRect { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top });
            Some(Live {
                outer: PhysicalRect { x: w.left, y: w.top, width: w.right - w.left, height: w.bottom - w.top },
                clip,
                zoomed: IsZoomed(h) != 0,
            })
        }
    }

    /// True while the hosted window covers its monitor (the page went full screen).
    fn window_is_fullscreen(hwnd: isize, target: Option<PhysicalRect>, zoomed: bool) -> bool {
        let h = hwnd_of(hwnd);
        unsafe {
            let mut w = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(h, &mut w) == 0 {
                return false;
            }
            let monitor = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return false;
            }
            let m = info.rcMonitor;
            let window = PhysicalRect { x: w.left, y: w.top, width: w.right - w.left, height: w.bottom - w.top };
            let monitor = PhysicalRect { x: m.left, y: m.top, width: m.right - m.left, height: m.bottom - m.top };
            is_fullscreen(window, monitor, target, zoomed)
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

    unsafe extern "system" fn find_content(hwnd: HWND, lparam: LPARAM) -> i32 {
        let found = &mut *(lparam as *mut Option<HWND>);
        if class_name(hwnd) == "Chrome_RenderWidgetHostHWND" {
            *found = Some(hwnd);
            return 0;
        }
        TRUE
    }

    /// Top of the page widget relative to the top of the outer window, in device pixels.
    fn content_offset(hwnd: isize) -> Option<i32> {
        let h = hwnd_of(hwnd);
        let mut found: Option<HWND> = None;
        let mut w = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let mut c = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe {
            EnumChildWindows(h, Some(find_content), &mut found as *mut Option<HWND> as LPARAM);
            let content = found?;
            if GetWindowRect(h, &mut w) == 0 || GetWindowRect(content, &mut c) == 0 || c.bottom <= c.top {
                return None;
            }
        }
        Some(c.top - w.top)
    }

    /// Insets and the live height of the band above the page.
    fn measure_frame(hwnd: isize, scale: f64) -> (Insets, i32) {
        let insets = measure(hwnd).unwrap_or_default();
        (insets, top_band(content_offset(hwnd), insets.top, scale))
    }

    /// Places the hosted window so that its page area covers `dock` exactly. The insets and the
    /// band above the page are read from the live window; if resizing changed them (an infobar
    /// can wrap at another width), the window is placed once more. Returns the band used.
    fn place_window(hwnd: isize, dock: PhysicalRect, scale: f64) -> (i32, Option<Placed>) {
        let h = hwnd_of(hwnd);
        flatten(hwnd);
        // A maximised window ignores MoveWindow (it snaps back to the monitor): leave that state first.
        if unsafe { IsZoomed(h) } != 0 {
            unsafe { ShowWindow(h, SW_RESTORE) };
        }
        let mut frame = measure_frame(hwnd, scale);
        let mut placed = hosted_frame(dock, frame.0, frame.1);
        unsafe { MoveWindow(h, placed.0.x, placed.0.y, placed.0.width, placed.0.height, TRUE) };
        let after = measure_frame(hwnd, scale);
        if after != frame {
            frame = after;
            placed = hosted_frame(dock, frame.0, frame.1);
            unsafe { MoveWindow(h, placed.0.x, placed.0.y, placed.0.width, placed.0.height, TRUE) };
        }
        let v = placed.1;
        unsafe {
            let region = CreateRectRgn(v.x, v.y, v.x + v.width, v.y + v.height);
            SetWindowRgn(h, region, TRUE);
        }
        // Read back what the window really looks like (Chromium may clamp the size), so a later
        // difference means somebody changed it and not that we asked for something unreachable.
        let placed = live_state(hwnd).map(|live| Placed { outer: live.outer, clip: live.clip.unwrap_or(v) });
        (frame.1, placed)
    }

    fn main_window(app: &AppHandle) -> Result<(isize, f64), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is missing".to_owned())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        Ok((hwnd, scale))
    }

    fn client_origin(main: isize) -> Option<(i32, i32)> {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
        let mut origin = POINT { x: 0, y: 0 };
        (unsafe { ClientToScreen(hwnd_of(main), &mut origin) } != 0).then_some((origin.x, origin.y))
    }

    /// Brings the screen in line with the panel state (see `run_pass`; runs under the driver lock
    /// only, never under the panel lock). The hosted window stays a top-level window with no owner
    /// or parent; it is moved onto the dock box in screen pixels and the main window is kept
    /// directly below it.
    fn execute(i: &Inputs, d: &mut Driver) {
        if !window_exists(i.main) {
            return;
        }
        let Some(origin) = client_origin(i.main) else { return };
        let active = i.active;
        // A hosted window that does not answer is left alone this pass (a call into it would block).
        if i.entries.iter().any(|e| is_hung(e.hwnd)) {
            return;
        }
        let screen = i.dock.map(|d| to_screen(d, origin));
        let live = active.and_then(live_state);
        let wanted = Wanted {
            hwnd: active,
            shown: i.shown,
            main_minimized: unsafe { IsIconic(hwnd_of(i.main)) } != 0,
            screen,
            fullscreen: active.is_some_and(|hwnd| window_is_fullscreen(hwnd, screen, live.is_some_and(|l| l.zoomed))),
            live,
        };
        let mut plan = plan_follow(&d.applied, &wanted);
        // A repair that only came from drift is rate limited: a window that keeps changing itself
        // right after each placement must not be moved every tick.
        let repair_only = plan.place.is_some() && d.applied.hwnd == active && d.applied.rect == screen;
        if repair_only && d.placed_at.is_some_and(|at| at.elapsed() < Duration::from_millis(DRIFT_REPAIR_MIN_MS)) {
            plan.place = None;
        }
        // Page content can move inside the window after it was placed (the first draw, an infobar
        // appearing or going away): re-place at the same box when the measured band changed.
        if let (Some(hwnd), None, false, true, false) =
            (active, plan.place, plan.hide, d.applied.visible, wanted.fullscreen)
        {
            if d.applied.hwnd == active && d.applied.rect.is_some() {
                flatten(hwnd);
                if measure_frame(hwnd, i.scale).1 != d.band {
                    plan.place = d.applied.rect;
                }
            }
        }
        let scale = i.scale;
        if plan.hide {
            for entry in &i.entries {
                unsafe { ShowWindow(hwnd_of(entry.hwnd), SW_HIDE) };
            }
        } else if plan.hide_others {
            for entry in i.entries.iter().filter(|e| Some(e.hwnd) != active) {
                unsafe { ShowWindow(hwnd_of(entry.hwnd), SW_HIDE) };
            }
        }
        if let (Some(hwnd), true) = (active, plan.suspend) {
            unsafe { SetWindowRgn(hwnd_of(hwnd), std::ptr::null_mut(), TRUE) };
        }
        let mut placed = d.applied.placed;
        if let (Some(hwnd), Some(rect)) = (active, plan.place) {
            let (band, after) = place_window(hwnd, rect, scale);
            d.band = band;
            d.placed_at = Some(Instant::now());
            placed = after;
        }
        if let (Some(hwnd), true) = (active, plan.show) {
            unsafe { ShowWindow(hwnd_of(hwnd), SW_SHOWNOACTIVATE) };
        }
        let visible = !plan.hide && (plan.show || d.applied.visible && wanted.hwnd == d.applied.hwnd);
        if let (Some(hwnd), true, false) = (active, visible, wanted.fullscreen) {
            // Only reorder while yerminal or the app window is the one in use, and only when the
            // main window is not already directly below the app window.
            // Asynchronous: the app window belongs to another process, and a call that waits for
            // it would hang with it.
            const FLAGS: u32 = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
            unsafe {
                let (m, h) = (hwnd_of(i.main), hwnd_of(hwnd));
                let above = GetWindow(m, GW_HWNDPREV);
                let main_prev = (!above.is_null()).then_some(above as isize);
                match z_action(GetForegroundWindow() as isize, i.main, hwnd, main_prev) {
                    ZAction::Keep => {}
                    ZAction::MainBelowApp => {
                        SetWindowPos(m, h, 0, 0, 0, 0, FLAGS);
                    }
                    ZAction::AppAboveMain { after } => {
                        SetWindowPos(h, after.map_or(std::ptr::null_mut(), hwnd_of), 0, 0, 0, 0, FLAGS);
                    }
                }
            }
        }
        d.applied = if plan.hide {
            Applied { hwnd: active, visible: false, rect: None, suspended: false, placed: None }
        } else if wanted.fullscreen && visible {
            // The next placement happens when the window is back to normal size.
            Applied { hwnd: active, visible, rect: None, suspended: true, placed: None }
        } else {
            Applied {
                hwnd: active,
                visible,
                rect: if plan.place.is_some() { plan.place } else { d.applied.rect },
                suspended: false,
                placed,
            }
        };
        sync_rescue(i, d);
    }

    /// True when the window's owner does not process messages: a call into it would block.
    fn is_hung(raw: isize) -> bool {
        unsafe { IsHungAppWindow(hwnd_of(raw)) != 0 }
    }

    /// One pass over the screen, for the commands and the follow loop.
    fn apply_now() {
        run_pass(execute);
    }

    /// Writes the rescue file when what it must contain changed, and starts the watchdog the
    /// first time. Cheap when nothing changed (in-memory comparison only).
    fn sync_rescue(i: &Inputs, d: &mut Driver) {
        let Some(dir) = i.rescue_dir.clone() else { return };
        let path = dir.join(app_panel_rescue::rescue_file_name(std::process::id()));
        if i.entries.is_empty() {
            if d.rescue_last.take().is_some() {
                let _ = std::fs::remove_file(&path);
            }
            return;
        }
        let backdrops = BACKDROPS.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let windows = i
            .entries
            .iter()
            .map(|e| {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd_of(e.hwnd), &mut pid) };
                RescueWindow {
                    hwnd: e.hwnd,
                    pid,
                    class: class_name(hwnd_of(e.hwnd)),
                    x: e.saved.x,
                    y: e.saved.y,
                    width: e.saved.width,
                    height: e.saved.height,
                    backdrop: backdrops.iter().find(|(w, _)| *w == e.hwnd).map(|(_, v)| *v),
                    hidden: !(d.applied.visible && d.applied.hwnd == Some(e.hwnd)),
                }
            })
            .collect();
        let file = RescueFile { owner_pid: std::process::id(), owner_started: app_panel_rescue::own_start_time(), windows };
        if d.rescue_last.as_ref() == Some(&file) {
            return;
        }
        if app_panel_rescue::write_atomic(&path, &file).is_ok() {
            d.rescue_last = Some(file);
            if !d.watchdog {
                d.watchdog = spawn_watchdog(&path);
            }
        }
    }

    /// Same executable in watchdog mode: no window, no Tauri, only waits for this process to end.
    fn spawn_watchdog(path: &Path) -> bool {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let Ok(exe) = std::env::current_exe() else { return false };
        Command::new(exe)
            .arg(app_panel_rescue::WATCHDOG_FLAG)
            .arg(std::process::id().to_string())
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
    }

    /// Remembers where the rescue file lives (called by every command that has the app handle).
    fn remember_rescue_dir(panel: &mut Panel, app: &AppHandle) {
        if panel.rescue_dir.is_none() {
            panel.rescue_dir = app.path().app_data_dir().ok();
        }
    }

    /// Start-up fallback: windows left behind by a yerminal that died are given back.
    pub fn rescue_orphans(app: &AppHandle) {
        if let Ok(dir) = app.path().app_data_dir() {
            app_panel_rescue::rescue_orphans(&dir);
        }
    }

    /// Starts the follow loop (once). Light polling: a few window queries every 40 ms, no
    /// placement unless something moved; it stops when the last hosted window is gone.
    fn ensure_follower(panel: &mut Panel) {
        if panel.following {
            return;
        }
        panel.following = true;
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(FOLLOW_INTERVAL_MS));
            let finished = {
                let mut panel = lock_panel();
                panel.registry.prune(window_exists);
                let done = panel.registry.entries().is_empty() || !window_exists(panel.main);
                if done {
                    panel.following = false;
                }
                done
            };
            if finished {
                run_pass(|i, d| {
                    d.applied = Applied::default();
                    sync_rescue(i, d);
                });
                return;
            }
            apply_now();
        });
    }

    /// Launches the app and waits for the window that appears because of it. Windows that existed
    /// before the launch (the user's own) are never taken; if none appears, the user is told.
    fn obtain_window(url: &str, hint: &str) -> Result<isize, String> {
        let browser = find_browser()?;
        let before: Vec<isize> = top_windows().iter().map(|w| w.hwnd).collect();
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
            if let Some(found) = pick_new_window(&before, &top_windows(), CHROMIUM_WINDOW_CLASS, hint, &browser.exe.to_string_lossy()) {
                return Ok(found);
            }
            if Instant::now() >= deadline {
                return Err(NO_NEW_WINDOW_MESSAGE.to_owned());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn open(app: &AppHandle, id: &str, url: &str, hint: &str, rect: DockRect) -> Result<PanelState, String> {
        let (main, scale) = main_window(app)?;
        let known = {
            let mut panel = lock_panel();
            remember_rescue_dir(&mut panel, app);
            (panel.main, panel.scale, panel.dock) = (main, scale, Some(round_rect(rect)));
            panel.registry.activate(id)
        };
        if known {
            apply_now();
            return Ok(lock_panel().registry.state());
        }
        let hwnd = obtain_window(url, hint)?;
        let saved = capture(hwnd);
        {
            let mut panel = lock_panel();
            panel.shown = true;
            remember_rescue_dir(&mut panel, app);
            (panel.main, panel.scale, panel.dock) = (main, scale, Some(round_rect(rect)));
            panel.registry.add(Entry { id: id.to_owned(), hwnd, saved });
            ensure_follower(&mut panel);
        }
        apply_now();
        Ok(lock_panel().registry.state())
    }

    pub fn activate(app: &AppHandle, id: &str, rect: DockRect) -> Result<PanelState, String> {
        let (main, scale) = main_window(app)?;
        {
            let mut panel = lock_panel();
            panel.registry.prune(window_exists);
            panel.registry.activate(id);
            (panel.main, panel.scale, panel.dock) = (main, scale, Some(round_rect(rect)));
        }
        apply_now();
        Ok(lock_panel().registry.state())
    }

    pub fn place(app: &AppHandle, rect: DockRect) -> Result<(), String> {
        let (main, scale) = main_window(app)?;
        {
            let mut panel = lock_panel();
            (panel.main, panel.scale, panel.dock) = (main, scale, Some(round_rect(rect)));
        }
        apply_now();
        Ok(())
    }

    /// Closes one hosted window with WM_CLOSE. The browser process is not touched.
    pub fn close(app: &AppHandle, id: &str, rect: DockRect) -> Result<PanelState, String> {
        let (main, scale) = main_window(app)?;
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
        {
            let mut panel = lock_panel();
            (panel.main, panel.scale, panel.dock) = (main, scale, Some(round_rect(rect)));
        }
        apply_now();
        Ok(lock_panel().registry.state())
    }

    #[link(name = "user32")]
    extern "system" {
        fn PrintWindow(hwnd: HWND, hdc: isize, flags: u32) -> i32;
    }

    /// PW_RENDERFULLCONTENT: asks DirectComposition/GPU based windows (Chromium) to render too.
    const PW_RENDERFULLCONTENT: u32 = 2;

    /// Renders the whole window into a top-down BGRA buffer (alpha forced opaque).
    fn print_window(hwnd: isize, width: i32, height: i32) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{
            CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
            BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        if width <= 0 || height <= 0 {
            return None;
        }
        let h = hwnd_of(hwnd);
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return None;
            }
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let mut result = None;
            if !dc.is_null() && !bitmap.is_null() {
                let old = SelectObject(dc, bitmap as _);
                if PrintWindow(h, dc as isize, PW_RENDERFULLCONTENT) != 0 {
                    let mut info: BITMAPINFO = std::mem::zeroed();
                    info.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width,
                        biHeight: -height, // negative: top-down rows
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        biSizeImage: 0,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 0,
                        biClrImportant: 0,
                    };
                    let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
                    // The bitmap must not be selected into a DC while GetDIBits reads it.
                    SelectObject(dc, old);
                    let rows = GetDIBits(dc, bitmap, 0, height as u32, buf.as_mut_ptr() as *mut _, &mut info, DIB_RGB_COLORS);
                    if rows == height {
                        for px in buf.chunks_exact_mut(4) {
                            px[3] = 255;
                        }
                        result = Some(buf);
                    }
                }
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap as _);
            }
            if !dc.is_null() {
                DeleteDC(dc);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            result
        }
    }

    /// The visible part (clip box) of the active hosted window as a raw frame. Taken while the
    /// window is still shown; the panel lock is not held during the capture.
    pub fn snapshot() -> Result<Vec<u8>, String> {
        let started = Instant::now();
        let (hwnd, clip) = {
            let panel = lock_panel();
            let active = panel
                .registry
                .active_id()
                .and_then(|id| panel.registry.entries().iter().find(|e| e.id == id))
                .map(|e| e.hwnd);
            match (active, panel.applied.visible, panel.applied.placed, panel.applied.suspended) {
                (Some(hwnd), true, Some(placed), false) => (hwnd, placed.clip),
                _ => return Err("No visible hosted window to capture".to_owned()),
            }
        };
        let live = live_state(hwnd).ok_or("Hosted window is gone")?;
        let full = print_window(hwnd, live.outer.width, live.outer.height).ok_or("Capture failed")?;
        let (w, h, pixels) = crop_bgra(&full, live.outer.width, live.outer.height, clip).ok_or("Nothing to capture")?;
        if looks_blank(&pixels) {
            return Err("Capture was blank".to_owned());
        }
        if std::env::var_os("YERMINAL_APP_PANEL_SNAPSHOT_LOG").is_some() {
            eprintln!("[app-panel snapshot] {w}x{h} {} bytes in {:?}", pixels.len(), started.elapsed());
        }
        Ok(snapshot_bytes(w as u32, h as u32, &pixels))
    }

    pub fn set_visible(visible: bool) -> Result<(), String> {
        lock_panel().shown = visible;
        apply_now();
        Ok(())
    }

    pub fn state() -> PanelState {
        let mut panel = lock_panel();
        panel.registry.prune(window_exists);
        panel.registry.state()
    }

    /// How long the exit path waits for a lock or for the windows to answer. Longer than that and
    /// yerminal exits anyway; the watchdog (rescue file left in place) finishes the job.
    const EXIT_WAIT: Duration = Duration::from_millis(2000);

    /// A release gave up waiting for a hung window: the rescue file must stay for the watchdog.
    static RELEASE_ABANDONED: AtomicBool = AtomicBool::new(false);

    pub fn release_all(non_blocking: bool) {
        let limit = if non_blocking { Duration::ZERO } else { EXIT_WAIT };
        // The driver lock keeps a pass from placing a window again while it is given back; a pass
        // stuck on a hung window must not hold the exit, so the wait is bounded.
        let mut driver = try_lock_for(&DRIVER, limit);
        let Some(mut panel) = try_lock_for(&PANEL, limit) else { return };
        panel.applied = Applied::default();
        let rescue_path = panel.rescue_dir.clone().map(|d| d.join(app_panel_rescue::rescue_file_name(std::process::id())));
        let drained = panel.registry.drain();
        drop(panel);
        if let Some(d) = driver.as_mut() {
            d.applied = Applied::default();
            d.rescue_last = None;
        }
        let finished = if non_blocking {
            drained.iter().for_each(release);
            true
        } else {
            // Window calls can block on a hung browser: bounded, never an endless exit.
            run_bounded(limit, move || drained.iter().for_each(release)).is_some()
        };
        let abandoned_before = if finished { RELEASE_ABANDONED.load(Ordering::SeqCst) } else { RELEASE_ABANDONED.swap(true, Ordering::SeqCst) };
        if rescue_file_may_go(finished, abandoned_before) {
            if let Some(path) = rescue_path {
                let _ = std::fs::remove_file(path);
            }
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

    pub fn place(_app: &AppHandle, _rect: DockRect) -> Result<(), String> {
        Ok(())
    }

    pub fn close(_app: &AppHandle, _id: &str, _rect: DockRect) -> Result<PanelState, String> {
        Ok(PanelState { apps: Vec::new(), active: None })
    }

    pub fn set_visible(_visible: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn snapshot() -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.to_owned())
    }

    pub fn state() -> PanelState {
        PanelState { apps: Vec::new(), active: None }
    }

    pub fn rescue_orphans(_app: &AppHandle) {}

    pub fn release_all(_non_blocking: bool) {}
}

#[cfg(test)]
#[path = "app_panel_tests.rs"]
mod tests;

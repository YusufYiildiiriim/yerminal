use super::*;
use std::path::{Path, PathBuf};

const CLASS: &str = "Chrome_WidgetWin_1";

fn window(hwnd: isize, title: &str) -> TopWindow {
    TopWindow {
        hwnd,
        pid: 10,
        class: CLASS.to_owned(),
        title: title.to_owned(),
        visible: true,
        has_owner: false,
    }
}

fn entry(id: &str, hwnd: isize) -> Entry {
    Entry {
        id: id.to_owned(),
        hwnd,
        saved: Saved { x: 10, y: 20, width: 800, height: 600 },
    }
}

#[test]
fn device_rect_is_rounded_to_whole_pixels() {
    let rect = DockRect { x: 820.83, y: 111.98, width: 379.17, height: 638.85 };
    assert_eq!(round_rect(rect), PhysicalRect { x: 821, y: 112, width: 379, height: 639 });
}

// Measured 2026-11-26 on a 1440x900 client at webview zoom 1.2: the dock box was 379x639 CSS px,
// i.e. 455x767 device px, while the window scale factor stayed 1.0. The webview's pixel ratio,
// not the window scale factor, converts CSS px to device px; the page sends device px.
#[test]
fn hosted_frame_grows_by_the_insets_and_caption_and_clips_to_the_dock() {
    let dock = PhysicalRect { x: 985, y: 134, width: 455, height: 766 };
    let insets = Insets { left: 7, top: 0, right: 7, bottom: 7 };
    let (window, visible) = hosted_frame(dock, insets, 31);
    assert_eq!(window, PhysicalRect { x: 978, y: 103, width: 469, height: 804 });
    assert_eq!(visible, PhysicalRect { x: 7, y: 31, width: 455, height: 766 });
}

#[test]
fn visible_area_lands_exactly_on_the_dock_after_placing_the_window() {
    let dock = PhysicalRect { x: 400, y: 90, width: 300, height: 500 };
    let insets = Insets { left: 8, top: 1, right: 9, bottom: 6 };
    let (window, visible) = hosted_frame(dock, insets, 31);
    assert_eq!((window.x + visible.x, window.y + visible.y), (dock.x, dock.y));
    assert_eq!((visible.width, visible.height), (dock.width, dock.height));
    assert!(window.x + visible.x + visible.width <= window.x + window.width);
    assert!(window.y + visible.y + visible.height <= window.y + window.height);
}

#[test]
fn insets_are_the_gap_between_window_rect_and_client_rect() {
    let insets = measure_insets(
        PhysicalRect { x: 1059, y: 264, width: 379, height: 670 },
        (1066, 264),
        (365, 663),
    );
    assert_eq!(insets, Insets { left: 7, top: 0, right: 7, bottom: 7 });
}

#[test]
fn insets_never_go_negative() {
    let insets = measure_insets(PhysicalRect { x: 10, y: 10, width: 100, height: 100 }, (10, 10), (120, 120));
    assert_eq!(insets, Insets { left: 0, top: 0, right: 0, bottom: 0 });
}

#[test]
fn caption_height_scales_with_the_display() {
    assert_eq!(caption_height(1.0), 31);
    assert_eq!(caption_height(1.5), 47);
}

// Measured 2026-11-26, isolated Brave --app window at scale 1.2: window top 240, content
// (Chrome_RenderWidgetHostHWND) 102 px below it on example.com and youtube.com alike. 37 px
// is the caption, the other 65 px a first-run infobar; a fixed caption left the infobar visible.
#[test]
fn top_band_is_the_measured_content_offset_minus_the_top_inset() {
    assert_eq!(top_band(Some(102), 0, 1.2), 102);
    assert_eq!(top_band(Some(102), 1, 1.2), 101);
}

#[test]
fn top_band_without_infobar_equals_the_caption() {
    assert_eq!(top_band(Some(37), 0, 1.2), 37);
}

#[test]
fn top_band_falls_back_to_the_scaled_caption_when_nothing_was_measured() {
    assert_eq!(top_band(None, 0, 1.0), 31);
    assert_eq!(top_band(None, 0, 1.5), 47);
    assert_eq!(top_band(Some(0), 2, 1.0), 31);
}

// Measured 2026-11-26: Windows 11 paints the system backdrop (Mica, DWMWA_SYSTEMBACKDROP_TYPE 2)
// over the whole window rectangle and ignores SetWindowRgn, which left a dark band where the
// region cuts the caption. With backdrop type 1 (none) the region clips everything.
#[test]
fn backdrop_is_switched_off_only_when_something_is_drawn() {
    assert_eq!(backdrop_change(2), Some(1));
    assert_eq!(backdrop_change(0), Some(1));
    assert_eq!(backdrop_change(1), None);
}

#[test]
fn launch_args_use_only_the_app_flag_and_never_an_isolated_profile() {
    assert_eq!(
        app_launch_args("https://music.youtube.com"),
        vec!["--app=https://music.youtube.com".to_owned()]
    );
}

fn candidates() -> Vec<Browser> {
    browser_candidates(
        Some("C:/Program Files"),
        Some("C:/Program Files (x86)"),
        Some("C:/Users/u/AppData/Local"),
    )
}

#[test]
fn brave_is_preferred_over_edge_when_both_are_installed() {
    let all = |_: &Path| true;
    let list = candidates();
    let picked = pick_browser(&list, &all).unwrap();
    assert_eq!(picked.name, "Brave");
    assert!(picked.exe.ends_with("brave.exe"));
}

#[test]
fn edge_is_used_when_brave_is_missing() {
    let only_edge = |p: &Path| p.to_string_lossy().contains("msedge.exe");
    let list = candidates();
    let picked = pick_browser(&list, &only_edge).unwrap();
    assert_eq!(picked.name, "Edge");
}

#[test]
fn per_user_brave_install_is_found() {
    let per_user = |p: &Path| p.starts_with("C:/Users/u/AppData/Local");
    let list = candidates();
    let picked = pick_browser(&list, &per_user).unwrap();
    assert_eq!(
        picked.exe,
        PathBuf::from("C:/Users/u/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe")
    );
}

#[test]
fn no_browser_gives_a_clear_message() {
    let none = |_: &Path| false;
    assert!(pick_browser(&candidates(), &none).is_none());
    assert_eq!(NO_BROWSER_MESSAGE, "No supported browser found. Install Brave or Microsoft Edge.");
}

#[test]
fn new_window_is_the_app_window_absent_before_launch() {
    let before = [1, 2];
    let after = [window(1, "Other"), window(2, "Other"), window(5, "YouTube Music")];
    assert_eq!(pick_new_window(&before, &after, CLASS), Some(5));
}

#[test]
fn new_window_is_none_when_nothing_new_appeared() {
    assert_eq!(pick_new_window(&[1], &[window(1, "Other")], CLASS), None);
}

#[test]
fn new_window_skips_main_browser_windows_hidden_owned_untitled_and_other_classes() {
    let mut hidden = window(3, "YouTube Music");
    hidden.visible = false;
    let mut owned = window(4, "YouTube Music");
    owned.has_owner = true;
    let mut other = window(6, "YouTube Music");
    other.class = "Notepad".to_owned();
    let after = [
        window(2, "New Tab - Brave"),
        window(7, "Inbox - Microsoft Edge"),
        window(8, "Docs - Google Chrome"),
        hidden,
        owned,
        window(5, ""),
        other,
    ];
    assert_eq!(pick_new_window(&[], &after, CLASS), None);
}

#[test]
fn main_browser_titles_are_recognised_by_their_browser_suffix() {
    assert!(is_main_browser_title("GitHub - Brave"));
    assert!(is_main_browser_title("GitHub - Microsoft Edge"));
    assert!(is_main_browser_title("GitHub - Google Chrome"));
    assert!(!is_main_browser_title("YouTube Music"));
    assert!(!is_main_browser_title("Home / X"));
}

#[test]
fn existing_app_window_is_found_by_title_hint() {
    let windows = [
        window(1, "New Tab - Brave"),
        window(2, "Lofi mix - YouTube Music"),
        window(3, "Some video - YouTube"),
        window(4, "Home / X"),
    ];
    assert_eq!(pick_existing_app_window(&windows, "YouTube Music", CLASS, &[]), Some(2));
    assert_eq!(pick_existing_app_window(&windows, "YouTube", CLASS, &[]), Some(3));
    assert_eq!(pick_existing_app_window(&windows, "X", CLASS, &[]), Some(4));
    assert_eq!(pick_existing_app_window(&windows, "Spotify", CLASS, &[]), None);
}

#[test]
fn existing_app_window_skips_windows_already_hosted() {
    let windows = [window(2, "YouTube Music")];
    assert_eq!(pick_existing_app_window(&windows, "YouTube Music", CLASS, &[2]), None);
}

#[test]
fn registry_activates_the_newest_entry_and_lists_ids() {
    let mut reg = Registry::default();
    reg.add(entry("music", 1));
    reg.add(entry("x", 2));
    assert_eq!(
        reg.state(),
        PanelState { apps: vec!["music".into(), "x".into()], active: Some("x".into()) }
    );
    assert!(reg.activate("music"));
    assert_eq!(reg.active_id(), Some("music"));
    assert!(!reg.activate("missing"));
}

#[test]
fn closing_the_active_entry_activates_a_neighbour() {
    let mut reg = Registry::default();
    reg.add(entry("a", 1));
    reg.add(entry("b", 2));
    reg.add(entry("c", 3));
    reg.activate("b");
    let removed = reg.remove("b").unwrap();
    assert_eq!(removed.hwnd, 2);
    assert_eq!(reg.active_id(), Some("a"));
    reg.remove("a");
    assert_eq!(reg.active_id(), Some("c"));
    reg.remove("c");
    assert_eq!(reg.state(), PanelState { apps: vec![], active: None });
}

#[test]
fn closing_an_inactive_entry_keeps_the_active_one() {
    let mut reg = Registry::default();
    reg.add(entry("a", 1));
    reg.add(entry("b", 2));
    reg.remove("a");
    assert_eq!(reg.active_id(), Some("b"));
}

#[test]
fn drain_returns_every_entry_with_its_saved_geometry_so_all_can_be_released() {
    let mut reg = Registry::default();
    reg.add(entry("a", 1));
    reg.add(entry("b", 2));
    let all = reg.drain();
    assert_eq!(all.iter().map(|e| e.hwnd).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(all[0].saved, Saved { x: 10, y: 20, width: 800, height: 600 });
    assert!(reg.state().apps.is_empty());
}

#[test]
fn prune_drops_entries_whose_window_is_gone() {
    let mut reg = Registry::default();
    reg.add(entry("a", 1));
    reg.add(entry("b", 2));
    reg.prune(|hwnd| hwnd == 1);
    assert_eq!(reg.state(), PanelState { apps: vec!["a".into()], active: Some("a".into()) });
}

// Follow mode: the window stays top-level, so the dock box (client relative) is moved to screen
// pixels by the client origin, and a pure planner decides what to do on each tick.
fn rect(x: i32, y: i32, width: i32, height: i32) -> PhysicalRect {
    PhysicalRect { x, y, width, height }
}

fn wanted(hwnd: Option<isize>, shown: bool, minimized: bool, screen: Option<PhysicalRect>) -> Wanted {
    Wanted { hwnd, shown, main_minimized: minimized, screen }
}

#[test]
fn dock_box_moves_to_screen_pixels_by_the_client_origin() {
    assert_eq!(to_screen(rect(985, 134, 455, 766), (100, 40)), rect(1085, 174, 455, 766));
}

#[test]
fn first_tick_places_shows_and_raises_the_window() {
    let screen = rect(10, 20, 300, 400);
    let plan = plan_follow(&Applied::default(), &wanted(Some(7), true, false, Some(screen)));
    assert_eq!(plan, Plan { hide_others: true, hide: false, place: Some(screen), show: true });
}

#[test]
fn unchanged_state_does_nothing() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen) };
    assert_eq!(plan_follow(&applied, &wanted(Some(7), true, false, Some(screen))), Plan::default());
}

#[test]
fn moving_the_main_window_replaces_the_window_without_reshowing() {
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(rect(10, 20, 300, 400)) };
    let moved = rect(60, 20, 300, 400);
    let plan = plan_follow(&applied, &wanted(Some(7), true, false, Some(moved)));
    assert_eq!(plan, Plan { place: Some(moved), ..Plan::default() });
}

#[test]
fn dock_resize_places_the_window_on_the_new_box() {
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(rect(10, 20, 300, 400)) };
    let wider = rect(-70, 20, 380, 400);
    assert_eq!(plan_follow(&applied, &wanted(Some(7), true, false, Some(wider))).place, Some(wider));
}

#[test]
fn switching_tabs_hides_the_others_and_places_the_new_window() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen) };
    let plan = plan_follow(&applied, &wanted(Some(8), true, false, Some(screen)));
    assert_eq!(plan, Plan { hide_others: true, hide: false, place: Some(screen), show: true });
}

#[test]
fn minimised_main_window_hides_once() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen) };
    let plan = plan_follow(&applied, &wanted(Some(7), true, true, Some(screen)));
    assert_eq!(plan, Plan { hide: true, ..Plan::default() });
    let hidden = Applied { visible: false, ..applied };
    assert_eq!(plan_follow(&hidden, &wanted(Some(7), true, true, Some(screen))), Plan::default());
}

#[test]
fn restoring_the_main_window_shows_without_a_new_placement() {
    let screen = rect(10, 20, 300, 400);
    let hidden = Applied { hwnd: Some(7), visible: false, rect: Some(screen) };
    let plan = plan_follow(&hidden, &wanted(Some(7), true, false, Some(screen)));
    assert_eq!(plan, Plan { show: true, ..Plan::default() });
}

#[test]
fn dock_hidden_by_a_dialog_hides_and_no_active_app_hides() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen) };
    assert!(plan_follow(&applied, &wanted(Some(7), false, false, Some(screen))).hide);
    assert!(plan_follow(&applied, &wanted(None, true, false, Some(screen))).hide);
}

#[test]
fn restore_target_is_the_saved_geometry() {
    let saved = Saved { x: 10, y: 20, width: 800, height: 600 };
    assert_eq!(restore_geometry(&saved), PhysicalRect { x: 10, y: 20, width: 800, height: 600 });
}

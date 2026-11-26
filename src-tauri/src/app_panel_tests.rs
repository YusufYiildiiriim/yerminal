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
    assert_eq!(pick_new_window(&before, &after, CLASS, "YouTube Music"), Some(5));
}

#[test]
fn new_window_is_none_when_nothing_new_appeared() {
    assert_eq!(pick_new_window(&[1], &[window(1, "Other")], CLASS, "YouTube Music"), None);
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
    assert_eq!(pick_new_window(&[], &after, CLASS, "YouTube Music"), None);
}

#[test]
fn main_browser_titles_are_recognised_by_their_browser_suffix() {
    assert!(is_main_browser_title("GitHub - Brave"));
    assert!(is_main_browser_title("GitHub - Microsoft Edge"));
    assert!(is_main_browser_title("GitHub - Google Chrome"));
    assert!(!is_main_browser_title("YouTube Music"));
    assert!(!is_main_browser_title("Home / X"));
}

// The panel only takes a window it caused: a window that was already open before the launch is
// never taken, even when its title matches the app (the user's own YouTube Music window).
#[test]
fn a_window_open_before_the_launch_is_never_taken_even_with_a_matching_title() {
    let after = [window(2, "Lofi mix - YouTube Music")];
    assert_eq!(pick_new_window(&[2], &after, CLASS, "YouTube Music"), None);
}

#[test]
fn only_the_window_that_appeared_after_the_launch_is_taken() {
    let after = [window(2, "Lofi mix - YouTube Music"), window(9, "YouTube Music")];
    assert_eq!(pick_new_window(&[2], &after, CLASS, "YouTube Music"), Some(9));
}

#[test]
fn among_new_windows_the_one_matching_the_app_title_wins() {
    let after = [window(8, "Some other app"), window(9, "Home / X")];
    assert_eq!(pick_new_window(&[], &after, CLASS, "X"), Some(9));
}

#[test]
fn a_new_window_with_another_title_is_taken_while_the_page_has_not_titled_itself_yet() {
    assert_eq!(pick_new_window(&[1], &[window(1, "Old"), window(9, "music.youtube.com")], CLASS, "YouTube Music"), Some(9));
}

#[test]
fn hint_matching_is_exact_or_by_suffix() {
    assert!(title_matches_hint("YouTube Music", "YouTube Music"));
    assert!(title_matches_hint("Mix - YouTube", "YouTube"));
    assert!(title_matches_hint("Home / X", "X"));
    assert!(!title_matches_hint("Mix - YouTube Music", "YouTube"));
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
    Wanted { hwnd, shown, main_minimized: minimized, screen, fullscreen: false, live: None }
}

#[test]
fn dock_box_moves_to_screen_pixels_by_the_client_origin() {
    assert_eq!(to_screen(rect(985, 134, 455, 766), (100, 40)), rect(1085, 174, 455, 766));
}

#[test]
fn first_tick_places_shows_and_raises_the_window() {
    let screen = rect(10, 20, 300, 400);
    let plan = plan_follow(&Applied::default(), &wanted(Some(7), true, false, Some(screen)));
    assert_eq!(plan, Plan { hide_others: true, hide: false, place: Some(screen), show: true, ..Plan::default() });
}

#[test]
fn unchanged_state_does_nothing() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen), ..Applied::default() };
    assert_eq!(plan_follow(&applied, &wanted(Some(7), true, false, Some(screen))), Plan::default());
}

#[test]
fn moving_the_main_window_replaces_the_window_without_reshowing() {
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(rect(10, 20, 300, 400)), ..Applied::default() };
    let moved = rect(60, 20, 300, 400);
    let plan = plan_follow(&applied, &wanted(Some(7), true, false, Some(moved)));
    assert_eq!(plan, Plan { place: Some(moved), ..Plan::default() });
}

#[test]
fn dock_resize_places_the_window_on_the_new_box() {
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(rect(10, 20, 300, 400)), ..Applied::default() };
    let wider = rect(-70, 20, 380, 400);
    assert_eq!(plan_follow(&applied, &wanted(Some(7), true, false, Some(wider))).place, Some(wider));
}

#[test]
fn switching_tabs_hides_the_others_and_places_the_new_window() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen), ..Applied::default() };
    let plan = plan_follow(&applied, &wanted(Some(8), true, false, Some(screen)));
    assert_eq!(plan, Plan { hide_others: true, hide: false, place: Some(screen), show: true, ..Plan::default() });
}

#[test]
fn minimised_main_window_hides_once() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen), ..Applied::default() };
    let plan = plan_follow(&applied, &wanted(Some(7), true, true, Some(screen)));
    assert_eq!(plan, Plan { hide: true, ..Plan::default() });
    let hidden = Applied { visible: false, ..applied };
    assert_eq!(plan_follow(&hidden, &wanted(Some(7), true, true, Some(screen))), Plan::default());
}

#[test]
fn restoring_the_main_window_shows_without_a_new_placement() {
    let screen = rect(10, 20, 300, 400);
    let hidden = Applied { hwnd: Some(7), visible: false, rect: Some(screen), ..Applied::default() };
    let plan = plan_follow(&hidden, &wanted(Some(7), true, false, Some(screen)));
    assert_eq!(plan, Plan { show: true, ..Plan::default() });
}

#[test]
fn dock_hidden_by_a_dialog_hides_and_no_active_app_hides() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen), ..Applied::default() };
    assert!(plan_follow(&applied, &wanted(Some(7), false, false, Some(screen))).hide);
    assert!(plan_follow(&applied, &wanted(None, true, false, Some(screen))).hide);
}

#[test]
fn restore_target_is_the_saved_geometry() {
    let saved = Saved { x: 10, y: 20, width: 800, height: 600 };
    assert_eq!(restore_geometry(&saved), PhysicalRect { x: 10, y: 20, width: 800, height: 600 });
}

// ---------------------------------------------------------------------------
// Full screen (an app that went full screen on its own, e.g. a video)
// ---------------------------------------------------------------------------

const MONITOR: PhysicalRect = PhysicalRect { x: 0, y: 0, width: 1920, height: 1080 };

#[test]
fn a_window_covering_the_monitor_is_full_screen() {
    assert!(is_fullscreen(MONITOR, MONITOR, Some(rect(1400, 100, 500, 800)), false));
    // Chromium's full screen rectangle can overshoot by the invisible frame.
    assert!(is_fullscreen(rect(-7, 0, 1934, 1087), MONITOR, None, false));
}

#[test]
fn a_window_on_the_dock_is_not_full_screen() {
    assert!(!is_fullscreen(rect(1393, 69, 514, 835), MONITOR, Some(rect(1400, 100, 500, 800)), false));
    // Maximised-looking but short of the monitor height (taskbar): not full screen.
    assert!(!is_fullscreen(rect(0, 0, 1920, 1040), MONITOR, None, false));
}

#[test]
fn a_dock_as_big_as_the_monitor_does_not_count_as_full_screen() {
    assert!(!is_fullscreen(MONITOR, MONITOR, Some(MONITOR), false));
}

fn fullscreen_wanted(hwnd: isize, screen: PhysicalRect) -> Wanted {
    Wanted { fullscreen: true, ..wanted(Some(hwnd), true, false, Some(screen)) }
}

#[test]
fn going_full_screen_suspends_once_and_never_places() {
    let screen = rect(10, 20, 300, 400);
    let applied = Applied { hwnd: Some(7), visible: true, rect: Some(screen), ..Applied::default() };
    let plan = plan_follow(&applied, &fullscreen_wanted(7, screen));
    assert_eq!(plan, Plan { suspend: true, ..Plan::default() });
    assert_eq!(plan.place, None);
}

#[test]
fn while_full_screen_the_loop_leaves_the_window_alone_even_when_the_dock_moves() {
    let suspended = Applied { hwnd: Some(7), visible: true, rect: None, suspended: true, ..Applied::default() };
    let moved = rect(60, 20, 300, 400);
    assert_eq!(plan_follow(&suspended, &fullscreen_wanted(7, moved)), Plan::default());
}

#[test]
fn leaving_full_screen_places_the_window_on_the_dock_again() {
    let suspended = Applied { hwnd: Some(7), visible: true, rect: None, suspended: true, ..Applied::default() };
    let screen = rect(10, 20, 300, 400);
    let plan = plan_follow(&suspended, &wanted(Some(7), true, false, Some(screen)));
    assert_eq!(plan, Plan { place: Some(screen), ..Plan::default() });
}

#[test]
fn full_screen_window_that_was_hidden_is_shown_without_placement() {
    let hidden = Applied { hwnd: Some(7), visible: false, rect: None, suspended: false, ..Applied::default() };
    let plan = plan_follow(&hidden, &fullscreen_wanted(7, rect(10, 20, 300, 400)));
    assert_eq!(plan, Plan { suspend: true, show: true, ..Plan::default() });
}

#[test]
fn switching_to_another_tab_while_the_old_one_is_full_screen_places_the_new_one() {
    let suspended = Applied { hwnd: Some(7), visible: true, rect: None, suspended: true, ..Applied::default() };
    let screen = rect(10, 20, 300, 400);
    let plan = plan_follow(&suspended, &wanted(Some(8), true, false, Some(screen)));
    assert_eq!(plan, Plan { hide_others: true, place: Some(screen), show: true, ..Plan::default() });
}

#[test]
fn hiding_wins_over_full_screen() {
    let suspended = Applied { hwnd: Some(7), visible: true, rect: None, suspended: true, ..Applied::default() };
    let wanted = Wanted { fullscreen: true, ..wanted(Some(7), true, true, Some(rect(10, 20, 300, 400))) };
    assert!(plan_follow(&suspended, &wanted).hide);
}

#[test]
fn the_no_new_window_message_tells_the_user_what_to_do() {
    assert!(NO_NEW_WINDOW_MESSAGE.contains("already open"));
    assert!(NO_NEW_WINDOW_MESSAGE.contains("close"));
}

// ---------------------------------------------------------------------------
// Drift: the window or its clip changed behind our back (maximise/restore of either window)
// ---------------------------------------------------------------------------

#[test]
fn a_maximised_window_that_overshoots_the_monitor_is_not_full_screen() {
    // A maximised window (Chromium remembered it, or the user pressed its button) overshoots the
    // monitor by the invisible frame, exactly like a real full screen one; only the state tells them apart.
    assert!(!is_fullscreen(rect(-8, -8, 1936, 1096), MONITOR, None, true));
    assert!(is_fullscreen(rect(-8, -8, 1936, 1096), MONITOR, None, false));
}

fn placed(outer: PhysicalRect, clip: PhysicalRect) -> Placed {
    Placed { outer, clip }
}

fn settled(screen: PhysicalRect, outer: PhysicalRect, clip: PhysicalRect) -> Applied {
    Applied { hwnd: Some(7), visible: true, rect: Some(screen), placed: Some(placed(outer, clip)), ..Applied::default() }
}

fn seen(screen: PhysicalRect, live: Live) -> Wanted {
    Wanted { live: Some(live), ..wanted(Some(7), true, false, Some(screen)) }
}

#[test]
fn a_window_exactly_as_placed_is_left_alone() {
    let (screen, outer, clip) = (rect(10, 20, 300, 400), rect(2, -80, 316, 508), rect(8, 102, 300, 400));
    let live = Live { outer, clip: Some(clip), zoomed: false };
    assert_eq!(plan_follow(&settled(screen, outer, clip), &seen(screen, live)), Plan::default());
}

#[test]
fn a_lost_clip_region_is_put_back_on_the_same_box() {
    // Chromium resets the window region on its own resize handling; the box did not change.
    let (screen, outer, clip) = (rect(10, 20, 300, 400), rect(2, -80, 316, 508), rect(8, 102, 300, 400));
    let live = Live { outer, clip: None, zoomed: false };
    assert_eq!(plan_follow(&settled(screen, outer, clip), &seen(screen, live)).place, Some(screen));
}

#[test]
fn a_changed_clip_region_is_put_back() {
    let (screen, outer, clip) = (rect(10, 20, 300, 400), rect(2, -80, 316, 508), rect(8, 102, 300, 400));
    let live = Live { outer, clip: Some(rect(0, 0, 316, 508)), zoomed: false };
    assert_eq!(plan_follow(&settled(screen, outer, clip), &seen(screen, live)).place, Some(screen));
}

#[test]
fn a_window_moved_or_resized_by_the_page_is_placed_again() {
    let (screen, outer, clip) = (rect(10, 20, 300, 400), rect(2, -80, 316, 508), rect(8, 102, 300, 400));
    let moved = Live { outer: rect(500, 300, 316, 508), clip: Some(clip), zoomed: false };
    assert_eq!(plan_follow(&settled(screen, outer, clip), &seen(screen, moved)).place, Some(screen));
    let resized = Live { outer: rect(2, -80, 1936, 1096), clip: Some(clip), zoomed: false };
    assert_eq!(plan_follow(&settled(screen, outer, clip), &seen(screen, resized)).place, Some(screen));
}

#[test]
fn a_maximised_app_window_is_placed_again_even_when_its_rectangle_matches() {
    let (screen, outer, clip) = (rect(10, 20, 300, 400), rect(2, -80, 316, 508), rect(8, 102, 300, 400));
    let live = Live { outer, clip: Some(clip), zoomed: true };
    assert_eq!(plan_follow(&settled(screen, outer, clip), &seen(screen, live)).place, Some(screen));
}

#[test]
fn drift_never_places_while_suspended_hidden_or_switching() {
    let (screen, outer, clip) = (rect(10, 20, 300, 400), rect(2, -80, 316, 508), rect(8, 102, 300, 400));
    let lost = Live { outer, clip: None, zoomed: false };
    // Full screen: the page owns the window.
    let suspended = Applied { suspended: true, rect: None, ..settled(screen, outer, clip) };
    let full = Wanted { fullscreen: true, ..seen(screen, lost) };
    assert_eq!(plan_follow(&suspended, &full).place, None);
    // Hidden by a dialog or a minimised main window: nothing is placed.
    let hidden = Applied { visible: false, ..settled(screen, outer, clip) };
    assert_eq!(plan_follow(&hidden, &seen(screen, lost)).place, None);
}

#[test]
fn maximising_and_restoring_the_main_window_replaces_and_clips_on_every_size() {
    // Dock grows with the maximised main window and shrinks back; the app window is never taken
    // for full screen, the clip is never dropped, and each new box is placed exactly once.
    let (small, big) = (rect(865, 134, 575, 767), rect(1938, 134, 575, 1306));
    let (small_outer, big_outer) = (rect(857, 32, 591, 877), rect(1930, 32, 591, 1416));
    let (small_clip, big_clip) = (rect(8, 102, 575, 767), rect(8, 102, 575, 1306));
    let mut applied = settled(small, small_outer, small_clip);
    for (screen, outer, clip) in [(big, big_outer, big_clip), (small, small_outer, small_clip), (big, big_outer, big_clip)] {
        let before = Live { outer: applied.placed.unwrap().outer, clip: Some(applied.placed.unwrap().clip), zoomed: false };
        let plan = plan_follow(&applied, &seen(screen, before));
        assert_eq!(plan, Plan { place: Some(screen), ..Plan::default() });
        applied = settled(screen, outer, clip);
        let after = Live { outer, clip: Some(clip), zoomed: false };
        assert_eq!(plan_follow(&applied, &seen(screen, after)), Plan::default());
    }
}

// --- snapshot (still image shown while a dialog needs the area) ---

/// `w` x `h` BGRA image whose pixel (x, y) is [x, y, 7, 255].
fn gradient(w: i32, h: i32) -> Vec<u8> {
    let mut v = Vec::new();
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&[x as u8, y as u8, 7, 255]);
        }
    }
    v
}

#[test]
fn crop_keeps_only_the_requested_pixels() {
    let src = gradient(6, 4);
    let (w, h, out) = crop_bgra(&src, 6, 4, PhysicalRect { x: 2, y: 1, width: 3, height: 2 }).unwrap();
    assert_eq!((w, h), (3, 2));
    assert_eq!(out.len(), 3 * 2 * 4);
    assert_eq!(&out[0..4], &[2, 1, 7, 255]);
    assert_eq!(&out[out.len() - 4..], &[4, 2, 7, 255]);
}

#[test]
fn crop_is_clamped_to_the_source() {
    let src = gradient(6, 4);
    let (w, h, out) = crop_bgra(&src, 6, 4, PhysicalRect { x: -2, y: 3, width: 20, height: 20 }).unwrap();
    assert_eq!((w, h), (6, 1));
    assert_eq!(&out[0..4], &[0, 3, 7, 255]);
}

#[test]
fn crop_rejects_empty_or_mismatched_input() {
    let src = gradient(6, 4);
    assert!(crop_bgra(&src, 6, 4, PhysicalRect { x: 10, y: 0, width: 3, height: 3 }).is_none());
    assert!(crop_bgra(&src, 6, 4, PhysicalRect { x: 0, y: 0, width: 0, height: 3 }).is_none());
    assert!(crop_bgra(&src[..10], 6, 4, PhysicalRect { x: 0, y: 0, width: 3, height: 3 }).is_none());
}

#[test]
fn an_all_black_capture_counts_as_failed() {
    assert!(looks_blank(&vec![0u8; 64 * 64 * 4]));
    assert!(looks_blank(&[]));
    let mut img = vec![0u8; 64 * 64 * 4];
    img[(30 * 64 + 31) * 4 + 1] = 90;
    assert!(!looks_blank(&img));
    assert!(!looks_blank(&gradient(32, 32)));
}

#[test]
fn snapshot_payload_starts_with_little_endian_size() {
    let bytes = snapshot_bytes(3, 2, &[9u8; 24]);
    assert_eq!(&bytes[0..4], &3u32.to_le_bytes());
    assert_eq!(&bytes[4..8], &2u32.to_le_bytes());
    assert_eq!(bytes.len(), 8 + 24);
}

// --- lock discipline (A-2): no foreign window call under the panel lock, bounded waits on exit ---

use std::sync::mpsc;
use std::time::Duration;

#[test]
fn bounded_lock_gives_up_while_another_thread_holds_the_lock() {
    static HELD: Mutex<u8> = Mutex::new(0);
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let _guard = HELD.lock().unwrap();
        held_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    held_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let started = std::time::Instant::now();
    assert!(try_lock_for(&HELD, Duration::from_millis(100)).is_none());
    assert!(started.elapsed() < Duration::from_secs(1), "the wait must be bounded");
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    assert!(try_lock_for(&HELD, Duration::from_millis(100)).is_some(), "free lock is taken at once");
}

#[test]
fn bounded_run_reports_a_blocked_call_instead_of_waiting_for_it() {
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let started = std::time::Instant::now();
    let done = run_bounded(Duration::from_millis(100), move || {
        let _ = release_rx.recv(); // a hung browser window: never returns on its own
    });
    assert!(done.is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(release_tx);
    assert_eq!(run_bounded(Duration::from_secs(2), || 7), Some(7));
}

#[test]
fn panel_lock_is_free_while_a_pass_makes_window_calls() {
    let (started_tx, started_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let pass = std::thread::spawn(move || {
        run_pass(move |_inputs, _driver| {
            started_tx.send(()).unwrap();
            go_rx.recv().unwrap(); // stands in for a window call that takes long
        });
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(PANEL.try_lock().is_ok(), "window calls must run outside the panel lock");
    go_tx.send(()).unwrap();
    pass.join().unwrap();
}

#[test]
fn rescue_file_stays_once_a_release_was_abandoned() {
    // exit calls release_all twice (window destroyed, then app exit): the second, empty call must
    // not delete the file the first (timed out) call left for the watchdog.
    assert!(!rescue_file_may_go(false, false), "release did not finish");
    assert!(rescue_file_may_go(true, false), "release finished");
    assert!(!rescue_file_may_go(true, true), "an earlier release was abandoned");
}

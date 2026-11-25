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
        saved: Saved { x: 10, y: 20, width: 800, height: 600, style: 0x16CF_0000 },
    }
}

#[test]
fn dock_rect_scales_css_pixels_to_physical_pixels() {
    let rect = DockRect { x: 100.0, y: 40.0, width: 300.0, height: 500.0 };
    assert_eq!(to_physical(rect, 1.5), PhysicalRect { x: 150, y: 60, width: 450, height: 750 });
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
    assert_eq!(all[0].saved, Saved { x: 10, y: 20, width: 800, height: 600, style: 0x16CF_0000 });
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

#[test]
fn embedded_style_drops_the_frame_and_becomes_a_child_but_stays_visible() {
    let framed = 0x16CF_0000_isize | 0x1000_0000; // caption, sysmenu, thickframe, min/max + visible
    let child = embedded_style(framed);
    assert_eq!(child & FRAME_STYLE_BITS, 0);
    assert_ne!(child & STYLE_CHILD, 0);
    assert_ne!(child & 0x1000_0000, 0);
}

#[test]
fn restore_target_is_the_saved_geometry() {
    let saved = Saved { x: 10, y: 20, width: 800, height: 600, style: 0x16CF_0000 };
    assert_eq!(restore_geometry(&saved), PhysicalRect { x: 10, y: 20, width: 800, height: 600 });
}

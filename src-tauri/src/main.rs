// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Hidden watchdog mode (see `app_panel_rescue`): no window, no Tauri, only Win32.
    let args: Vec<String> = std::env::args().collect();
    if let Some((owner_pid, file)) = yerminal_lib::app_panel_rescue::parse_watchdog_args(&args) {
        yerminal_lib::app_panel_rescue::run_watchdog(owner_pid, &file);
        return;
    }
    yerminal_lib::run();
}

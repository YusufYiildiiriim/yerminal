import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isDockRectUsable, toDockRect } from "./dockRect";

const DEFAULT_EXE = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
// {profile} is replaced in Rust with a dock-owned folder; without it Chromium hands the request to the running instance.
const DEFAULT_ARGS = "--app=https://music.youtube.com --user-data-dir={profile}";

/** Spike UI: a fixed right dock whose area hosts an external app window (Windows only). */
export function AppPanelDock() {
  const dockRef = useRef<HTMLDivElement>(null);
  const [exe, setExe] = useState(DEFAULT_EXE);
  const [args, setArgs] = useState(DEFAULT_ARGS);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  const currentRect = () => {
    const element = dockRef.current;
    return element ? toDockRect(element.getBoundingClientRect()) : null;
  };

  // Keep the hosted window on the dock while the dock or the main window changes size.
  useEffect(() => {
    const element = dockRef.current;
    if (!open || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rect = currentRect();
      if (rect && isDockRectUsable(rect)) {
        invoke("app_panel_place", { rect }).catch((error: unknown) => setMessage(String(error)));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const openApp = async () => {
    const rect = currentRect();
    if (!rect || !isDockRectUsable(rect)) return;
    setMessage("");
    try {
      await invoke("app_panel_open", { exe, args: args.trim().split(/\s+/), rect });
      setOpen(true);
    } catch (error) {
      setMessage(String(error));
    }
  };

  const closeApp = async () => {
    try {
      await invoke("app_panel_close");
    } finally {
      setOpen(false);
    }
  };

  return (
    <aside className="app-panel" aria-label="App panel">
      <div className="app-panel-controls">
        <label>
          App path
          <input value={exe} onChange={(event) => setExe(event.target.value)} />
        </label>
        <label>
          Arguments
          <input value={args} onChange={(event) => setArgs(event.target.value)} />
        </label>
        <div className="app-panel-actions">
          <button type="button" onClick={openApp} disabled={open}>Open app</button>
          <button type="button" onClick={closeApp} disabled={!open}>Close app</button>
        </div>
        {message && <p className="app-panel-message" role="status">{message}</p>}
      </div>
      <div ref={dockRef} className="app-panel-dock" aria-label="App dock" />
    </aside>
  );
}

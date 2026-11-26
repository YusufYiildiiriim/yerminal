import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { APP_CATALOG, findApp, type AppDef } from "./apps";
import { isDockRectUsable, toDeviceRect, toDockRect, type DockRect } from "./dockRect";
import { clampDockWidth, readDockPrefs, writeDockPrefs } from "./dockPrefs";
import { overlapsContent, overlayBoxes } from "./overlayGeometry";
import { SnapshotView } from "./SnapshotView";
import { parseSnapshot, type SnapshotImage } from "./snapshotImage";

interface PanelState {
  apps: string[];
  active: string | null;
}

const EMPTY_STATE: PanelState = { apps: [], active: null };
const KEY_STEP = 16;
/** Dialogs open and close in bursts; this keeps the overlay check off the hot path of terminal output. */
const OVERLAY_CHECK_DELAY_MS = 50;

const iconProps = { viewBox: "0 0 24 24", "aria-hidden": true, focusable: false } as const;

/**
 * Right dock. The hosted app window (the user's own browser, default profile) is placed
 * over `.app-panel-content` only; header, tabs and menus sit in their own strips above it.
 */
export function AppPanelDock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readDockPrefs().width);
  const [state, setState] = useState<PanelState>(EMPTY_STATE);
  const [menuOpen, setMenuOpen] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [opening, setOpening] = useState<AppDef | null>(null);
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [snapshot, setSnapshot] = useState<SnapshotImage | null>(null);

  const currentRect = useCallback((): DockRect | null => {
    const element = contentRef.current;
    if (!element) return null;
    const rect = toDockRect(element.getBoundingClientRect());
    return isDockRectUsable(rect) ? toDeviceRect(rect, window.devicePixelRatio) : null;
  }, []);

  // Windows already hosted (for example after a webview reload) come back as tabs.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<PanelState>("app_panel_state")
      .then((next) => { if (!cancelled && next) setState(next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Dialogs and menus are HTML: the native window would be drawn over them. It is hidden only
  // while one of them actually reaches the content area, and a still frame stands in meanwhile.
  useEffect(() => {
    if (!open || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      timer = undefined;
      const element = contentRef.current;
      setOverlay(element ? overlapsContent(overlayBoxes(document), toDockRect(element.getBoundingClientRect()), window.devicePixelRatio) : false);
    };
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(check, OVERLAY_CHECK_DELAY_MS);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    check();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, width]);

  const shown = open && !overlay;
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const sync = async () => {
      if (!shown) {
        let image: SnapshotImage | null = null;
        if (open) {
          try {
            image = parseSnapshot(await invoke<unknown>("app_panel_snapshot"));
          } catch {
            image = null;
          }
          if (cancelled) return;
        }
        setSnapshot(image);
        await invoke("app_panel_set_visible", { visible: false });
        return;
      }
      await invoke("app_panel_set_visible", { visible: true });
      const rect = currentRect();
      if (rect) await invoke("app_panel_place", { rect });
      if (!cancelled) setSnapshot(null);
    };
    sync().catch(() => undefined);
    return () => { cancelled = true; };
  }, [shown, open, currentRect]);

  // Keep the hosted window on the content area when the dock or the main window changes.
  useEffect(() => {
    const element = contentRef.current;
    if (!open || !element || !isTauri()) return;
    const place = () => {
      const rect = currentRect();
      if (rect) invoke("app_panel_place", { rect }).catch(() => undefined);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, currentRect]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  const run = async (command: string, args: Record<string, unknown>, busy?: AppDef) => {
    setMessage("");
    setOpening(busy ?? null);
    try {
      setState(await invoke<PanelState>(command, args));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setOpening(null);
    }
  };

  const launch = (app: AppDef) => {
    setMenuOpen(false);
    const rect = currentRect();
    if (!rect) return;
    void run("app_panel_open", { id: app.id, url: app.url, titleHint: app.titleHint, rect }, app);
  };

  const activate = (id: string) => {
    const rect = currentRect();
    if (rect) void run("app_panel_activate", { id, rect });
  };

  const closeApp = (id: string) => {
    const rect = currentRect();
    if (rect) void run("app_panel_close", { id, rect });
  };

  const commitWidth = (next: number) => {
    const clamped = clampDockWidth(next, window.innerWidth);
    setWidth(clamped);
    return clamped;
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    writeDockPrefs({ width: commitWidth(width + (event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP)) });
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) commitWidth(window.innerWidth - event.clientX);
  };

  const onHandlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    writeDockPrefs({ width: clampDockWidth(window.innerWidth - event.clientX, window.innerWidth) });
  };

  if (!open) return null;

  return (
    <aside className="app-panel" data-app-panel data-dragging={dragging ? "true" : "false"} aria-label="App panel" style={{ flexBasis: width, width }}>
      <div
        className="app-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize app panel"
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={onHandleKeyDown}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
      />
      <header className="app-panel-header">
        <h2>Apps</h2>
        <button className="app-panel-icon-button" type="button" aria-label="Collapse app panel" title="Collapse" onClick={onClose}>
          <svg {...iconProps}><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </header>
      <div className="app-panel-tabs-row">
        <div className="app-panel-tabs" role="tablist" aria-label="Open apps">
          {state.apps.map((id) => {
            const name = findApp(id)?.name ?? id;
            const active = state.active === id;
            return (
              <div className="app-panel-tab" key={id} data-active={active ? "true" : "false"}>
                <button className="app-panel-tab-select" type="button" role="tab" aria-selected={active} onClick={() => activate(id)}>{name}</button>
                <button className="app-panel-tab-close" type="button" aria-label={`Close ${name}`} title="Close" onClick={() => closeApp(id)}>
                  <svg {...iconProps}><path d="M7 7l10 10M17 7L7 17" /></svg>
                </button>
              </div>
            );
          })}
          {opening && <span className="app-panel-opening">Opening {opening.name}…</span>}
        </div>
        <div className="app-panel-add" ref={menuRef}>
          <button className="app-panel-icon-button" type="button" aria-label="Add app" title="Add app" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
            <svg {...iconProps}><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {menuOpen && (
            <div className="app-panel-menu" role="menu" aria-label="Apps" onKeyDown={(event) => { if (event.key === "Escape") setMenuOpen(false); }}>
              {APP_CATALOG.map((app) => (
                <button key={app.id} className="app-panel-menu-item" type="button" role="menuitem" onClick={() => launch(app)}>{app.name}</button>
              ))}
            </div>
          )}
        </div>
      </div>
      {message && <p className="app-panel-message" role="status">{message}</p>}
      <div ref={contentRef} className="app-panel-content" aria-label="App content">
        {open && overlay && state.apps.length > 0 && (snapshot
          ? <SnapshotView image={snapshot} />
          : <p className="app-panel-hidden-note">Hidden while a dialog is open</p>)}
        {state.apps.length === 0 && !opening && (
          <div className="app-panel-empty">
            <p>Pick an app to keep next to your work.</p>
            <div className="app-panel-empty-list">
              {APP_CATALOG.map((app) => (
                <button key={app.id} className="app-panel-empty-item" type="button" aria-label={`Open ${app.name}`} onClick={() => launch(app)}>{app.name}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

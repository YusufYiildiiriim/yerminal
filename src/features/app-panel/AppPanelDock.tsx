import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { READY_MADE_APPS, nameOf, splitApps, type AppInfo } from "./apps";
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

/**
 * Numbers placement requests upward so the backend can drop one that arrives late. Starts at the
 * clock so a reloaded page still counts higher than the numbers the backend saw before.
 */
let placeSeq = Date.now();
const placeRequest = (rect: DockRect) => invoke("app_panel_place", { rect, seq: ++placeSeq });

/** Longest name the backend accepts. */
const MAX_APP_NAME = 60;

/** What the name form is doing: naming a file the backend just picked, or renaming a saved app. */
type Editor = { mode: "add" } | { mode: "rename"; id: string };

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
  const [apps, setApps] = useState<AppInfo[]>([...READY_MADE_APPS]);
  const seenNames = useRef(new Map<string, string>());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<AppInfo | null>(null);
  const [picking, setPicking] = useState(false);
  const [opening, setOpening] = useState<AppInfo | null>(null);
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

  const applyList = useCallback((list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const app of list as AppInfo[]) seenNames.current.set(app.id, app.name);
    setApps(list as AppInfo[]);
  }, []);

  // The app list (ready-made and saved apps) is kept by the backend; the page never sees a path.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<AppInfo[]>("app_panel_apps_list")
      .then((list) => { if (!cancelled) applyList(list); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [applyList]);

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
      if (rect) await placeRequest(rect);
      if (!cancelled) setSnapshot(null);
    };
    sync().catch(() => undefined);
    return () => { cancelled = true; };
  }, [shown, open, currentRect]);

  // Keep the hosted window on the content area when the dock or the main window changes.
  useEffect(() => {
    const element = contentRef.current;
    if (!open || !element || !isTauri()) return;
    // At most one request per frame, measured when the frame comes (a drag fires far more often).
    let frame: number | null = null;
    const place = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const rect = currentRect();
        if (rect) placeRequest(rect).catch(() => undefined);
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      if (frame !== null) window.cancelAnimationFrame(frame);
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

  const run = async (command: string, args: Record<string, unknown>, busy?: AppInfo) => {
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

  const launch = (app: AppInfo) => {
    setMenuOpen(false);
    // One launch at a time (a second would see the first one's new window), and an app that is
    // already open is brought forward instead of started again.
    if (opening) return;
    const rect = currentRect();
    if (!rect) return;
    if (state.apps.includes(app.id)) {
      void run("app_panel_activate", { id: app.id, rect });
      return;
    }
    // The backend knows what an id launches; the page sends the id and the dock box only.
    void run("app_panel_open", { id: app.id, rect }, app);
  };

  /** The native file picker is opened by the backend; the page only gets a suggested name back. */
  const addApp = async () => {
    setMenuOpen(false);
    if (opening || picking) return;
    setMessage("");
    setConfirming(null);
    setPicking(true);
    try {
      const picked = await invoke<{ default_name: string } | null>("app_panel_app_pick");
      if (picked) {
        setDraft(picked.default_name ?? "");
        setEditor({ mode: "add" });
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setPicking(false);
    }
  };

  const startRename = (app: AppInfo) => {
    setMenuOpen(false);
    setMessage("");
    setConfirming(null);
    setDraft(app.name);
    setEditor({ mode: "rename", id: app.id });
  };

  const startRemove = (app: AppInfo) => {
    setMenuOpen(false);
    setMessage("");
    setEditor(null);
    setConfirming(app);
  };

  const submitName = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const name = draft.trim();
    if (!editor || !name) return;
    try {
      applyList(editor.mode === "add"
        ? await invoke("app_panel_app_register", { name })
        : await invoke("app_panel_app_rename", { id: editor.id, name }));
      setEditor(null);
    } catch (error) {
      setMessage(String(error));
      // A pick is used up by one save attempt; naming it again would need a new pick.
      if (editor.mode === "add") setEditor(null);
    }
  };

  /** Removing only edits the list: an open window of that app stays open and keeps its tab. */
  const removeApp = async () => {
    const app = confirming;
    setConfirming(null);
    if (!app) return;
    try {
      applyList(await invoke("app_panel_app_remove", { id: app.id }));
    } catch (error) {
      setMessage(String(error));
    }
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

  const { ready, own } = splitApps(apps);

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
            const name = nameOf(id, apps, seenNames.current);
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
              {ready.map((app) => (
                <button key={app.id} className="app-panel-menu-item" type="button" role="menuitem" disabled={opening !== null} onClick={() => launch(app)}>{app.name}</button>
              ))}
              <div className="app-panel-menu-separator" role="separator" />
              {own.map((app) => (
                <div key={app.id} className="app-panel-menu-row" role="none">
                  <button className="app-panel-menu-item" type="button" role="menuitem" disabled={opening !== null} onClick={() => launch(app)}>{app.name}</button>
                  <button className="app-panel-menu-action" type="button" role="menuitem" aria-label={`Rename ${app.name}`} title="Rename" onClick={() => startRename(app)}>
                    <svg {...iconProps}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                  </button>
                  <button className="app-panel-menu-action" type="button" role="menuitem" aria-label={`Remove ${app.name}`} title="Remove" onClick={() => startRemove(app)}>
                    <svg {...iconProps}><path d="M7 7l10 10M17 7L7 17" /></svg>
                  </button>
                </div>
              ))}
              {own.length > 0 && <div className="app-panel-menu-separator" role="separator" />}
              <button className="app-panel-menu-item" type="button" role="menuitem" disabled={opening !== null || picking} onClick={() => void addApp()}>Add app…</button>
            </div>
          )}
        </div>
      </div>
      {editor && (
        <form
          className="app-panel-name-form"
          onSubmit={(event) => void submitName(event)}
          onKeyDown={(event) => { if (event.key === "Escape") setEditor(null); }}
        >
          <input
            className="app-panel-name-input"
            type="text"
            aria-label="App name"
            value={draft}
            maxLength={MAX_APP_NAME}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="app-panel-name-button" type="submit" disabled={draft.trim() === ""}>Save</button>
          <button className="app-panel-name-button" type="button" onClick={() => setEditor(null)}>Cancel</button>
        </form>
      )}
      {confirming && (
        <div className="app-panel-confirm" role="group" aria-label="Remove app">
          <span>Remove {confirming.name} from the list? A window that is open stays open.</span>
          <button className="app-panel-name-button" type="button" onClick={() => void removeApp()}>Remove</button>
          <button className="app-panel-name-button" type="button" onClick={() => setConfirming(null)}>Keep</button>
        </div>
      )}
      {message && <p className="app-panel-message" role="status">{message}</p>}
      <div ref={contentRef} className="app-panel-content" aria-label="App content">
        {open && overlay && state.apps.length > 0 && (snapshot
          ? <SnapshotView image={snapshot} />
          : <p className="app-panel-hidden-note">Hidden while a dialog is open</p>)}
        {state.apps.length === 0 && !opening && (
          <div className="app-panel-empty">
            <p>Pick an app to keep next to your work.</p>
            <div className="app-panel-empty-list">
              {[...ready, ...own].map((app) => (
                <button key={app.id} className="app-panel-empty-item" type="button" aria-label={`Open ${app.name}`} onClick={() => launch(app)}>{app.name}</button>
              ))}
              <button className="app-panel-empty-item" type="button" disabled={picking} onClick={() => void addApp()}>Add app…</button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

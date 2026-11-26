export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 720;
export const DOCK_DEFAULT_WIDTH = 380;
/** Space the workspace keeps when the dock grows. */
const WORKSPACE_MIN_WIDTH = 480;
const STORAGE_KEY = "yerminal.app-panel";

export interface DockPrefs {
  open: boolean;
  width: number;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

export function clampDockWidth(width: number, viewportWidth: number): number {
  const max = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, viewportWidth - WORKSPACE_MIN_WIDTH));
  return Math.round(Math.min(max, Math.max(DOCK_MIN_WIDTH, width)));
}

export function readDockPrefs(storage: ReadStorage = localStorage): DockPrefs {
  const fallback: DockPrefs = { open: false, width: DOCK_DEFAULT_WIDTH };
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as { open?: unknown; width?: unknown };
    const width = typeof raw.width === "number" && Number.isFinite(raw.width)
      ? Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(raw.width)))
      : DOCK_DEFAULT_WIDTH;
    return { open: raw.open === true, width };
  } catch {
    return fallback;
  }
}

export function writeDockPrefs(patch: Partial<DockPrefs>, storage: WriteStorage = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...readDockPrefs(storage), ...patch }));
  } catch {
    // A preference only; the dock keeps working without persistence.
  }
}

/**
 * Dialogs and menus are HTML and cannot draw over the native app window, so the window is
 * hidden while one is rendered.
 */
export const BLOCKING_OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]';


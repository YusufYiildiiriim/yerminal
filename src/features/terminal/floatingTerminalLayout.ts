import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export type TerminalLayoutMode = "tiled" | "floating";
export type TerminalDockEdge = "left" | "right" | "top" | "bottom";

export type FloatingTerminalRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type FloatingLayoutSnapshot = {
  workspaceId: string;
  mode: TerminalLayoutMode;
  positions: Record<string, FloatingTerminalRect>;
};

type DragState = {
  sessionId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
};

export type TerminalResizeDirection = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

type ResizeState = {
  sessionId: string;
  pointerId: number;
  direction: TerminalResizeDirection;
  startX: number;
  startY: number;
  startRect: FloatingTerminalRect;
};

export type FloatingTerminalLayoutController = {
  mode: TerminalLayoutMode;
  setMode: (mode: TerminalLayoutMode) => void;
  positions: Record<string, FloatingTerminalRect>;
  draggingSessionId: string | null;
  resizingSessionId: string | null;
  dockTarget: TerminalDockEdge | null;
  surfaceRef: RefObject<HTMLDivElement | null>;
  getRect: (sessionId: string) => FloatingTerminalRect;
  getWindowStyle: (sessionId: string) => CSSProperties;
  startDrag: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  moveDrag: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  endDrag: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  cancelDrag: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  startResize: (sessionId: string, direction: TerminalResizeDirection, event: ReactPointerEvent<HTMLElement>) => void;
  moveResize: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  endResize: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  cancelResize: (sessionId: string, event: ReactPointerEvent<HTMLElement>) => void;
  nudgeResize: (sessionId: string, direction: TerminalResizeDirection, key: string) => boolean;
};

const STORAGE_PREFIX = "yerminal:floating-terminal-layout:v1:";
const EDGE_SNAP_DISTANCE = 36;
const MIN_WIDTH_PX = 240;
const MIN_HEIGHT_PX = 160;
const MIN_SIZE_PERCENT = 14;
const KEYBOARD_RESIZE_STEP = 4;

function storageKey(workspaceId: string) {
  return `${STORAGE_PREFIX}${workspaceId}`;
}

function isRect(value: unknown): value is FloatingTerminalRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Partial<FloatingTerminalRect>;
  return [rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part));
}

function normalizeStoredRect(rect: FloatingTerminalRect): FloatingTerminalRect {
  const width = Math.max(MIN_SIZE_PERCENT, Math.min(100, rect.width));
  const height = Math.max(MIN_SIZE_PERCENT, Math.min(100, rect.height));
  return {
    x: Math.max(0, Math.min(100 - width, rect.x)),
    y: Math.max(0, Math.min(100 - height, rect.y)),
    width,
    height,
  };
}

function createDefaultPositions(sessionIds: string[]): Record<string, FloatingTerminalRect> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(sessionIds.length)));
  const rows = Math.max(1, Math.ceil(sessionIds.length / columns));
  const gap = 3;
  const width = Math.min(56, (100 - gap * (columns + 1)) / columns);
  const height = Math.min(58, (100 - gap * (rows + 1)) / rows);

  return Object.fromEntries(sessionIds.map((sessionId, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return [sessionId, { x: gap + column * (width + gap), y: gap + row * (height + gap), width, height }];
  }));
}

function readSnapshot(workspaceId: string, sessionIds: string[]): FloatingLayoutSnapshot {
  const defaults = createDefaultPositions(sessionIds);
  try {
    const stored = localStorage.getItem(storageKey(workspaceId));
    if (stored) {
      const value = JSON.parse(stored) as Partial<FloatingLayoutSnapshot>;
      if (value.workspaceId === workspaceId) {
        const positions: Record<string, FloatingTerminalRect> = { ...defaults };
        for (const sessionId of sessionIds) {
          if (isRect(value.positions?.[sessionId])) positions[sessionId] = normalizeStoredRect(value.positions[sessionId]);
        }
        return { workspaceId, mode: value.mode === "floating" ? "floating" : "tiled", positions };
      }
    }
  } catch {
    // Ignore invalid persisted data and initialize a safe default layout.
  }
  return { workspaceId, mode: "tiled", positions: defaults };
}

function edgeAtPoint(clientX: number, clientY: number, bounds: DOMRect): TerminalDockEdge | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const distances = [
    { edge: "left" as const, distance: clientX - bounds.left },
    { edge: "right" as const, distance: bounds.right - clientX },
    { edge: "top" as const, distance: clientY - bounds.top },
    { edge: "bottom" as const, distance: bounds.bottom - clientY },
  ].sort((first, second) => first.distance - second.distance);
  return distances[0].distance <= EDGE_SNAP_DISTANCE ? distances[0].edge : null;
}

type CanvasBounds = { left: number; top: number; width: number; height: number };

function getCanvasBounds(surface: HTMLElement): CanvasBounds | null {
  const rect = surface.getBoundingClientRect();
  const scaleX = surface.offsetWidth > 0 ? rect.width / surface.offsetWidth : 1;
  const scaleY = surface.offsetHeight > 0 ? rect.height / surface.offsetHeight : 1;
  const bounds = {
    left: rect.left + surface.clientLeft * scaleX,
    top: rect.top + surface.clientTop * scaleY,
    width: surface.clientWidth * scaleX,
    height: surface.clientHeight * scaleY,
  };
  return bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

function clampRectToCanvas(rect: FloatingTerminalRect, bounds: CanvasBounds): FloatingTerminalRect {
  const minWidth = Math.min(100, Math.max(MIN_SIZE_PERCENT, MIN_WIDTH_PX / bounds.width * 100));
  const minHeight = Math.min(100, Math.max(MIN_SIZE_PERCENT, MIN_HEIGHT_PX / bounds.height * 100));
  const renderedWidth = Math.min(100, Math.max(minWidth, rect.width));
  const renderedHeight = Math.min(100, Math.max(minHeight, rect.height));
  return {
    ...rect,
    x: Math.max(0, Math.min(100 - renderedWidth, rect.x)),
    y: Math.max(0, Math.min(100 - renderedHeight, rect.y)),
  };
}

export function useFloatingTerminalLayout(
  workspaceId: string,
  sessionIds: string[],
  onDockToTiledLayout?: (sessionId: string, edge: TerminalDockEdge) => void,
): FloatingTerminalLayoutController {
  const [snapshot, setSnapshot] = useState<FloatingLayoutSnapshot>(() => readSnapshot(workspaceId, sessionIds));
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [resizingSessionId, setResizingSessionId] = useState<string | null>(null);
  const [dockTarget, setDockTarget] = useState<TerminalDockEdge | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const dockCallbackRef = useRef(onDockToTiledLayout);
  dockCallbackRef.current = onDockToTiledLayout;
  const sessionIdsKey = sessionIds.join("\u0000");

  useEffect(() => {
    setSnapshot(readSnapshot(workspaceId, sessionIds));
    setDraggingSessionId(null);
    setResizingSessionId(null);
    setDockTarget(null);
    dragRef.current = null;
    resizeRef.current = null;
  }, [workspaceId]);

  useEffect(() => {
    const validIds = new Set(sessionIds);
    setSnapshot((current) => {
      if (current.workspaceId !== workspaceId) return readSnapshot(workspaceId, sessionIds);
      const positions = Object.fromEntries(Object.entries(current.positions).filter(([sessionId]) => validIds.has(sessionId)));
      const defaults = createDefaultPositions(sessionIds);
      for (const sessionId of sessionIds) positions[sessionId] ??= defaults[sessionId];
      return { ...current, positions };
    });
  }, [sessionIdsKey, workspaceId]);

  useEffect(() => {
    if (snapshot.workspaceId !== workspaceId) return;
    const timeoutId = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey(workspaceId), JSON.stringify(snapshot));
      } catch {
        // The in-memory layout remains usable when browser storage is unavailable.
      }
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [snapshot, workspaceId]);

  const currentSnapshot = snapshot.workspaceId === workspaceId ? snapshot : readSnapshot(workspaceId, sessionIds);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const clampVisibleRects = () => {
      const bounds = getCanvasBounds(surface);
      if (!bounds) return;
      setSnapshot((current) => {
        if (current.workspaceId !== workspaceId || current.mode !== "floating") return current;
        let changed = false;
        const positions = Object.fromEntries(Object.entries(current.positions).map(([sessionId, rect]) => {
          const clamped = clampRectToCanvas(rect, bounds);
          if (clamped.x !== rect.x || clamped.y !== rect.y) changed = true;
          return [sessionId, clamped];
        }));
        return changed ? { ...current, positions } : current;
      });
    };

    const observer = new ResizeObserver(clampVisibleRects);
    observer.observe(surface);
    clampVisibleRects();
    return () => observer.disconnect();
  }, [currentSnapshot.mode, workspaceId]);

  const setMode = useCallback((mode: TerminalLayoutMode) => {
    setSnapshot((current) => {
      const target = current.workspaceId === workspaceId ? current : readSnapshot(workspaceId, sessionIds);
      return { ...target, mode };
    });
  }, [sessionIdsKey, workspaceId]);

  const getRect = useCallback((sessionId: string) => currentSnapshot.positions[sessionId] ?? createDefaultPositions(sessionIds)[sessionId] ?? { x: 4, y: 4, width: 50, height: 50 }, [currentSnapshot, sessionIdsKey]);

  const getWindowStyle = useCallback((sessionId: string): CSSProperties => {
    const rect = getRect(sessionId);
    return {
      left: `${rect.x}%`,
      top: `${rect.y}%`,
      width: `${rect.width}%`,
      height: `${rect.height}%`,
    };
  }, [getRect]);

  const startDrag = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !surfaceRef.current) return;
    const pane = event.currentTarget.closest<HTMLElement>(".floating-terminal-window");
    if (!pane) return;
    const paneBounds = pane.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      sessionId,
      pointerId: event.pointerId,
      offsetX: event.clientX - paneBounds.left,
      offsetY: event.clientY - paneBounds.top,
    };
    setDraggingSessionId(sessionId);
  }, []);

  const moveDrag = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const surface = surfaceRef.current;
    if (!drag || drag.sessionId !== sessionId || drag.pointerId !== event.pointerId || !surface) return;
    const bounds = getCanvasBounds(surface);
    const pane = event.currentTarget.closest<HTMLElement>(".floating-terminal-window");
    if (!bounds || !pane) return;
    const paneBounds = pane.getBoundingClientRect();
    const current = getRect(sessionId);
    const maxX = Math.max(0, (bounds.width - paneBounds.width) / bounds.width * 100);
    const maxY = Math.max(0, (bounds.height - paneBounds.height) / bounds.height * 100);
    const x = Math.max(0, Math.min(maxX, (event.clientX - drag.offsetX - bounds.left) / bounds.width * 100));
    const y = Math.max(0, Math.min(maxY, (event.clientY - drag.offsetY - bounds.top) / bounds.height * 100));
    setSnapshot((value) => {
      const target = value.workspaceId === workspaceId ? value : readSnapshot(workspaceId, sessionIds);
      return { ...target, positions: { ...target.positions, [sessionId]: { ...current, x, y } } };
    });
    setDockTarget(edgeAtPoint(event.clientX, event.clientY, surface.getBoundingClientRect()));
  }, [getRect, sessionIdsKey, workspaceId]);

  const endDrag = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.sessionId !== sessionId || drag.pointerId !== event.pointerId) return;
    const surface = surfaceRef.current;
    const edge = surface ? edgeAtPoint(event.clientX, event.clientY, surface.getBoundingClientRect()) : null;
    dragRef.current = null;
    setDraggingSessionId(null);
    setDockTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (edge && dockCallbackRef.current) {
      setMode("tiled");
      dockCallbackRef.current(sessionId, edge);
    }
  }, [setMode]);

  const cancelDrag = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.sessionId !== sessionId || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingSessionId(null);
    setDockTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const updateRect = useCallback((sessionId: string, rect: FloatingTerminalRect) => {
    setSnapshot((value) => {
      const target = value.workspaceId === workspaceId ? value : readSnapshot(workspaceId, sessionIds);
      return { ...target, positions: { ...target.positions, [sessionId]: rect } };
    });
  }, [sessionIdsKey, workspaceId]);

  const startResize = useCallback((sessionId: string, direction: TerminalResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    if (currentSnapshot.mode !== "floating" || event.button !== 0 || !surfaceRef.current) return;
    const bounds = surfaceRef.current.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    resizeRef.current = {
      sessionId,
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRect: getRect(sessionId),
    };
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingSessionId(sessionId);
  }, [currentSnapshot.mode, getRect]);

  const moveResize = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    const surface = surfaceRef.current;
    if (!resize || resize.sessionId !== sessionId || resize.pointerId !== event.pointerId || !surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const deltaX = (event.clientX - resize.startX) / bounds.width * 100;
    const deltaY = (event.clientY - resize.startY) / bounds.height * 100;
    const start = resize.startRect;
    const minWidth = Math.min(100, Math.max(MIN_SIZE_PERCENT, MIN_WIDTH_PX / bounds.width * 100));
    const minHeight = Math.min(100, Math.max(MIN_SIZE_PERCENT, MIN_HEIGHT_PX / bounds.height * 100));
    let next = { ...start };
    if (resize.direction.includes("left")) {
      next.x = Math.max(0, Math.min(start.x + start.width - minWidth, start.x + deltaX));
      next.width = start.x + start.width - next.x;
    } else if (resize.direction.includes("right")) {
      next.width = Math.max(minWidth, Math.min(100 - start.x, start.width + deltaX));
    }
    if (resize.direction.includes("top")) {
      next.y = Math.max(0, Math.min(start.y + start.height - minHeight, start.y + deltaY));
      next.height = start.y + start.height - next.y;
    } else if (resize.direction.includes("bottom")) {
      next.height = Math.max(minHeight, Math.min(100 - start.y, start.height + deltaY));
    }
    updateRect(sessionId, next);
  }, [updateRect]);

  const endResize = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.sessionId !== sessionId || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setResizingSessionId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const cancelResize = useCallback((sessionId: string, event: ReactPointerEvent<HTMLElement>) => {
    endResize(sessionId, event);
  }, [endResize]);

  const nudgeResize = useCallback((sessionId: string, direction: TerminalResizeDirection, key: string) => {
    if (currentSnapshot.mode !== "floating") return false;
    const rect = getRect(sessionId);
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const minWidth = bounds && bounds.width > 0 ? Math.min(100, Math.max(MIN_SIZE_PERCENT, MIN_WIDTH_PX / bounds.width * 100)) : MIN_SIZE_PERCENT;
    const minHeight = bounds && bounds.height > 0 ? Math.min(100, Math.max(MIN_SIZE_PERCENT, MIN_HEIGHT_PX / bounds.height * 100)) : MIN_SIZE_PERCENT;
    const next = { ...rect };
    if ((key === "ArrowLeft" || key === "ArrowRight") && (direction.includes("left") || direction.includes("right"))) {
      const delta = (key === "ArrowLeft" ? -1 : 1) * KEYBOARD_RESIZE_STEP;
      if (direction.includes("left")) {
        next.x = Math.max(0, Math.min(rect.x + rect.width - minWidth, rect.x + delta));
        next.width = rect.x + rect.width - next.x;
      } else {
        next.width = Math.max(minWidth, Math.min(100 - rect.x, rect.width + delta));
      }
    } else if ((key === "ArrowUp" || key === "ArrowDown") && (direction.includes("top") || direction.includes("bottom"))) {
      const delta = (key === "ArrowUp" ? -1 : 1) * KEYBOARD_RESIZE_STEP;
      if (direction.includes("top")) {
        next.y = Math.max(0, Math.min(rect.y + rect.height - minHeight, rect.y + delta));
        next.height = rect.y + rect.height - next.y;
      } else {
        next.height = Math.max(minHeight, Math.min(100 - rect.y, rect.height + delta));
      }
    } else return false;
    updateRect(sessionId, next);
    return true;
  }, [currentSnapshot.mode, getRect, updateRect]);

  return { mode: currentSnapshot.mode, setMode, positions: currentSnapshot.positions, draggingSessionId, resizingSessionId, dockTarget, surfaceRef, getRect, getWindowStyle, startDrag, moveDrag, endDrag, cancelDrag, startResize, moveResize, endResize, cancelResize, nudgeResize };
}

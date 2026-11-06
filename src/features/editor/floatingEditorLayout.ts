import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

export type EditorLayoutMode = "tiled" | "free";
export type EditorDockEdge = "left" | "right" | "top" | "bottom";

export type FloatingEditorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type FloatingEditorSnapshot = {
  workspaceId: string;
  mode: EditorLayoutMode;
  positions: Record<string, FloatingEditorRect>;
};

type DragState = {
  groupId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

type ResizeDirection = "left" | "right" | "top" | "bottom";

type ResizeState = {
  groupId: string;
  pointerId: number;
  direction: ResizeDirection;
  startX: number;
  startY: number;
  startRect: FloatingEditorRect;
};

export type FloatingEditorLayoutController = {
  mode: EditorLayoutMode;
  setMode: (mode: EditorLayoutMode) => void;
  draggingGroupId: string | null;
  resizingGroupId: string | null;
  dockTarget: EditorDockEdge | null;
  surfaceRef: RefObject<HTMLDivElement | null>;
  getRect: (groupId: string) => FloatingEditorRect;
  getWindowStyle: (groupId: string) => CSSProperties;
  startDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  moveDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  endDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  cancelDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  startResize: (groupId: string, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => void;
  moveResize: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  endResize: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  cancelResize: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  nudgeResize: (groupId: string, key: string) => boolean;
};

const STORAGE_PREFIX = "yerminal:floating-editor-layout:v1:";
const EDGE_SNAP_DISTANCE = 36;
const GROUP_GAP = 3;
const MIN_EDITOR_SIZE = 12;
const KEYBOARD_RESIZE_STEP = 4;

function storageKey(workspaceId: string) {
  return STORAGE_PREFIX + workspaceId;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isRect(value: unknown): value is FloatingEditorRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Partial<FloatingEditorRect>;
  return [rect.x, rect.y, rect.width, rect.height].every((part) => typeof part === "number" && Number.isFinite(part))
    && rect.x! >= 0 && rect.y! >= 0 && rect.width! > 0 && rect.height! > 0;
}

function createDefaultPositions(groupIds: string[]): Record<string, FloatingEditorRect> {
  if (groupIds.length === 0) return {};
  const columns = Math.max(1, Math.ceil(Math.sqrt(groupIds.length)));
  const rows = Math.max(1, Math.ceil(groupIds.length / columns));
  const width = (100 - GROUP_GAP * (columns + 1)) / columns;
  const height = (100 - GROUP_GAP * (rows + 1)) / rows;
  return Object.fromEntries(groupIds.map((groupId, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return [groupId, {
      x: GROUP_GAP + column * (width + GROUP_GAP),
      y: GROUP_GAP + row * (height + GROUP_GAP),
      width,
      height,
    }];
  }));
}

function normalizeSnapshot(
  snapshot: Partial<FloatingEditorSnapshot> | null | undefined,
  workspaceId: string,
  groupIds: string[],
): FloatingEditorSnapshot {
  const defaults = createDefaultPositions(groupIds);
  const positions: Record<string, FloatingEditorRect> = {};
  for (const groupId of groupIds) {
    const stored = snapshot?.positions?.[groupId];
    if (isRect(stored)) {
      const width = clamp(stored.width, 12, 100);
      const height = clamp(stored.height, 12, 100);
      positions[groupId] = {
        x: clamp(stored.x, 0, 100 - width),
        y: clamp(stored.y, 0, 100 - height),
        width,
        height,
      };
    } else {
      positions[groupId] = defaults[groupId];
    }
  }
  return {
    workspaceId,
    mode: snapshot?.mode === "free" ? "free" : "tiled",
    positions,
  };
}

function readSnapshot(workspaceId: string, groupIds: string[]): FloatingEditorSnapshot {
  try {
    const stored = localStorage.getItem(storageKey(workspaceId));
    if (stored) {
      const value = JSON.parse(stored) as Partial<FloatingEditorSnapshot>;
      if (value.workspaceId === workspaceId) return normalizeSnapshot(value, workspaceId, groupIds);
    }
  } catch {
    // Ignore invalid persisted data and use the default tiled layout.
  }
  return normalizeSnapshot(null, workspaceId, groupIds);
}

function edgeAtPoint(clientX: number, clientY: number, bounds: DOMRect): EditorDockEdge | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const distances = [
    { edge: "left" as const, distance: clientX - bounds.left },
    { edge: "right" as const, distance: bounds.right - clientX },
    { edge: "top" as const, distance: clientY - bounds.top },
    { edge: "bottom" as const, distance: bounds.bottom - clientY },
  ].sort((first, second) => first.distance - second.distance);
  return distances[0].distance <= EDGE_SNAP_DISTANCE ? distances[0].edge : null;
}

export function useFloatingEditorLayout(workspaceId: string, groupIds: string[]): FloatingEditorLayoutController {
  const groupIdsKey = groupIds.join("|");
  const stableGroupIds = useMemo(
    () => groupIdsKey ? groupIdsKey.split("|") : [],
    [groupIdsKey],
  );
  const [snapshot, setSnapshot] = useState<FloatingEditorSnapshot>(() => readSnapshot(workspaceId, stableGroupIds));
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [resizingGroupId, setResizingGroupId] = useState<string | null>(null);
  const [dockTarget, setDockTarget] = useState<EditorDockEdge | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const currentSnapshot = snapshot.workspaceId === workspaceId
    ? normalizeSnapshot(snapshot, workspaceId, stableGroupIds)
    : readSnapshot(workspaceId, stableGroupIds);

  useEffect(() => {
    setSnapshot(readSnapshot(workspaceId, stableGroupIds));
    dragRef.current = null;
    resizeRef.current = null;
    setDraggingGroupId(null);
    setResizingGroupId(null);
    setDockTarget(null);
  }, [workspaceId]);

  useEffect(() => {
    setSnapshot((current) => normalizeSnapshot(
      current.workspaceId === workspaceId ? current : readSnapshot(workspaceId, stableGroupIds),
      workspaceId,
      stableGroupIds,
    ));
  }, [workspaceId, groupIdsKey]);

  useEffect(() => {
    if (snapshot.workspaceId !== workspaceId) return;
    try {
      localStorage.setItem(storageKey(workspaceId), JSON.stringify(normalizeSnapshot(snapshot, workspaceId, stableGroupIds)));
    } catch {
      // Keep the in-memory layout usable if storage is unavailable.
    }
  }, [snapshot, workspaceId, groupIdsKey]);

  const updateSnapshot = (update: (current: FloatingEditorSnapshot) => FloatingEditorSnapshot) => {
    setSnapshot((current) => update(normalizeSnapshot(
      current.workspaceId === workspaceId ? current : readSnapshot(workspaceId, stableGroupIds),
      workspaceId,
      stableGroupIds,
    )));
  };

  const setMode = (mode: EditorLayoutMode) => {
    updateSnapshot((current) => ({ ...current, mode }));
  };

  const getRect = (groupId: string) => currentSnapshot.positions[groupId] ?? createDefaultPositions([groupId])[groupId];
  const getWindowStyle = (groupId: string): CSSProperties => {
    if (currentSnapshot.mode !== "free") return {};
    const rect = getRect(groupId);
    return {
      left: rect.x + "%",
      top: rect.y + "%",
      width: rect.width + "%",
      height: rect.height + "%",
    };
  };

  const startDrag = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (currentSnapshot.mode !== "free" || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, select, input, textarea, .editor-group-resize-handle")) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const rect = getRect(groupId);
    const left = bounds.left + rect.x / 100 * bounds.width;
    const top = bounds.top + rect.y / 100 * bounds.height;
    dragRef.current = {
      groupId,
      pointerId: event.pointerId,
      offsetX: event.clientX - left,
      offsetY: event.clientY - top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingGroupId(groupId);
  };

  const moveDrag = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const surface = surfaceRef.current;
    if (!drag || drag.groupId !== groupId || drag.pointerId !== event.pointerId || !surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const current = getRect(groupId);
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) drag.moved = true;
    const x = clamp((event.clientX - drag.offsetX - bounds.left) / bounds.width * 100, 0, 100 - current.width);
    const y = clamp((event.clientY - drag.offsetY - bounds.top) / bounds.height * 100, 0, 100 - current.height);
    updateSnapshot((value) => ({
      ...value,
      positions: { ...value.positions, [groupId]: { ...current, x, y } },
    }));
    setDockTarget(drag.moved ? edgeAtPoint(event.clientX, event.clientY, bounds) : null);
  };

  const endDrag = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.groupId !== groupId || drag.pointerId !== event.pointerId) return;
    const surface = surfaceRef.current;
    const edge = drag.moved && surface ? edgeAtPoint(event.clientX, event.clientY, surface.getBoundingClientRect()) : null;
    dragRef.current = null;
    setDraggingGroupId(null);
    setDockTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (edge) setMode("tiled");
  };

  const cancelDrag = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.groupId !== groupId || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingGroupId(null);
    setDockTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startResize = (groupId: string, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    if (currentSnapshot.mode !== "free" || event.button !== 0) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    resizeRef.current = {
      groupId,
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startRect: getRect(groupId),
    };
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingGroupId(groupId);
  };

  const resizeGroupTo = (groupId: string, rect: FloatingEditorRect) => {
    updateSnapshot((value) => ({
      ...value,
      positions: { ...value.positions, [groupId]: rect },
    }));
  };

  const moveResize = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    const surface = surfaceRef.current;
    if (!resize || resize.groupId !== groupId || resize.pointerId !== event.pointerId || !surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const deltaX = (event.clientX - resize.startX) / bounds.width * 100;
    const deltaY = (event.clientY - resize.startY) / bounds.height * 100;
    const start = resize.startRect;
    let next = { ...start };
    if (resize.direction === "right") next.width = clamp(start.width + deltaX, MIN_EDITOR_SIZE, 100 - start.x);
    else if (resize.direction === "left") {
      next.x = clamp(start.x + deltaX, 0, start.x + start.width - MIN_EDITOR_SIZE);
      next.width = start.x + start.width - next.x;
    } else if (resize.direction === "bottom") next.height = clamp(start.height + deltaY, MIN_EDITOR_SIZE, 100 - start.y);
    else {
      next.y = clamp(start.y + deltaY, 0, start.y + start.height - MIN_EDITOR_SIZE);
      next.height = start.y + start.height - next.y;
    }
    resizeGroupTo(groupId, next);
  };

  const endResize = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.groupId !== groupId || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setResizingGroupId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const cancelResize = (groupId: string, event: ReactPointerEvent<HTMLElement>) => {
    endResize(groupId, event);
  };

  const nudgeResize = (groupId: string, key: string) => {
    if (currentSnapshot.mode !== "free") return false;
    const rect = getRect(groupId);
    let next = { ...rect };
    if (key === "ArrowRight") next.width = clamp(rect.width + KEYBOARD_RESIZE_STEP, MIN_EDITOR_SIZE, 100 - rect.x);
    else if (key === "ArrowLeft") next.width = clamp(rect.width - KEYBOARD_RESIZE_STEP, MIN_EDITOR_SIZE, 100 - rect.x);
    else if (key === "ArrowDown") next.height = clamp(rect.height + KEYBOARD_RESIZE_STEP, MIN_EDITOR_SIZE, 100 - rect.y);
    else if (key === "ArrowUp") next.height = clamp(rect.height - KEYBOARD_RESIZE_STEP, MIN_EDITOR_SIZE, 100 - rect.y);
    else return false;
    resizeGroupTo(groupId, next);
    return true;
  };

  return {
    mode: currentSnapshot.mode,
    setMode,
    draggingGroupId,
    resizingGroupId,
    dockTarget,
    surfaceRef,
    getRect,
    getWindowStyle,
    startDrag,
    moveDrag,
    endDrag,
    cancelDrag,
    startResize,
    moveResize,
    endResize,
    cancelResize,
    nudgeResize,
  };
}

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { findGroupAtPoint, hasDragStarted, resolveTerminalGroupDrop, type GroupHit } from "./terminalGroupDrag";

type PendingDrag = {
  terminalId: string;
  sourceGroupId: string;
  pointerId: number;
  start: { x: number; y: number };
  started: boolean;
  overGroupId: string | null;
};

function collectGroupHits(): GroupHit[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-terminal-group-id]")).map((element) => {
    const rect = element.getBoundingClientRect();
    return { groupId: element.dataset.terminalGroupId ?? "", rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
  });
}

/**
 * Pointer-driven drag of a terminal row onto another terminal group.
 * Pointer events are used instead of HTML5 drag and drop because Tauri's native
 * drag-drop handler on Windows swallows in-page HTML5 drags (the pane drag does the same).
 */
export function useTerminalGroupDrag(onDrop: (terminalId: string, groupId: string) => void) {
  const pendingRef = useRef<PendingDrag | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const onDropRef = useRef(onDrop);
  useEffect(() => { onDropRef.current = onDrop; }, [onDrop]);
  const [dragTerminalId, setDragTerminalId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

  const finish = useCallback((commit: boolean) => {
    const drag = pendingRef.current;
    detachRef.current?.();
    detachRef.current = null;
    pendingRef.current = null;
    setDragTerminalId(null);
    setDropTargetGroupId(null);
    if (!drag?.started) return;
    suppressClickRef.current = true;
    // The click that follows pointerup is dispatched in the same task; clear the flag after it.
    setTimeout(() => { suppressClickRef.current = false; }, 0);
    const target = commit ? resolveTerminalGroupDrop(drag.sourceGroupId, drag.overGroupId) : null;
    if (target) onDropRef.current(drag.terminalId, target);
  }, []);

  useEffect(() => () => { detachRef.current?.(); }, []);

  const rowProps = useCallback((terminalId: string, groupId: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || pendingRef.current) return;
      const pending: PendingDrag = { terminalId, sourceGroupId: groupId, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, started: false, overGroupId: null };
      pendingRef.current = pending;

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pending.pointerId) return;
        const point = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!pending.started) {
          if (!hasDragStarted(pending.start, point)) return;
          pending.started = true;
          setDragTerminalId(terminalId);
        }
        pending.overGroupId = findGroupAtPoint(point, collectGroupHits());
        setDropTargetGroupId(resolveTerminalGroupDrop(pending.sourceGroupId, pending.overGroupId));
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId === pending.pointerId) finish(true);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pending.pointerId) finish(false);
      };
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape" || !pending.started) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(false);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      detachRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      };
    },
  }), [finish]);

  /** Row click handler calls this first; true means the click was the end of a drag and must be ignored. */
  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return { rowProps, dragTerminalId, dropTargetGroupId, consumeSuppressedClick };
}

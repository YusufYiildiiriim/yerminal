export const DRAG_START_DISTANCE_PX = 5;

export type DragPoint = { x: number; y: number };
export type GroupRect = { left: number; top: number; right: number; bottom: number };
export type GroupHit = { groupId: string; rect: GroupRect };

/** A press becomes a drag only after the pointer leaves a small dead zone, so clicks stay clicks. */
export function hasDragStarted(start: DragPoint, current: DragPoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_START_DISTANCE_PX;
}

export function findGroupAtPoint(point: DragPoint, groups: GroupHit[]): string | null {
  const hit = groups.find(({ rect }) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  return hit ? hit.groupId : null;
}

/** Returns the group a terminal should move to, or null when releasing should do nothing. */
export function resolveTerminalGroupDrop(sourceGroupId: string, targetGroupId: string | null): string | null {
  if (!targetGroupId || targetGroupId === sourceGroupId) return null;
  return targetGroupId;
}

import { BLOCKING_OVERLAY_SELECTOR } from "./dockPrefs";
import { isDockRectUsable, toDeviceRect, type DockRect } from "./dockRect";

/** CSS pixel boxes of the dialogs and menus now in the DOM (the element itself, never a backdrop around it). */
export function overlayBoxes(root: ParentNode): DockRect[] {
  const boxes: DockRect[] = [];
  for (const element of Array.from(root.querySelectorAll(BLOCKING_OVERLAY_SELECTOR))) {
    const rect = element.getBoundingClientRect();
    const box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    if (isDockRectUsable(box)) boxes.push(box);
  }
  return boxes;
}

function overlap(a: DockRect, b: DockRect): boolean {
  const edge = (r: DockRect) => ({ l: Math.round(r.x), t: Math.round(r.y), r: Math.round(r.x + r.width), b: Math.round(r.y + r.height) });
  const [p, q] = [edge(a), edge(b)];
  return p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;
}

/**
 * True when any overlay covers part of the dock content box, where the native window is drawn.
 * Both sides are compared in device pixels rounded the way the native window is placed.
 */
export function overlapsContent(overlays: DockRect[], content: DockRect, pixelRatio: number): boolean {
  if (!isDockRectUsable(content)) return false;
  const target = toDeviceRect(content, pixelRatio);
  return overlays.some((box) => overlap(toDeviceRect(box, pixelRatio), target));
}

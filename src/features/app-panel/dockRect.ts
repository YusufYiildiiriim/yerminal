/** Dock box in CSS pixels, relative to the main window client area. */
export interface DockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function toDockRect(box: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">): DockRect {
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export function isDockRectUsable(rect: DockRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

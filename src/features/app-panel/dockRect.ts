/** Dock box relative to the main window client area, in CSS pixels or (after toDeviceRect) device pixels. */
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

/**
 * CSS pixels to device pixels. The ratio is window.devicePixelRatio, which already includes the
 * webview zoom; the window scale factor does not, and using it misplaces the hosted window.
 */
export function toDeviceRect(rect: DockRect, pixelRatio: number): DockRect {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { x: rect.x * ratio, y: rect.y * ratio, width: rect.width * ratio, height: rect.height * ratio };
}

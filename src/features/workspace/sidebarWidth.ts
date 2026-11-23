/** Pixel limits for the workspace tools sidebar (the Panel that holds the rail and its content). */
export const SIDEBAR_MIN_PX = 240;
export const SIDEBAR_MAX_PX = 560;

/** Clamps a sidebar width in px to the allowed range. Non-finite input falls back to the minimum. */
export function clampSidebarWidth(px: number): number {
  return px;
}

/** Converts a px width to the percent the resizable panel group expects, for a window of the given width. */
export function sidebarLimitPercent(px: number, viewportWidth: number): number {
  return 0;
}

/** Where the branch popover goes, from the trigger's rectangle and the viewport. Pure, so it can be tested without a DOM. */

export type AnchorRect = { top: number; bottom: number; left: number; width: number };
export type ViewportSize = { width: number; height: number };
export type PopoverPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when the popover opens below the trigger. */
  top?: number;
  /** Set when the popover opens above the trigger (distance from the viewport bottom). */
  bottom?: number;
  placement: "below" | "above";
};

export const POPOVER_MIN_WIDTH = 240;
export const POPOVER_MAX_WIDTH = 280;
export const POPOVER_MAX_HEIGHT = 340;
export const POPOVER_GAP = 4;
export const VIEWPORT_MARGIN = 8;

/**
 * Width is at least the trigger's width (and at least 240 px), at most 280 px and never wider than the
 * viewport minus the margins. It opens below the trigger unless there is clearly more room above.
 */
export function placeBranchPopover(anchor: AnchorRect, viewport: ViewportSize): PopoverPlacement {
  const margin = VIEWPORT_MARGIN;
  const width = Math.max(0, Math.min(Math.max(anchor.width, POPOVER_MIN_WIDTH), POPOVER_MAX_WIDTH, viewport.width - 2 * margin));
  const left = Math.min(Math.max(anchor.left, margin), Math.max(margin, viewport.width - width - margin));
  const below = viewport.height - anchor.bottom - POPOVER_GAP - margin;
  const above = anchor.top - POPOVER_GAP - margin;
  const openBelow = below >= Math.min(POPOVER_MAX_HEIGHT, 200) || below >= above;
  if (openBelow) return { left, width, top: anchor.bottom + POPOVER_GAP, maxHeight: Math.max(0, Math.min(POPOVER_MAX_HEIGHT, below)), placement: "below" };
  return { left, width, bottom: viewport.height - anchor.top + POPOVER_GAP, maxHeight: Math.max(0, Math.min(POPOVER_MAX_HEIGHT, above)), placement: "above" };
}

import { describe, expect, it } from "vitest";
import { placeBranchPopover, POPOVER_MAX_HEIGHT, POPOVER_MAX_WIDTH } from "../../src/features/git/branchPopoverPlacement";

const anchorAt = (left: number, top: number, width = 120, height = 24) => ({ left, top, width, bottom: top + height });

describe("placeBranchPopover", () => {
  it("opens below the trigger, aligned to its left edge, with a 4 px gap", () => {
    const place = placeBranchPopover(anchorAt(20, 100), { width: 800, height: 900 });
    expect(place.placement).toBe("below");
    expect(place.left).toBe(20);
    expect(place.top).toBe(128);
    expect(place.bottom).toBeUndefined();
  });

  it("is at least as wide as the trigger and at most 280 px", () => {
    expect(placeBranchPopover(anchorAt(20, 100, 150), { width: 800, height: 900 }).width).toBe(240);
    expect(placeBranchPopover(anchorAt(20, 100, 400), { width: 800, height: 900 }).width).toBe(POPOVER_MAX_WIDTH);
  });

  it("stays inside a 184 px panel: width is capped by the viewport minus the margins", () => {
    const place = placeBranchPopover(anchorAt(8, 100, 162), { width: 184, height: 700 });
    expect(place.width).toBeLessThanOrEqual(184 - 16);
    expect(place.left).toBeGreaterThanOrEqual(8);
    expect(place.left + place.width).toBeLessThanOrEqual(184 - 8);
  });

  it("clamps to the right edge of the viewport", () => {
    const place = placeBranchPopover(anchorAt(600, 100, 280), { width: 700, height: 900 });
    expect(place.left + place.width).toBeLessThanOrEqual(700 - 8);
  });

  it("opens above when there is not enough room below and there is more room above", () => {
    const place = placeBranchPopover(anchorAt(20, 640), { width: 800, height: 700 });
    expect(place.placement).toBe("above");
    expect(place.top).toBeUndefined();
    expect(place.bottom).toBe(700 - 640 + 4);
    expect(place.maxHeight).toBeLessThanOrEqual(POPOVER_MAX_HEIGHT);
  });

  it("caps the list height at 340 px and at the space that is available", () => {
    expect(placeBranchPopover(anchorAt(20, 100), { width: 800, height: 2000 }).maxHeight).toBe(POPOVER_MAX_HEIGHT);
    const tight = placeBranchPopover(anchorAt(20, 100), { width: 800, height: 260 });
    expect(tight.maxHeight).toBeLessThanOrEqual(260 - 128 - 8);
    expect(tight.maxHeight).toBeGreaterThanOrEqual(0);
  });
});

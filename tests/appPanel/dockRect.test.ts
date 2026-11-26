import { describe, expect, it } from "vitest";
import { isDockRectUsable, toDeviceRect, toDockRect } from "../../src/features/app-panel/dockRect";

describe("toDockRect", () => {
  it("copies the element box in CSS pixels", () => {
    const box = { left: 560, top: 40, width: 340, height: 660 } as DOMRect;
    expect(toDockRect(box)).toEqual({ x: 560, y: 40, width: 340, height: 660 });
  });
});

describe("isDockRectUsable", () => {
  it("accepts a box with a positive width and height", () => {
    expect(isDockRectUsable({ x: 0, y: 0, width: 340, height: 660 })).toBe(true);
  });

  it("rejects an empty box so a hidden dock is not placed or opened", () => {
    expect(isDockRectUsable({ x: 0, y: 0, width: 0, height: 660 })).toBe(false);
    expect(isDockRectUsable({ x: 0, y: 0, width: 340, height: 0 })).toBe(false);
  });
});

describe("toDeviceRect", () => {
  it("multiplies CSS pixels by the webview pixel ratio, which includes zoom, not by the window scale", () => {
    // Measured: webview zoom 1.2 on a 100% display; the dock box 379x639 CSS px is 455x767 device px.
    const rect = toDeviceRect({ x: 820.83, y: 111.98, width: 379.17, height: 638.85 }, 1.2);
    expect([rect.x, rect.y, rect.width, rect.height].map(Math.round)).toEqual([985, 134, 455, 767]);
  });

  it("is the identity at a pixel ratio of 1", () => {
    expect(toDeviceRect({ x: 5, y: 6, width: 7, height: 8 }, 1)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it("falls back to 1 for a missing or invalid ratio", () => {
    expect(toDeviceRect({ x: 5, y: 6, width: 7, height: 8 }, 0)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(toDeviceRect({ x: 5, y: 6, width: 7, height: 8 }, Number.NaN)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });
});

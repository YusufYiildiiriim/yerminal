import { describe, expect, it } from "vitest";
import { isDockRectUsable, toDockRect } from "../../src/features/app-panel/dockRect";

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

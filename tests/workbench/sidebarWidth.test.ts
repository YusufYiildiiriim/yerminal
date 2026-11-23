import { describe, expect, it } from "vitest";
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX, clampSidebarWidth, sidebarLimitPercent } from "../../src/features/workspace/sidebarWidth";

describe("sidebar width limits", () => {
  it("uses a 240 px minimum and a 560 px maximum", () => {
    expect(SIDEBAR_MIN_PX).toBe(240);
    expect(SIDEBAR_MAX_PX).toBe(560);
  });

  it("clamps a saved width below the minimum up to the minimum", () => {
    expect(clampSidebarWidth(80)).toBe(240);
  });

  it("clamps widths above the maximum down to the maximum and keeps widths in range", () => {
    expect(clampSidebarWidth(900)).toBe(560);
    expect(clampSidebarWidth(400)).toBe(400);
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(240);
  });

  it("converts px limits to percent of the window so the minimum holds as the window shrinks", () => {
    expect(sidebarLimitPercent(240, 1000)).toBe(24);
    expect(sidebarLimitPercent(560, 1000)).toBe(56);
    expect(sidebarLimitPercent(240, 800)).toBe(30);
    expect(sidebarLimitPercent(240, 1920)).toBe(12.5);
  });
});

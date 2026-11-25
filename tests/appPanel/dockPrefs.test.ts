import { describe, expect, it } from "vitest";
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  clampDockWidth,
  hasBlockingOverlay,
  readDockPrefs,
  writeDockPrefs,
} from "../../src/features/app-panel/dockPrefs";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}

describe("clampDockWidth", () => {
  it("keeps the width inside the minimum and maximum", () => {
    expect(clampDockWidth(10, 1600)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(5000, 4000)).toBe(DOCK_MAX_WIDTH);
    expect(clampDockWidth(400, 1600)).toBe(400);
  });

  it("leaves room for the workspace on a narrow window", () => {
    expect(clampDockWidth(700, 920)).toBeLessThanOrEqual(920 - 480);
    expect(clampDockWidth(700, 920)).toBeGreaterThanOrEqual(DOCK_MIN_WIDTH);
  });
});

describe("dock preferences", () => {
  it("defaults to closed with the default width", () => {
    expect(readDockPrefs(memoryStorage())).toEqual({ open: false, width: DOCK_DEFAULT_WIDTH });
  });

  it("remembers open state and width, merging patches", () => {
    const storage = memoryStorage();
    writeDockPrefs({ open: true }, storage);
    writeDockPrefs({ width: 450 }, storage);
    expect(readDockPrefs(storage)).toEqual({ open: true, width: 450 });
  });

  it("ignores corrupt or out of range stored values", () => {
    expect(readDockPrefs(memoryStorage({ "yerminal.app-panel": "{nope" }))).toEqual({ open: false, width: DOCK_DEFAULT_WIDTH });
    expect(readDockPrefs(memoryStorage({ "yerminal.app-panel": JSON.stringify({ open: "yes", width: 9 }) }))).toEqual({ open: false, width: DOCK_MIN_WIDTH });
  });
});

describe("hasBlockingOverlay", () => {
  it("is false for a plain page and true while a dialog or menu is rendered", () => {
    document.body.innerHTML = "<main><p>hi</p></main>";
    expect(hasBlockingOverlay(document)).toBe(false);
    document.body.innerHTML = '<main></main><section role="dialog" aria-modal="true"></section>';
    expect(hasBlockingOverlay(document)).toBe(true);
    document.body.innerHTML = '<div role="menu"></div>';
    expect(hasBlockingOverlay(document)).toBe(true);
  });

  it("ignores menus that live inside the app panel itself", () => {
    document.body.innerHTML = '<aside data-app-panel><div role="menu"></div></aside>';
    expect(hasBlockingOverlay(document)).toBe(false);
  });
});

import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFloatingTerminalLayout } from "../../src/features/terminal/floatingTerminalLayout";

const SURFACE = { left: 0, top: 0, width: 1000, height: 800 };

function createSurface() {
  const surface = document.createElement("div");
  surface.getBoundingClientRect = () => ({
    ...SURFACE, x: SURFACE.left, y: SURFACE.top, right: SURFACE.left + SURFACE.width, bottom: SURFACE.top + SURFACE.height, toJSON: () => ({}),
  });
  for (const [key, value] of Object.entries({ clientWidth: SURFACE.width, clientHeight: SURFACE.height, offsetWidth: SURFACE.width, offsetHeight: SURFACE.height })) {
    Object.defineProperty(surface, key, { configurable: true, value });
  }
  return surface;
}

function pointer(clientX: number, clientY: number) {
  const pane = document.createElement("div");
  pane.getBoundingClientRect = () => ({ left: 100, top: 100, width: 400, height: 300, x: 100, y: 100, right: 500, bottom: 400, toJSON: () => ({}) });
  const currentTarget = {
    closest: () => pane,
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
  };
  return { button: 0, pointerId: 1, clientX, clientY, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget } as unknown as ReactPointerEvent<HTMLElement>;
}

function renderFloatingLayout(onDock = vi.fn(), workspaceId = "workspace-1", sessionIds = ["one", "two"]) {
  const hook = renderHook(() => useFloatingTerminalLayout(workspaceId, sessionIds, onDock));
  hook.result.current.surfaceRef.current = createSurface();
  act(() => hook.result.current.setMode("floating"));
  return { ...hook, onDock };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("floating terminal drag docking", () => {
  it("does not dock when the header is clicked near an edge without moving", () => {
    const { result, onDock } = renderFloatingLayout();
    act(() => result.current.startDrag("one", pointer(500, 10)));
    act(() => result.current.endDrag("one", pointer(500, 10)));
    expect(onDock).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("floating");
  });

  it("docks when a real drag ends at an edge", () => {
    const { result, onDock } = renderFloatingLayout();
    act(() => result.current.startDrag("one", pointer(500, 300)));
    act(() => result.current.moveDrag("one", pointer(500, 10)));
    act(() => result.current.endDrag("one", pointer(500, 10)));
    expect(onDock).toHaveBeenCalledWith("one", "top");
    expect(result.current.mode).toBe("tiled");
  });
});

const STORAGE_KEY = "yerminal:floating-terminal-layout:v1:workspace-1";
// Two sessions lay out as two columns with a 3% gap: (100 - 3 * 3) / 2 = 45.5% wide, height capped at 58%.
const DEFAULTS = {
  one: { x: 3, y: 3, width: 45.5, height: 58 },
  two: { x: 51.5, y: 3, width: 45.5, height: 58 },
};

describe("floating terminal persistence", () => {
  it("falls back to tiled defaults when stored data is corrupt", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useFloatingTerminalLayout("workspace-1", ["one", "two"]));
    expect(result.current.mode).toBe("tiled");
    expect(result.current.positions).toEqual(DEFAULTS);
  });

  it("ignores a snapshot that belongs to another workspace", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaceId: "workspace-2", mode: "floating", positions: { one: { x: 10, y: 10, width: 30, height: 30 } } }));
    const { result } = renderHook(() => useFloatingTerminalLayout("workspace-1", ["one", "two"]));
    expect(result.current.mode).toBe("tiled");
    expect(result.current.positions).toEqual(DEFAULTS);
  });

  it("clamps stored rects into the canvas with a 14% minimum size", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      workspaceId: "workspace-1",
      mode: "floating",
      positions: {
        one: { x: -20, y: 150, width: 5, height: 300 },
        two: { x: 95, y: 90, width: 30, height: 20 },
      },
    }));
    const { result } = renderHook(() => useFloatingTerminalLayout("workspace-1", ["one", "two"]));
    expect(result.current.mode).toBe("floating");
    expect(result.current.getRect("one")).toEqual({ x: 0, y: 0, width: 14, height: 100 });
    expect(result.current.getRect("two")).toEqual({ x: 70, y: 80, width: 30, height: 20 });
  });

  it("uses defaults for stored rects with non-numeric parts", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaceId: "workspace-1", mode: "floating", positions: { one: { x: "1", y: 2, width: 30, height: 30 } } }));
    const { result } = renderHook(() => useFloatingTerminalLayout("workspace-1", ["one", "two"]));
    expect(result.current.getRect("one")).toEqual(DEFAULTS.one);
  });
});

describe("floating terminal keyboard resize", () => {
  it("nudges the edge named by the handle in 4% steps", () => {
    const { result } = renderFloatingLayout();
    let handled = false;
    act(() => { handled = result.current.nudgeResize("one", "right", "ArrowRight"); });
    expect(handled).toBe(true);
    expect(result.current.getRect("one")).toEqual({ ...DEFAULTS.one, width: 49.5 });

    act(() => { result.current.nudgeResize("one", "top", "ArrowDown"); });
    expect(result.current.getRect("one")).toEqual({ x: 3, y: 7, width: 49.5, height: 54 });

    act(() => { result.current.nudgeResize("one", "left", "ArrowLeft"); });
    expect(result.current.getRect("one")).toEqual({ x: 0, y: 7, width: 52.5, height: 54 });
  });

  it("keeps the pixel minimum width of the canvas (240px of 1000px = 24%)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaceId: "workspace-1", mode: "floating", positions: { one: { x: 10, y: 10, width: 26, height: 30 } } }));
    const { result } = renderFloatingLayout();
    act(() => { result.current.nudgeResize("one", "right", "ArrowLeft"); });
    expect(result.current.getRect("one").width).toBe(24);
  });

  it("ignores keys that do not match the handle and tiled mode", () => {
    const { result } = renderFloatingLayout();
    expect(result.current.nudgeResize("one", "bottom", "ArrowLeft")).toBe(false);
    act(() => result.current.setMode("tiled"));
    expect(result.current.nudgeResize("one", "right", "ArrowRight")).toBe(false);
    expect(result.current.getRect("one")).toEqual(DEFAULTS.one);
  });
});

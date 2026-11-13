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

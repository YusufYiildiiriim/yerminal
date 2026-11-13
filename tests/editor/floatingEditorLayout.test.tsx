import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFloatingEditorLayout, type FloatingEditorLayoutController } from "../../src/features/editor/floatingEditorLayout";

const STORAGE_KEY = "yerminal:floating-editor-layout:v1:workspace-1";
const SURFACE = { width: 1000, height: 500 };

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

function attachSurface(layout: FloatingEditorLayoutController) {
  const surface = document.createElement("div");
  surface.getBoundingClientRect = () => domRect(0, 0, SURFACE.width, SURFACE.height);
  for (const [property, value] of Object.entries({ clientWidth: SURFACE.width, clientHeight: SURFACE.height, offsetWidth: SURFACE.width, offsetHeight: SURFACE.height })) {
    Object.defineProperty(surface, property, { configurable: true, value });
  }
  layout.surfaceRef.current = surface;
}

/** A pointer event aimed at a pane's header or resize handle. The pane occupies `pane` in client pixels. */
function pointer(clientX: number, clientY: number, pane = domRect(100, 100, 400, 250)) {
  const paneElement = document.createElement("section");
  paneElement.className = "editor-group-pane";
  paneElement.getBoundingClientRect = () => pane;
  const handle = document.createElement("header");
  paneElement.appendChild(handle);
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
  return {
    button: 0, pointerId: 1, clientX, clientY, target: handle, currentTarget: handle,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLElement>;
}

function storedLayout() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
}

function renderLayout(groupIds = ["group-1"]) {
  const hook = renderHook(() => useFloatingEditorLayout("workspace-1", groupIds));
  attachSurface(hook.result.current);
  return hook;
}

describe("useFloatingEditorLayout persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function layoutWrites(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.filter(([key]) => key === STORAGE_KEY).length;
  }

  it("debounces storage writes during a resize and flushes when the pointer is released", () => {
    const { result } = renderLayout();
    act(() => result.current.setMode("free"));
    act(() => { vi.advanceTimersByTime(200); });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    act(() => result.current.startResize("group-1", "right", pointer(500, 200)));
    for (const x of [520, 540, 560, 580]) act(() => result.current.moveResize("group-1", pointer(x, 200)));
    expect(layoutWrites(setItem)).toBe(0);

    act(() => result.current.endResize("group-1", pointer(580, 200)));
    expect(layoutWrites(setItem)).toBe(1);
    expect(storedLayout().positions["group-1"].width).toBeCloseTo(result.current.getRect("group-1").width);
  });

  it("writes once after the debounce interval for a burst of keyboard resizes and flushes on unmount", () => {
    const { result, unmount } = renderLayout();
    act(() => result.current.setMode("free"));
    act(() => { vi.advanceTimersByTime(200); });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    for (let step = 0; step < 3; step += 1) act(() => { result.current.nudgeResize("group-1", "right", "ArrowLeft"); });
    act(() => { vi.advanceTimersByTime(100); });
    expect(layoutWrites(setItem)).toBe(0);
    act(() => { vi.advanceTimersByTime(40); });
    expect(layoutWrites(setItem)).toBe(1);
    const width = result.current.getRect("group-1").width;
    expect(storedLayout().positions["group-1"].width).toBeCloseTo(width);

    act(() => { result.current.nudgeResize("group-1", "right", "ArrowLeft"); });
    unmount();
    expect(storedLayout().positions["group-1"].width).toBeCloseTo(width - 4);
  });
});

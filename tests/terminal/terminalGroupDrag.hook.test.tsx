import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTerminalGroupDrag } from "../../src/features/terminal/useTerminalGroupDrag";

function mountGroups(ids: string[]) {
  ids.forEach((id, index) => {
    const el = document.createElement("div");
    el.dataset.terminalGroupId = id;
    el.getBoundingClientRect = () => ({ left: 0, top: index * 100, right: 200, bottom: index * 100 + 100, width: 200, height: 100, x: 0, y: index * 100, toJSON() {} }) as DOMRect;
    document.body.appendChild(el);
  });
}

function down(x: number, y: number) {
  return { button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} } as unknown as ReactPointerEvent<HTMLButtonElement>;
}

function windowPointer(type: "pointermove" | "pointerup", x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  window.dispatchEvent(event);
}

describe("useTerminalGroupDrag", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("moves a terminal to the group under the pointer on release", () => {
    mountGroups(["g1", "g2"]);
    const onDrop = vi.fn();
    const { result } = renderHook(() => useTerminalGroupDrag(onDrop));

    act(() => { result.current.rowProps("t1", "g1").onPointerDown(down(10, 10)); });
    act(() => { windowPointer("pointermove", 20, 150); });
    expect(result.current.dragTerminalId).toBe("t1");
    expect(result.current.dropTargetGroupId).toBe("g2");

    act(() => { windowPointer("pointerup", 20, 150); });
    expect(onDrop).toHaveBeenCalledWith("t1", "g2");
    expect(result.current.dragTerminalId).toBeNull();
  });

  it("does nothing when released over the source group or outside any group", () => {
    mountGroups(["g1", "g2"]);
    const onDrop = vi.fn();
    const { result } = renderHook(() => useTerminalGroupDrag(onDrop));

    act(() => { result.current.rowProps("t1", "g1").onPointerDown(down(10, 10)); });
    act(() => { windowPointer("pointermove", 20, 40); });
    act(() => { windowPointer("pointerup", 20, 40); });
    act(() => { result.current.rowProps("t1", "g1").onPointerDown(down(10, 10)); });
    act(() => { windowPointer("pointermove", 20, 500); });
    act(() => { windowPointer("pointerup", 20, 500); });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("cancels on Escape without moving the terminal", () => {
    mountGroups(["g1", "g2"]);
    const onDrop = vi.fn();
    const { result } = renderHook(() => useTerminalGroupDrag(onDrop));

    act(() => { result.current.rowProps("t1", "g1").onPointerDown(down(10, 10)); });
    act(() => { windowPointer("pointermove", 20, 150); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    act(() => { windowPointer("pointerup", 20, 150); });
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.dragTerminalId).toBeNull();
  });

  it("treats a plain click below the threshold as a click, not a drag", () => {
    mountGroups(["g1", "g2"]);
    const onDrop = vi.fn();
    const { result } = renderHook(() => useTerminalGroupDrag(onDrop));

    act(() => { result.current.rowProps("t1", "g1").onPointerDown(down(10, 10)); });
    act(() => { windowPointer("pointermove", 11, 11); });
    act(() => { windowPointer("pointerup", 11, 11); });
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.consumeSuppressedClick()).toBe(false);
  });

  it("swallows the click that follows a real drag", () => {
    vi.useFakeTimers();
    try {
      mountGroups(["g1", "g2"]);
      const { result } = renderHook(() => useTerminalGroupDrag(vi.fn()));
      act(() => { result.current.rowProps("t1", "g1").onPointerDown(down(10, 10)); });
      act(() => { windowPointer("pointermove", 20, 150); });
      act(() => { windowPointer("pointerup", 20, 150); });
      expect(result.current.consumeSuppressedClick()).toBe(true);
      expect(result.current.consumeSuppressedClick()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

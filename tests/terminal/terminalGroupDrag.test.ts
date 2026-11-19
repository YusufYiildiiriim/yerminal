import { describe, expect, it } from "vitest";
import { DRAG_START_DISTANCE_PX, findGroupAtPoint, hasDragStarted, resolveTerminalGroupDrop } from "../../src/features/terminal/terminalGroupDrag";

describe("terminal group drag decisions", () => {
  it("starts a drag only after the pointer travels past the threshold", () => {
    expect(hasDragStarted({ x: 10, y: 10 }, { x: 10, y: 10 + DRAG_START_DISTANCE_PX - 1 })).toBe(false);
    expect(hasDragStarted({ x: 10, y: 10 }, { x: 10 + DRAG_START_DISTANCE_PX, y: 10 })).toBe(true);
  });

  it("finds the group whose rectangle contains the pointer", () => {
    const groups = [
      { groupId: "a", rect: { left: 0, top: 0, right: 100, bottom: 50 } },
      { groupId: "b", rect: { left: 0, top: 50, right: 100, bottom: 120 } },
    ];
    expect(findGroupAtPoint({ x: 20, y: 60 }, groups)).toBe("b");
    expect(findGroupAtPoint({ x: 20, y: 10 }, groups)).toBe("a");
    expect(findGroupAtPoint({ x: 500, y: 10 }, groups)).toBeNull();
  });

  it("moves only to a different existing group and does nothing otherwise", () => {
    expect(resolveTerminalGroupDrop("a", "b")).toBe("b");
    expect(resolveTerminalGroupDrop("a", "a")).toBeNull();
    expect(resolveTerminalGroupDrop("a", null)).toBeNull();
  });
});

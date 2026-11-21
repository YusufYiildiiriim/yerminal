import { describe, expect, it } from "vitest";
import { changeJumpLine, diffPosition } from "../../src/features/git/diffEditorModel";

describe("changeJumpLine", () => {
  it("jumps to the first modified line of a changed or inserted block", () => {
    expect(changeJumpLine({ modifiedStartLineNumber: 5, modifiedEndLineNumber: 7 })).toBe(5);
  });

  it("lands a deletion on the line after the gap, as Monaco's own goToDiff does", () => {
    expect(changeJumpLine({ modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 })).toBe(5);
    expect(changeJumpLine({ modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 })).toBe(1);
  });
});

describe("diffPosition", () => {
  const changes = [
    { modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 },
    { modifiedStartLineNumber: 9, modifiedEndLineNumber: 9 },
  ];

  it("reports zero before the cursor reaches the first change", () => {
    expect(diffPosition(changes, 1)).toEqual({ index: 0, total: 2 });
  });

  it("reports the change the cursor is on or last passed", () => {
    expect(diffPosition(changes, 5)).toEqual({ index: 1, total: 2 });
    expect(diffPosition(changes, 8)).toEqual({ index: 1, total: 2 });
    expect(diffPosition(changes, 9)).toEqual({ index: 2, total: 2 });
  });

  it("reports an empty diff as zero of zero", () => {
    expect(diffPosition([], 3)).toEqual({ index: 0, total: 0 });
  });
});

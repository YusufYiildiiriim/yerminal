import { describe, expect, it } from "vitest";
import { planDiffEditor } from "../../src/features/git/diffEditorModel";

describe("planDiffEditor", () => {
  it("uses the full text of both sides for a normal text change", () => {
    expect(planDiffEditor({ original: "a\n", modified: "b\n", binary: false, tooLarge: false })).toEqual({ mode: "monaco", original: "a\n", modified: "b\n" });
  });

  it("keeps an absent side as empty text for added and deleted files", () => {
    expect(planDiffEditor({ original: "", modified: "new\n", binary: false, tooLarge: false })).toEqual({ mode: "monaco", original: "", modified: "new\n" });
  });

  it("falls back to the patch view for binary, oversized or missing versions", () => {
    expect(planDiffEditor({ original: "", modified: "", binary: true, tooLarge: false })).toEqual({ mode: "patch", reason: "binary" });
    expect(planDiffEditor({ original: "", modified: "", binary: false, tooLarge: true })).toEqual({ mode: "patch", reason: "too-large" });
    expect(planDiffEditor(null)).toEqual({ mode: "patch", reason: "unavailable" });
    expect(planDiffEditor(undefined)).toEqual({ mode: "patch", reason: "unavailable" });
  });
});

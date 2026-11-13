import { describe, expect, it, vi } from "vitest";

const shiki = vi.hoisted(() => ({ createHighlighterCore: vi.fn() }));
vi.mock("shiki/core", () => ({ createHighlighterCore: shiki.createHighlighterCore }));
vi.mock("shiki/engine/oniguruma", () => ({ createOnigurumaEngine: vi.fn(() => ({})) }));
vi.mock("shiki/wasm", () => ({ default: {} }));

import { highlightCode } from "../../src/features/editor/highlighter";

describe("highlightCode", () => {
  it("retries highlighter initialization after a failed attempt", async () => {
    const highlighter = {
      getLoadedLanguages: vi.fn(() => ["typescript"]),
      loadLanguage: vi.fn(),
      codeToHtml: vi.fn((code: string) => `<pre>${code}</pre>`),
    };
    shiki.createHighlighterCore
      .mockRejectedValueOnce(new Error("wasm failed to load"))
      .mockResolvedValueOnce(highlighter);

    await expect(highlightCode("let a = 1;", "typescript")).rejects.toThrow("wasm failed to load");
    await expect(highlightCode("let a = 1;", "typescript")).resolves.toBe("<pre>let a = 1;</pre>");
    expect(shiki.createHighlighterCore).toHaveBeenCalledTimes(2);

    // A successful highlighter is reused.
    await highlightCode("let b = 2;", "typescript");
    expect(shiki.createHighlighterCore).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LANGUAGES, detectEditorLanguage, normalizeEnabledLanguages, createLanguageRegistry } from "../../src/features/editor/editorLanguages";

describe("editor language selection", () => {
  it.each([
    ["C:\\repo\\Page.CSHTML", "razor"], ["Views/Home.razor", "razor"], ["App.tsx", "typescript"],
    ["App.jsx", "javascript"], ["module.cts", "typescript"], ["config.jsonc", "json"],
    ["script.ps1", "powershell"], ["script.sh", "shell"], ["Dockerfile.prod", "dockerfile"],
    ["unknown.bin", "plaintext"], ["README", "plaintext"],
  ])("maps %s to %s", (path, id) => expect(detectEditorLanguage(path).id).toBe(id));

  it("enables the agreed defaults and preserves an explicit empty selection", () => {
    expect(DEFAULT_LANGUAGES).toEqual(expect.arrayContaining(["csharp", "razor", "typescript", "javascript", "html", "css", "json", "markdown", "yaml", "sql", "shell", "powershell"]));
    expect(normalizeEnabledLanguages(undefined)).toEqual(DEFAULT_LANGUAGES);
    expect(normalizeEnabledLanguages([])).toEqual([]);
    expect(normalizeEnabledLanguages(["python", "unknown", "python", 3])).toEqual(["python"]);
  });
});

describe("lazy language registry", () => {
  it("does not load or register a disabled language and falls back to plain text", async () => {
    const load = vi.fn(async () => ({ dispose: vi.fn() }));
    const registry = createLanguageRegistry(load);
    registry.setEnabled(["typescript"]);
    expect(load).not.toHaveBeenCalled();
    expect(await registry.ensure("file.py")).toBe("plaintext");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads only opened languages and shares concurrent requests", async () => {
    const load = vi.fn(async () => ({ dispose: vi.fn() }));
    const registry = createLanguageRegistry(load);
    registry.setEnabled(["typescript", "python"]);
    expect(await Promise.all([registry.ensure("a.ts"), registry.ensure("b.tsx")])).toEqual(["typescript", "typescript"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("typescript");
  });

  it("unregisters a loaded language when disabled and reloads on demand after re-enabling", async () => {
    const dispose = vi.fn();
    const load = vi.fn(async () => ({ dispose }));
    const registry = createLanguageRegistry(load);
    registry.setEnabled(["python"]);
    await registry.ensure("a.py");
    registry.setEnabled([]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await registry.ensure("a.py")).toBe("plaintext");
    registry.setEnabled(["python"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await registry.ensure("a.py")).toBe("python");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("disposes an in-flight registration disabled before its loader finishes", async () => {
    const dispose = vi.fn();
    let resolve!: (registration: { dispose: () => void }) => void;
    const registry = createLanguageRegistry(() => new Promise((done) => { resolve = done; }));
    registry.setEnabled(["python"]);
    const pending = registry.ensure("a.py");
    registry.setEnabled([]);
    resolve({ dispose });
    expect(await pending).toBe("plaintext");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed load without registering other languages", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("load failed")).mockResolvedValue({ dispose: vi.fn() });
    const registry = createLanguageRegistry(load);
    registry.setEnabled(["python"]);
    await expect(registry.ensure("a.py")).rejects.toThrow("load failed");
    expect(await registry.ensure("a.py")).toBe("python");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

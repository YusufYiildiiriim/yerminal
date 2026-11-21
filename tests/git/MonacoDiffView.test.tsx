import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ load: vi.fn(), instance: null as any, monaco: null as any, languages: null as any }));
const nav = vi.hoisted(() => ({
  changes: [] as Array<{ modifiedStartLineNumber: number; modifiedEndLineNumber: number }>,
  cursor: { lineNumber: 1, column: 1 },
  onCursor: null as null | (() => void),
  onUpdate: null as null | (() => void),
  commands: new Map<number, () => void>(),
}));
vi.mock("../../src/features/editor/monacoRuntime", () => ({ loadMonaco: runtime.load }));
import { DiffView } from "../../src/features/git/DiffView";

const patch = ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-old value", "+new value"].join("\n");
const versions = { original: "old value\nkeep\n", modified: "new value\nkeep\n", binary: false, tooLarge: false };
const fakeModel = (value: string) => ({ value, dispose: vi.fn() });

beforeEach(() => {
  nav.changes = [];
  nav.cursor = { lineNumber: 1, column: 1 };
  nav.onCursor = null;
  nav.onUpdate = null;
  nav.commands.clear();
  const modifiedEditor = {
    getPosition: vi.fn(() => nav.cursor),
    setPosition: vi.fn(),
    onDidChangeCursorPosition: vi.fn((callback: () => void) => { nav.onCursor = callback; return { dispose: vi.fn() }; }),
    addCommand: vi.fn((key: number, handler: () => void) => { nav.commands.set(key, handler); }),
  };
  runtime.instance = {
    setModel: vi.fn(), updateOptions: vi.fn(), dispose: vi.fn(),
    revealFirstDiff: vi.fn(() => { nav.cursor = { lineNumber: nav.changes[0]?.modifiedStartLineNumber ?? 1, column: 1 }; nav.onCursor?.(); }),
    goToDiff: vi.fn(),
    getLineChanges: vi.fn(() => nav.changes),
    getModifiedEditor: vi.fn(() => modifiedEditor),
    onDidUpdateDiff: vi.fn((callback: () => void) => { nav.onUpdate = callback; return { dispose: vi.fn() }; }),
  };
  runtime.monaco = {
    editor: {
      createModel: vi.fn((value: string) => fakeModel(value)),
      createDiffEditor: vi.fn(() => runtime.instance),
      setModelLanguage: vi.fn(),
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
    },
    Uri: { parse: (value: string) => value },
    KeyMod: { Alt: 512, Shift: 1024 },
    KeyCode: { F5: 62 },
  };
  runtime.languages = { setEnabled: vi.fn(), ensure: vi.fn(async () => "typescript") };
  runtime.load.mockResolvedValue({ monaco: runtime.monaco, languages: runtime.languages });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderDiff = (theme = "obsidian", fontFamily = "Cascadia Code", fontSize = 14, enabled: string[] = ["typescript"]) => <DiffView diff={patch} path="src/app.ts" root="C:/work/repo" staged={false} versions={versions} enabledLanguages={enabled as any} theme={theme as any} fontFamily={fontFamily} fontSize={fontSize} />;
const mountedPair = () => runtime.instance.setModel.mock.calls[0][0] as { original: { value: string; dispose: ReturnType<typeof vi.fn> }; modified: { value: string; dispose: ReturnType<typeof vi.fn> } };

describe("DiffView with full file versions", () => {
  it("feeds both full texts to the Monaco diff editor and keeps the header", async () => {
    render(renderDiff());
    await waitFor(() => expect(runtime.instance.setModel).toHaveBeenCalled());
    expect(mountedPair().original.value).toBe("old value\nkeep\n");
    expect(mountedPair().modified.value).toBe("new value\nkeep\n");
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(document.querySelector(".diff-view-lines")).toBeNull();
  });

  it("applies the language to both sides through the registry", async () => {
    render(renderDiff());
    await waitFor(() => expect(runtime.monaco.editor.setModelLanguage).toHaveBeenCalledTimes(2));
    expect(runtime.languages.ensure).toHaveBeenCalledWith("src/app.ts");
    expect(runtime.languages.setEnabled).toHaveBeenCalledWith(["typescript"]);
  });

  it("disposes the editor and both models on unmount", async () => {
    const view = render(renderDiff());
    await waitFor(() => expect(runtime.instance.setModel).toHaveBeenCalled());
    const pair = mountedPair();
    view.unmount();
    expect(runtime.instance.dispose).toHaveBeenCalledOnce();
    expect(pair.original.dispose).toHaveBeenCalledOnce();
    expect(pair.modified.dispose).toHaveBeenCalledOnce();
  });

  it("re-applies the theme when the app theme changes", async () => {
    const view = render(renderDiff());
    await waitFor(() => expect(runtime.monaco.editor.setTheme).toHaveBeenCalled());
    runtime.monaco.editor.setTheme.mockClear();
    view.rerender(renderDiff("nordic"));
    expect(runtime.monaco.editor.setTheme).toHaveBeenCalledWith("yerminal-nordic");
  });

  it("updates font options without recreating the diff", async () => {
    const view = render(renderDiff());
    await waitFor(() => expect(runtime.instance.setModel).toHaveBeenCalled());
    view.rerender(renderDiff("obsidian", "Consolas", 18));
    expect(runtime.instance.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ fontFamily: "Consolas", fontSize: 18 }));
    expect(runtime.monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1);
  });

  it("reapplies languages when the enabled set changes", async () => {
    const view = render(renderDiff());
    await waitFor(() => expect(runtime.monaco.editor.setModelLanguage).toHaveBeenCalledTimes(2));
    runtime.languages.setEnabled.mockClear();
    view.rerender(renderDiff("obsidian", "Cascadia Code", 14, []));
    expect(runtime.languages.setEnabled).toHaveBeenCalledWith([]);
  });

  it("does not load Monaco for binary files and shows the patch view", () => {
    render(<DiffView diff={"diff --git a/data.bin b/data.bin\nBinary files a/data.bin and b/data.bin differ"} path="data.bin" root="repo" staged={false} versions={{ original: "", modified: "", binary: true, tooLarge: false }} />);
    expect(screen.getByText("Binary files a/data.bin and b/data.bin differ")).toBeInTheDocument();
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it("uses the empty message instead of an empty editor when both versions are identical", () => {
    render(<DiffView diff="" path="same.ts" root="repo" staged={false} emptyMessage="No changes in this file." versions={{ original: "same\n", modified: "same\n", binary: false, tooLarge: false }} />);
    expect(screen.getByText("No changes in this file.")).toBeInTheDocument();
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it("falls back to the patch rows when the editor cannot load", async () => {
    runtime.load.mockRejectedValueOnce(new Error("chunk unavailable"));
    render(<DiffView diff={patch} path="src/app.ts" root="repo" staged={false} versions={versions} />);
    expect(await screen.findByText("new value")).toBeInTheDocument();
    expect(document.querySelector(".diff-view-cell.added")).toBeInTheDocument();
  });
});

describe("DiffView change navigation", () => {
  const altF5 = 512 | 62;
  const shiftAltF5 = 512 | 1024 | 62;

  it("opens on the first change instead of the top of the file", async () => {
    nav.changes = [{ modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }, { modifiedStartLineNumber: 9, modifiedEndLineNumber: 9 }];
    render(renderDiff());
    await waitFor(() => expect(runtime.instance.revealFirstDiff).toHaveBeenCalledOnce());
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
  });

  it("moves to the next and previous change with the buttons", async () => {
    nav.changes = [{ modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }, { modifiedStartLineNumber: 9, modifiedEndLineNumber: 9 }];
    render(renderDiff());
    await screen.findByText("1 / 2");
    const next = screen.getByRole("button", { name: "Next change" });
    const previous = screen.getByRole("button", { name: "Previous change" });
    expect(next).toBeEnabled();
    expect(previous).toBeEnabled();
    await act(async () => { next.click(); });
    expect(runtime.instance.goToDiff).toHaveBeenLastCalledWith("next");
    await act(async () => { previous.click(); });
    expect(runtime.instance.goToDiff).toHaveBeenLastCalledWith("previous");
  });

  it("follows the cursor so the position reads 2 / 2 after moving to the last change", async () => {
    nav.changes = [{ modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }, { modifiedStartLineNumber: 9, modifiedEndLineNumber: 9 }];
    render(renderDiff());
    await screen.findByText("1 / 2");
    nav.cursor = { lineNumber: 9, column: 1 };
    act(() => { nav.onCursor?.(); });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("binds Alt+F5 and Shift+Alt+F5 to next and previous change", async () => {
    nav.changes = [{ modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 }];
    render(renderDiff());
    await waitFor(() => expect(nav.commands.size).toBe(2));
    act(() => { nav.commands.get(altF5)?.(); });
    expect(runtime.instance.goToDiff).toHaveBeenLastCalledWith("next");
    act(() => { nav.commands.get(shiftAltF5)?.(); });
    expect(runtime.instance.goToDiff).toHaveBeenLastCalledWith("previous");
  });

  it("disables the change buttons and reads 0 / 0 when the diff has no change ranges", async () => {
    render(renderDiff());
    await waitFor(() => expect(runtime.instance.setModel).toHaveBeenCalled());
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous change" })).toBeDisabled();
  });

  it("keeps the Monaco host below the navigation bar instead of covering it", () => {
    const css = readFileSync("src/features/editor/monaco-editor.css", "utf8");
    const host = css.match(/\.diff-monaco\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(host).not.toMatch(/position:\s*absolute/);
    expect(css).toMatch(/\.diff-monaco-nav\s*\{[^}]*display:\s*flex/);
  });
});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ load: vi.fn(), created: [] as Array<{ original: string; modified: string }>, setEnabled: vi.fn(), ensure: vi.fn(async () => "typescript") }));
vi.mock("../../src/features/editor/monacoRuntime", () => ({ loadMonaco: runtime.load }));
import { DiffView } from "../../src/features/git/DiffView";

const patch = ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-old value", "+new value"].join("\n");

beforeEach(() => {
  runtime.created = [];
  const model = (value: string) => ({ value, dispose: vi.fn() });
  runtime.load.mockResolvedValue({
    monaco: {
      editor: {
        createModel: vi.fn((value: string) => model(value)),
        setModelLanguage: vi.fn(),
        defineTheme: vi.fn(),
        setTheme: vi.fn(),
        createDiffEditor: vi.fn(() => ({ setModel: vi.fn((pair: { original: { value: string }; modified: { value: string } }) => runtime.created.push({ original: pair.original.value, modified: pair.modified.value })), dispose: vi.fn() })),
      },
      Uri: { parse: (value: string) => value },
    },
    languages: { ensure: runtime.ensure, setEnabled: runtime.setEnabled },
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("DiffView with full file versions", () => {
  it("feeds both full texts to the Monaco diff editor and keeps the header", async () => {
    render(<DiffView diff={patch} path="src/app.ts" root="C:/work/repo" staged={false} versions={{ original: "old value\nkeep\n", modified: "new value\nkeep\n", binary: false, tooLarge: false }} enabledLanguages={["typescript"]} />);
    await waitFor(() => expect(runtime.created).toEqual([{ original: "old value\nkeep\n", modified: "new value\nkeep\n" }]));
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(runtime.ensure).toHaveBeenCalledWith("src/app.ts");
    expect(document.querySelector(".diff-view-lines")).toBeNull();
  });

  it("does not load Monaco for binary files and shows the patch view", () => {
    render(<DiffView diff={"diff --git a/data.bin b/data.bin\nBinary files a/data.bin and b/data.bin differ"} path="data.bin" root="repo" staged={false} versions={{ original: "", modified: "", binary: true, tooLarge: false }} />);
    expect(screen.getByText("Binary files a/data.bin and b/data.bin differ")).toBeInTheDocument();
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it("falls back to the patch rows when the editor cannot load", async () => {
    runtime.load.mockRejectedValueOnce(new Error("chunk unavailable"));
    render(<DiffView diff={patch} path="src/app.ts" root="repo" staged={false} versions={{ original: "old value\n", modified: "new value\n", binary: false, tooLarge: false }} />);
    expect(await screen.findByText("new value")).toBeInTheDocument();
    expect(document.querySelector(".diff-view-cell.added")).toBeInTheDocument();
  });
});

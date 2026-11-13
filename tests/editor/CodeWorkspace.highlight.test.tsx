import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const highlighter = vi.hoisted(() => ({ highlightCode: vi.fn() }));
vi.mock("../../src/features/editor/highlighter", () => highlighter);

import { CodeWorkspace, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";

const group = { id: "group-1", name: "Editor 1", tabIds: ["tab-1"], activeTabId: "tab-1" };

function tab(content: string): EditorFileTab {
  return {
    id: "tab-1", root: "C:/repo", path: "C:/repo/main.ts", name: "main.ts", status: "ready",
    content, savedContent: "const a = 1;", error: null, sourceLabel: null, sourceCommitId: null,
    snapshot: null, isSaving: false, saveError: null,
  };
}

function workspace(content: string) {
  return <CodeWorkspace
    workspaceId="workspace-1"
    tabs={[tab(content)]}
    groups={[group]}
    activeGroupId="group-1"
    onSelect={vi.fn()}
    onActivateGroup={vi.fn()}
    onClose={vi.fn()}
    onChange={vi.fn()}
    onSave={vi.fn()}
    onMoveTab={vi.fn()}
    onCloseGroup={vi.fn()}
    onModeState={vi.fn()}
  />;
}

const html = (code: string) => `<pre class="shiki"><code>${code}</code></pre>`;
const minimapHtml = () => document.querySelector(".code-editor-minimap-highlighted")?.innerHTML ?? null;
const editableHtml = () => document.querySelector(".code-editor-editable-highlight .code-editor-highlighted")?.innerHTML ?? null;

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("CodeWorkspace syntax highlighting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    highlighter.highlightCode.mockReset();
    highlighter.highlightCode.mockImplementation(async (code: string) => html(code));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("highlights once per burst of edits and keeps the previous highlight until the new one is ready", async () => {
    const view = render(workspace("const a = 1;"));
    await advance(200);
    expect(highlighter.highlightCode).toHaveBeenCalledTimes(1);
    expect(minimapHtml()).toBe(html("const a = 1;"));

    for (const content of ["const a = 12;", "const a = 123;", "const a = 1234;"]) {
      view.rerender(workspace(content));
      await advance(50);
      // The last highlight stays on screen instead of flashing back to null.
      expect(minimapHtml()).toBe(html("const a = 1;"));
    }
    expect(highlighter.highlightCode).toHaveBeenCalledTimes(1);

    await advance(200);
    expect(highlighter.highlightCode).toHaveBeenCalledTimes(2);
    expect(highlighter.highlightCode).toHaveBeenLastCalledWith("const a = 1234;", "typescript");
    expect(minimapHtml()).toBe(html("const a = 1234;"));
    expect(editableHtml()).toBe(html("const a = 1234;"));
  });

  it("ignores a highlight result for content that has since changed", async () => {
    const pending: Array<{ code: string; resolve: (value: string) => void }> = [];
    highlighter.highlightCode.mockImplementation((code: string) => new Promise<string>((resolve) => pending.push({ code, resolve })));
    const view = render(workspace("const a = 1;"));
    await advance(200);
    expect(pending).toHaveLength(1);

    view.rerender(workspace("const b = 2;"));
    await act(async () => { pending[0].resolve(html("const a = 1;")); });
    expect(minimapHtml()).toBeNull();

    await advance(200);
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1].resolve(html("const b = 2;")); });
    expect(minimapHtml()).toBe(html("const b = 2;"));
  });

  it("keeps debouncing after a failed highlight instead of retrying on every keystroke", async () => {
    highlighter.highlightCode.mockRejectedValue(new Error("highlighter unavailable"));
    const view = render(workspace("const a = 1;"));
    await advance(0);
    // A freshly opened tab is highlighted immediately.
    expect(highlighter.highlightCode).toHaveBeenCalledTimes(1);

    for (const content of ["const a = 12;", "const a = 123;", "const a = 1234;"]) {
      view.rerender(workspace(content));
      await advance(50);
    }
    expect(highlighter.highlightCode).toHaveBeenCalledTimes(1);

    await advance(200);
    expect(highlighter.highlightCode).toHaveBeenCalledTimes(2);
    expect(highlighter.highlightCode).toHaveBeenLastCalledWith("const a = 1234;", "typescript");
  });
});

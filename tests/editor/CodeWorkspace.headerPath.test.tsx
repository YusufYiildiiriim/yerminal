import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";


import { CodeWorkspace, editorDisplayPath, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";

afterEach(cleanup);

const group = { id: "group-1", name: "Editor 1", tabIds: ["tab-1"], activeTabId: "tab-1" };

function renderTab(root: string, path: string) {
  const tab: EditorFileTab = {
    id: "tab-1", root, path, name: "notes.md", status: "ready",
    content: "# notes", savedContent: "# notes", error: null, sourceLabel: null, sourceCommitId: null,
    snapshot: null, isSaving: false, saveError: null,
  };
  return render(<CodeWorkspace workspaceId="workspace-1" tabs={[tab]} groups={[group]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={vi.fn()} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
}

describe("editor header path", () => {
  it("shows the folder and the path relative to it, without the Windows long-path prefix", () => {
    expect(editorDisplayPath("C:\\Users\\Y\\ortak\\ortamlar", "\\\\?\\C:\\Users\\Y\\ortak\\ortamlar\\notes.md"))
      .toEqual({ label: "ortamlar › notes.md", full: "C:\\Users\\Y\\ortak\\ortamlar\\notes.md" });
    expect(editorDisplayPath("C:/repo", "src/App.tsx")).toEqual({ label: "repo › src/App.tsx", full: "C:/repo/src/App.tsx" });
  });

  it("renders the path in the editor header and not in the status bar", () => {
    renderTab("C:/repo", "C:/repo/docs/notes.md");
    const header = document.querySelector(".code-editor-header") as HTMLElement;
    const path = header.querySelector(".code-editor-header-path") as HTMLElement;
    expect(path).toHaveTextContent("repo › docs/notes.md");
    expect(path).toHaveAttribute("title", "C:/repo/docs/notes.md");
    expect(document.querySelector(".code-editor-statusbar .code-editor-path")).toBeNull();
  });
});

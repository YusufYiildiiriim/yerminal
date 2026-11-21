import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeWorkspace, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";

afterEach(cleanup);

const group = { id: "group-1", name: "Editor 1", tabIds: ["tab-1"], activeTabId: "tab-1" };
const snapshot = { shortId: "abc1234", message: "Fix parser", changeKind: "modified", author: "Ada", timestamp: 1_700_000_000 };

function renderTab(overrides: Partial<EditorFileTab>) {
  const tab: EditorFileTab = {
    id: "tab-1", root: "C:/repo", path: "C:/repo/src/app.ts", name: "app.ts", status: "ready",
    content: "const a = 1;", savedContent: "const a = 1;", error: null,
    sourceLabel: null, sourceCommitId: null, snapshot: null, isSaving: false, saveError: null,
    ...overrides,
  };
  return render(<CodeWorkspace workspaceId="workspace-1" tabs={[tab]} groups={[group]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={vi.fn()} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
}

describe("editor info row under the tab bar", () => {
  it("is not rendered for a workspace text file", () => {
    renderTab({});

    expect(document.querySelector(".code-editor-header")).toBeNull();
    expect(document.querySelector(".code-editor-header-path")).toBeNull();
    expect(document.querySelector(".code-editor-meta")).toBeNull();
    expect(document.querySelector(".code-editor-editable-badge")).toBeNull();
    expect(document.querySelector(".code-editor-source-label")).toBeNull();
  });

  it("is not rendered for a read-only commit snapshot, and the status bar keeps the read-only state", () => {
    renderTab({ sourceLabel: "abc1234 · modified", sourceCommitId: "abc1234567890", snapshot });

    expect(document.querySelector(".code-editor-header")).toBeNull();
    expect(document.querySelector(".code-editor-readonly")).toBeNull();
    expect(document.querySelector(".code-editor-statusbar")).toHaveTextContent("Read-only commit snapshot");
  });

  it("is not rendered for a commit diff, and the diff strip keeps the file name and hash", () => {
    renderTab({ view: "diff", content: "", savedContent: "", sourceLabel: "abc1234 · modified", sourceCommitId: "abc1234567890", snapshot });

    expect(document.querySelector(".code-editor-header")).toBeNull();
    expect(document.querySelector(".diff-view-strip")).toHaveTextContent("app.ts");
    expect(document.querySelector(".diff-view-strip")).toHaveTextContent("abc1234");
  });

  it("keeps the status bar save state, line count and encoding", () => {
    renderTab({});

    const statusbar = document.querySelector(".code-editor-statusbar") as HTMLElement;
    expect(statusbar).toHaveTextContent("All changes saved");
    expect(statusbar).toHaveTextContent("1 lines");
    expect(statusbar).toHaveTextContent("UTF-8");
  });
});

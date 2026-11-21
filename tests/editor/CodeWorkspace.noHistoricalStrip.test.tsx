import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeWorkspace, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";

afterEach(cleanup);

const group = { id: "group-1", name: "Editor 1", tabIds: ["tab-1"], activeTabId: "tab-1" };
const snapshot = { shortId: "abc1234", message: "Fix parser", changeKind: "modified", author: "Ada", timestamp: 1_700_000_000 };

function renderCommitTab(view: "text" | "diff") {
  const tab: EditorFileTab = {
    id: "tab-1", root: "C:/repo", path: "C:/repo/src/app.ts", name: "app.ts", status: "ready",
    content: view === "diff" ? "" : "const a = 1;", savedContent: view === "diff" ? "" : "const a = 1;", error: null,
    sourceLabel: "abc1234 · modified", sourceCommitId: "abc1234567890", snapshot, view, isSaving: false, saveError: null,
  };
  return render(<CodeWorkspace workspaceId="workspace-1" tabs={[tab]} groups={[group]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={vi.fn()} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
}

describe("commit source view header", () => {
  it("does not render the historical source strip for a read-only commit file", () => {
    renderCommitTab("text");

    expect(screen.queryByText("HISTORICAL SOURCE")).toBeNull();
    expect(screen.queryByRole("complementary", { name: /Historical source/ })).toBeNull();
    expect(document.querySelector(".commit-snapshot-banner")).toBeNull();
    expect(screen.queryByText("Modified in commit")).toBeNull();
  });

  it("does not render the historical source strip for a commit diff", () => {
    renderCommitTab("diff");

    expect(screen.queryByText("HISTORICAL SOURCE")).toBeNull();
    expect(document.querySelector(".commit-snapshot-banner")).toBeNull();
    expect(screen.queryByText("Modified in commit")).toBeNull();
  });

  it("keeps the read-only state in the status bar instead of the removed info row", () => {
    renderCommitTab("text");

    expect(document.querySelector(".code-editor-header")).toBeNull();
    expect(document.querySelector(".code-editor-readonly")).toBeNull();
    expect(document.querySelector(".code-editor-statusbar")).toHaveTextContent("Read-only commit snapshot");
  });
});

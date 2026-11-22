import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeWorkspace } from "../../src/features/editor/CodeWorkspace";

afterEach(cleanup);

const emptyGroup = { id: "group-1", name: "Editor 1", tabIds: [], activeTabId: null };

function renderEmptyGroup() {
  return render(<CodeWorkspace workspaceId="workspace-1" tabs={[]} groups={[emptyGroup]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={vi.fn()} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
}

describe("empty editor group state", () => {
  it("renders no decorative icon, like the terminal empty state", () => {
    renderEmptyGroup();

    expect(document.querySelector(".code-editor-empty")).not.toBeNull();
    expect(document.querySelector(".code-editor-empty-icon")).toBeNull();
  });

  it("uses a short heading and one short line of text", () => {
    renderEmptyGroup();

    const heading = document.querySelector(".code-editor-empty h2");
    const line = document.querySelector(".code-editor-empty p");
    expect(heading).toHaveTextContent("No file open");
    expect(line).toHaveTextContent("Open a file from the explorer or Git history.");
    expect(document.querySelectorAll(".code-editor-empty p")).toHaveLength(1);
    expect((line?.textContent ?? "").length).toBeLessThanOrEqual(60);
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderContextMenu } from "../../src/features/explorer/FolderContextMenu";

describe("FolderContextMenu workspace-root action", () => {
  afterEach(cleanup);
  it("offers removal only for workspace roots and dispatches it", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <div className="app-shell">
        <FolderContextMenu
          target={{ root: "C:\\work\\repo", path: "C:\\work\\repo\\src", isWorkspaceRoot: false, x: 10, y: 10 }}
          onAction={onAction}
          onClose={onClose}
        />
      </div>,
    );

    expect(screen.queryByRole("menuitem", { name: "Remove from Workspace" })).not.toBeInTheDocument();
    rerender(
      <div className="app-shell">
        <FolderContextMenu
          target={{ root: "C:\\work\\repo", path: "C:\\work\\repo", isWorkspaceRoot: true, x: 10, y: 10 }}
          onAction={onAction}
          onClose={onClose}
        />
      </div>,
    );

    await user.click(screen.getByRole("menuitem", { name: "Remove from Workspace" }));

    expect(onAction).toHaveBeenCalledWith("remove-folder");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

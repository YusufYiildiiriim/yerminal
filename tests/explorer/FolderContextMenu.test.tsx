import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolderContextMenu } from "../../src/features/explorer/FolderContextMenu";

describe("FolderContextMenu", () => {
  it("dispatches Open in Terminal for the selected folder and closes the menu", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onClose = vi.fn();

    render(
      <div className="app-shell" data-theme="obsidian">
        <FolderContextMenu
          target={{ root: "C:\\work\\repo", path: "C:\\work\\repo\\src", isWorkspaceRoot: false, x: 10, y: 10 }}
          onAction={onAction}
          onClose={onClose}
        />
      </div>,
    );

    await user.click(screen.getByRole("menuitem", { name: "Open in Terminal" }));

    expect(onAction).toHaveBeenCalledWith("open-terminal");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

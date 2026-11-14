import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionMenu } from "../../src/features/workspace/ActionMenu";

afterEach(cleanup);

function renderMenu(onRename = vi.fn()) {
  render(<ActionMenu label="Workspace actions" title="Workspace actions" className="box" items={[
    { label: "Rename workspace", onSelect: onRename },
    { label: "Add folders", onSelect: vi.fn() },
    { label: "Delete workspace", onSelect: vi.fn(), disabled: true },
  ]}>⋯</ActionMenu>);
  return screen.getByRole("button", { name: "Workspace actions" });
}

describe("ActionMenu keyboard", () => {
  it("moves focus with arrow keys, Home and End, skipping disabled items", async () => {
    const user = userEvent.setup();
    const trigger = renderMenu();
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Rename workspace" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Add folders" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename workspace" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Add folders" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Rename workspace" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Add folders" })).toHaveFocus();
  });

  it("closes on Tab and returns focus to the trigger after choosing an item", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const trigger = renderMenu(onRename);
    await user.click(trigger);
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(trigger);
    await user.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

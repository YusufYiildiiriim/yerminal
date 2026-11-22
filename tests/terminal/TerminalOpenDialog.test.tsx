import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalOpenDialog } from "../../src/features/terminal/TerminalOpenDialog";

afterEach(cleanup);

const groups = [
  { id: "g-default", name: "Terminal 1" },
  { id: "g-api", name: "API" },
];

function renderDialog(overrides: Partial<Parameters<typeof TerminalOpenDialog>[0]> = {}) {
  const props = {
    ask: { folder: true, group: true },
    folders: ["C:\\repo", "C:\\recent"],
    initialFolder: "C:\\repo",
    groups,
    activeGroupId: "g-default",
    automaticNameFor: () => "Terminal 1",
    onBrowse: vi.fn(async () => null),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<TerminalOpenDialog {...props} />);
  return props;
}

describe("TerminalOpenDialog", () => {
  it("asks for the folder and the group with the initial folder and active group selected", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Open terminal" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "C:\\repo" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "C:\\recent" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Terminal 1/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: "API" })).not.toBeChecked();
  });

  it("confirms the chosen folder and an existing group", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("radio", { name: "C:\\recent" }));
    await user.click(screen.getByRole("radio", { name: "API" }));
    await user.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(props.onConfirm).toHaveBeenCalledWith({ folder: "C:\\recent", group: { kind: "existing", id: "g-api" } });
  });

  it("confirms a new group with the typed name", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("radio", { name: "New group" }));
    await user.type(screen.getByRole("textbox", { name: "New group name" }), "Logs");
    await user.click(screen.getByRole("button", { name: "Open terminal" }));

    expect(props.onConfirm).toHaveBeenCalledWith({ folder: "C:\\repo", group: { kind: "new", name: "Logs" } });
  });

  it("cancel and Escape close without opening a terminal", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");

    expect(props.onCancel).toHaveBeenCalledTimes(2);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("adds a browsed folder to the list and selects it", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ onBrowse: vi.fn(async () => "D:\\picked") });

    await user.click(screen.getByRole("button", { name: "Browse for a folder" }));

    expect(screen.getByRole("radio", { name: "D:\\picked" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ folder: "D:\\picked" }));
  });

  it("keeps the browse result selected when browsing is cancelled", async () => {
    const user = userEvent.setup();
    renderDialog({ onBrowse: vi.fn(async () => null) });

    await user.click(screen.getByRole("button", { name: "Browse for a folder" }));

    expect(screen.getByRole("radio", { name: "C:\\repo" })).toBeChecked();
  });

  it("asks only for the group when the folder is already known", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ ask: { folder: false, group: true } });

    expect(screen.queryByRole("radio", { name: "C:\\recent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse for a folder" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(props.onConfirm).toHaveBeenCalledWith({ folder: null, group: { kind: "existing", id: "g-default" } });
  });

  it("asks only for the folder when the group is not chosen here (split)", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ ask: { folder: true, group: false } });

    // Folder-only prompts (split, group row add button) are titled for the folder and show no group choice.
    expect(screen.getByRole("dialog", { name: "Terminal Folder" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Group" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "API" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(props.onConfirm).toHaveBeenCalledWith({ folder: "C:\\repo", group: null });
  });
});

describe("TerminalOpenDialog optional name (#45)", () => {
  const automaticNameFor = (groupId: string | null) => (groupId ? `Auto ${groupId}` : "PowerShell");

  function renderNamed(ask = { folder: true, group: true }) {
    const props = {
      ask,
      folders: ["C:\repo"],
      initialFolder: "C:\repo",
      groups,
      activeGroupId: "g-default",
      fixedGroupId: null,
      automaticNameFor,
      onBrowse: vi.fn(async () => null),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    render(<TerminalOpenDialog {...props} />);
    return props;
  }

  it("shows the name field in every prompt shape, with the automatic name as placeholder", () => {
    for (const ask of [{ folder: true, group: true }, { folder: true, group: false }, { folder: false, group: true }]) {
      cleanup();
      renderNamed(ask);
      const field = screen.getByRole("textbox", { name: "Terminal name" });
      expect(field).toHaveAttribute("placeholder", "Auto g-default");
    }
  });

  it("sends the typed name, trimmed, with the folder and group", async () => {
    const user = userEvent.setup();
    const props = renderNamed();
    await user.type(screen.getByRole("textbox", { name: "Terminal name" }), "  API  ");
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ name: "API" }));
  });

  it("sends no name when the field is blank or only spaces", async () => {
    const user = userEvent.setup();
    const props = renderNamed();
    await user.type(screen.getByRole("textbox", { name: "Terminal name" }), "   ");
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(props.onConfirm.mock.calls[0][0].name).toBeUndefined();
  });

  it("caps a long name at 40 characters", async () => {
    const user = userEvent.setup();
    const props = renderNamed();
    await user.type(screen.getByRole("textbox", { name: "Terminal name" }), "n".repeat(60));
    await user.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(props.onConfirm.mock.calls[0][0].name).toHaveLength(40);
  });

  it("Enter in the name field confirms the prompt", async () => {
    const user = userEvent.setup();
    const props = renderNamed();
    await user.type(screen.getByRole("textbox", { name: "Terminal name" }), "logs{Enter}");
    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ name: "logs" }));
  });

  it("the placeholder follows the chosen group and falls back to the new-group name", async () => {
    const user = userEvent.setup();
    renderNamed();
    await user.click(screen.getByRole("radio", { name: "API" }));
    expect(screen.getByRole("textbox", { name: "Terminal name" })).toHaveAttribute("placeholder", "Auto g-api");
    await user.click(screen.getByRole("radio", { name: "New group" }));
    expect(screen.getByRole("textbox", { name: "Terminal name" })).toHaveAttribute("placeholder", "PowerShell");
  });

  it("cancel confirms nothing", async () => {
    const user = userEvent.setup();
    const props = renderNamed();
    await user.type(screen.getByRole("textbox", { name: "Terminal name" }), "logs");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).toHaveBeenCalled();
  });
});

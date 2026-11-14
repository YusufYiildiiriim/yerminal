import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
  revealItemInDir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: tauri.onFocusChanged }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, confirm: tauri.confirm }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: tauri.revealItemInDir }));
vi.mock("../../src/features/terminal/TerminalPane", async () => {
  const React = await import("react");
  return {
    default: ({ sessionId }: { sessionId: string }) => React.createElement("div", { "data-testid": "mock-terminal", "data-session-id": sessionId }),
  };
});

import App from "../../src/App";
import { invoke } from "@tauri-apps/api/core";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithTwoTerminals() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("mock-terminal");
  await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
  await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
  return user;
}

function paneTitle(name: string) {
  const title = Array.from(document.querySelectorAll<HTMLElement>(".terminal-pane-title")).find((element) => element.textContent === name);
  if (!title) throw new Error("No pane titled " + name);
  return title;
}

function paneCount() {
  return screen.getAllByTestId("mock-terminal").length;
}

describe("terminal pane header", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: "", folderPaths: [] }],
      activeId: "workspace-1",
    }));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => command === "terminal_output_snapshot" ? { events: [] } : undefined);
    tauri.confirm.mockResolvedValue(true);
  });

  it("no longer renders the terminal tab strip or the Active status label", async () => {
    await renderWithTwoTerminals();
    expect(screen.queryByRole("tablist", { name: "Terminal sessions" })).not.toBeInTheDocument();
    expect(document.querySelector(".terminal-session-toolbar")).toBeNull();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("opens the pane ... menu with Rename, Split right and Close, and hides Move to group with one group", async () => {
    const user = await renderWithTwoTerminals();
    await user.click(screen.getByRole("button", { name: "More actions for Terminal 2" }));
    const menu = screen.getByRole("menu", { name: "Terminal 2 actions" });
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Move to group" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Split right" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Close" })).toBeInTheDocument();
  });

  it("renames a pane from the menu, saving on Enter", async () => {
    const user = await renderWithTwoTerminals();
    await user.click(screen.getByRole("button", { name: "More actions for Terminal 2" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "New name for Terminal 2" });
    await user.clear(input);
    await user.type(input, "Build{Enter}");
    expect(screen.queryByRole("textbox", { name: /New name for/ })).not.toBeInTheDocument();
    expect(paneTitle("Build")).toBeInTheDocument();
  });

  it("double-clicking the pane name starts a rename that Escape cancels", async () => {
    const user = await renderWithTwoTerminals();
    await user.dblClick(paneTitle("Terminal 2"));
    const input = screen.getByRole("textbox", { name: "New name for Terminal 2" });
    await user.clear(input);
    await user.type(input, "Scratch{Escape}");
    expect(screen.queryByRole("textbox", { name: /New name for/ })).not.toBeInTheDocument();
    expect(paneTitle("Terminal 2")).toBeInTheDocument();
  });

  it("saves a double-click rename when the field loses focus", async () => {
    const user = await renderWithTwoTerminals();
    await user.dblClick(paneTitle("Terminal 2"));
    const input = screen.getByRole("textbox", { name: "New name for Terminal 2" });
    await user.clear(input);
    await user.type(input, "Logs");
    fireEvent.blur(input);
    expect(screen.queryByRole("textbox", { name: /New name for/ })).not.toBeInTheDocument();
    expect(paneTitle("Logs")).toBeInTheDocument();
  });

  it("moves a pane to another group from the Move to group submenu", async () => {
    const user = await renderWithTwoTerminals();
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));
    const explorerGroups = screen.getByRole("region", { name: "Terminal groups" });
    await user.click(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 1" }));
    expect(screen.getByRole("button", { name: "More actions for Terminal 2" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More actions for Terminal 2" }));
    const menu = screen.getByRole("menu", { name: "Terminal 2 actions" });
    await user.click(within(menu).getByRole("menuitem", { name: "Move to group" }));
    const targets = within(menu).getAllByRole("menuitem").filter((item) => item.hasAttribute("data-group-to"));
    expect(targets).toHaveLength(1);
    await user.click(targets[0]);

    // Moving a pane activates the destination group, which already holds Terminal 3.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^More actions for/ })).toHaveLength(2));
    expect(screen.getByRole("button", { name: "More actions for Terminal 2" })).toBeInTheDocument();
  });

  it("Split right creates a new terminal next to the pane", async () => {
    const user = await renderWithTwoTerminals();
    const before = paneCount();
    await user.click(screen.getByRole("button", { name: "More actions for Terminal 2" }));
    await user.click(screen.getByRole("menuitem", { name: "Split right" }));
    await waitFor(() => expect(paneCount()).toBe(before + 1));
  });

  it("Close from the pane menu closes that terminal after confirmation", async () => {
    const user = await renderWithTwoTerminals();
    await user.click(screen.getByRole("button", { name: "More actions for Terminal 2" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "close_terminal")).toBe(true));
    expect(tauri.confirm).toHaveBeenCalledTimes(1);
  });
});

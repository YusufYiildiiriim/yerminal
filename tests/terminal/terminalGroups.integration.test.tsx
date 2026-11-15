import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  open: vi.fn(async () => null),
  revealItemInDir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: tauri.onFocusChanged }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: tauri.revealItemInDir }));
vi.mock("../../src/features/terminal/TerminalPane", async () => {
  const React = await import("react");
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    default: ({ sessionId }: { sessionId: string }) => {
      React.useEffect(() => { void invoke("create_terminal", { sessionId, shell: "powershell", workingDirectory: null, cols: 80, rows: 24 }); }, [sessionId]);
      return React.createElement("div", { "data-testid": "mock-terminal", "data-session-id": sessionId });
    },
  };
});

import App from "../../src/App";
import { invoke } from "@tauri-apps/api/core";
import { chooseGroupAction, chooseWorkspaceAction } from "../shellMenus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("terminal groups", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: "", folderPaths: [] }],
      activeId: "workspace-1",
    }));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => command === "terminal_output_snapshot" ? { events: [] } : undefined);
  });

  it("isolates group tabs and preserves live PTYs while switching, moving, and closing groups", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await screen.findByTestId("mock-terminal");
    expect(screen.queryByRole("tablist", { name: "Terminal groups" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    const explorerGroups = screen.getByRole("region", { name: "Terminal groups" });
    expect(within(explorerGroups).getByRole("button", { name: "Group actions for Terminal 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));

    expect(screen.getAllByRole("button", { name: /^More actions for/ })).toHaveLength(1);
    await user.click(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 1" }));
    expect(screen.getAllByRole("button", { name: /^More actions for/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "More actions for Terminal 2" }));
    const paneMenu = screen.getByRole("menu", { name: "Terminal 2 actions" });
    await user.click(within(paneMenu).getByRole("menuitem", { name: "Move to group" }));
    const moveTarget = within(paneMenu).getAllByRole("menuitem").find((item) => item.hasAttribute("data-group-to"));
    expect(moveTarget).toBeDefined();
    await user.click(moveTarget!);

    await waitFor(() => expect(screen.getAllByRole("button", { name: /^More actions for/ })).toHaveLength(2));
    await chooseGroupAction(user, within(explorerGroups), "Terminal 1", "Close group");
    expect(screen.getAllByRole("button", { name: /^More actions for/ }).length).toBeGreaterThanOrEqual(1);
    expect(invoke.mock.calls.filter(([command]) => command === "close_terminal")).toHaveLength(0);
    expect(invoke.mock.calls.filter(([command]) => command === "create_terminal")).toHaveLength(3);
  });

  it("keeps each registered workspace's groups independent when switching workspaces", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "prompt").mockReturnValue("Workspace 2");
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    expect(within(screen.getByRole("region", { name: "Terminal groups" })).getAllByRole("button", { name: /Select terminal group/ })).toHaveLength(2);
    const initialGroups = within(screen.getByRole("region", { name: "Terminal groups" }));
    await chooseGroupAction(user, initialGroups, "Terminal 2", "Rename group");
    const renameInput = screen.getByRole("textbox", { name: "New name for terminal group Terminal 2" });
    await user.clear(renameInput);
    await user.type(renameInput, "Build tools");
    await user.click(screen.getByRole("button", { name: "Save name for terminal group Terminal 2" }));
    expect(initialGroups.getByRole("button", { name: "Select terminal group Build tools" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New workspace" }));
    const explorerGroups = await screen.findByRole("region", { name: "Terminal groups" });
    expect(within(explorerGroups).getAllByRole("button", { name: /Select terminal group/ })).toHaveLength(1);
    await user.selectOptions(screen.getByRole("combobox", { name: "Active terminal workspace" }), "workspace-1");
    expect(within(screen.getByRole("region", { name: "Terminal groups" })).getAllByRole("button", { name: /Select terminal group/ })).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Terminal groups" })).getByRole("button", { name: "Select terminal group Build tools" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renames a group from Explorer with Enter without changing its terminal sessions", async () => {
    const user = userEvent.setup();
    const app = render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    const before = [...document.querySelectorAll<HTMLElement>("[data-testid='mock-terminal']")].map((node) => node.dataset.sessionId);
    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));

    await chooseGroupAction(user, groups, "Terminal 1", "Rename group");
    const input = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "  Build tools  ");
    await user.keyboard("{Enter}");

    expect(groups.getByRole("button", { name: "Select terminal group Build tools" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Select terminal group Build tools" })).toHaveFocus();
    expect([...document.querySelectorAll<HTMLElement>("[data-testid='mock-terminal']")].map((node) => node.dataset.sessionId)).toEqual(before);
    expect(invoke.mock.calls.filter(([command]) => command === "close_terminal")).toHaveLength(0);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("yerminal.terminal-workspaces")!);
      expect(saved.workspaces[0].groups).toEqual([{ id: "terminal-group-default", name: "Build tools" }]);
      expect(saved.workspaces[0].activeGroupId).toBe("terminal-group-default");
    });
    const oldSessionId = before[0];
    expect(localStorage.getItem("yerminal.terminal-workspaces")).not.toContain(oldSessionId);
    app.unmount();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Select terminal group Build tools" })).toBeInTheDocument();
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "create_terminal")).toHaveLength(2));
    const restoredSessionId = document.querySelector<HTMLElement>("[data-testid='mock-terminal']")?.dataset.sessionId;
    expect(restoredSessionId).not.toBe(oldSessionId);
  });

  it("cancels a group rename with Escape and does not accept an empty name", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));

    await chooseGroupAction(user, groups, "Terminal 1", "Rename group");
    const input = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    await user.clear(input);
    await user.type(input, "Changed");
    await user.keyboard("{Escape}");
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toHaveFocus();

    await chooseGroupAction(user, groups, "Terminal 1", "Rename group");
    const cancelInput = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    await user.clear(cancelInput);
    await user.type(cancelInput, "Canceled");
    await user.click(screen.getByRole("button", { name: "Cancel renaming terminal group Terminal 1" }));
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toHaveFocus();

    await chooseGroupAction(user, groups, "Terminal 1", "Rename group");
    const emptyInput = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    await user.clear(emptyInput);
    await user.click(screen.getByRole("button", { name: "Save name for terminal group Terminal 1" }));
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toHaveFocus();
  });

  it("restores persisted group names and active group without reviving old PTY IDs or layouts", async () => {
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{
        id: "workspace-1",
        name: "Workspace 1",
        rootPath: "",
        folderPaths: [],
        groups: [
          { id: "group-build", name: "Build", terminalIds: ["stale-pty"], activeTerminalId: "stale-pty", layout: { type: "terminal", sessionId: "stale-pty" } },
          { id: "group-ops", name: "Operations", terminalIds: ["stale-pty-2"], activeTerminalId: "stale-pty-2", layout: { type: "terminal", sessionId: "stale-pty-2" } },
        ],
        activeGroupId: "group-ops",
      }],
      activeId: "workspace-1",
    }));
    const user = userEvent.setup();
    render(<App />);

    const groups = within(await screen.findByRole("region", { name: "Terminal groups" }));
    expect(groups.getByRole("button", { name: "Select terminal group Build" })).toHaveAttribute("aria-pressed", "false");
    expect(groups.getByRole("button", { name: "Select terminal group Operations" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-session-id="stale-pty"]')).toBeNull();
    expect(document.querySelector('[data-session-id="stale-pty-2"]')).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.objectContaining({ shell: "powershell" })));

    await user.click(groups.getByRole("button", { name: "Select terminal group Build" }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("yerminal.terminal-workspaces")!);
      expect(saved.workspaces[0].activeGroupId).toBe("group-build");
      expect(saved.workspaces[0].groups).toEqual([
        { id: "group-build", name: "Build" },
        { id: "group-ops", name: "Operations" },
      ]);
    });
    expect(JSON.stringify(JSON.parse(localStorage.getItem("yerminal.terminal-workspaces")!))).not.toContain("stale-pty");
  });

  it("falls back to the first persisted group when the active group ID is stale", async () => {
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{
        id: "workspace-1",
        name: "Workspace 1",
        rootPath: "",
        folderPaths: [],
        groups: [{ id: "group-first", name: "First" }, { id: "group-second", name: "Second" }],
        activeGroupId: "deleted-group",
      }],
      activeId: "workspace-1",
    }));
    render(<App />);

    const groups = within(await screen.findByRole("region", { name: "Terminal groups" }));
    expect(groups.getByRole("button", { name: "Select terminal group First" })).toHaveAttribute("aria-pressed", "true");
    expect(groups.getByRole("button", { name: "Select terminal group Second" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("yerminal.terminal-workspaces")!).workspaces[0].activeGroupId).toBe("group-first"));
  });

  it("shows workspace groups and their terminals in the Explorer and selects them", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await screen.findByTestId("mock-terminal");

    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));

    const explorerGroups = screen.getByRole("region", { name: "Terminal groups" });
    expect(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 2" })).toBeInTheDocument();
    await user.click(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 1" }));
    expect(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 1" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(explorerGroups).getByRole("button", { name: "Select terminal Terminal 2" }));
    expect(document.querySelector(".terminal-pane-frame[data-active=\"true\"] .terminal-pane-title")).toHaveTextContent("Terminal 2");
    expect(within(explorerGroups).getByRole("button", { name: "Select terminal Terminal 2" })).toHaveAttribute("aria-pressed", "true");
    expect(within(explorerGroups).getByRole("button", { name: "Select terminal Terminal 2" })).toHaveClass("selected");

    const collapse = within(explorerGroups).getByRole("button", { name: "Collapse terminal groups" });
    await user.click(collapse);
    expect(collapse).toHaveAttribute("aria-expanded", "false");
    expect(within(explorerGroups).queryByRole("button", { name: "Select terminal Terminal 2" })).not.toBeInTheDocument();
  });
  it("opens the terminal view when a group or terminal is selected from Explorer", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await screen.findByTestId("mock-terminal");

    expect(screen.queryByRole("tablist", { name: "Terminal groups" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));

    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    await user.click(screen.getByRole("tab", { name: "Editor" }));
    expect(screen.queryByRole("region", { name: "Terminal groups" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    await user.click(within(screen.getByRole("region", { name: "Terminal groups" })).getByRole("button", { name: "Select terminal group Terminal 1" }));
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Terminal · Terminal 1");

    await user.click(screen.getByRole("tab", { name: "Editor" }));
    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    await user.click(within(screen.getByRole("region", { name: "Terminal groups" })).getByRole("button", { name: "Select terminal Terminal 2" }));
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".terminal-pane-frame[data-active=\"true\"] .terminal-pane-title")).toHaveTextContent("Terminal 2");
  });
});

describe("terminal right-click menus", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: "", folderPaths: [] }],
      activeId: "workspace-1",
    }));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => command === "terminal_output_snapshot" ? { events: [] } : undefined);
  });

  async function twoGroups(user: ReturnType<typeof userEvent.setup>) {
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
  }

  it("suppresses the webview's native context menu everywhere", async () => {
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    expect(fireEvent.contextMenu(document.body)).toBe(false);
  });

  it("offers Rename, Move to group, Split right and Close on a terminal pane right-click", async () => {
    const user = userEvent.setup();
    await twoGroups(user);
    const pane = document.querySelector<HTMLElement>(".terminal-pane-frame[data-active='true']")!;
    expect(fireEvent.contextMenu(pane)).toBe(false);
    const menu = await screen.findByRole("menu", { name: /actions$/ });
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels[0]).toBe("Rename");
    expect(labels.some((label) => label?.startsWith("Move to "))).toBe(true);
    expect(labels).toContain("Split right");
    expect(labels[labels.length - 1]).toBe("Close");

    const move = within(menu).getAllByRole("menuitem").find((item) => item.textContent?.startsWith("Move to "))!;
    await user.click(move);
    await waitFor(() => expect(screen.queryByRole("menu", { name: /actions$/ })).not.toBeInTheDocument());
  });

  it("offers Rename, Move and Close when right-clicking a terminal in the left sidebar", async () => {
    const user = userEvent.setup();
    await twoGroups(user);
    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));
    const entry = groups.getAllByRole("button", { name: /^Select terminal (?!group)/ })[0];
    expect(fireEvent.contextMenu(entry)).toBe(false);
    const menu = await screen.findByRole("menu", { name: /actions$/ });
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels[0]).toBe("Rename");
    expect(labels.some((label) => label?.startsWith("Move to "))).toBe(true);
    expect(labels[labels.length - 1]).toBe("Close");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: /actions$/ })).not.toBeInTheDocument());
  });
});

describe("remembered terminal view per group", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: "", folderPaths: [] }],
      activeId: "workspace-1",
    }));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => command === "terminal_output_snapshot" ? { events: [] } : undefined);
  });

  const visiblePanes = () => [...document.querySelectorAll<HTMLElement>(".terminal-pane-frame")].filter((pane) => pane.style.display !== "none");

  it("keeps a group on 'all terminals' after visiting another group and picking its terminal from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    await waitFor(() => expect(visiblePanes()).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));
    await waitFor(() => expect(visiblePanes()).toHaveLength(1));

    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));
    await user.click(groups.getByRole("button", { name: "Select terminal bash" }));
    await waitFor(() => expect(visiblePanes()).toHaveLength(2));
  });

  it("remembers a group's focused terminal and restores it when coming back", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.anything()));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(visiblePanes()).toHaveLength(2));
    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));
    await user.click(groups.getByRole("button", { name: "Select terminal bash" }));
    await user.click(groups.getByRole("button", { name: "Select terminal Terminal 2" }));
    await user.click(screen.getByRole("button", { name: "Show all terminals" }));
    await waitFor(() => expect(visiblePanes()).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(visiblePanes()).toHaveLength(1));
    await user.click(groups.getByRole("button", { name: "Select terminal group Terminal 1" }));
    await waitFor(() => expect(visiblePanes()).toHaveLength(2));
  });
  it("moves the sidebar active-terminal marker when switching terminals inside the same group", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("mock-terminal");
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));
    const [first, second] = groups.getAllByRole("button", { name: /^Select terminal (?!group)/ });
    expect(second).toHaveAttribute("aria-pressed", "true");
    await user.click(first);
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(first).toHaveClass("selected");
    expect(second).toHaveAttribute("aria-pressed", "false");
    await user.click(second);
    expect(second).toHaveAttribute("aria-pressed", "true");
    expect(first).toHaveAttribute("aria-pressed", "false");
  });
  it("deletes a group with its terminals only after confirmation, from a button at the right of the group row", async () => {
    const user = userEvent.setup();
    // Inside Tauri the dialog plugin makes window.confirm async (it resolves to a Promise), so mimic that.
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation((async () => false) as unknown as typeof window.confirm);
    render(<App />);
    await screen.findByTestId("mock-terminal");
    expect(screen.queryByRole("button", { name: /Delete terminal group/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    const groups = within(screen.getByRole("region", { name: "Terminal groups" }));

    await user.click(groups.getByRole("button", { name: "Delete terminal group Terminal 2" }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Delete terminal group "Terminal 2"'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(groups.getAllByRole("button", { name: /^Select terminal group/ })).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalledWith("close_terminal", expect.anything());

    confirmSpy.mockImplementation((async () => true) as unknown as typeof window.confirm);
    await user.click(groups.getByRole("button", { name: "Delete terminal group Terminal 2" }));
    await waitFor(() => expect(groups.getAllByRole("button", { name: /^Select terminal group/ })).toHaveLength(1));
    expect(invoke).toHaveBeenCalledWith("close_terminal", expect.anything());
    expect(screen.queryByRole("button", { name: /Delete terminal group/ })).not.toBeInTheDocument();
  });
});

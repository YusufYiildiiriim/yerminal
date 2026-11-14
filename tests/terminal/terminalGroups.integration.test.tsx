import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(within(explorerGroups).getByRole("button", { name: "Close Terminal 2 and move its terminals" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));

    expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(1);
    await user.click(within(explorerGroups).getByRole("button", { name: "Select terminal group Terminal 1" }));
    expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Rename Terminal 2" })).toBeInTheDocument();
    const moveGroup = screen.getByRole("combobox", { name: "Move Terminal 2 to terminal group" });
    const destinationGroupId = (moveGroup.querySelectorAll("option")[1] as HTMLOptionElement).value;
    await user.selectOptions(moveGroup, destinationGroupId);

    await waitFor(() => expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(2));
    await user.click(within(explorerGroups).getByRole("button", { name: "Close Terminal 1 and move its terminals" }));
    expect(screen.getAllByRole("tab", { name: /Terminal/ }).length).toBeGreaterThanOrEqual(1);
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
    await user.click(initialGroups.getByRole("button", { name: "Rename terminal group Terminal 2" }));
    const renameInput = screen.getByRole("textbox", { name: "New name for terminal group Terminal 2" });
    await user.clear(renameInput);
    await user.type(renameInput, "Build tools");
    await user.click(screen.getByRole("button", { name: "Save name for terminal group Terminal 2" }));
    expect(initialGroups.getByRole("button", { name: "Select terminal group Build tools" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create workspace" }));
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

    await user.click(groups.getByRole("button", { name: "Rename terminal group Terminal 1" }));
    const input = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "  Build tools  ");
    await user.keyboard("{Enter}");

    expect(groups.getByRole("button", { name: "Select terminal group Build tools" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Rename terminal group Build tools" })).toHaveFocus();
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

    await user.click(groups.getByRole("button", { name: "Rename terminal group Terminal 1" }));
    const input = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    await user.clear(input);
    await user.type(input, "Changed");
    await user.keyboard("{Escape}");
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Rename terminal group Terminal 1" })).toHaveFocus();

    await user.click(groups.getByRole("button", { name: "Rename terminal group Terminal 1" }));
    const cancelInput = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    await user.clear(cancelInput);
    await user.type(cancelInput, "Canceled");
    await user.click(screen.getByRole("button", { name: "Cancel renaming terminal group Terminal 1" }));
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Rename terminal group Terminal 1" })).toHaveFocus();

    await user.click(groups.getByRole("button", { name: "Rename terminal group Terminal 1" }));
    const emptyInput = screen.getByRole("textbox", { name: "New name for terminal group Terminal 1" });
    await user.clear(emptyInput);
    await user.click(screen.getByRole("button", { name: "Save name for terminal group Terminal 1" }));
    expect(groups.getByRole("button", { name: "Select terminal group Terminal 1" })).toBeInTheDocument();
    expect(groups.getByRole("button", { name: "Rename terminal group Terminal 1" })).toHaveFocus();
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
    expect(within(screen.getByRole("tablist", { name: "Terminal sessions" })).getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute("aria-selected", "true");

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
    await user.click(within(rail).getByRole("button", { name: "Editor" }));
    expect(screen.queryByRole("region", { name: "Terminal groups" })).not.toBeInTheDocument();

    await user.click(within(rail).getByRole("button", { name: "Terminal" }));
    await user.click(within(screen.getByRole("region", { name: "Terminal groups" })).getByRole("button", { name: "Select terminal group Terminal 1" }));
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Terminal · Terminal 1");

    await user.click(within(rail).getByRole("button", { name: "Editor" }));
    await user.click(within(rail).getByRole("button", { name: "Terminal" }));
    await user.click(within(screen.getByRole("region", { name: "Terminal groups" })).getByRole("button", { name: "Select terminal Terminal 2" }));
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("tablist", { name: "Terminal sessions" })).getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute("aria-selected", "true");
  });
});

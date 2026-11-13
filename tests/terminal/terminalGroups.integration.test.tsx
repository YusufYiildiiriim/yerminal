import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "New terminal group" }));
    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(3));

    expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(1);
    await user.click(screen.getByRole("tab", { name: /Terminal 1/ }));
    expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(2);
    const moveGroup = screen.getByRole("combobox", { name: "Move Terminal 2 to terminal group" });
    const destinationGroupId = (moveGroup.querySelectorAll("option")[1] as HTMLOptionElement).value;
    await user.selectOptions(moveGroup, destinationGroupId);

    await waitFor(() => expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Close Terminal 1 and move its terminals" }));
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
    expect(screen.getByRole("tablist", { name: "Terminal groups" }).querySelectorAll('[role="tab"]')).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await screen.findByRole("tablist", { name: "Terminal groups" });
    expect(screen.getByRole("tablist", { name: "Terminal groups" }).querySelectorAll('[role="tab"]')).toHaveLength(1);
    await user.selectOptions(screen.getByRole("combobox", { name: "Active terminal workspace" }), "workspace-1");
    expect(screen.getByRole("tablist", { name: "Terminal groups" }).querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute("aria-selected", "true");
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("../../src/features/terminal/TerminalPane", () => ({
  default: () => <div data-testid="mock-terminal">Terminal Pane</div>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Sidebar and header layout redesign", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: "", folderPaths: [] }],
      activeId: "workspace-1",
    }));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "terminal_output_snapshot") return { events: [] };
      return undefined;
    });
  });

  it("places tool pages in the titlebar next to the brand name and removes old titlebar buttons", () => {
    render(<App />);
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    expect(titlebar).toBeInTheDocument();

    const titlebarPages = within(titlebar).getByRole("navigation", { name: "Tool pages" });
    expect(within(titlebarPages).getByRole("button", { name: "Explorer" })).toBeInTheDocument();
    expect(within(titlebarPages).getByRole("button", { name: "Git Changes" })).toBeInTheDocument();
    expect(within(titlebarPages).getByRole("button", { name: "Git Graph" })).toBeInTheDocument();

    // The + and CPU/RAM buttons should no longer be in the titlebar
    expect(within(titlebar).queryByRole("button", { name: "Add terminal to group" })).not.toBeInTheDocument();
    expect(within(titlebar).queryByRole("button", { name: "CPU / RAM" })).not.toBeInTheDocument();
  });

  it("places a vertical resize handle between Explorer tree and terminal groups", () => {
    render(<App />);
    const explorer = screen.getByRole("region", { name: "Explorer" });
    const resizeHandle = within(explorer).getByRole("separator", { name: "Resize terminal groups" });
    expect(resizeHandle).toBeInTheDocument();
  });

  it("integrates Add terminal and CPU / RAM buttons into the Explorer terminal groups section", async () => {
    const user = userEvent.setup();
    render(<App />);

    const explorer = screen.getByRole("region", { name: "Explorer" });
    const terminalGroups = within(explorer).getByRole("region", { name: "Explorer terminal groups" });

    // Add terminal button is located in the terminal groups section
    const addTerminalButton = within(terminalGroups).getByRole("button", { name: "Add terminal to group" });
    expect(addTerminalButton).toBeInTheDocument();

    // CPU / RAM button is integrated in terminal groups and toggles the resource panel
    const cpuRamButton = within(terminalGroups).getByRole("button", { name: "CPU / RAM" });
    expect(cpuRamButton).toBeInTheDocument();
    expect(document.getElementById("terminal-resource-panel")).not.toBeInTheDocument();

    await user.click(cpuRamButton);
    expect(document.getElementById("terminal-resource-panel")).toBeInTheDocument();
  });

  it("renders a compact single-row workspace switcher inside Explorer without large heading", () => {
    render(<App />);
    const explorer = screen.getByRole("region", { name: "Explorer" });
    expect(within(explorer).queryByRole("heading", { name: "Explorer" })).not.toBeInTheDocument();

    const switcher = explorer.querySelector(".workspace-management") as HTMLElement;
    expect(switcher).toBeInTheDocument();
    expect(within(switcher).getByRole("combobox", { name: "Active terminal workspace" })).toBeInTheDocument();
    expect(within(switcher).getByRole("button", { name: "Create workspace" })).toBeInTheDocument();
    expect(within(switcher).getByRole("button", { name: "Rename workspace" })).toBeInTheDocument();
    expect(within(switcher).getByRole("button", { name: "Delete workspace" })).toBeInTheDocument();
    expect(within(switcher).getByRole("button", { name: "Add folders to this workspace" })).toBeInTheDocument();
  });
});

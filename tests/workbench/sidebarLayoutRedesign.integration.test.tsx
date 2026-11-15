import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { invoke } from "@tauri-apps/api/core";
import { chooseGroupAction, chooseWorkspaceAction } from "../shellMenus";

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

  it("puts Terminal and Editor in the switch under the workspace picker, keeps Git tools in the rail and switches panels on click", async () => {
    const user = userEvent.setup();
    render(<App />);
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    expect(titlebar).toBeInTheDocument();
    expect(within(titlebar).queryByRole("navigation", { name: "Tool pages" })).not.toBeInTheDocument();
    expect(within(titlebar).queryByRole("button", { name: "Explorer" })).not.toBeInTheDocument();
    expect(within(titlebar).queryByRole("button", { name: "Git Changes" })).not.toBeInTheDocument();
    expect(within(titlebar).queryByRole("button", { name: "Git Graph" })).not.toBeInTheDocument();

    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    const railLabels = within(rail).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(railLabels.slice(0, 4)).toEqual(["Terminal", "Editor", "Git Changes", "Git Graph"]);
    expect(rail.querySelector(".tool-sidebar-separator")).toBeInTheDocument();
    const switcher = screen.getByRole("tablist", { name: "Workspace view" });
    expect(within(switcher).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Terminal", "Editor", "Git Changes", "Git Graph"]);
    await user.click(within(switcher).getByRole("tab", { name: "Git Graph" }));
    expect(screen.getByRole("region", { name: "Git Graph" })).toBeInTheDocument();
    expect(within(screen.getByRole("tablist", { name: "Workspace view" })).getByRole("tab", { name: "Git Graph" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(screen.getByRole("tablist", { name: "Workspace view" })).getByRole("tab", { name: "Editor" }));
    await user.click(within(rail).getByRole("button", { name: "Terminal" }));

    await user.click(within(rail).getByRole("button", { name: "Git Changes" }));
    expect(within(rail).getByRole("button", { name: "Git Changes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Git Changes" })).toBeInTheDocument();
    await user.click(within(rail).getByRole("button", { name: "Git Graph" }));
    expect(screen.getByRole("region", { name: "Git Graph" })).toBeInTheDocument();

    // The + and CPU/RAM buttons should no longer be in the titlebar
    expect(within(titlebar).queryByRole("button", { name: "Add terminal to group" })).not.toBeInTheDocument();
    expect(within(titlebar).queryByRole("button", { name: "Resource usage" })).not.toBeInTheDocument();
  });

  it("renders a gear icon, not a '?' text glyph, on the Help & Settings rail button", () => {
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    const settings = within(rail).getByRole("button", { name: "Help & Settings" });
    expect(settings.querySelector("svg")).toBeInTheDocument();
    expect(settings.querySelector(".tool-sidebar-icon")?.textContent).toBe("");
    // Settings stays at the bottom of the rail, after the tool pages
    const buttons = within(rail).getAllByRole("button");
    expect(buttons.indexOf(settings)).toBeGreaterThan(buttons.findIndex((button) => button.getAttribute("aria-label") === "Git Graph"));
  });

  it("shows only terminal groups in the Terminal side panel, with the layout toggle and Add terminal at the bottom", () => {
    render(<App />);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    expect(within(panel).queryByRole("region", { name: "Explorer" })).not.toBeInTheDocument();
    const terminalGroups = within(panel).getByRole("region", { name: "Terminal groups" });
    expect(within(terminalGroups).getByRole("button", { name: "Resource usage" })).toBeInTheDocument();
    const layout = within(panel).getByRole("group", { name: "Terminal layout mode" });
    expect(within(layout).getByRole("button", { name: "Split" })).toBeInTheDocument();
    expect(within(layout).getByRole("button", { name: "Free" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Add terminal to group" })).toBeInTheDocument();
  });

  it("shows the Explorer file tree with Go to file and the editor layout block when Editor is selected", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    await user.click(screen.getByRole("button", { name: "Editor" }));

    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const explorer = within(panel).getByRole("region", { name: "Explorer" });
    expect(within(explorer).getByRole("heading", { name: "Explorer" })).toBeInTheDocument();
    expect(within(explorer).getByRole("button", { name: "Go to file" })).toHaveAttribute("title", "Go to file (Ctrl+P)");
    expect(within(panel).queryByRole("region", { name: "Terminal groups" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Add terminal to group" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("group", { name: "Editor group layout mode" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "New group" })).toBeInTheDocument();
  });

  it("opens Quick Open from the Explorer Go to file button", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    await user.click(screen.getByRole("button", { name: "Editor" }));
    await user.click(screen.getByRole("button", { name: "Go to file" }));
    expect(screen.getByRole("dialog", { name: /quick open/i })).toBeInTheDocument();
  });

  it("switches the main view with the rail: Editor shows the editor breadcrumb, Terminal shows the terminal group", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Editor$/);
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Terminal · Terminal 1");
  });

  it("Git shortcuts select the rail tool and switch the main view to the editor", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Terminal · Terminal 1");
    await user.keyboard("{Control>}{Shift>}g{/Shift}{/Control}");
    expect(within(rail).getByRole("button", { name: "Git Changes" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Editor/);
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(within(rail).getByRole("button", { name: "Git Graph" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Editor/);
  });

  it("labels the side panel layout block as a group", () => {
    render(<App />);
    expect(screen.getByRole("group", { name: "Terminal layout mode" })).toBeInTheDocument();
  });

  it("shows a breadcrumb in the titlebar instead of Workspace views tabs", () => {
    render(<App />);
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    expect(within(titlebar).queryByRole("tablist", { name: "Workspace views" })).not.toBeInTheDocument();
    const breadcrumb = within(titlebar).getByText("Terminal · Terminal 1");
    expect(breadcrumb).toHaveClass("titlebar-breadcrumb");
    expect(breadcrumb).not.toHaveAttribute("aria-live");
  });

  it("integrates the CPU / RAM button into the terminal groups section and toggles the resource panel", async () => {
    const user = userEvent.setup();
    render(<App />);

    const terminalGroups = screen.getByRole("region", { name: "Terminal groups" });
    const cpuRamButton = within(terminalGroups).getByRole("button", { name: "Resource usage" });
    expect(document.getElementById("terminal-resource-panel")).not.toBeInTheDocument();

    await user.click(cpuRamButton);
    expect(document.getElementById("terminal-resource-panel")).toBeInTheDocument();
  });

  it("renders a compact single-row workspace switcher at the top of the side panel without large heading", () => {
    render(<App />);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    expect(within(panel).queryByRole("heading", { name: "Explorer" })).not.toBeInTheDocument();

    const switcher = panel.querySelector(".workspace-row") as HTMLElement;
    expect(switcher).toBeInTheDocument();
    expect(within(switcher).getByRole("combobox", { name: "Active terminal workspace" })).toBeInTheDocument();
    expect(within(switcher).getByRole("button", { name: "New workspace" })).toBeInTheDocument();
    expect(within(switcher).getByRole("button", { name: "Workspace actions" })).toBeInTheDocument();
    expect(within(switcher).queryByRole("button", { name: "Rename workspace" })).not.toBeInTheDocument();
    expect(within(switcher).queryByRole("button", { name: "Delete workspace" })).not.toBeInTheDocument();
  });

  it("opens the workspace actions menu with three items, closes it on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<App />);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const trigger = within(panel).getByRole("button", { name: "Workspace actions" });
    expect(within(panel).queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    const menu = within(panel).getByRole("menu", { name: "Workspace actions" });
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Rename workspace", "Add folders", "Delete workspace"]);
    expect(within(menu).getByRole("menuitem", { name: "Delete workspace" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(within(panel).queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

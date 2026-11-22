import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  open: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => () => {}), onCloseRequested: vi.fn(), destroy: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, confirm: vi.fn(async () => true) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("../../src/features/terminal/TerminalPane", async () => {
  const React = await import("react");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return {
    default: ({ sessionId, shell, workingDirectory }: { sessionId: string; shell: string; workingDirectory: string | null }) => {
      React.useEffect(() => {
        void tauriInvoke("create_terminal", { sessionId, shell, workingDirectory, cols: 80, rows: 24 });
      }, [sessionId, shell, workingDirectory]);
      return React.createElement("div", { "data-testid": "mock-terminal", "data-working-directory": workingDirectory ?? "" });
    },
  };
});

import App from "../../src/App";

const root = "C:\\repo";
const apiFolder = "C:\\repo\\api";
const srcFolder = "C:\\repo\\src";

function seed(settings: Record<string, unknown>) {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root, apiFolder] }],
    activeId: "workspace-1",
  }));
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify(settings));
}

/** Working directories of every create_terminal call, in order. */
function createdDirectories(): (string | null)[] {
  return tauri.invoke.mock.calls
    .filter(([command]) => command === "create_terminal")
    .map(([, args]) => (args as { workingDirectory: string | null }).workingDirectory);
}

function storedGroups(): { id: string; name: string }[] {
  const stored = JSON.parse(localStorage.getItem("yerminal.terminal-workspaces") ?? "{}");
  return stored.workspaces?.[0]?.groups ?? [];
}

afterEach(() => {
  cleanup();
});

describe("terminal open with defaults on (no prompt)", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "list_workspace_directory") return [];
      if (command === "terminal_output_snapshot") return { events: [] };
      if (command === "terminal_resource_usage") return [];
      return undefined;
    });
  });

  it("opens the first terminal in the workspace root without asking", async () => {
    seed({ terminalUseDefaults: true });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
  });

  it("uses the stored default path when one is set", async () => {
    seed({ terminalUseDefaults: true, terminalDefaultPath: apiFolder });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([apiFolder]));
    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
  });

  it("creates the stored default group when no group has that name", async () => {
    seed({ terminalUseDefaults: true, terminalDefaultGroup: "Logs" });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    expect(storedGroups().map((group) => group.name)).toContain("Logs");
    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
  });
});

describe("terminal open with defaults off (prompt)", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.open.mockReset();
    tauri.open.mockResolvedValue(null);
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "list_workspace_directory") return [];
      if (command === "terminal_output_snapshot") return { events: [] };
      if (command === "terminal_resource_usage") return [];
      return undefined;
    });
  });

  it("asks on startup and cancel opens nothing", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Open terminal" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
    expect(createdDirectories()).toEqual([]);
    expect(screen.queryByTestId("mock-terminal")).toBeNull();
  });

  it("New Terminal asks for folder and group, then opens the terminal in the chosen folder and a new group", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await user.click(await screen.findByRole("button", { name: "New Terminal" }));
    const dialog = await screen.findByRole("dialog", { name: "Open terminal" });
    await user.click(within(dialog).getByRole("radio", { name: apiFolder }));
    await user.click(within(dialog).getByRole("radio", { name: "New group" }));
    // user.type does not focus this input in the App harness, so the value is set directly.
    fireEvent.change(within(dialog).getByRole("textbox", { name: "New group name" }), { target: { value: "Logs" } });
    await user.click(within(dialog).getByRole("button", { name: "Open terminal" }));

    await waitFor(() => expect(createdDirectories()).toEqual([apiFolder]));
    expect(storedGroups().map((group) => group.name)).toContain("Logs");
    expect(JSON.parse(localStorage.getItem("yerminal.terminal-recent-folders.v1") ?? "[]")).toEqual([apiFolder]);
  });

  it("Open in Terminal keeps its folder and asks only for the group", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_workspace_directory") {
        return args?.root === root ? [{ name: "src", path: srcFolder, isDir: true, size: null }] : [];
      }
      if (command === "terminal_output_snapshot") return { events: [] };
      if (command === "terminal_resource_usage") return [];
      return undefined;
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    const folderButton = await screen.findByRole("button", { name: "src" });
    fireEvent.contextMenu(folderButton.closest(".workspace-tree-row")!);
    await user.click(screen.getByRole("menuitem", { name: "Open in Terminal" }));

    const dialog = await screen.findByRole("dialog", { name: "Open terminal" });
    expect(within(dialog).queryByRole("radio", { name: apiFolder })).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /New group/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Open terminal" }));

    await waitFor(() => expect(createdDirectories()).toEqual([srcFolder]));
  });

  it("split asks only for the folder, and the keyboard new-terminal shortcut asks too", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "New Terminal" }));
    const first = await screen.findByRole("dialog", { name: "Open terminal" });
    await user.click(within(first).getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(createdDirectories()).toHaveLength(1));

    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
    const splitDialog = await screen.findByRole("dialog", { name: "Open terminal" });
    expect(within(splitDialog).queryByRole("textbox", { name: "New group name" })).toBeNull();
    expect(within(splitDialog).getByRole("radio", { name: root })).toBeInTheDocument();
    await user.click(within(splitDialog).getByRole("button", { name: "Cancel" }));
    expect(createdDirectories()).toHaveLength(1);

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Open terminal" })).toBeInTheDocument();
  });
});

describe("terminal open settings persistence", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async () => undefined);
  });

  it("stores the switch and defaults from Settings and applies them after a restart", async () => {
    const user = userEvent.setup();
    seed({});
    const first = render(<App />);
    await waitFor(() => expect(createdDirectories()).toEqual([root]));

    await user.click(screen.getByRole("button", { name: "Help & Settings" }));
    await user.click(screen.getByRole("button", { name: "Terminal", exact: true }));
    await user.click(screen.getByRole("checkbox", { name: "Use defaults when opening a terminal" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Terminal default group" }), { target: { value: "API" } });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("yerminal.app-settings.v1") ?? "{}");
      expect(stored.terminalUseDefaults).toBe(false);
      expect(stored.terminalDefaultGroup).toBe("API");
    });
    first.unmount();

    tauri.invoke.mockClear();
    render(<App />);
    // Startup restores saved terminals without the open prompt (#43), even with the defaults switch off (#34).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("yerminal.app-settings.v1") ?? "{}").terminalUseDefaults).toBe(false);
  });
});

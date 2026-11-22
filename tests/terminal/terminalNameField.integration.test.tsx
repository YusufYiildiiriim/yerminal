import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => () => {}), onCloseRequested: vi.fn(), destroy: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, confirm: tauri.confirm }));
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
const SESSIONS_KEY = "yerminal.terminal-sessions.v1";

function seed(settings: Record<string, unknown>, twoGroups = false) {
  localStorage.clear();
  const groups = twoGroups
    ? [{ id: "g-one", name: "Terminal 1" }, { id: "g-two", name: "Logs" }]
    : [{ id: "terminal-group-default", name: "Terminal 1" }];
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root, apiFolder], groups, activeGroupId: groups[0].id }],
    activeId: "workspace-1",
  }));
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify(settings));
}

/**
 * Focuses the field, then types. In this app harness a pointer click does not move focus into the prompt
 * (the same quirk noted for the branch picker tests), so the focus is set explicitly before the keys.
 */
async function typeInto(user: ReturnType<typeof userEvent.setup>, element: HTMLElement, text: string) {
  await act(async () => { element.focus(); });
  await user.keyboard(text);
}

function createdDirectories(): (string | null)[] {
  return tauri.invoke.mock.calls
    .filter(([command]) => command === "create_terminal")
    .map(([, args]) => (args as { workingDirectory: string | null }).workingDirectory);
}

function savedSessions(): { name: string; groupId: string }[] {
  const stored = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "{}");
  return stored.workspaces?.["workspace-1"] ?? [];
}

function savedNames(): string[] {
  return savedSessions().map((session) => session.name);
}

beforeEach(() => {
  // Windows gives the first automatic name "PowerShell", so the automatic names are predictable here.
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_workspace_directory") {
      return args?.path === root ? [{ name: "src", path: srcFolder, isDir: true, size: null }] : [];
    }
    if (command === "terminal_output_snapshot") return { events: [] };
    if (command === "terminal_resource_usage") return [];
    return undefined;
  });
  tauri.open.mockReset();
  tauri.open.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("optional terminal name in the open prompt (#45)", () => {
  it("a typed name is the terminal's name and is saved; Enter in the field confirms", async () => {
    seed({ terminalUseDefaults: false });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    const field = await screen.findByRole("textbox", { name: "Terminal name" });
    const user = userEvent.setup();
    await typeInto(user, field, "  API{Enter}");

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    await waitFor(() => expect(savedNames()).toEqual(["API"]));
  });

  it("a blank or spaces-only name keeps the automatic naming, and the second automatic name is Terminal 2", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    const first = await screen.findByRole("dialog", { name: "Open terminal" });
    expect(within(first).getByRole("textbox", { name: "Terminal name" })).toHaveAttribute("placeholder", "PowerShell");
    await typeInto(user, within(first).getByRole("textbox", { name: "Terminal name" }), "   ");
    await user.click(within(first).getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(savedNames()).toEqual(["PowerShell"]));

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    const second = await screen.findByRole("dialog", { name: "Open terminal" });
    expect(within(second).getByRole("textbox", { name: "Terminal name" })).toHaveAttribute("placeholder", "Terminal 2");
    await user.click(within(second).getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(savedNames()).toEqual(["PowerShell", "Terminal 2"]));
  });

  it("a long name is capped at 40 characters", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Open terminal" });
    await typeInto(user, within(dialog).getByRole("textbox", { name: "Terminal name" }), "n".repeat(60));
    await user.click(within(dialog).getByRole("button", { name: "Open terminal" }));

    await waitFor(() => expect(savedNames()).toEqual(["n".repeat(40)]));
  });

  it("cancel opens nothing and saves nothing, even with a name typed", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Open terminal" });
    await typeInto(user, within(dialog).getByRole("textbox", { name: "Terminal name" }), "logs");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(createdDirectories()).toEqual([]);
    expect(localStorage.getItem(SESSIONS_KEY) ?? "").not.toContain("logs");
  });

  it("the group row's folder-only prompt has the name field and names the terminal in that group", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false }, true);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "New terminal in Logs" }));
    const dialog = await screen.findByRole("dialog", { name: "Terminal Folder" });
    expect(within(dialog).getByRole("textbox", { name: "Terminal name" })).toHaveAttribute("placeholder", "PowerShell");
    await typeInto(user, within(dialog).getByRole("textbox", { name: "Terminal name" }), "Deploy{Enter}");

    await waitFor(() => expect(savedSessions()).toEqual([expect.objectContaining({ name: "Deploy", groupId: "g-two" })]));
  });

  it("the Open in Terminal prompt (group only) has the name field", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    const folderButton = await screen.findByRole("button", { name: "src" });
    fireEvent.contextMenu(folderButton.closest(".workspace-tree-row")!);
    await user.click(screen.getByRole("menuitem", { name: "Open in Terminal" }));

    const dialog = await screen.findByRole("dialog", { name: "Open terminal" });
    await typeInto(user, within(dialog).getByRole("textbox", { name: "Terminal name" }), "Build");
    await user.click(within(dialog).getByRole("button", { name: "Open terminal" }));

    await waitFor(() => expect(createdDirectories()).toEqual([srcFolder]));
    await waitFor(() => expect(savedNames()).toEqual(["Build"]));
  });

  it("the split prompt (folder only) has the name field", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    const first = await screen.findByRole("dialog", { name: "Open terminal" });
    await user.click(within(first).getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(createdDirectories()).toHaveLength(1));

    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
    const split = await screen.findByRole("dialog", { name: "Terminal Folder" });
    await typeInto(user, within(split).getByRole("textbox", { name: "Terminal name" }), "Second{Enter}");

    await waitFor(() => expect(savedNames()).toEqual(["PowerShell", "Second"]));
  });

  it("with defaults on there is no prompt, so no name is asked", async () => {
    seed({ terminalUseDefaults: true });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    expect(screen.queryByRole("textbox", { name: "Terminal name" })).toBeNull();
  });

  it("a name kept in the saved list comes back after a restart", async () => {
    const user = userEvent.setup();
    seed({ terminalUseDefaults: false });
    const first = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    await typeInto(user, await screen.findByRole("textbox", { name: "Terminal name" }), "API{Enter}");
    // The debounced save has written the name once the snapshot holds it; no extra wait is needed.
    await waitFor(() => expect(savedNames()).toEqual(["API"]));
    first.unmount();

    tauri.invoke.mockClear();
    render(<App />);
    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    await waitFor(() => expect(savedNames()).toEqual(["API"]));
    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
  });
});

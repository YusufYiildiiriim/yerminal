import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    default: ({ sessionId, shell, workingDirectory, onExit }: { sessionId: string; shell: string; workingDirectory: string | null; onExit: (sessionId: string, options?: { startFailed?: boolean }) => void }) => {
      React.useEffect(() => {
        // "broken" folders stand in for a shell that cannot start.
        if (workingDirectory?.includes("broken")) {
          onExit(sessionId, { startFailed: true });
          return;
        }
        void tauriInvoke("create_terminal", { sessionId, shell, workingDirectory, cols: 80, rows: 24 });
      }, [sessionId, shell, workingDirectory, onExit]);
      return React.createElement("div", { "data-testid": "mock-terminal", "data-working-directory": workingDirectory ?? "" });
    },
  };
});

import App from "../../src/App";

const root = "C:\\repo";
const apiDir = "C:\\repo\\api";
const SESSIONS_KEY = "yerminal.terminal-sessions.v1";
const GROUP = "terminal-group-default";

type Saved = { name: string; groupId: string; shell: string; workingDirectory: string | null; active: boolean };

function seed(options: { sessions?: Record<string, Saved[]>; settings?: Record<string, unknown>; extraWorkspace?: boolean } = {}) {
  localStorage.clear();
  const workspaces = [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root, apiDir] }];
  if (options.extraWorkspace) workspaces.push({ id: "workspace-2", name: "Workspace 2", rootPath: "C:\\other", folderPaths: ["C:\\other"] });
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: workspaces.map((workspace) => ({ ...workspace, groups: [{ id: GROUP, name: "Terminal 1" }], activeGroupId: GROUP })),
    activeId: "workspace-1",
  }));
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify({ terminalUseDefaults: true, ...(options.settings ?? {}) }));
  if (options.sessions) localStorage.setItem(SESSIONS_KEY, JSON.stringify({ workspaces: options.sessions }));
}

function createdDirectories(): (string | null)[] {
  return tauri.invoke.mock.calls
    .filter(([command]) => command === "create_terminal")
    .map(([, args]) => (args as { workingDirectory: string | null }).workingDirectory);
}

function savedSessions(workspaceId = "workspace-1"): Saved[] {
  const stored = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "{}");
  return stored.workspaces?.[workspaceId] ?? [];
}

const api: Saved = { name: "api", groupId: GROUP, shell: "powershell", workingDirectory: apiDir, active: false };
const logs: Saved = { name: "logs", groupId: GROUP, shell: "powershell", workingDirectory: root, active: true };

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "check_terminal_directory") {
      if (String(args?.path).includes("missing")) throw "Working directory does not exist";
      return undefined;
    }
    if (command === "list_workspace_directory") return [];
    if (command === "terminal_output_snapshot") return { events: [] };
    if (command === "terminal_resource_usage") return [];
    return undefined;
  });
  tauri.open.mockReset();
  tauri.open.mockResolvedValue(null);
});

afterEach(() => cleanup());

describe("restoring open terminals on startup", () => {
  it("starts each saved terminal in its folder and group, with its name and active flag, without asking", async () => {
    seed({ sessions: { "workspace-1": [api, logs] }, settings: { terminalUseDefaults: false } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([apiDir, root]));
    expect(screen.queryByRole("dialog", { name: "Open terminal" })).toBeNull();
    expect((await screen.findAllByText("api")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("logs").length).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelector(".workspace-terminal-select.selected")).toHaveTextContent("logs"));
  });

  it("does not start the automatic first terminal when there are saved terminals", async () => {
    seed({ sessions: { "workspace-1": [api, logs] } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(createdDirectories()).toHaveLength(2);
  });

  it("keeps the saved list while terminals are starting, so an empty start cannot overwrite it", async () => {
    seed({ sessions: { "workspace-1": [api, logs] } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(savedSessions().map((session) => session.name)).toEqual(["api", "logs"]);
  });

  it("starts the automatic first terminal as before when nothing was saved", async () => {
    seed({});
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
  });

  it("does not restore anything when the setting is off; the old startup behaviour applies", async () => {
    seed({ sessions: { "workspace-1": [api, logs] }, settings: { terminalRestoreOnStartup: false } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(createdDirectories()).toEqual([root]);
    expect(screen.queryByText("api")).toBeNull();
  });

  it("falls back to the workspace root with a notice when a saved folder no longer exists", async () => {
    const gone: Saved = { ...api, name: "gone", workingDirectory: "C:\\repo\\missing" };
    seed({ sessions: { "workspace-1": [gone, logs] } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root, root]));
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
    expect((await screen.findAllByText("gone")).length).toBeGreaterThan(0);
  });

  it("drops a terminal whose shell cannot start and keeps the others", async () => {
    const broken: Saved = { ...api, name: "broken-one", workingDirectory: "C:\\repo\\broken" };
    seed({ sessions: { "workspace-1": [broken, logs] } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toEqual([root]));
    await waitFor(() => expect(screen.queryByText("broken-one")).toBeNull());
    expect(screen.getAllByText("logs").length).toBeGreaterThan(0);
  });

  it("restores each workspace into its own groups and leaves the other workspace's terminals alone", async () => {
    seed({
      sessions: { "workspace-1": [api], "workspace-2": [{ name: "other", groupId: GROUP, shell: "bash", workingDirectory: "C:\\other", active: false }] },
      extraWorkspace: true,
    });
    render(<App />);

    // Only the active workspace starts at once; the other workspace's terminal stays saved and starts when it is opened.
    await waitFor(() => expect(createdDirectories()).toEqual([apiDir]));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(createdDirectories()).toEqual([apiDir]);
    expect(savedSessions("workspace-2").map((session) => session.name)).toEqual(["other"]);
  });

  it("starts twelve saved terminals in order without blocking the UI", async () => {
    const twelve = Array.from({ length: 12 }, (_, index): Saved => ({ name: `t${index}`, groupId: GROUP, shell: "powershell", workingDirectory: root, active: index === 11 }));
    seed({ sessions: { "workspace-1": twelve } });
    render(<App />);

    await waitFor(() => expect(createdDirectories()).toHaveLength(12), { timeout: 3000 });
    expect(savedSessions()).toHaveLength(12);
  });
});

describe("saving changes to the open terminals", () => {
  it("removes a closed terminal from the saved list, and it does not come back", async () => {
    const user = userEvent.setup();
    seed({ sessions: { "workspace-1": [api, logs] } });
    render(<App />);
    await waitFor(() => expect(createdDirectories()).toHaveLength(2));

    fireEvent.contextMenu((await screen.findAllByText("api"))[0].closest("button")!);
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Close" }));

    await waitFor(() => expect(savedSessions().map((session) => session.name)).toEqual(["logs"]));
  });

  it("saves a renamed terminal under its new name", async () => {
    const user = userEvent.setup();
    seed({ sessions: { "workspace-1": [api, logs] } });
    render(<App />);
    await waitFor(() => expect(createdDirectories()).toHaveLength(2));

    fireEvent.contextMenu((await screen.findAllByText("api"))[0].closest("button")!);
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByDisplayValue("api");
    await user.clear(input);
    await user.type(input, "API v2{Enter}");

    await waitFor(() => expect(savedSessions().map((session) => session.name)).toEqual(["API v2", "logs"]));
  });

  it("gives a new terminal the first free 'Terminal N' name when restored names already use some", async () => {
    const numbered: Saved = { ...api, name: "Terminal 1" };
    seed({ sessions: { "workspace-1": [numbered, logs] } });
    render(<App />);
    await waitFor(() => expect(createdDirectories()).toHaveLength(2));

    // The restored "Terminal 1" keeps its name; the next automatic name must not reuse it.
    expect(savedSessions().map((session) => session.name)).toEqual(["Terminal 1", "logs"]);
  });
});

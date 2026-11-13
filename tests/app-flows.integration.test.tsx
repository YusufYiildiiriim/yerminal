import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  open: vi.fn(),
  listen: vi.fn(async () => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke, isTauri: tauriMocks.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: tauriMocks.onFocusChanged }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauriMocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauriMocks.openUrl, revealItemInDir: tauriMocks.revealItemInDir }));
vi.mock("../src/features/terminal/TerminalPane", () => ({ default: () => <div aria-label="Terminal session" /> }));

type InvokeArgs = Record<string, unknown>;
const rootPath = "C:\\repo";
const invokeMock = tauriMocks.invoke;
const openMock = tauriMocks.open;

function seedWorkspace(settings: Record<string, unknown> = {}) {
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath] }],
    activeId: "workspace-1",
  }));
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify(settings));
}

function seedTwoWorkspaces(settings: Record<string, unknown> = {}) {
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [
      { id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath] },
      { id: "workspace-2", name: "Workspace 2", rootPath, folderPaths: [rootPath] },
    ],
    activeId: "workspace-1",
  }));
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify(settings));
}

function writeCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === "write_workspace_text_file");
}

async function openNotesAndEdit(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(await screen.findByRole("button", { name: /notes/ }));
  const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
  await user.clear(editor);
  await user.type(editor, text);
  return editor;
}

function entriesFor(path: unknown) {
  if (path === rootPath) return [
    { name: "src", path: `${rootPath}\\src`, isDir: true, size: null, extension: null },
    { name: "notes.txt", path: `${rootPath}\\notes.txt`, isDir: false, size: 20, extension: "txt" },
    { name: "large.txt", path: `${rootPath}\\large.txt`, isDir: false, size: 1024 * 1024 + 1, extension: "txt" },
  ];
  if (path === `${rootPath}\\src`) return [
    { name: "main.ts", path: `${rootPath}\\src\\main.ts`, isDir: false, size: 12, extension: "ts" },
  ];
  return [];
}

function defaultInvokeResult(command: string, args?: InvokeArgs): unknown {
  switch (command) {
    case "list_workspace_directory": return entriesFor(args?.path);
    case "git_repository_info": return { root: args?.path ?? rootPath, branch: "main", state: "clean" };
    case "git_status": return [{ path: "notes.txt", kind: "modified", staged: false, unstaged: true }];
    case "read_workspace_text_file": return "disk baseline";
    case "git_diff": return "diff --git a/notes.txt b/notes.txt\\n@@ -1 +1 @@\\n-old\\n+new";
    default: return undefined;
  }
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: InvokeArgs) => defaultInvokeResult(command, args));
  tauriMocks.isTauri.mockReturnValue(true);
  tauriMocks.listen.mockReset();
  tauriMocks.listen.mockImplementation(async () => () => {});
  tauriMocks.onFocusChanged.mockReset();
  tauriMocks.onFocusChanged.mockImplementation(async () => () => {});
  openMock.mockReset();
  openMock.mockResolvedValue([rootPath]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("App user flows", () => {
  it("adds a folder, re-reads nested directories on collapse/expand, and removes the folder", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Add Folder" }));
    expect(await screen.findByRole("button", { name: "Expand src" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand src" }));
    expect(await screen.findByRole("button", { name: /main/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse src" }));
    await user.click(screen.getByRole("button", { name: "Expand src" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command, args]) => command === "list_workspace_directory" && args?.path === `${rootPath}\\src`)).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Remove repo from this workspace" }));
    expect(await screen.findByText("No folders in this workspace")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("yerminal.terminal-workspaces") ?? "{}").workspaces[0].folderPaths).toEqual([]);
  });

  it("saves with the on-disk baseline and keeps edits when a stale write is rejected", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    invokeMock.mockImplementation(async (command: string, args?: InvokeArgs) => {
      if (command === "write_workspace_text_file") throw new Error("File changed on disk since it was opened");
      return defaultInvokeResult(command, args);
    });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /notes/ }));
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    await user.clear(editor);
    await user.type(editor, "my unsaved change");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect(await screen.findByText(/The file changed on disk/)).toBeInTheDocument();
    expect(editor).toHaveValue("my unsaved change");
    expect(invokeMock).toHaveBeenCalledWith("write_workspace_text_file", {
      root: rootPath,
      path: `${rootPath}\\notes.txt`,
      content: "my unsaved change",
      expectedContent: "disk baseline",
    });
  });

  it("auto-saves a dirty workspace file after the debounce interval", async () => {
    const user = userEvent.setup();
    seedWorkspace({ autoSave: true });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /notes/ }));
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    await user.clear(editor);
    await user.type(editor, "saved automatically");

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("write_workspace_text_file", {
      root: rootPath,
      path: `${rootPath}\\notes.txt`,
      content: "saved automatically",
      expectedContent: "disk baseline",
    }), { timeout: 2500 });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
  });

  it("persists the selected theme and enforces the 1 MiB diff limit", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Help & Settings" }));
    await user.click(screen.getByRole("button", { name: /Foundry/ }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("yerminal.app-settings.v1") ?? "{}").theme).toBe("foundry"));
    expect(document.documentElement).toHaveAttribute("data-theme", "foundry");

    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Git Changes" }));
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === "git_status")).toBe(true));
    await user.click(await screen.findByRole("button", { name: /M.*notes.*U/ }));
    expect((await screen.findByRole("region", { name: "File diff" })).parentElement).toHaveClass("is-diff");
    invokeMock.mockImplementation(async (command: string, args?: InvokeArgs) => {
      if (command === "git_diff") return "x".repeat(1024 * 1024 + 1);
      return defaultInvokeResult(command, args);
    });
    await user.click(screen.getByRole("button", { name: /M.*notes.*U/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This diff exceeds the 1 MiB preview limit.");
  });
});

describe("Closing editor tabs", () => {
  it("asks before closing a dirty tab and keeps it when cancelled", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    const editor = await openNotesAndEdit(user, "keep me");
    await user.click(screen.getByRole("button", { name: "Close notes.txt" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to notes.txt?");
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveValue("keep me");
  });

  it("asks before closing a tab whose save is still in flight, even if its text matches the baseline", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    let finishWrite: () => void = () => {};
    invokeMock.mockImplementation(async (command: string, args?: InvokeArgs) => {
      if (command === "write_workspace_text_file") return new Promise<void>((resolve) => { finishWrite = resolve; });
      return defaultInvokeResult(command, args);
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    const editor = await openNotesAndEdit(user, "being saved");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(await screen.findByText("Saving changes…")).toBeInTheDocument();
    // Revert the text while the write is still running: the tab looks clean but the disk is about to change.
    await user.clear(editor);
    await user.type(editor, "disk baseline");
    await user.click(screen.getByRole("button", { name: "Close notes.txt" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/still saving/i);
    expect(screen.getByRole("textbox", { name: "Edit notes.txt" })).toBeInTheDocument();

    finishWrite();
    expect(await screen.findByText("Unsaved changes", { selector: ".code-editor-statusbar span" })).toBeInTheDocument();
  });
});

describe("Window close guard", () => {
  function dispatchBeforeUnload() {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it("blocks unloading only while an editor tab has unsaved changes", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /notes/ }));
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    await user.clear(editor);
    await user.type(editor, "edited");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

    await user.clear(editor);
    await user.type(editor, "disk baseline");
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
  });
});

describe("Workspace deletion with unsaved editor tabs", () => {
  it("warns about unsaved files and keeps the workspace and edits when cancelled", async () => {
    const user = userEvent.setup();
    seedTwoWorkspaces();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    const editor = await openNotesAndEdit(user, "unsaved work");
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/unsaved changes.*notes\.txt/i);
    expect(editor).toHaveValue("unsaved work");
    expect(JSON.parse(localStorage.getItem("yerminal.terminal-workspaces") ?? "{}").workspaces).toHaveLength(2);
  });

  it("drops the deleted workspace's editor state so auto-save never writes its tabs", async () => {
    const user = userEvent.setup();
    seedTwoWorkspaces({ autoSave: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    await openNotesAndEdit(user, "discard me");
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("yerminal.terminal-workspaces") ?? "{}").workspaces).toHaveLength(1));

    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(writeCalls()).toHaveLength(0);
  });
});

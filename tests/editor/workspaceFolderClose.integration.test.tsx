import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  open: vi.fn(),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  onCloseRequested: vi.fn(),
  destroy: vi.fn(async () => {}),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke, isTauri: tauriMocks.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: tauriMocks.onFocusChanged, onCloseRequested: tauriMocks.onCloseRequested, destroy: tauriMocks.destroy }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauriMocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauriMocks.openUrl, revealItemInDir: tauriMocks.revealItemInDir }));
vi.mock("../../src/features/terminal/TerminalPane", () => ({ default: ({ sessionId }: { sessionId: string }) => <div aria-label={`Terminal session ${sessionId}`} /> }));

type InvokeArgs = Record<string, unknown>;
const rootPath = "C:\\repo";
const invokeMock = tauriMocks.invoke;

function seedWorkspace() {
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath] }],
    activeId: "workspace-1",
  }));
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify({}));
}

function entriesFor(path: unknown) {
  if (path === rootPath) return [
    { name: "notes.txt", path: `${rootPath}\\notes.txt`, isDir: false, size: 20, extension: "txt" },
  ];
  return [];
}

function defaultInvokeResult(command: string, args?: InvokeArgs): unknown {
  switch (command) {
    case "list_workspace_directory": return entriesFor(args?.path);
    case "git_repository_info": return null;
    case "read_workspace_text_file": return "disk baseline";
    default: return undefined;
  }
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: InvokeArgs) => defaultInvokeResult(command, args));
  tauriMocks.isTauri.mockReturnValue(true);
  tauriMocks.onFocusChanged.mockReset();
  tauriMocks.onFocusChanged.mockImplementation(async () => () => {});
  tauriMocks.onCloseRequested.mockReset();
  tauriMocks.onCloseRequested.mockResolvedValue(() => {});
  tauriMocks.open.mockReset();
  tauriMocks.open.mockResolvedValue([rootPath]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("removing a workspace folder closes its editor tabs", () => {
  it("keeps the removed folder's file tab closed after switching Editor -> Terminal -> Editor", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    await user.click(await screen.findByRole("button", { name: /notes/ }));
    expect(await screen.findByRole("textbox", { name: "Edit notes.txt" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove repo from this workspace" }));
    expect(await screen.findByText("No folders in this workspace")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit notes.txt" })).not.toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: /notes\.txt/ })).not.toBeInTheDocument();
  });

  it("asks before removing a folder with an unsaved tab and keeps the folder when cancelled", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    await user.click(await screen.findByRole("button", { name: /notes/ }));
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    await waitFor(() => expect(editor).toHaveValue("disk baseline"));
    await user.clear(editor);
    await user.type(editor, "keep me");
    await user.click(screen.getByRole("button", { name: "Remove repo from this workspace" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to notes.txt?");
    expect(screen.queryByText("No folders in this workspace")).not.toBeInTheDocument();
    expect(editor).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /notes\.txt/ })).toBeInTheDocument();
  });

  it("discards the unsaved tab and removes the folder when the prompt is confirmed", async () => {
    const user = userEvent.setup();
    seedWorkspace();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    await user.click(await screen.findByRole("button", { name: /notes/ }));
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    await waitFor(() => expect(editor).toHaveValue("disk baseline"));
    await user.clear(editor);
    await user.type(editor, "keep me");
    await user.click(screen.getByRole("button", { name: "Remove repo from this workspace" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to notes.txt?");
    expect(await screen.findByText("No folders in this workspace")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Edit notes.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /notes\.txt/ })).not.toBeInTheDocument();
  });
});

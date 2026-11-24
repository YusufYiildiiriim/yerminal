import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
  confirm: vi.fn(async (_message: string, _options?: Record<string, unknown>) => false),
  open: vi.fn(async () => null),
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
  terminalExitHandlers: new Map<string, (id: string) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {}, onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm, open: mocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl, revealItemInDir: mocks.revealItemInDir }));
vi.mock("../../src/features/terminal/TerminalPane", () => ({
  default: ({ sessionId, onExit }: { sessionId: string; onExit: (id: string) => void }) => {
    React.useEffect(() => {
      mocks.terminalExitHandlers.set(sessionId, onExit);
      return () => { mocks.terminalExitHandlers.delete(sessionId); };
    }, [sessionId, onExit]);
    return React.createElement("div", { "data-testid": "terminal-session", "data-session-id": sessionId },
      React.createElement("textarea", { className: "xterm-helper-textarea", "aria-label": "Mock terminal input" }));
  },
}));

const rootPath = "C:\\repo";

function seedWorkspace() {
  localStorage.setItem("yerminal.app-settings.v1", JSON.stringify({ terminalUseDefaults: true }));
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath] }],
    activeId: "workspace-1",
  }));
}

function terminalIds() {
  return [...document.querySelectorAll<HTMLElement>("[data-testid='terminal-session']")].map((element) => element.dataset.sessionId!);
}

function closeInvocations() {
  return mocks.invoke.mock.calls.filter(([command]) => command === "close_terminal");
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  seedWorkspace();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_workspace_directory" && args?.path === rootPath) {
      return [{ name: "notes.txt", path: `${rootPath}\\notes.txt`, isDir: false, size: 14, extension: "txt" }];
    }
    if (command === "read_workspace_text_file") return "disk baseline";
    if (command === "git_repository_info") return { root: rootPath, branch: "main", state: "clean" };
    return undefined;
  });
  mocks.isTauri.mockReturnValue(true);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(false);
  mocks.terminalExitHandlers.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWithOneTerminal() {
  render(<App />);
  await waitFor(() => expect(terminalIds()).toHaveLength(1));
  const [id] = terminalIds();
  // The mock registers its exit handler in an effect, which can run after the pane is already in the DOM.
  await waitFor(() => expect(mocks.terminalExitHandlers.has(id)).toBe(true));
  return id;
}

async function addSecondTerminal() {
  fireEvent.click(screen.getByRole("button", { name: "Add terminal to group" }));
  await waitFor(() => expect(terminalIds()).toHaveLength(2));
  return terminalIds();
}

describe("closing terminal sessions", () => {
  it("asks before closing a live terminal and cancellation preserves its PTY and UI state", async () => {
    const targetId = await renderWithOneTerminal();

    fireEvent.keyDown(screen.getByRole("main"), { key: "w", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0][0]).toMatch(/live terminal session/i);
    expect(mocks.confirm.mock.calls[0][0]).toMatch(/running processes.*may be interrupted/i);
    expect(mocks.confirm.mock.calls[0][1]).toEqual({ title: "Close terminal session", kind: "warning" });
    expect(closeInvocations()).toHaveLength(0);
    expect(terminalIds()).toEqual([targetId]);
    expect(mocks.terminalExitHandlers.has(targetId)).toBe(true);
  });

  it("closes only the selected terminal from its tab close button after confirmation", async () => {
    await renderWithOneTerminal();
    const [targetId, remainingId] = await addSecondTerminal();
    mocks.confirm.mockResolvedValue(true);
    const closeButton = document.querySelector<HTMLButtonElement>(`.terminal-pane-frame[data-terminal-id="${targetId}"] .pane-close`);
    expect(closeButton).not.toBeNull();

    fireEvent.click(closeButton!);

    await waitFor(() => expect(closeInvocations()).toEqual([["close_terminal", { sessionId: targetId }]]));
    await waitFor(() => expect(terminalIds()).toEqual([remainingId]));
    expect(mocks.terminalExitHandlers.has(remainingId)).toBe(true);
  });

  it("uses the same confirmation path for the terminal pane close button", async () => {
    await renderWithOneTerminal();
    const ids = await addSecondTerminal();
    const closeButton = document.querySelector<HTMLButtonElement>(".terminal-pane-frame .pane-close");
    expect(closeButton).not.toBeNull();

    fireEvent.click(closeButton!);

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(closeInvocations()).toHaveLength(0);
    expect(terminalIds()).toEqual(ids);
  });

  it("does not open a second confirmation for the same terminal while one is pending", async () => {
    const targetId = await renderWithOneTerminal();
    let resolveConfirmation!: (accepted: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }));

    fireEvent.keyDown(screen.getByRole("main"), { key: "w", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const paneClose = document.querySelector<HTMLButtonElement>(".terminal-pane-frame[data-terminal-id=\"" + targetId + "\"] .pane-close");
    fireEvent.click(paneClose!);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(closeInvocations()).toHaveLength(0);
    resolveConfirmation(false);
    await waitFor(() => expect(terminalIds()).toEqual([targetId]));
    expect(closeInvocations()).toHaveLength(0);
  });

  it("keeps the terminal open if the native confirmation cannot be shown", async () => {
    const targetId = await renderWithOneTerminal();
    mocks.confirm.mockRejectedValue(new Error("native dialog unavailable"));

    fireEvent.keyDown(screen.getByRole("main"), { key: "w", ctrlKey: true, shiftKey: true });

    expect(await screen.findByText(/Could not confirm terminal close: Error: native dialog unavailable/)).toBeInTheDocument();
    expect(closeInvocations()).toHaveLength(0);
    expect(terminalIds()).toEqual([targetId]);
    expect(mocks.terminalExitHandlers.has(targetId)).toBe(true);
  });

  it("closes an exited terminal without an unnecessary confirmation", async () => {
    const targetId = await renderWithOneTerminal();
    const onExit = mocks.terminalExitHandlers.get(targetId);
    expect(onExit).toBeDefined();
    await act(async () => onExit?.(targetId));

    fireEvent.keyDown(screen.getByRole("main"), { key: "w", ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(closeInvocations()).toEqual([["close_terminal", { sessionId: targetId }]]));
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});

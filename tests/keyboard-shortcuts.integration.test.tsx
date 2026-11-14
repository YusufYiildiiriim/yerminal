import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
  open: vi.fn(async () => null),
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: async () => () => {}, onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl, revealItemInDir: mocks.revealItemInDir }));
vi.mock("../src/features/terminal/TerminalPane", () => ({
  default: () => React.createElement("textarea", { className: "xterm-helper-textarea", "aria-label": "Mock terminal input" }),
}));

const rootPath = "C:\\repo";

function seedWorkspace() {
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath] }],
    activeId: "workspace-1",
  }));
}

function terminalCount() {
  return document.querySelectorAll(".terminal-pane-frame").length;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  seedWorkspace();
  mocks.invoke.mockClear();
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_workspace_directory" && args?.path === rootPath) {
      return [{ name: "notes.txt", path: `${rootPath}\\notes.txt`, isDir: false, size: 14, extension: "txt" }];
    }
    if (command === "read_workspace_text_file") return "disk baseline";
    if (command === "git_repository_info") return { root: rootPath, branch: "main", state: "clean" };
    return undefined;
  });
  mocks.isTauri.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("global keyboard shortcuts", () => {
  it("runs an application shortcut while the xterm helper textarea is focused", async () => {
    render(<App />);
    const terminalInput = await screen.findByRole("textbox", { name: "Mock terminal input" });
    await waitFor(() => expect(terminalCount()).toBe(1));
    terminalInput.focus();

    fireEvent.keyDown(terminalInput, { key: "g", ctrlKey: true, shiftKey: true });

    expect(screen.getByRole("button", { name: "Git Changes" })).toHaveAttribute("aria-pressed", "true");
  });

  it("runs an application shortcut while the code editor textarea is focused", async () => {
    render(<App />);
    await screen.findByRole("textbox", { name: "Mock terminal input" });
    await waitFor(() => expect(terminalCount()).toBe(1));
    await screen.findByRole("button", { name: /notes\.txt/ });
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    fireEvent.click(screen.getByRole("button", { name: /notes\.txt/ }));
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    editor.focus();

    fireEvent.keyDown(editor, { key: "g", ctrlKey: true, shiftKey: true });

    expect(screen.getByRole("button", { name: "Git Changes" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Quick Open and terminal rename inputs usable without running terminal shortcuts", async () => {
    render(<App />);
    await screen.findByRole("textbox", { name: "Mock terminal input" });
    await waitFor(() => expect(terminalCount()).toBe(1));
    fireEvent.keyDown(document.body, { key: "p", ctrlKey: true });
    const quickOpen = await screen.findByPlaceholderText("Search files by name or path…");
    fireEvent.keyDown(quickOpen, { key: "g", ctrlKey: true, shiftKey: true });
    fireEvent.change(quickOpen, { target: { value: "notes" } });
    expect(quickOpen).toHaveValue("notes");
    expect(terminalCount()).toBe(1);
    expect(screen.getByRole("button", { name: "Git Changes" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.keyDown(quickOpen, { key: "Escape" });
    const renameButton = document.querySelector<HTMLButtonElement>(".terminal-tab-rename");
    expect(renameButton).not.toBeNull();
    fireEvent.click(renameButton!);
    const renameInput = await screen.findByRole("textbox", { name: /new name for/i });
    renameInput.focus();
    fireEvent.keyDown(renameInput, { key: "g", ctrlKey: true, shiftKey: true });
    fireEvent.change(renameInput, { target: { value: "terminal draft" } });

    expect(renameInput).toHaveValue("terminal draft");
    expect(terminalCount()).toBe(1);
    expect(screen.getByRole("button", { name: "Git Changes" })).toHaveAttribute("aria-pressed", "false");
  });

  it("ignores repeated keydown events so holding the shortcut does not create more terminals", async () => {
    render(<App />);
    await screen.findByRole("textbox", { name: "Mock terminal input" });
    await waitFor(() => expect(terminalCount()).toBe(1));
    const app = screen.getByRole("main");

    fireEvent.keyDown(app, { key: "t", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(terminalCount()).toBe(2));
    fireEvent.keyDown(app, { key: "t", ctrlKey: true, shiftKey: true, repeat: true });

    expect(terminalCount()).toBe(2);
  });
});

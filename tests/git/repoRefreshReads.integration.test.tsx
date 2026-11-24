import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => () => {}), onCloseRequested: vi.fn(), destroy: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, confirm: vi.fn(async () => true) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("../../src/features/terminal/TerminalPane", () => ({ default: () => null }));

import App from "../../src/App";

const root = "C:\\repo";

function callsOf(command: string): number {
  return tauri.invoke.mock.calls.filter(([name]) => name === command).length;
}

function setup() {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root] }],
    activeId: "workspace-1",
  }));
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "git_repository_info") return { root, branch: "develop", state: "clean" };
    if (command === "git_status") return [{ path: "b.ts", kind: "modified", staged: false, unstaged: true }];
    if (command === "git_remote_state") return { branch: "develop", upstream: "origin/develop", ahead: 0, behind: 0, hasRemote: true };
    if (command === "list_workspace_directory") return [];
    return undefined;
  });
}

afterEach(() => cleanup());

describe("Git Changes refresh reads", () => {
  it("reads each repository's status once per refresh, not once per re-read of its info", async () => {
    const user = userEvent.setup();
    setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    await screen.findByText("b.ts");
    expect(callsOf("git_status")).toBe(1);

    await user.click(screen.getByRole("button", { name: "Refresh repositories and changes" }));
    await waitFor(() => expect(callsOf("git_repository_info")).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(callsOf("git_status")).toBe(2);
  });
});

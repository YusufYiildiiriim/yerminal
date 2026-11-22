import { cleanup, render, screen, within } from "@testing-library/react";
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

const rootA = "C:\\work\\alpha";

/** The repository's git_status fails until the test changes `statusFails` to false. */
function setup() {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: rootA, folderPaths: [rootA] }],
    activeId: "workspace-1",
  }));
  const state = { statusFails: true };
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === "git_repository_info") return { root: args?.path ?? rootA, branch: "main", state: "clean" };
    if (command === "git_status") {
      if (state.statusFails) throw "fatal: index file is corrupt";
      return [];
    }
    if (command === "git_remote_state") return { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true };
    if (command === "list_workspace_directory") return [];
    return undefined;
  });
  return state;
}

afterEach(() => cleanup());

describe("Git Changes when git_status fails", () => {
  it("shows a short error line in the card instead of a 0 staged / 0 changes count", async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    const list = await screen.findByLabelText("Git repositories");
    const card = (await within(list).findByText("alpha")).closest(".git-repository-section") as HTMLElement;

    expect(await within(card).findByRole("alert")).toHaveTextContent("Could not read changes");
    expect(within(card).queryByText(/staged ·/)).toBeNull();
    expect(within(card).queryByText("0 staged · 0 changes")).toBeNull();
  });

  it("offers a retry that reloads the card once git_status works again", async () => {
    const state = setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    const list = await screen.findByLabelText("Git repositories");
    const card = (await within(list).findByText("alpha")).closest(".git-repository-section") as HTMLElement;
    await within(card).findByRole("alert");

    state.statusFails = false;
    await user.click(within(card).getByRole("button", { name: "Try again" }));

    expect(await within(card).findByText("0 staged · 0 changes")).toBeInTheDocument();
    expect(within(card).queryByRole("alert")).toBeNull();
  });
});

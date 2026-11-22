import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
const rootB = "C:\\work\\beta";
const rootC = "C:\\work\\gamma";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Each folder's repository info is held back until the test resolves it. */
function setup(folders: string[]) {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: folders[0], folderPaths: folders }],
    activeId: "workspace-1",
  }));
  const infos = new Map<string, Deferred<unknown>>(folders.map((folder) => [folder, deferred()]));
  const removed = new Set<string>();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args?: { path?: string; name?: string }) => {
    const path = args?.path ?? "";
    if (command === "terminal_output_snapshot") return { events: [] };
    if (command === "git_repository_info") return removed.has(path) ? null : infos.get(path)?.promise;
    if (command === "git_history") return [];
    if (command === "git_branches") return [{ name: "main", isRemote: false, isHead: true, ahead: null, behind: null }, { name: "develop", isRemote: false, isHead: false, ahead: null, behind: null }];
    if (command === "git_status") return [];
    if (command === "git_checkout_branch") return { root: path, branch: args?.name, state: "clean" };
    if (command === "git_remote_state") return { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true };
    if (command === "list_workspace_directory") return [];
    return undefined;
  });
  return { infos, removed };
}

afterEach(() => cleanup());

describe("Git Graph keeps the repository it first showed", () => {
  it("stays on the first shown repository when an earlier folder resolves later", async () => {
    const { infos } = setup([rootA, rootB]);
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");

    infos.get(rootB)!.resolve({ root: rootB, branch: "main", state: "clean" });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_branches", { path: rootB }));

    infos.get(rootA)!.resolve({ root: rootA, branch: "main", state: "clean" });
    const picker = await screen.findByRole("combobox", { name: "Select repository" });
    await waitFor(() => expect(picker).toHaveValue(rootB));
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_branches", { path: rootA });
  });

  it("does not let a repository that resolves later override the user's choice", async () => {
    const { infos } = setup([rootA, rootB, rootC]);
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");

    infos.get(rootC)!.resolve({ root: rootC, branch: "main", state: "clean" });
    infos.get(rootB)!.resolve({ root: rootB, branch: "main", state: "clean" });
    const picker = await screen.findByRole("combobox", { name: "Select repository" });
    await user.selectOptions(picker, rootB);
    await waitFor(() => expect(picker).toHaveValue(rootB));

    infos.get(rootA)!.resolve({ root: rootA, branch: "main", state: "clean" });
    await act(async () => {});
    await act(async () => {});
    expect(picker).toHaveValue(rootB);
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_branches", { path: rootA });
  });

  it("moves to the first remaining repository when the selected one is removed", async () => {
    const { infos, removed } = setup([rootA, rootB, rootC]);
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");

    infos.get(rootA)!.resolve({ root: rootA, branch: "main", state: "clean" });
    infos.get(rootB)!.resolve({ root: rootB, branch: "main", state: "clean" });
    infos.get(rootC)!.resolve({ root: rootC, branch: "main", state: "clean" });
    const picker = await screen.findByRole("combobox", { name: "Select repository" });
    await user.selectOptions(picker, rootB);
    await waitFor(() => expect(picker).toHaveValue(rootB));

    // Git Graph's branch switch refreshes every repository; the selected one no longer resolves.
    removed.add(rootB);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    await user.click(await within(panel).findByRole("button", { name: /^Switch branch/ }));
    await user.click(await screen.findByRole("button", { name: "Checkout develop" }));

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_checkout_branch", { path: rootB, name: "develop" }));
    await waitFor(() => expect(picker).toHaveValue(rootA));
  });
});

describe("Git Changes lists each repository once and shows pending folders only while unknown", () => {
  it("drops a pending subfolder card once its repository root is already shown", async () => {
    const sub = "C:\\work\\alpha\\sub";
    const { infos } = setup([sub, rootA]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    const list = await screen.findByLabelText("Git repositories");

    infos.get(sub)!.resolve({ root: rootA, branch: "main", state: "clean" });
    await within(list).findByText("alpha");
    expect(within(list).queryByRole("status", { name: "Loading repository…" })).toBeNull();
  });

  it("drops a pending card whose path differs only by letter case from a shown root", async () => {
    const upper = "C:\\work\\Alpha";
    const { infos } = setup([upper, rootA]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    const list = await screen.findByLabelText("Git repositories");

    infos.get(rootA)!.resolve({ root: rootA, branch: "main", state: "clean" });
    await within(list).findByText("alpha");
    expect(within(list).queryByRole("status", { name: "Loading repository…" })).toBeNull();
  });
});

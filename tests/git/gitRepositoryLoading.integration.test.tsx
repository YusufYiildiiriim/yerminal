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
const rootB = "C:\\work\\beta";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Each repository's info and status are held back until the test resolves them, one by one. */
function setup() {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: rootA, folderPaths: [rootA, rootB] }],
    activeId: "workspace-1",
  }));
  const infos = new Map<string, Deferred<unknown>>([[rootA, deferred()], [rootB, deferred()]]);
  const statuses = new Map<string, Deferred<unknown>>([[rootA, deferred()], [rootB, deferred()]]);
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    const path = args?.path ?? "";
    if (command === "git_repository_info") return infos.get(path)?.promise;
    if (command === "git_status") return statuses.get(path)?.promise;
    if (command === "git_remote_state") return { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true };
    if (command === "list_workspace_directory") return [];
    return undefined;
  });
  return { infos, statuses };
}

afterEach(() => cleanup());

describe("Git Changes repository loading", () => {
  it("opens the panel and shows every repository card as loading before any status arrives", async () => {
    setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));

    expect(await screen.findByRole("heading", { name: "Git Changes" })).toBeInTheDocument();
    const list = await screen.findByLabelText("Git repositories");
    expect(within(list).getByText("alpha")).toBeInTheDocument();
    expect(within(list).getByText("beta")).toBeInTheDocument();
    expect(within(list).getAllByRole("status", { name: "Loading repository…" })).toHaveLength(2);
  });

  it("renders each repository as soon as its own info arrives, without waiting for the others", async () => {
    const { infos, statuses } = setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    const list = await screen.findByLabelText("Git repositories");
    await within(list).findByText("beta");

    infos.get(rootA)!.resolve({ root: rootA, branch: "main", state: "clean" });
    statuses.get(rootA)!.resolve([]);

    expect(await within(list).findByText("0 staged · 0 changes")).toBeInTheDocument();
    expect(within(list).getAllByRole("status", { name: "Loading repository…" })).toHaveLength(1);
    expect(within(list).getByText("beta")).toBeInTheDocument();
  });

  it("shows a loading state inside a repository card until its own changes arrive", async () => {
    const { infos, statuses } = setup();
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Git" }));
    const list = await screen.findByLabelText("Git repositories");
    await within(list).findByText("alpha");

    infos.get(rootA)!.resolve({ root: rootA, branch: "main", state: "clean" });
    const loadingChanges = await within(list).findByRole("status", { name: "Loading changes…" });
    const card = loadingChanges.closest(".git-repository-section") as HTMLElement;
    expect(within(card).getByText("alpha")).toBeInTheDocument();
    expect(within(card).queryByText("0 staged · 0 changes")).toBeNull();

    statuses.get(rootA)!.resolve([]);
    expect(await within(card).findByText("0 staged · 0 changes")).toBeInTheDocument();
    expect(within(card).queryByRole("status", { name: "Loading changes…" })).toBeNull();
  });
});

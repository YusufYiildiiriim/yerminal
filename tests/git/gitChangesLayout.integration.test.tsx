import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true), open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => () => {}), onCloseRequested: vi.fn(), destroy: vi.fn(async () => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, confirm: vi.fn(async () => true) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("../../src/features/terminal/TerminalPane", () => ({ default: () => null }));

import App from "../../src/App";

const root = "C:\\repo";

type Status = { path: string; kind: string; staged: boolean; unstaged: boolean };

function setup(statuses: Status[], ahead: number) {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root] }],
    activeId: "workspace-1",
  }));
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "git_repository_info") return { root, branch: "develop", state: "clean" };
    if (command === "git_status") return statuses;
    if (command === "git_remote_state") return { branch: "develop", upstream: "origin/develop", ahead, behind: 0, hasRemote: true };
    if (command === "list_workspace_directory") return [];
    return undefined;
  });
}

async function openGit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Git" }));
}

afterEach(() => cleanup());

describe("Git Changes layout A: header summary", () => {
  it("puts the status summary, with the ahead count, in the repository header", async () => {
    const user = userEvent.setup();
    setup([
      { path: "a.ts", kind: "modified", staged: true, unstaged: false },
      { path: "b.ts", kind: "modified", staged: false, unstaged: true },
      { path: "c.ts", kind: "modified", staged: false, unstaged: true },
    ], 3);
    render(<App />);
    await openGit(user);

    const summary = await screen.findByText("1 staged · 2 changes · ↑3");
    expect(summary.closest(".git-repository-toggle")).not.toBeNull();
  });

  it("omits the ahead part when nothing is waiting to be pushed", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], 0);
    render(<App />);
    await openGit(user);

    expect(await screen.findByText("0 staged · 1 changes")).toBeInTheDocument();
  });
});

describe("Git Changes layout A: commit box", () => {
  it("is not opened while nothing is staged, and shows a short hint instead", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], 0);
    render(<App />);
    await openGit(user);

    await screen.findByText("b.ts");
    expect(document.querySelector(".git-commit-box")).toBeNull();
    expect(document.querySelector(".git-commit-min")).toHaveTextContent("Stage a change to commit");
  });

  it("opens once a file is staged", async () => {
    const user = userEvent.setup();
    setup([{ path: "a.ts", kind: "modified", staged: true, unstaged: false }], 0);
    render(<App />);
    await openGit(user);

    await waitFor(() => expect(document.querySelector(".git-commit-box")).not.toBeNull());
    expect(document.querySelector(".git-commit-min")).toBeNull();
  });
});

describe("Git Changes layout A: toolbar and menu keep every action", () => {
  it("keeps Push visible and moves Fetch, Pull, New branch, Refresh and the view switch into the More menu", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], 2);
    render(<App />);
    await openGit(user);

    expect(await screen.findByRole("button", { name: "Push to remote" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Fetch from remote" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More git actions" }));
    const menu = await screen.findByRole("menu");
    for (const name of [/Fetch/, /Pull/, "New branch…", "Refresh", "Tree view"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("switches to tree view from the menu", async () => {
    const user = userEvent.setup();
    setup([
      { path: "src/ui/a.tsx", kind: "modified", staged: false, unstaged: true },
      { path: "src/ui/b.tsx", kind: "modified", staged: false, unstaged: true },
    ], 0);
    render(<App />);
    await openGit(user);

    await screen.findByText("src/ui/a.tsx");
    await user.click(screen.getByRole("button", { name: "More git actions" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Tree view" }));
    expect(await screen.findByRole("button", { name: "Collapse folder src/ui" })).toBeInTheDocument();
  });
});

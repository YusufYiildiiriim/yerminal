import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {}, onCloseRequested: async () => () => {}, destroy: async () => {} }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));

vi.mock("../../src/features/terminal/TerminalPane", () => ({
  default: () => <div data-testid="mock-terminal">Terminal Pane</div>,
}));

const rootPath = "C:\\repo";
const now = Math.floor(Date.now() / 1000);

const commits = [
  { id: "a".repeat(40), shortId: "aaaaaaaa", message: "Add graph view", author: "Yusuf", timestamp: now - 30 * 60, parents: ["b".repeat(40)], branches: ["develop", "origin/develop"] },
  { id: "b".repeat(40), shortId: "bbbbbbbb", message: "Fix branch list", author: "Yusuf", timestamp: now - 26 * 3600, parents: ["c".repeat(40)], branches: ["main"] },
  { id: "c".repeat(40), shortId: "cccccccc", message: "Initial setup", author: "Yusuf", timestamp: now - 3 * 86400 - 3600, parents: [], branches: [] },
];

const branches = [
  { name: "develop", isRemote: false, isHead: true, ahead: 2, behind: 0 },
  { name: "main", isRemote: false, isHead: false, ahead: null, behind: null },
  { name: "origin/develop", isRemote: true, isHead: false, ahead: null, behind: null },
  { name: "origin/main", isRemote: true, isHead: false, ahead: null, behind: null },
];

const files = [
  { path: "src/App.tsx", kind: "modified" },
  { path: "src/features/git/GitGraphView.tsx", kind: "added" },
];

const patch = "diff --git a/src/App.tsx b/src/App.tsx\n@@ -1 +1 @@\n-old line\n+new line\n";

function seedWorkspace() {
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath] }],
    activeId: "workspace-1",
  }));
}

type GitMockOptions = {
  repo?: boolean;
  history?: typeof commits;
  branchList?: typeof branches;
  failHistoryAt?: number;
  failDiff?: boolean;
};

function installGitMock(options: GitMockOptions = {}) {
  const history = options.history ?? commits;
  let failedOnce = false;
  vi.mocked(invoke).mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "terminal_output_snapshot") return { events: [] };
    if (command === "git_repository_info") return options.repo === false ? undefined : { root: rootPath, branch: "develop", state: "clean" };
    if (command === "git_history") {
      const skip = Number(args?.skip ?? 0);
      const limit = Number(args?.limit ?? 51);
      if (options.failHistoryAt !== undefined && skip === options.failHistoryAt && !failedOnce) {
        failedOnce = true;
        throw "history unavailable";
      }
      return history.slice(skip, skip + limit);
    }
    if (command === "git_branches") return options.branchList ?? branches;
    if (command === "git_commit_files") return files;
    if (command === "git_commit_file_diff") {
      if (options.failDiff) throw "diff unavailable";
      return patch;
    }
    if (command === "git_commit_file_content") return { content: "content", sourceLabel: "snapshot" };
    return undefined;
  });
}

async function openGitGraph(user: ReturnType<typeof userEvent.setup>) {
  const rail = screen.getByRole("navigation", { name: "Workspace tools" });
  await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  return rail;
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  seedWorkspace();
  vi.mocked(invoke).mockReset();
  installGitMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Git Graph lives in the side panel: branches, commits, and commit details under the commit", () => {
  it("opens the branch panel with the current branch expanded and keeps the editor in the main area", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = await openGitGraph(user);
    expect(screen.getByRole("tab", { name: "Git Graph" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("region", { name: "Commit graph" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Editor/));

    const panel = document.querySelector(".tools-panel") as HTMLElement;
    expect(within(panel).getByText("Branches")).toBeInTheDocument();
    expect(within(panel).getByText("Remotes")).toBeInTheDocument();
    const current = await within(panel).findByRole("button", { name: "develop" });
    await waitFor(() => expect(current).toHaveAttribute("aria-expanded", "true"));
    const list = await within(panel).findByRole("list", { name: "Commits on develop" });
    expect(await within(list).findByText("Add graph view")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("git_history", expect.objectContaining({ branch: "develop", skip: 0 }));
  });

  it("clicking a commit opens its message, author, date and changed files right under it, and clicking again closes them", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const list = await within(panel).findByRole("list", { name: "Commits on develop" });
    const commit = await within(list).findByRole("button", { name: /Add graph view/ });
    await user.click(commit);

    expect(commit).toHaveAttribute("aria-expanded", "true");
    const details = await within(list).findByRole("region", { name: "Details for Add graph view" });
    expect(commit.closest("li")?.contains(details)).toBe(true);
    expect(within(details).getByText("Yusuf")).toBeInTheDocument();
    expect(within(details).getByText("aaaaaaaa")).toBeInTheDocument();
    expect(await within(details).findByRole("button", { name: "src/App.tsx" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "src/features/git/GitGraphView.tsx" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("git_commit_files", { path: rootPath, commitId: "a".repeat(40) });
    expect(screen.queryByRole("region", { name: "Commit details" })).not.toBeInTheDocument();

    await user.click(commit);
    expect(commit).toHaveAttribute("aria-expanded", "false");
    expect(within(list).queryByRole("region", { name: "Details for Add graph view" })).not.toBeInTheDocument();
  });

  it("clicking a changed file opens what that commit changed in the editor, with added and removed lines marked", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const list = await within(panel).findByRole("list", { name: "Commits on develop" });
    await user.click(await within(list).findByRole("button", { name: /Add graph view/ }));
    const details = await within(list).findByRole("region", { name: "Details for Add graph view" });
    await user.click(await within(details).findByRole("button", { name: "src/App.tsx" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_commit_file_diff", { path: rootPath, commitId: "a".repeat(40), filePath: "src/App.tsx" }));
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Editor · App.tsx"));
    const diff = await screen.findByRole("region", { name: "File diff" });
    expect(within(diff).getByText("new line")).toBeInTheDocument();
    expect(within(diff).getByText("old line")).toBeInTheDocument();
    expect(diff.querySelector(".has-added")).toBeInTheDocument();
    expect(diff.querySelector(".has-removed")).toBeInTheDocument();
    expect(within(diff).getByText("aaaaaaaa")).toHaveClass("diff-view-side");
    expect(within(diff).queryByText("Working Tree")).not.toBeInTheDocument();
  });

  it("right-clicking a commit opens its details too", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    await user.click(await within(panel).findByRole("button", { name: "main" }));
    const list = await within(panel).findByRole("list", { name: "Commits on main" });
    fireEvent.contextMenu(await within(list).findByRole("button", { name: /Initial setup/ }));
    const details = await within(list).findByRole("region", { name: "Details for Initial setup" });
    expect(await within(details).findByRole("button", { name: "src/App.tsx" })).toBeInTheDocument();
  });

  it("shows an inline error under the commit when its files cannot be loaded", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const list = await within(panel).findByRole("list", { name: "Commits on develop" });
    await within(list).findByRole("button", { name: /Add graph view/ });
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "git_commit_files") throw "files unavailable";
      return undefined;
    });
    await user.click(within(list).getByRole("button", { name: /Add graph view/ }));
    const details = await within(list).findByRole("region", { name: "Details for Add graph view" });
    expect(await within(details).findByRole("alert")).toHaveTextContent("files unavailable");
  });

  it("clicking a branch expands its own commits under it and clicking again collapses them", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const branchButton = await within(panel).findByRole("button", { name: "main" });
    await user.click(branchButton);

    expect(branchButton).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_history", expect.objectContaining({ branch: "main", skip: 0 })));
    const list = await within(panel).findByRole("list", { name: "Commits on main" });
    expect(await within(list).findByText("Fix branch list")).toBeInTheDocument();

    await user.click(branchButton);
    expect(branchButton).toHaveAttribute("aria-expanded", "false");
    expect(within(panel).queryByRole("list", { name: "Commits on main" })).not.toBeInTheDocument();
  });

  it("Ctrl+Shift+B selects Git Graph in the rail", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    expect(screen.getByRole("tab", { name: "Git Graph" })).toHaveAttribute("aria-selected", "true");
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    expect(await within(panel).findByText("Branches")).toBeInTheDocument();
  });
});

describe("Git Graph repository picker", () => {
  it("lets the user pick which opened repository the graph shows", async () => {
    const otherPath = "C:\other-repo";
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath, folderPaths: [rootPath, otherPath] }],
      activeId: "workspace-1",
    }));
    const branchCalls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "terminal_output_snapshot") return { events: [] };
      if (command === "git_repository_info") return { root: args?.path, branch: args?.path === otherPath ? "trunk" : "develop", state: "clean" };
      if (command === "git_branches") { branchCalls.push(String(args?.path)); return branches; }
      if (command === "git_history") return commits;
      return undefined;
    });
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const picker = await screen.findByRole("combobox", { name: "Select repository" });
    await waitFor(() => expect(branchCalls).toContain(rootPath));
    await user.selectOptions(picker, otherPath);
    await waitFor(() => expect(branchCalls).toContain(otherPath));
  });
});

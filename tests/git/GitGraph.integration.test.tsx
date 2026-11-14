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
  await user.click(within(rail).getByRole("button", { name: "Git Graph" }));
  return rail;
}

async function selectBranchCommit(user: ReturnType<typeof userEvent.setup>, branch: string, commit: RegExp, how: "click" | "contextmenu" = "click") {
  const panel = document.querySelector(".tools-panel") as HTMLElement;
  let list = within(panel).queryByRole("list", { name: `Commits on ${branch}` });
  if (!list) {
    await user.click(await within(panel).findByRole("button", { name: branch }));
    list = await within(panel).findByRole("list", { name: `Commits on ${branch}` });
  }
  const row = await within(list).findByRole("button", { name: commit });
  if (how === "contextmenu") fireEvent.contextMenu(row);
  else await user.click(row);
  const graphView = await screen.findByRole("region", { name: "Commit graph" });
  const details = await within(graphView).findByRole("region", { name: "Commit details" });
  return { panel, list, graphView, details };
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

describe("Git Graph: branches on the left, file changes in the middle, commit details on the right", () => {
  it("opens with the branch panel, expands the current branch and shows no duplicate commit list in the middle", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = await openGitGraph(user);
    expect(within(rail).getByRole("button", { name: "Git Graph" })).toHaveAttribute("aria-pressed", "true");

    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    expect(within(graphView).getByText("Select a commit on the left to see its changes.")).toBeInTheDocument();
    expect(graphView.querySelector(".g-row")).toBeNull();
    expect(graphView.querySelector(".g-list")).toBeNull();

    const panel = document.querySelector(".tools-panel") as HTMLElement;
    expect(within(panel).getByText("Branches")).toBeInTheDocument();
    expect(within(panel).getByText("Remotes")).toBeInTheDocument();
    const current = await within(panel).findByRole("button", { name: "develop" });
    await waitFor(() => expect(current).toHaveAttribute("aria-expanded", "true"));
    const list = await within(panel).findByRole("list", { name: "Commits on develop" });
    expect(await within(list).findByText("Add graph view")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("git_history", expect.objectContaining({ branch: "develop", skip: 0 }));
  });

  it("shows the current branch in the breadcrumb, or Git Graph alone without a repository", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await openGitGraph(user);
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Git Graph · develop"));
    unmount();

    cleanup();
    localStorage.clear();
    seedWorkspace();
    installGitMock({ repo: false });
    render(<App />);
    await openGitGraph(userEvent.setup());
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Git Graph$/));
  });

  it("selecting a commit shows its details and files on the right and the first file diff in the middle", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const { graphView, details } = await selectBranchCommit(user, "develop", /Add graph view/);

    expect(within(details).getByRole("heading", { name: "Add graph view" })).toBeInTheDocument();
    expect(within(details).getByText("aaaaaaaa")).toBeInTheDocument();
    expect(await within(details).findByRole("button", { name: "src/App.tsx" })).toHaveAttribute("aria-pressed", "true");
    expect(invoke).toHaveBeenCalledWith("git_commit_files", { path: rootPath, commitId: "a".repeat(40) });

    const diff = await within(graphView).findByRole("region", { name: "File changes" });
    expect(details.contains(diff)).toBe(false);
    expect(invoke).toHaveBeenCalledWith("git_commit_file_diff", { path: rootPath, commitId: "a".repeat(40), filePath: "src/App.tsx" });
    expect(within(diff).getByText("new line")).toBeInTheDocument();
    expect(within(diff).getByText("old line")).toBeInTheDocument();
    expect(diff.querySelector(".diff-line.added")).toBeInTheDocument();
    expect(diff.querySelector(".diff-line.removed")).toBeInTheDocument();
  });

  it("clicking another changed file shows that file in the middle", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const { details } = await selectBranchCommit(user, "develop", /Add graph view/);
    const other = await within(details).findByRole("button", { name: "src/features/git/GitGraphView.tsx" });
    await user.click(other);
    expect(other).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_commit_file_diff", { path: rootPath, commitId: "a".repeat(40), filePath: "src/features/git/GitGraphView.tsx" }));
    expect(document.querySelector(".g-diff-head")).toHaveTextContent("src/features/git/GitGraphView.tsx");
  });

  it("Open in editor opens the shown file from the commit in the editor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const { graphView } = await selectBranchCommit(user, "develop", /Add graph view/);
    await user.click(await within(graphView).findByRole("button", { name: "Open src/App.tsx in editor" }));
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Editor/));
    expect(invoke).toHaveBeenCalledWith("git_commit_file_content", { path: rootPath, commitId: "a".repeat(40), filePath: "src/App.tsx" });
  });

  it("shows an inline error in the middle when the file diff fails", async () => {
    installGitMock({ failDiff: true });
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const { graphView } = await selectBranchCommit(user, "develop", /Add graph view/);
    const main = graphView.querySelector(".g-main") as HTMLElement;
    expect(await within(main).findByRole("alert")).toHaveTextContent("diff unavailable");
  });

  it("closing the details clears the selection and the middle goes back to its empty state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const { graphView, details } = await selectBranchCommit(user, "develop", /Add graph view/);
    await user.click(within(details).getByRole("button", { name: "Close commit details" }));
    expect(within(graphView).queryByRole("region", { name: "Commit details" })).not.toBeInTheDocument();
    expect(within(graphView).getByText("Select a commit on the left to see its changes.")).toBeInTheDocument();
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

  it("right-clicking a commit under a branch shows its changes too", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const { details } = await selectBranchCommit(user, "main", /Initial setup/, "contextmenu");
    expect(within(details).getByRole("heading", { name: "Initial setup" })).toBeInTheDocument();
    expect(await within(details).findByText("src/App.tsx")).toBeInTheDocument();
  });

  it("Ctrl+Shift+B opens the graph view", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Git Graph · develop"));
    expect(await screen.findByRole("region", { name: "Commit graph" })).toBeVisible();
  });
});

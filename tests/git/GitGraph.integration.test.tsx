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

async function openGraphWithCommitSelected(user: ReturnType<typeof userEvent.setup>, name = /Add graph view/) {
  render(<App />);
  await openGitGraph(user);
  const graphView = await screen.findByRole("region", { name: "Commit graph" });
  await user.click(await within(graphView).findByRole("button", { name }));
  const details = await within(graphView).findByRole("region", { name: "Commit details" });
  return { graphView, details };
}

function manyCommits(extra: (index: number) => Partial<typeof commits[number]> = () => ({})) {
  return Array.from({ length: 52 }, (_, index) => ({
    id: String(index).padStart(40, "0"),
    shortId: `c${String(index).padStart(7, "0")}`,
    message: `Commit ${index}`,
    author: "Yusuf",
    timestamp: now - index * 60,
    parents: [],
    branches: [],
    ...extra(index),
  }));
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

describe("Git Graph main view and branch panel", () => {
  it("opens the graph main view and the Branches side panel from the rail", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = await openGitGraph(user);

    expect(within(rail).getByRole("button", { name: "Git Graph" })).toHaveAttribute("aria-pressed", "true");
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    expect(graphView).toBeVisible();
    expect(await within(graphView).findByText("Add graph view")).toBeInTheDocument();

    const panel = document.querySelector(".tools-panel") as HTMLElement;
    const sideSection = within(panel).getByRole("region", { name: "Git Graph" });
    expect(within(sideSection).getByText("Branches")).toBeInTheDocument();
    expect(within(sideSection).getByText("Remotes")).toBeInTheDocument();
    expect(await within(sideSection).findByRole("button", { name: /^develop/ })).toBeInTheDocument();
    expect(within(sideSection).getByRole("button", { name: /origin\/develop/ })).toBeInTheDocument();
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

  it("renders each commit row with its hash, branch tag, message, author and relative time", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    const row = await within(graphView).findByRole("button", { name: /Add graph view/ });
    expect(within(row).getByText("aaaaaaaa")).toBeInTheDocument();
    expect(within(row).getByText("develop", { selector: ".tag" })).toBeInTheDocument();
    expect(within(row).getByText("Yusuf")).toBeInTheDocument();
    expect(within(row).getByText("30 min ago")).toBeInTheDocument();
    expect(within(graphView).getByText("3 commits")).toBeInTheDocument();
  });

  it("shows remote-tracking tags with a muted style next to local tags", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    const row = await within(graphView).findByRole("button", { name: /Add graph view/ });
    await waitFor(() => expect(within(row).getByText("origin/develop", { selector: ".tag" })).toHaveClass("remote"));
    expect(within(row).getByText("develop", { selector: ".tag" })).not.toHaveClass("remote");
  });

  it("selecting a commit opens its details with the changed files", async () => {
    const user = userEvent.setup();
    const { details, graphView } = await openGraphWithCommitSelected(user);
    expect(within(details).getByRole("heading", { name: "Add graph view" })).toBeInTheDocument();
    expect(within(details).getByText("aaaaaaaa")).toBeInTheDocument();
    expect(await within(details).findByRole("button", { name: "src/App.tsx" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "src/features/git/GitGraphView.tsx" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("git_commit_files", { path: rootPath, commitId: "a".repeat(40) });

    await user.click(within(details).getByRole("button", { name: "Close commit details" }));
    expect(within(graphView).queryByRole("region", { name: "Commit details" })).not.toBeInTheDocument();
  });

  it("clicking a changed file opens it from the commit in the editor", async () => {
    const user = userEvent.setup();
    const { details } = await openGraphWithCommitSelected(user);
    await user.click(await within(details).findByRole("button", { name: "src/App.tsx" }));

    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent(/^Editor/));
    expect(invoke).toHaveBeenCalledWith("git_commit_file_content", { path: rootPath, commitId: "a".repeat(40), filePath: "src/App.tsx" });
  });

  it("Show diff loads the commit file patch and renders its added and removed lines", async () => {
    const user = userEvent.setup();
    const { details } = await openGraphWithCommitSelected(user);
    await user.click(await within(details).findByRole("button", { name: "Show diff for src/App.tsx" }));

    const diff = await within(details).findByRole("region", { name: "File changes" });
    expect(invoke).toHaveBeenCalledWith("git_commit_file_diff", { path: rootPath, commitId: "a".repeat(40), filePath: "src/App.tsx" });
    expect(within(diff).getByText("new line")).toBeInTheDocument();
    expect(within(diff).getByText("old line")).toBeInTheDocument();
    expect(diff.querySelector(".diff-line.added")).toBeInTheDocument();
    expect(diff.querySelector(".diff-line.removed")).toBeInTheDocument();
  });

  it("shows an inline error when the commit file diff fails", async () => {
    installGitMock({ failDiff: true });
    const user = userEvent.setup();
    const { details } = await openGraphWithCommitSelected(user);
    await user.click(await within(details).findByRole("button", { name: "Show diff for src/App.tsx" }));
    expect(await within(details).findByRole("alert")).toHaveTextContent("diff unavailable");
  });

  it("Escape closes the details panel and returns focus to the selected commit row", async () => {
    const user = userEvent.setup();
    const { graphView } = await openGraphWithCommitSelected(user);
    const row = within(graphView).getByRole("button", { name: /Add graph view/ });
    row.focus();
    await user.keyboard("{Escape}");
    expect(within(graphView).queryByRole("region", { name: "Commit details" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("Home and End move the selection to the first and last loaded commits", async () => {
    const user = userEvent.setup();
    const { graphView } = await openGraphWithCommitSelected(user);
    const rows = within(graphView).getAllByRole("button", { name: /Initial setup|Fix branch list|Add graph view/ });
    rows[1].focus();
    await user.keyboard("{End}");
    expect(rows[2]).toHaveFocus();
    expect(rows[2]).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Home}");
    expect(rows[0]).toHaveFocus();
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("Refresh history reloads the commit list and branches", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await within(graphView).findByRole("button", { name: /Add graph view/ });
    vi.mocked(invoke).mockClear();
    await user.click(within(graphView).getByRole("button", { name: "Refresh history" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("git_history", { path: rootPath, skip: 0, limit: 51 }));
    expect(invoke).toHaveBeenCalledWith("git_branches", { path: rootPath });
  });

  it("clicking a local branch selects its tip commit in the main list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await within(graphView).findByRole("button", { name: /Add graph view/ });

    const panel = document.querySelector(".tools-panel") as HTMLElement;
    await user.click(await within(panel).findByRole("button", { name: "main" }));

    const tip = within(graphView).getByRole("button", { name: /Fix branch list/ });
    expect(tip).toHaveAttribute("aria-pressed", "true");
    expect(within(graphView).getByRole("button", { name: /Add graph view/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(graphView).getByRole("region", { name: "Commit details" })).toBeInTheDocument();
  });

  it("clicking a remote branch selects the commit that carries it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await within(graphView).findByRole("button", { name: /Add graph view/ });

    const panel = document.querySelector(".tools-panel") as HTMLElement;
    await user.click(await within(panel).findByRole("button", { name: /origin\/develop/ }));
    expect(within(graphView).getByRole("button", { name: /Add graph view/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(graphView).queryByText("Tip not in loaded history")).not.toBeInTheDocument();
  });

  it("notes when a branch tip is not in the loaded history", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await within(graphView).findByRole("button", { name: /Add graph view/ });
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    await user.click(await within(panel).findByRole("button", { name: /origin\/main/ }));
    expect(within(graphView).getByText("Tip not in loaded history")).toBeInTheDocument();
  });

  it("selects a branch tip that was outside the first page once Load more brings it in", async () => {
    const user = userEvent.setup();
    installGitMock({
      history: manyCommits((index) => (index === 51 ? { branches: ["feature/far"] } : {})),
      branchList: [...branches, { name: "feature/far", isRemote: false, isHead: false, ahead: null, behind: null }],
    });
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await waitFor(() => expect(graphView.querySelectorAll(".g-row")).toHaveLength(50));
    const panel = document.querySelector(".tools-panel") as HTMLElement;
    await user.click(await within(panel).findByRole("button", { name: "feature/far" }));
    expect(within(graphView).getByText("Tip not in loaded history")).toBeInTheDocument();

    await user.click(within(graphView).getByRole("button", { name: "Load more commits" }));
    await waitFor(() => expect(within(graphView).getByRole("button", { name: /Commit 51/ })).toHaveAttribute("aria-pressed", "true"));
    expect(within(graphView).queryByText("Tip not in loaded history")).not.toBeInTheDocument();
  });

  it("does not auto-load again after a scroll-triggered failure until Load more is clicked", async () => {
    const user = userEvent.setup();
    installGitMock({ history: manyCommits(), failHistoryAt: 50 });
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await waitFor(() => expect(graphView.querySelectorAll(".g-row")).toHaveLength(50));
    const list = graphView.querySelector(".g-list") as HTMLElement;
    const historyCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "git_history").length;

    fireEvent.scroll(list);
    await waitFor(() => expect(historyCalls()).toBe(2));
    await waitFor(() => expect(within(graphView).getByRole("button", { name: "Load more commits" })).toBeEnabled());

    fireEvent.scroll(list);
    fireEvent.scroll(list);
    expect(historyCalls()).toBe(2);

    await user.click(within(graphView).getByRole("button", { name: "Load more commits" }));
    await waitFor(() => expect(historyCalls()).toBe(3));
    await waitFor(() => expect(within(graphView).getByRole("button", { name: /Commit 51/ })).toBeInTheDocument());
  });

  it("loads the next page of commits from Load more", async () => {
    const user = userEvent.setup();
    installGitMock({ history: manyCommits() });
    render(<App />);
    await openGitGraph(user);
    const graphView = await screen.findByRole("region", { name: "Commit graph" });
    await user.click(await within(graphView).findByRole("button", { name: "Load more commits" }));
    await waitFor(() => expect(within(graphView).getByRole("button", { name: /Commit 51/ })).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("git_history", { path: rootPath, skip: 50, limit: 51 });
  });

  it("Ctrl+Shift+B opens the graph main view", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await waitFor(() => expect(document.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Git Graph · develop"));
    expect(await screen.findByRole("region", { name: "Commit graph" })).toBeVisible();
  });
});

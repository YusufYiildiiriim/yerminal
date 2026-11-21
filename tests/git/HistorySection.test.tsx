import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));

import { HistorySection } from "../../src/features/git/HistorySection";
import { HISTORY_OPEN_STORAGE_KEY } from "../../src/features/git/historyExpansion";

const now = Math.floor(Date.now() / 1000);
const file = { path: "src/app.ts", kind: "modified" };

function hashOf(index: number): string {
  return `${String(index).padStart(2, "0")}a1b2c3`;
}

function makeCommit(index: number) {
  return {
    id: `${hashOf(index)}${"0".repeat(32)}`,
    shortId: hashOf(index),
    message: `Pushed change ${index}`,
    author: "Test User",
    timestamp: now - (index + 1) * 3600,
    parents: [],
    branches: [],
  };
}

let serverHistory: ReturnType<typeof makeCommit>[] = [];
let upstream: string | null = "origin/develop";

function serve(skip: number, limit: number) {
  return { upstream, commits: serverHistory.slice(skip, skip + limit) };
}

function calls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

beforeEach(() => {
  invokeMock.mockReset();
  window.localStorage.removeItem(HISTORY_OPEN_STORAGE_KEY);
  serverHistory = Array.from({ length: 25 }, (_, index) => makeCommit(index));
  upstream = "origin/develop";
  invokeMock.mockImplementation(async (command: string, args?: { skip?: number; limit?: number }) => {
    if (command === "git_pushed_history") return serve(args?.skip ?? 0, args?.limit ?? 20);
    if (command === "git_commit_files") return [file];
    return undefined;
  });
});
afterEach(cleanup);

function renderSection(overrides: Partial<Parameters<typeof HistorySection>[0]> = {}) {
  const props = {
    repoPath: "C:/repo",
    repoKey: "c:/repo",
    branch: "develop",
    refreshKey: 0,
    onError: vi.fn(),
    onOpenFile: vi.fn(),
    ...overrides,
  };
  const view = render(<HistorySection {...props} />);
  return { ...view, props };
}

const historyToggle = () => screen.getByRole("button", { name: /^History/ });

describe("HistorySection", () => {
  it("stays collapsed by default and loads nothing until it is opened", () => {
    renderSection();

    expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
    expect(calls("git_pushed_history")).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Pushed commits" })).not.toBeInTheDocument();
  });

  it("loads the first 20 pushed commits on first open and pages the rest with Load more", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(historyToggle());
    const list = await screen.findByRole("list", { name: "Pushed commits" });
    expect(calls("git_pushed_history")[0][1]).toEqual({ path: "C:/repo", skip: 0, limit: 20 });
    expect(within(list).getAllByRole("button", { name: /^Pushed change/ })).toHaveLength(20);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("button", { name: /^Pushed change/ })).toHaveLength(25));
    expect(calls("git_pushed_history")[1][1]).toEqual({ path: "C:/repo", skip: 20, limit: 20 });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("shows the short hash and relative time of each commit but not its author", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(historyToggle());
    const list = await screen.findByRole("list", { name: "Pushed commits" });
    expect(within(list).getByText("01a1b2c")).toBeInTheDocument();
    expect(within(list).getByText("2 h ago")).toBeInTheDocument();
    expect(screen.queryByText("Test User")).not.toBeInTheDocument();
  });

  it("shows a loading note while the first page is in flight", async () => {
    const user = userEvent.setup();
    let respond!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    renderSection();

    await user.click(historyToggle());
    expect(await screen.findByRole("status")).toHaveTextContent("Loading history");

    await act(async () => { respond(serve(0, 20)); });
    expect(await screen.findByRole("list", { name: "Pushed commits" })).toBeInTheDocument();
  });

  it("explains a branch without an upstream instead of listing commits", async () => {
    const user = userEvent.setup();
    upstream = null;
    renderSection();

    await user.click(historyToggle());
    expect(await screen.findByText(/No upstream for this branch/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Pushed commits" })).not.toBeInTheDocument();
  });

  it("says so when the upstream has no commits yet", async () => {
    const user = userEvent.setup();
    serverHistory = [];
    renderSection();

    await user.click(historyToggle());
    expect(await screen.findByText("No pushed commits on origin/develop.")).toBeInTheDocument();
  });

  it("shows a failed page with a retry that loads it again", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementationOnce(async () => { throw "git unavailable"; });
    renderSection();

    await user.click(historyToggle());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("git unavailable");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Pushed commits" })).toBeInTheDocument();
    expect(calls("git_pushed_history")).toHaveLength(2);
  });

  it("opens a commit to list its files, then sends a picked file to the editor", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    renderSection({ onOpenFile });

    await user.click(historyToggle());
    await user.click(await screen.findByText("Pushed change 0"));
    expect(invokeMock).toHaveBeenCalledWith("git_commit_files", { path: "C:/repo", commitId: serverHistory[0].id });
    const files = await screen.findByRole("list", { name: `Changed files in ${hashOf(0)}` });
    expect(files.closest(".gb-files-scroll")).not.toBeNull();

    await user.click(await screen.findByRole("button", { name: "src/app.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ id: serverHistory[0].id }), file);
  });

  it("remembers the open state for each repository", async () => {
    const user = userEvent.setup();
    const first = renderSection({ repoKey: "c:/one" });

    await user.click(historyToggle());
    await screen.findByRole("list", { name: "Pushed commits" });
    expect(JSON.parse(window.localStorage.getItem(HISTORY_OPEN_STORAGE_KEY) ?? "[]")).toEqual(["c:/one"]);
    first.unmount();

    const reopened = renderSection({ repoKey: "c:/one" });
    expect(historyToggle()).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("list", { name: "Pushed commits" })).toBeInTheDocument();
    reopened.unmount();

    renderSection({ repoKey: "c:/two" });
    expect(historyToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("reloads the first page when the branch changes and keeps repositories apart", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderSection();
    await user.click(historyToggle());
    await screen.findByRole("list", { name: "Pushed commits" });

    rerender(<HistorySection {...props} branch="main" />);
    await waitFor(() => expect(calls("git_pushed_history")).toHaveLength(2));
    expect(calls("git_pushed_history")[1][1]).toEqual({ path: "C:/repo", skip: 0, limit: 20 });

    render(<HistorySection {...props} repoPath="C:/other" repoKey="c:/other" />);
    expect(calls("git_pushed_history")).toHaveLength(2);
  });

  it("reloads an open list after a refresh", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderSection();
    await user.click(historyToggle());
    await screen.findByRole("list", { name: "Pushed commits" });

    rerender(<HistorySection {...props} refreshKey={1} />);
    await waitFor(() => expect(calls("git_pushed_history")).toHaveLength(2));
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));

import { GitGraphBranches } from "../../src/features/git/GitGraphBranches";
import { HistorySection } from "../../src/features/git/HistorySection";
import { OutgoingCommits } from "../../src/features/git/OutgoingCommits";

const now = Math.floor(Date.now() / 1000);
const commit = { id: "a".repeat(40), shortId: "aaaaaaaa", message: "Add graph view", author: "Yusuf", timestamp: now - 30 * 60, parents: ["b".repeat(40)], branches: ["develop"] };

/** Commit-files requests stay in flight, so the changed-files wait is visible on screen. */
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "git_commit_files") return new Promise(() => {});
    if (command === "git_outgoing_commits") return [commit];
    if (command === "git_history") return [commit];
    if (command === "git_pushed_history") return { upstream: "origin/develop", commits: [commit] };
    if (command === "git_branches") return [{ name: "develop", isRemote: false, isHead: true, ahead: null, behind: null }];
    return undefined;
  });
});
afterEach(() => cleanup());

describe("commit changes wait centered in the Git panel", () => {
  it("Outgoing commits: the changed-files wait is a centered loading block", async () => {
    const user = userEvent.setup();
    render(<OutgoingCommits repoPath="C:/repo" refreshKey={0} onError={vi.fn()} onOpenFile={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Add graph view/ }));
    const wait = await screen.findByRole("status");
    expect(wait).toHaveTextContent("Loading changed files…");
    expect(wait).toHaveClass("loading-state", "is-centered");
  });

  it("History: the changed-files wait is a centered loading block", async () => {
    const user = userEvent.setup();
    render(<HistorySection repoPath="C:/repo" repoKey="c:/repo" branch="develop" onError={vi.fn()} onOpenFile={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^History/ }));
    await user.click(await screen.findByRole("button", { name: /Add graph view/ }));
    const wait = (await screen.findByText("Loading changed files…")).closest(".loading-state");
    expect(wait).toHaveClass("loading-state", "is-centered");
  });

  it("Git Graph: the changed-files wait under an opened commit is a centered loading block", async () => {
    const user = userEvent.setup();
    render(<GitGraphBranches repoPath="C:/repo" currentBranch="develop" onError={vi.fn()} onOpenFile={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "Commits on develop" });
    await user.click(await within(list).findByRole("button", { name: /Add graph view/ }));
    const wait = (await screen.findByText("Loading changed files…")).closest(".loading-state");
    expect(wait).toHaveClass("loading-state", "is-centered");
  });
});

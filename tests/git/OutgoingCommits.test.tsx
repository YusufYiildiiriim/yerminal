import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));

import { OutgoingCommits } from "../../src/features/git/OutgoingCommits";

const now = Math.floor(Date.now() / 1000);
const commit = { id: "a".repeat(40), shortId: "aaaaaaaa", message: "Add graph view", author: "Yusuf", timestamp: now - 30 * 60, parents: ["b".repeat(40)], branches: ["develop"] };
const file = { path: "src/app.ts", kind: "modified" };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "git_outgoing_commits") return [commit];
    if (command === "git_commit_files") return [file];
    return undefined;
  });
});
afterEach(cleanup);

describe("OutgoingCommits", () => {
  it("shows nothing when the branch has no commits ahead of its upstream", async () => {
    invokeMock.mockImplementation(async () => []);
    render(<OutgoingCommits repoPath="C:/repo" refreshKey={0} onError={vi.fn()} onOpenFile={vi.fn()} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_outgoing_commits", { path: "C:/repo" }));
    expect(screen.queryByRole("region", { name: "Outgoing commits" })).not.toBeInTheDocument();
  });

  it("lists each outgoing commit with its hash, subject, author and time", async () => {
    render(<OutgoingCommits repoPath="C:/repo" refreshKey={0} onError={vi.fn()} onOpenFile={vi.fn()} />);

    const region = await screen.findByRole("region", { name: "Outgoing commits" });
    expect(within(region).getByText("1")).toBeInTheDocument();
    expect(within(region).getByText("Add graph view")).toBeInTheDocument();
    expect(within(region).getByText("aaaaaaa")).toBeInTheDocument();
    expect(within(region).getByText("Yusuf")).toBeInTheDocument();
    expect(within(region).getByText("30 min ago")).toBeInTheDocument();
  });

  it("opens a commit to list its changed files, then sends a picked file to the editor", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(<OutgoingCommits repoPath="C:/repo" refreshKey={0} onError={vi.fn()} onOpenFile={onOpenFile} />);

    await user.click(await screen.findByRole("button", { name: /Add graph view/ }));
    expect(invokeMock).toHaveBeenCalledWith("git_commit_files", { path: "C:/repo", commitId: commit.id });
    await user.click(await screen.findByRole("button", { name: "src/app.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith(commit, file);
  });

  it("reports a failed load through onError", async () => {
    const onError = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_outgoing_commits") throw "git unavailable";
      return undefined;
    });
    render(<OutgoingCommits repoPath="C:/repo" refreshKey={0} onError={onError} onOpenFile={vi.fn()} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("git unavailable"));
    expect(screen.queryByRole("region", { name: "Outgoing commits" })).not.toBeInTheDocument();
  });
});

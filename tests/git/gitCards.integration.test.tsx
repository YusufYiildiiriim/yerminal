import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const root = "C:\\repo";
type Status = { path: string; kind: string; staged: boolean; unstaged: boolean };
type Remote = { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean };

function setup(statuses: Status[], remote: Remote | undefined, outgoing: unknown[] = []) {
  localStorage.clear();
  localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
    workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root] }],
    activeId: "workspace-1",
  }));
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "git_repository_info") return { root, branch: "develop", state: "clean" };
    if (command === "git_status") return statuses;
    if (command === "git_remote_state") return remote;
    if (command === "git_outgoing_commits") return outgoing;
    if (command === "list_workspace_directory") return [];
    return undefined;
  });
}

async function openGit(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Git" }));
}

afterEach(() => cleanup());

const published: Remote = { branch: "develop", upstream: "origin/develop", ahead: 0, behind: 0, hasRemote: true };

describe("Git Changes section cards: structure", () => {
  it("renders Staged, Changes and Outgoing as cards with a header band and a body", async () => {
    const user = userEvent.setup();
    setup([
      { path: "a.ts", kind: "modified", staged: true, unstaged: false },
      { path: "b.ts", kind: "modified", staged: false, unstaged: true },
    ], { ...published, ahead: 1 }, [{ id: "d".repeat(40), shortId: "ddddddd", message: "Pending", author: "Test", timestamp: 1700000000, parents: [], branches: [] }]);
    await openGit(user);

    for (const name of ["Staged changes", "Changes", "Outgoing commits"]) {
      const card = await screen.findByRole("region", { name });
      expect(card).toHaveClass("git-card");
      const band = within(card).getByRole("button", { expanded: true, name: new RegExp(name.split(" ")[0], "i") });
      expect(band).toHaveClass("git-card-band");
      expect(card.querySelector(".git-card-body")).not.toBeNull();
    }
  });

  it("hides cards that have nothing to show", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], published, []);
    await openGit(user);

    await screen.findByRole("region", { name: "Changes" });
    expect(screen.queryByRole("region", { name: "Staged changes" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Outgoing commits" })).toBeNull();
  });

  it("does not render a Changes card when only staged changes exist", async () => {
    const user = userEvent.setup();
    setup([{ path: "a.ts", kind: "modified", staged: true, unstaged: false }], published, []);
    await openGit(user);

    await screen.findByRole("region", { name: "Staged changes" });
    expect(screen.queryByRole("region", { name: "Changes" })).toBeNull();
  });
});

describe("Git Changes section cards: collapse and keyboard", () => {
  it("collapses a card from its band and expands it again", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], published, []);
    await openGit(user);

    const card = await screen.findByRole("region", { name: "Changes" });
    const band = within(card).getByRole("button", { name: /Changes/ });
    await user.click(band);
    expect(band).toHaveAttribute("aria-expanded", "false");
    expect(card).toHaveClass("is-collapsed");
    expect(card.querySelector(".git-card-body")).toHaveAttribute("hidden");

    await user.click(band);
    expect(band).toHaveAttribute("aria-expanded", "true");
    expect(card.querySelector(".git-card-body")).not.toHaveAttribute("hidden");
  });

  it("toggles a card with the keyboard, Enter and Space on the focused band", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], published, []);
    await openGit(user);

    const card = await screen.findByRole("region", { name: "Changes" });
    const band = within(card).getByRole("button", { name: /Changes/ });
    band.focus();
    await user.keyboard("{Enter}");
    expect(band).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(band).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the card body as the inner scroll area", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], published, []);
    await openGit(user);

    const card = await screen.findByRole("region", { name: "Changes" });
    expect(card.querySelector(".git-card-body")).toHaveClass("git-card-scroll");
  });
});

describe("Git Changes section cards: action row", () => {
  it("shows Push only when there is something to push", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], published, []);
    await openGit(user);

    await screen.findByRole("region", { name: "Changes" });
    expect(screen.queryByRole("button", { name: "Push to remote" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More git actions" }));
    expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "New branch…" })).toBeInTheDocument();
  });

  it("shows Push with its count when commits are waiting", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], { ...published, ahead: 3 }, []);
    await openGit(user);

    expect(await screen.findByRole("button", { name: "Push to remote" })).toBeEnabled();
    expect(screen.getByLabelText("3 commits to push")).toHaveTextContent("3");
  });

  it("offers Publish for a branch without an upstream", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], { branch: "feature", upstream: null, ahead: 0, behind: 0, hasRemote: true }, []);
    await openGit(user);

    expect(await screen.findByRole("button", { name: "Publish branch" })).toBeInTheDocument();
  });

  it("removes the plus button and the repository branch chip; the branch picker stays", async () => {
    const user = userEvent.setup();
    setup([{ path: "b.ts", kind: "modified", staged: false, unstaged: true }], published, []);
    await openGit(user);

    await screen.findByRole("region", { name: "Changes" });
    expect(screen.queryByRole("button", { name: "Create new branch" })).toBeNull();
    expect(document.querySelector(".git-repository-branch")).toBeNull();
    expect(screen.getByRole("button", { name: /Switch branch/ })).toBeInTheDocument();
  });

  it("keeps the repository name and the summary on one header row", async () => {
    const user = userEvent.setup();
    setup([{ path: "a.ts", kind: "modified", staged: true, unstaged: false }], { ...published, ahead: 2 }, []);
    await openGit(user);

    const summary = await screen.findByText("1 staged · 0 changes · ↑2");
    expect(summary.closest(".git-repository-toggle")?.querySelector(".git-repository-name strong")).toHaveTextContent("repo");
    await waitFor(() => expect(summary).toBeVisible());
  });
});

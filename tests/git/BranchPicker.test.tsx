import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { BranchPicker } from "../../src/features/git/BranchPicker";

const BRANCHES = [
  { name: "main", isRemote: false, isHead: true, ahead: 1, behind: 0, upstream: "origin/main" },
  { name: "feature/login", isRemote: false, isHead: false, ahead: null, behind: null, upstream: null },
  { name: "origin/main", isRemote: true, isHead: false, ahead: null, behind: null },
  { name: "origin/release", isRemote: true, isHead: false, ahead: null, behind: null },
];

function setup(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (overrides[command]) return overrides[command](args);
    if (command === "git_branches") return BRANCHES;
    return undefined;
  });
  const view = render(<BranchPicker repoPath="C:/repo" currentBranch="main" onChanged={onChanged} onError={onError} />);
  return { onChanged, onError, view };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Switch branch, current main" }));
  return screen.findByRole("dialog", { name: "Branches" });
}

describe("BranchPicker", () => {
  beforeEach(() => tauri.invoke.mockReset());
  afterEach(cleanup);

  it("lists local and remote branches, filters them by search, and marks the current one", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openPicker(user);
    await within(dialog).findByRole("button", { name: "Checkout origin/release" });
    expect(within(dialog).getByRole("button", { name: "Checkout main" })).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox", { name: "Search branches" }), "rel");
    expect(within(dialog).queryByRole("button", { name: "Checkout feature/login" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Checkout origin/release" })).toBeInTheDocument();
  });

  it("switches branch through git_checkout_branch, reports the change and closes", async () => {
    const user = userEvent.setup();
    const { onChanged } = setup();
    const dialog = await openPicker(user);
    await user.click(await within(dialog).findByRole("button", { name: "Checkout feature/login" }));

    expect(tauri.invoke).toHaveBeenCalledWith("git_checkout_branch", { path: "C:/repo", name: "feature/login" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Branches" })).not.toBeInTheDocument();
  });

  it("creates a branch from the current one and checks it out", async () => {
    const user = userEvent.setup();
    const { onChanged } = setup();
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole("button", { name: /New branch from main/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "New branch name" }), "fix/typo{Enter}");

    expect(tauri.invoke).toHaveBeenCalledWith("git_create_branch", { path: "C:/repo", name: "fix/typo", from: null, checkout: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows the backend error (for example a dirty working tree) without closing the picker", async () => {
    const user = userEvent.setup();
    const { onError, onChanged } = setup({
      git_checkout_branch: () => { throw "Your local changes would be overwritten. Commit or stash them first"; },
    });
    const dialog = await openPicker(user);
    await user.click(await within(dialog).findByRole("button", { name: "Checkout feature/login" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("local changes")));
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Branches" })).toBeInTheDocument();
  });

  it("asks before force-deleting an unmerged branch", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { onError } = setup({
      git_delete_branch: (args) => {
        attempts += 1;
        if (!args.force) throw "Branch 'feature/login' is not fully merged";
        return undefined;
      },
    });
    const dialog = await openPicker(user);
    await user.click(await within(dialog).findByRole("button", { name: "Delete feature/login" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Not fully merged");
    expect(onError).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole("button", { name: "Force delete" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_delete_branch", { path: "C:/repo", name: "feature/login", force: true }));
    expect(attempts).toBe(2);
  });

  it("renames a local branch and never offers delete for the checked-out one", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openPicker(user);
    expect(within(dialog).queryByRole("button", { name: "Delete main" })).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "Rename feature/login" }));
    const input = within(dialog).getByRole("textbox", { name: "New name for feature/login" });
    await user.clear(input);
    await user.type(input, "feature/signin{Enter}");

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_rename_branch", { path: "C:/repo", oldName: "feature/login", newName: "feature/signin" }));
  });
});

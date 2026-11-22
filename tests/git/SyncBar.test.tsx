import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { SyncBar } from "../../src/features/git/SyncBar";

type State = { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean };

function setup(state: State | undefined, ops: Record<string, () => unknown> = {}) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "git_remote_state") return state;
    if (ops[command]) return ops[command]();
    return undefined;
  });
  render(<SyncBar repoPath="C:/repo" refreshKey={0} onChanged={onChanged} onError={onError} />);
  return { onChanged, onError };
}

async function menuItem(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(await screen.findByRole("button", { name: "More git actions" }));
  const menu = await screen.findByRole("menu");
  return within(menu).getByRole("menuitem", { name });
}

describe("SyncBar", () => {
  beforeEach(() => tauri.invoke.mockReset());
  afterEach(cleanup);

  it("shows only the More menu, without Push, when the repository has no remote", async () => {
    setup({ branch: "main", upstream: null, ahead: 0, behind: 0, hasRemote: false });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_remote_state", { path: "C:/repo" }));
    expect(await screen.findByRole("button", { name: "More git actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Push to remote|Publish branch/ })).toBeNull();
  });

  it("shows how many commits are waiting to push, and how many to pull inside the menu", async () => {
    const user = userEvent.setup();
    setup({ branch: "main", upstream: "origin/main", ahead: 2, behind: 3, hasRemote: true });
    expect((await screen.findByLabelText("2 commits to push")).textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Push to remote" })).toBeEnabled();
    expect(await menuItem(user, /Pull ↓3/)).toBeEnabled();
  });

  it("offers to publish an unpublished branch and disables pull until then", async () => {
    const user = userEvent.setup();
    const { onChanged, onError } = setup({ branch: "feature", upstream: null, ahead: 0, behind: 0, hasRemote: true }, { git_push: () => "Published feature to origin" });
    const publish = await screen.findByRole("button", { name: "Publish branch" });
    expect(await menuItem(user, /Pull/)).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(publish);
    expect(tauri.invoke).toHaveBeenCalledWith("git_push", { path: "C:/repo" });
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Publish: Published feature to origin"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("hides push when there is nothing to push, and fetch/pull from the menu report their result", async () => {
    const user = userEvent.setup();
    const { onError } = setup({ branch: "main", upstream: "origin/main", ahead: 0, behind: 1, hasRemote: true }, { git_fetch: () => "Already up to date", git_pull: () => "Fast-forward" });
    await screen.findByRole("button", { name: "More git actions" });
    expect(screen.queryByRole("button", { name: "Push to remote" })).toBeNull();
    await user.click(await menuItem(user, /Fetch/));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Fetch: Already up to date"));
    await user.click(await menuItem(user, /Pull/));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Pull: Fast-forward"));
  });

  it("surfaces a failed operation and still refreshes", async () => {
    const user = userEvent.setup();
    const { onChanged, onError } = setup({ branch: "main", upstream: "origin/main", ahead: 0, behind: 1, hasRemote: true }, {
      git_pull: () => { throw "Your local changes would be overwritten by merge"; },
    });
    await user.click(await menuItem(user, /Pull/));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("Pull failed: Your local changes")));
    expect(onChanged).toHaveBeenCalled();
  });
});

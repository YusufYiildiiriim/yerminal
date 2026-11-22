import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { SyncBar } from "../../src/features/git/SyncBar";

type State = { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean };

function setup(state: State | undefined, ops: Record<string, () => unknown> = {}, extra: Partial<Parameters<typeof SyncBar>[0]> = {}) {
  const props = { onChanged: vi.fn(), onError: vi.fn(), onNewBranch: vi.fn(), onRefresh: vi.fn(), onAheadChange: vi.fn(), onViewChange: vi.fn(), view: "list" as const, ...extra };
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "git_remote_state") return state;
    if (ops[command]) return ops[command]();
    return undefined;
  });
  render(<SyncBar repoPath="C:/repo" refreshKey={0} {...props} />);
  return props;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More git actions" }));
  return screen.getByRole("menu");
}

describe("SyncBar action menu", () => {
  beforeEach(() => tauri.invoke.mockReset());
  afterEach(cleanup);

  it("keeps the More button, New branch, Refresh and the view switch when the repository has no remote", async () => {
    const user = userEvent.setup();
    setup({ branch: "main", upstream: null, ahead: 0, behind: 0, hasRemote: false });
    const menu = await openMenu(user);
    expect(within(menu).queryByRole("menuitem", { name: /Fetch/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "New branch…" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Tree view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Push to remote|Publish branch/ })).toBeNull();
  });

  it("shows Push with its count outside the menu, and Fetch, Pull with its count inside it", async () => {
    const user = userEvent.setup();
    setup({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, hasRemote: true });
    expect((await screen.findByLabelText("2 commits to push")).textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Push to remote" })).toBeEnabled();
    const menu = await openMenu(user);
    expect(within(menu).getByRole("menuitem", { name: /Fetch/ })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: /Pull.*1/ })).toBeEnabled();
  });

  it("offers Publish instead of Push and disables Pull in the menu until the branch is published", async () => {
    const user = userEvent.setup();
    setup({ branch: "feature", upstream: null, ahead: 0, behind: 0, hasRemote: true });
    expect(await screen.findByRole("button", { name: "Publish branch" })).toBeEnabled();
    const menu = await openMenu(user);
    expect(within(menu).getByRole("menuitem", { name: /Pull/ })).toBeDisabled();
  });

  it("opens with the keyboard, moves focus into the menu, and Escape closes it and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    setup({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true });
    const trigger = await screen.findByRole("button", { name: "More git actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Fetch/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("runs Fetch from the menu and reports its result", async () => {
    const user = userEvent.setup();
    const { onError } = setup({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true }, { git_fetch: () => "Already up to date" });
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: /Fetch/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Fetch: Already up to date"));
  });

  it("routes New branch…, Refresh and the view switch to the parent", async () => {
    const user = userEvent.setup();
    const props = setup({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true });
    let menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "New branch…" }));
    expect(props.onNewBranch).toHaveBeenCalledTimes(1);

    menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Refresh" }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);

    menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Tree view" }));
    expect(props.onViewChange).toHaveBeenCalledWith("tree");
  });

  it("reports the ahead count to the repository header", async () => {
    const props = setup({ branch: "main", upstream: "origin/main", ahead: 4, behind: 0, hasRemote: true });
    await waitFor(() => expect(props.onAheadChange).toHaveBeenCalledWith(4));
  });
});

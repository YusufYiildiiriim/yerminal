import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { SyncBar } from "../../src/features/git/SyncBar";

type State = { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean };
const SIGNED_IN = { installed: true, loggedIn: true, login: "octocat" };

function setup(state: State | undefined, ops: Record<string, () => unknown> = {}, github: unknown = SIGNED_IN) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "git_remote_state") return state;
    if (command === "git_github_status") return github;
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

const NO_REMOTE: State = { branch: "main", upstream: null, ahead: 0, behind: 0, hasRemote: false };

describe("SyncBar", () => {
  beforeEach(() => tauri.invoke.mockReset());
  afterEach(cleanup);

  it("shows Publish without a remote, and it opens the publish dialog instead of pushing", async () => {
    const user = userEvent.setup();
    setup(NO_REMOTE);
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_remote_state", { path: "C:/repo" }));
    expect(await screen.findByRole("button", { name: "Publish branch" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Push to remote" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Publish branch" }));
    expect(await screen.findByRole("dialog", { name: "Publish main" })).toBeInTheDocument();
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_push", expect.anything());
  });

  it("creates a private GitHub repository named after the folder and reports the result", async () => {
    const user = userEvent.setup();
    const { onChanged, onError } = setup(NO_REMOTE, { git_create_github_repo: () => "Created repo on GitHub and published main" });
    await user.click(await screen.findByRole("button", { name: "Publish branch" }));
    expect(await screen.findByLabelText("Repository name")).toHaveValue("repo");
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(tauri.invoke).toHaveBeenCalledWith("git_create_github_repo", { path: "C:/repo", name: "repo", public: false });
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Publish: Created repo on GitHub and published main"));
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a public repository only after the public warning is shown", async () => {
    const user = userEvent.setup();
    setup(NO_REMOTE, { git_create_github_repo: () => "Created repo on GitHub and published main" });
    await user.click(await screen.findByRole("button", { name: "Publish branch" }));
    await user.click(await screen.findByRole("radio", { name: "Public" }));
    expect(screen.getByText("Anyone on the internet can see this repository.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish publicly" }));
    expect(tauri.invoke).toHaveBeenCalledWith("git_create_github_repo", { path: "C:/repo", name: "repo", public: true });
  });

  it("publishes through an existing remote URL, with an editable remote name", async () => {
    const user = userEvent.setup();
    const { onError } = setup(NO_REMOTE, { git_add_remote_publish: () => "Published main to upstream" });
    await user.click(await screen.findByRole("button", { name: "Publish branch" }));
    await user.click(await screen.findByRole("radio", { name: "Use existing remote URL" }));
    const name = screen.getByLabelText("Remote name");
    expect(name).toHaveValue("origin");
    await user.clear(name);
    await user.type(name, "upstream");
    await user.type(screen.getByLabelText("Remote URL"), "git@github.com:owner/repo.git");
    await user.click(screen.getByRole("button", { name: "Add remote and publish" }));
    expect(tauri.invoke).toHaveBeenCalledWith("git_add_remote_publish", { path: "C:/repo", name: "upstream", url: "git@github.com:owner/repo.git" });
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Publish: Published main to upstream"));
  });

  it("falls back to the URL mode when gh is missing, and does not create anything on GitHub", async () => {
    const user = userEvent.setup();
    setup(NO_REMOTE, {}, { installed: false, loggedIn: false, login: null });
    await user.click(await screen.findByRole("button", { name: "Publish branch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub CLI not found");
    expect(screen.getByRole("radio", { name: "Use existing remote URL" })).toBeChecked();
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_create_github_repo", expect.anything());
  });

  it("does not run anything when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    setup(NO_REMOTE);
    await user.click(await screen.findByRole("button", { name: "Publish branch" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_create_github_repo", expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_add_remote_publish", expect.anything());
  });

  it("reports a failed GitHub publish that left the repository created, and still refreshes", async () => {
    const user = userEvent.setup();
    const { onChanged, onError } = setup(NO_REMOTE, {
      git_create_github_repo: () => { throw "Repository created on GitHub and origin added, but publishing failed: fatal: Authentication failed"; },
    });
    await user.click(await screen.findByRole("button", { name: "Publish branch" }));
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("Publish failed: Repository created on GitHub")));
    expect(onChanged).toHaveBeenCalled();
  });

  it("disables Publish on a detached HEAD without a remote", async () => {
    setup({ branch: null, upstream: null, ahead: 0, behind: 0, hasRemote: false });
    expect(await screen.findByRole("button", { name: "Publish branch" })).toBeDisabled();
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
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_create_github_repo", expect.anything());
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

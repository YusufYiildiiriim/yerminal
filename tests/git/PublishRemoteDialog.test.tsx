import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishRemoteDialog, type GithubAccount } from "../../src/features/git/PublishRemoteDialog";

const READY: GithubAccount = { installed: true, loggedIn: true, login: "octocat" };

function setup(account: GithubAccount | null = READY) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<PublishRemoteDialog branch="main" defaultRepoName="repo" account={account} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

describe("PublishRemoteDialog", () => {
  afterEach(cleanup);

  it("defaults to a private GitHub repository named after the folder, under the signed-in account", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Publish main" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Create GitHub repository" })).toBeChecked();
    expect(screen.getByLabelText("Repository name")).toHaveValue("repo");
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    expect(screen.getByText(/octocat/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("submits the trimmed repository name with public false by default", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const name = screen.getByLabelText("Repository name");
    await user.clear(name);
    await user.type(name, "  my-repo  ");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "github", name: "my-repo", public: false });
  });

  it("rejects a repository name with spaces or a slash and does not submit", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const name = screen.getByLabelText("Repository name");
    await user.clear(name);
    await user.type(name, "owner/my repo");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Repository name/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("switches the button to Publish publicly and shows a warning when Public is chosen", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole("radio", { name: "Public" }));
    expect(screen.getByText("Anyone on the internet can see this repository.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish publicly" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "github", name: "repo", public: true });
  });

  it("keeps the GitHub submit disabled while the account is still being checked", () => {
    setup(null);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("falls back to the URL mode with an error when gh is not installed", () => {
    setup({ installed: false, loggedIn: false, login: null });
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub CLI not found");
    expect(screen.getByRole("radio", { name: "Use existing remote URL" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Create GitHub repository" })).toBeDisabled();
  });

  it("tells the user to run gh auth login when gh is installed but not signed in", () => {
    setup({ installed: true, loggedIn: false, login: null });
    expect(screen.getByRole("alert")).toHaveTextContent("gh auth login");
    expect(screen.getByRole("radio", { name: "Use existing remote URL" })).toBeChecked();
  });

  it("URL mode submits the remote name (origin by default) and the trimmed URL", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole("radio", { name: "Use existing remote URL" }));
    expect(screen.getByLabelText("Remote name")).toHaveValue("origin");
    await user.type(screen.getByLabelText("Remote URL"), "  https://github.com/owner/repo.git  ");
    await user.click(screen.getByRole("button", { name: "Add remote and publish" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "url", name: "origin", url: "https://github.com/owner/repo.git" });
  });

  it("URL mode shows an inline error for a missing or unsupported URL and does not submit", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole("radio", { name: "Use existing remote URL" }));
    await user.click(screen.getByRole("button", { name: "Add remote and publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/URL/);
    await user.type(screen.getByLabelText("Remote URL"), "not a url");
    await user.click(screen.getByRole("button", { name: "Add remote and publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/https:\/\/|ssh|git@/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("URL mode rejects a remote name that starts with a dash", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole("radio", { name: "Use existing remote URL" }));
    const name = screen.getByLabelText("Remote name");
    await user.clear(name);
    await user.type(name, "-x");
    await user.type(screen.getByLabelText("Remote URL"), "https://github.com/owner/repo.git");
    await user.click(screen.getByRole("button", { name: "Add remote and publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Remote name/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on the Cancel button and on Escape", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("portals into the app shell, so the theme tokens resolve, and out of the sync bar tree", () => {
    // Theme tokens are declared on .app-shell[data-theme] only, so the backdrop must render inside it.
    const shell = document.createElement("main");
    shell.className = "app-shell";
    shell.setAttribute("data-theme", "foundry");
    const bar = document.createElement("div");
    bar.className = "sync-bar";
    shell.appendChild(bar);
    document.body.appendChild(shell);
    try {
      render(<PublishRemoteDialog branch="main" defaultRepoName="repo" account={READY} onSubmit={vi.fn()} onCancel={vi.fn()} />, { container: bar });
      const backdrop = document.querySelector<HTMLElement>(".publish-remote-backdrop");
      expect(backdrop).not.toBeNull();
      expect(backdrop?.parentElement).toBe(shell);
      expect(bar.contains(backdrop)).toBe(false);
    } finally {
      shell.remove();
    }
  });
});

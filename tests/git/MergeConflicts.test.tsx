import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { MergeConflicts } from "../../src/features/git/MergeConflicts";

function setup(props: Partial<React.ComponentProps<typeof MergeConflicts>> = {}, failing: Record<string, string> = {}) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  const onOpenFile = vi.fn();
  tauri.invoke.mockImplementation(async (command: string) => {
    if (failing[command]) throw failing[command];
    if (command === "git_merge_message") return "Merge branch 'other'";
    if (command === "git_commit_staged") return "abcdef1234567890";
    return undefined;
  });
  render(<MergeConflicts repoPath="C:/repo" merging conflicts={["a.txt", "src/b.ts"]} onChanged={onChanged} onError={onError} onOpenFile={onOpenFile} {...props} />);
  return { onChanged, onError, onOpenFile };
}

describe("MergeConflicts", () => {
  beforeEach(() => tauri.invoke.mockReset());
  afterEach(cleanup);

  it("renders nothing outside a merge", () => {
    setup({ merging: false, conflicts: [] });
    expect(screen.queryByRole("region", { name: "Merge in progress" })).not.toBeInTheDocument();
  });

  it("lists conflicts, opens a file, and keeps Commit merge disabled while conflicts remain", async () => {
    const user = userEvent.setup();
    const { onOpenFile } = setup();
    expect(screen.getByText("2 conflicts to resolve")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit merge" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open src/b.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/b.ts");
  });

  it("resolves a file with ours, theirs or as edited, then asks the parent to refresh", async () => {
    const user = userEvent.setup();
    const { onChanged } = setup();
    await user.click(screen.getByRole("button", { name: "Take ours for a.txt" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_resolve_conflict", { path: "C:/repo", filePath: "a.txt", side: "ours" }));
    await user.click(screen.getByRole("button", { name: "Take theirs for src/b.ts" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_resolve_conflict", { path: "C:/repo", filePath: "src/b.ts", side: "theirs" }));
    await user.click(screen.getByRole("button", { name: "Mark a.txt as resolved" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_resolve_conflict", { path: "C:/repo", filePath: "a.txt", side: "merged" }));
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it("surfaces a refusal (conflict markers left in the file) instead of refreshing", async () => {
    const user = userEvent.setup();
    const { onChanged, onError } = setup({}, { git_resolve_conflict: "Conflict markers are still in the file" });
    await user.click(screen.getByRole("button", { name: "Mark a.txt as resolved" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("Conflict markers are still in the file")));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("commits the merge with the prepared message once every conflict is resolved", async () => {
    const user = userEvent.setup();
    const { onChanged, onError } = setup({ conflicts: [] });
    expect(screen.getByText("All conflicts resolved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Commit merge" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_commit_staged", { path: "C:/repo", message: "Merge branch 'other'" }));
    expect(onError).toHaveBeenCalledWith("Created merge commit abcdef1");
    expect(onChanged).toHaveBeenCalled();
  });

  it("asks for confirmation before aborting the merge", async () => {
    const user = userEvent.setup();
    const { onChanged } = setup();
    await user.click(screen.getByRole("button", { name: "Abort merge…" }));
    expect(tauri.invoke).not.toHaveBeenCalledWith("git_merge_abort", expect.anything());
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Abort merge…" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abort merge…" }));
    await user.click(screen.getByRole("button", { name: "Abort merge" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("git_merge_abort", { path: "C:/repo" }));
    expect(onChanged).toHaveBeenCalled();
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { BranchPicker } from "../../src/features/git/BranchPicker";

const branches = [
  { name: "develop", isHead: true, isRemote: false, upstream: "origin/develop", ahead: 0, behind: 0, lastCommit: 0 },
  { name: "feature", isHead: false, isRemote: false, upstream: null, ahead: 0, behind: 0, lastCommit: 0 },
];

function renderPicker() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = render(<BranchPicker repoPath="C:/repo" currentBranch="develop" onChanged={vi.fn()} onError={vi.fn()} showCreate={false} />, { container: host });
  return { host, ...view };
}

describe("BranchPicker popover is an overlay", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => (command === "git_branches" ? branches : undefined));
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("renders the popover outside the picker's own DOM, so the surrounding row does not grow", async () => {
    const user = userEvent.setup();
    const { host } = renderPicker();
    const before = host.querySelector(".branch-picker")!.getBoundingClientRect().height;
    await user.click(screen.getByRole("button", { name: /Switch branch/ }));
    const dialog = await screen.findByRole("dialog", { name: "Branches" });

    expect(host.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(host.querySelectorAll(".bp-popover")).toHaveLength(0);
    expect(host.querySelector(".branch-picker")!.getBoundingClientRect().height).toBe(before);
  });

  it("places the popover with inline coordinates from the trigger", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: /Switch branch/ }));
    const dialog = await screen.findByRole("dialog", { name: "Branches" });

    expect(dialog.style.position).toBe("");
    expect(dialog.style.width).toMatch(/^\d+(\.\d+)?px$/);
    expect(dialog.style.maxHeight).toMatch(/^\d+(\.\d+)?px$/);
    expect(dialog.style.top !== "" || dialog.style.bottom !== "").toBe(true);
  });

  it("closes on Escape and returns the trigger's expanded state to false", async () => {
    const user = userEvent.setup();
    renderPicker();
    const trigger = screen.getByRole("button", { name: /Switch branch/ });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Branches" });
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Branches" })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on an outside pointer press", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: /Switch branch/ }));
    await screen.findByRole("dialog", { name: "Branches" });
    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Branches" })).toBeNull());
  });

  it("keeps the popover open for presses inside it, such as the search field", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: /Switch branch/ }));
    const dialog = await screen.findByRole("dialog", { name: "Branches" });
    await user.click(screen.getByRole("textbox", { name: "Search branches" }));

    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search branches" })).toHaveFocus();
  });
});

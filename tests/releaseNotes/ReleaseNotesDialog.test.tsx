import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl, revealItemInDir: vi.fn() }));

import { ReleaseNotesDialog } from "../../src/features/releaseNotes/ReleaseNotesDialog";
import type { ReleaseNote } from "../../src/features/releaseNotes/releaseNotes";

const releases: ReleaseNote[] = [
  { version: "0.2.0", date: "2026-12-01", issues: [{ number: 70, title: "Newer change" }] },
  { version: "0.1.3", date: "2026-11-24", issues: [{ number: 59, title: "Editor tabs of a removed workspace folder stay open" }] },
];

beforeEach(() => {
  opener.openUrl.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ReleaseNotesDialog", () => {
  it("opens as a modal dialog titled Version notes", () => {
    render(<ReleaseNotesDialog releases={releases} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Version notes" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("lists releases newest first with the version, date and closed issues", () => {
    render(<ReleaseNotesDialog releases={releases} onClose={() => {}} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["0.2.0 · 2026-12-01", "0.1.3 · 2026-11-24"]);
    const list = screen.getByRole("list", { name: "Issues closed in 0.1.3" });
    expect(within(list).getByText("#59")).toBeInTheDocument();
    expect(within(list).getByText("Editor tabs of a removed workspace folder stay open")).toBeInTheDocument();
  });

  it("opens the GitHub issue in the browser when an issue row is clicked", async () => {
    const user = userEvent.setup();
    render(<ReleaseNotesDialog releases={releases} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Open issue #59" }));
    expect(opener.openUrl).toHaveBeenCalledWith("https://github.com/YusufYiildiiriim/yerminal/issues/59");
  });

  it("closes with the close button and with Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReleaseNotesDialog releases={releases} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close version notes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("labels an unreleased version as Upcoming and shows no date", () => {
    render(<ReleaseNotesDialog releases={[{ version: "0.1.4", date: null, issues: [{ number: 63, title: "Version notes page" }] }]} onClose={() => {}} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["0.1.4 · Upcoming"]);
  });

  it("shows an empty state when there are no releases", () => {
    render(<ReleaseNotesDialog releases={[]} onClose={() => {}} />);
    expect(screen.getByText("No release notes yet.")).toBeInTheDocument();
  });
});

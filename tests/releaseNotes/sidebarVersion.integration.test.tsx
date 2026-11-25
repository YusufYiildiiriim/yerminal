import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { CURRENT_VERSION } from "../../src/features/releaseNotes/releaseNotes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("../../src/features/terminal/TerminalPane", () => ({
  default: () => <div data-testid="mock-terminal">Terminal Pane</div>,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("sidebar version entry", () => {
  it("shows the app version below Auto-hide in the workspace rail", () => {
    render(<App />);
    const rail = screen.getByRole("navigation", { name: "Workspace tools" });
    const version = within(rail).getByRole("button", { name: `Version notes, v${CURRENT_VERSION}` });
    expect(version).toHaveTextContent(`v${CURRENT_VERSION}`);
    const autoHide = within(rail).getByRole("button", { name: /hide workspace panel/i });
    expect(autoHide.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the version notes dialog from the rail entry", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: `Version notes, v${CURRENT_VERSION}` }));
    expect(screen.getByRole("dialog", { name: "Version notes" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Version notes" })).not.toBeInTheDocument();
  });
});

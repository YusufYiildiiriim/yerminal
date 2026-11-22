import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
  revealItemInDir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: tauri.onFocusChanged }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open, confirm: tauri.confirm }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: tauri.revealItemInDir }));
vi.mock("../../src/features/terminal/TerminalPane", async () => {
  const React = await import("react");
  return {
    default: ({ sessionId }: { sessionId: string }) => React.createElement("div", { "data-testid": "mock-terminal", "data-session-id": sessionId }),
  };
});

import App from "../../src/App";

afterEach(() => {
  cleanup();
});

/** The sidebar row buttons, in order. */
function sidebarRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".workspace-terminal-select"));
}

/** The name span of the first sidebar terminal row. */
function firstSidebarName(): HTMLElement {
  const name = sidebarRows()[0]?.querySelector<HTMLElement>(".workspace-terminal-name");
  if (!name) throw new Error("No sidebar terminal row");
  return name;
}

function sidebarNameOf(index: number): string | null {
  return sidebarRows()[index]?.querySelector(".workspace-terminal-name")?.textContent ?? null;
}

function renameInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: /^New name for / }) as HTMLInputElement;
}

async function renderWithTwoTerminals() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("mock-terminal");
  await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
  await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
  return user;
}

describe("sidebar terminal name rename (double-click)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: "", folderPaths: [] }],
      activeId: "workspace-1",
    }));
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => command === "terminal_output_snapshot" ? { events: [] } : undefined);
  });

  it("double-clicking a sidebar terminal name opens an inline field, and Enter saves the new name", async () => {
    const user = await renderWithTwoTerminals();
    await user.dblClick(firstSidebarName());

    const input = renameInput();
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Build{Enter}");

    expect(screen.queryByRole("textbox", { name: /^New name for / })).not.toBeInTheDocument();
    expect(sidebarNameOf(0)).toBe("Build");
  });

  it("Escape cancels a sidebar rename and keeps the name", async () => {
    const user = await renderWithTwoTerminals();
    const before = sidebarNameOf(0);
    await user.dblClick(firstSidebarName());

    await user.clear(renameInput());
    await user.type(renameInput(), "Scratch{Escape}");

    expect(screen.queryByRole("textbox", { name: /^New name for / })).not.toBeInTheDocument();
    expect(sidebarNameOf(0)).toBe(before);
  });

  it("losing focus saves a sidebar rename", async () => {
    const user = await renderWithTwoTerminals();
    await user.dblClick(firstSidebarName());

    const input = renameInput();
    await user.clear(input);
    await user.type(input, "Logs");
    fireEvent.blur(input);

    expect(screen.queryByRole("textbox", { name: /^New name for / })).not.toBeInTheDocument();
    expect(sidebarNameOf(0)).toBe("Logs");
  });

  it("an empty name keeps the previous name", async () => {
    const user = await renderWithTwoTerminals();
    const before = sidebarNameOf(0);
    await user.dblClick(firstSidebarName());

    await user.clear(renameInput());
    await user.type(renameInput(), "   {Enter}");

    expect(sidebarNameOf(0)).toBe(before);
  });

  it("a single click on a sidebar row still selects that terminal and opens no field", async () => {
    const user = await renderWithTwoTerminals();
    const second = sidebarRows()[1];
    await user.click(second);

    expect(screen.queryByRole("textbox", { name: /^New name for / })).not.toBeInTheDocument();
    expect(sidebarRows()[1]).toHaveAttribute("aria-pressed", "true");
  });
});

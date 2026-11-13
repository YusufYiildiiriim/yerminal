import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  open: vi.fn(async () => null),
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onFocusChanged: tauri.onFocusChanged }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl, revealItemInDir: tauri.revealItemInDir }));
vi.mock("../../src/features/terminal/TerminalPane", async () => {
  const React = await import("react");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return {
    default: ({ sessionId, shell, workingDirectory }: { sessionId: string; shell: string; workingDirectory: string | null }) => {
      React.useEffect(() => {
        void tauriInvoke("create_terminal", { sessionId, shell, workingDirectory, cols: 80, rows: 24 });
      }, [sessionId, shell, workingDirectory]);
      return React.createElement("div", { "data-testid": "mock-terminal", "data-working-directory": workingDirectory ?? "" });
    },
  };
});

import App from "../../src/App";
import { invoke, isTauri } from "@tauri-apps/api/core";

const root = "C:\\work\\repo";
const targetFolder = `${root}\\src`;

const originalScrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollBy");
const originalHasCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hasPointerCapture");
const originalSetCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [["scrollBy", originalScrollBy], ["hasPointerCapture", originalHasCapture], ["setPointerCapture", originalSetCapture]] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

describe("Explorer Open in Terminal integration", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root] }],
      activeId: "workspace-1",
    }));
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_workspace_directory") {
        return [{ name: "src", path: `${String(args?.root ?? "")}\\src`, isDir: true, size: null }];
      }
      if (command === "terminal_output_snapshot") return { events: [] };
      if (command === "terminal_resource_usage") return [];
      return undefined;
    });
  });

  it("does not auto-scroll the terminal viewport while resizing a split", async () => {
    const scrollBy = vi.fn();
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("terminal-layout-scrollport")) return { left: 0, right: 500, top: 0, bottom: 500, width: 500, height: 500, x: 0, y: 0, toJSON() {} };
      if (this.classList.contains("terminal-layout-surface")) return { left: 0, right: 1000, top: 0, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON() {} };
      if (this.classList.contains("terminal-pane-frame")) return { left: 400, right: 800, top: 0, bottom: 500, width: 400, height: 500, x: 400, y: 0, toJSON() {} };
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
    });
    Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: scrollBy });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
    vi.stubGlobal("PointerEvent", MouseEvent);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("mock-terminal");
    const folderButton = await screen.findByRole("button", { name: "src" });
    fireEvent.contextMenu(folderButton.closest(".workspace-tree-row")!);
    await user.click(screen.getByRole("menuitem", { name: "Open in Terminal" }));
    await user.click(await screen.findByRole("button", { name: "Show all terminals" }));
    const divider = await screen.findByRole("separator", { name: "Resize terminal panes" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    scrollBy.mockClear();
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 700, clientY: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollBy).not.toHaveBeenCalled();
    expect(divider).toHaveStyle({ left: "calc(70% - 3px)" });
    bounds.mockRestore();
  });
  it("creates and focuses a new target-folder session while keeping the prior session", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByTestId("mock-terminal");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.objectContaining({ workingDirectory: root })));
    vi.mocked(invoke).mockClear();

    await screen.findByTestId("mock-terminal");
    const folderButton = await screen.findByRole("button", { name: "src" });
    fireEvent.contextMenu(folderButton.closest(".workspace-tree-row")!);
    await user.click(screen.getByRole("menuitem", { name: "Open in Terminal" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_terminal", expect.objectContaining({ workingDirectory: targetFolder })));
    expect(invoke).not.toHaveBeenCalledWith("write_terminal", expect.anything());
    expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist", { name: "Terminal sessions" }).querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
});

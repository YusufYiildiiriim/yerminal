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
vi.mock("../../src/features/terminal/TerminalPane", () => ({ default: () => <div aria-label="Terminal session" /> }));

import App from "../../src/App";

type PathCase = {
  root: string;
  action: "New File" | "New Folder";
  command: "write_workspace_text_file" | "create_workspace_directory";
  name: string;
};

const cases: PathCase[] = [
  { root: "C:\\work\\repo", action: "New File", command: "write_workspace_text_file", name: "new.ts" },
  { root: "C:\\work\\repo", action: "New Folder", command: "create_workspace_directory", name: "new-folder" },
  { root: "/work/repo", action: "New File", command: "write_workspace_text_file", name: "new.ts" },
  { root: "/work/repo", action: "New Folder", command: "create_workspace_directory", name: "new-folder" },
];

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(tauri.isTauri).mockReturnValue(true);
  tauri.invoke.mockReset();
  tauri.invoke.mockResolvedValue(undefined);
  tauri.listen.mockReset();
  tauri.listen.mockResolvedValue(() => {});
  tauri.onFocusChanged.mockReset();
  tauri.onFocusChanged.mockResolvedValue(() => {});
  tauri.open.mockReset();
  tauri.open.mockResolvedValue(null);
});

describe("Explorer workspace path joining", () => {
  it.each(cases)("joins $action paths correctly for root $root", async ({ root, action, command, name }) => {
    localStorage.setItem("yerminal.terminal-workspaces", JSON.stringify({
      workspaces: [{ id: "workspace-1", name: "Workspace 1", rootPath: root, folderPaths: [root] }],
      activeId: "workspace-1",
    }));
    vi.spyOn(window, "prompt").mockReturnValue(name);
    const user = userEvent.setup();
    const { container } = render(<App />);

    const rootRow = container.querySelector(".workspace-root-row");
    expect(rootRow).not.toBeNull();
    fireEvent.contextMenu(rootRow!);
    await user.click(screen.getByRole("menuitem", { name: action }));

    const separator = root.includes("\\") ? "\\" : "/";
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(command, expect.objectContaining({
      root,
      path: root.endsWith(separator) ? `${root}${name}` : `${root}${separator}${name}`,
    })));
  });
});

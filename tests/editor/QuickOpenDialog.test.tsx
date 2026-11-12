import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { QuickOpenDialog } from "../../src/features/editor/QuickOpenDialog";

describe("QuickOpenDialog", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReturnValue(true);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  it("searches the active workspace first, ranks exact names, and opens the keyboard selection", async () => {
    const user = userEvent.setup();
    tauri.invoke.mockImplementation(async (_command: string, options: { root: string }) => [
      { name: "config.json", path: `${options.root}/config.json`, isDir: false, size: 10, extension: "json" },
      { name: "config-loader.ts", path: `${options.root}/src/config-loader.ts`, isDir: false, size: 20, extension: "ts" },
    ]);
    const onOpen = vi.fn();
    const onClose = vi.fn();

    render(<QuickOpenDialog
      workspaces={[
        { id: "active", name: "Current", folderPaths: ["/work/current"] },
        { id: "other", name: "Other", folderPaths: ["/work/other"] },
      ]}
      activeWorkspaceId="active"
      scope="all"
      onOpen={onOpen}
      onClose={onClose}
    />);

    await user.type(screen.getByRole("combobox"), "config");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const exactResults = await screen.findAllByRole("option", { name: /config\.json/ });
    expect(exactResults).toHaveLength(2);
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(2));

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "search_workspace_files", { root: "/work/current", query: "config", limit: 100 });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "search_workspace_files", { root: "/work/other", query: "config", limit: 100 });
    expect(exactResults[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      name: "config.json",
      workspaceId: "active",
      workspaceName: "Current",
      root: "/work/current",
    }));
  });

  it("explains that Quick Open requires the desktop app", async () => {
    tauri.isTauri.mockReturnValue(false);
    const user = userEvent.setup();

    render(<QuickOpenDialog workspaces={[]} activeWorkspaceId={null} scope="active" onOpen={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByRole("combobox"), "readme");

    expect(await screen.findByRole("status")).toHaveTextContent("Quick Open is available in the desktop app.");
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});

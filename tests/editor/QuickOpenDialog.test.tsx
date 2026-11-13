import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("ranks exact names, then prefixes, substrings, and path-only matches, breaking ties by relative path", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const entry = (relative: string) => {
      const name = relative.split("/").pop()!;
      return { name, path: `/work/${relative}`, isDir: false, size: 1, extension: name.includes(".") ? name.split(".").pop()! : null };
    };
    tauri.invoke.mockResolvedValue([
      entry("a/other.ts"),
      entry("app/index.ts"),
      entry("x/myapp.ts"),
      entry("b/app.ts"),
      entry("a/app.js"),
      entry("z/app"),
    ]);

    render(<QuickOpenDialog workspaces={[{ id: "w", name: "Work", folderPaths: ["/work"] }]} activeWorkspaceId="w" scope="active" onOpen={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByRole("combobox"), "APP");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    const paths = (await screen.findAllByRole("option")).map((option) => option.querySelector(".quick-open-file-path")?.textContent);
    expect(paths).toEqual(["z/app", "a/app.js", "b/app.ts", "x/myapp.ts", "app/index.ts", "a/other.ts"]);
  });

  it("ignores a search response that arrives after a newer query", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const responses = new Map<string, (entries: unknown[]) => void>();
    tauri.invoke.mockImplementation((_command: string, options: { query: string }) => new Promise((resolve) => responses.set(options.query, resolve)));
    const file = (name: string) => ({ name, path: `/work/${name}`, isDir: false, size: 1, extension: "ts" });

    render(<QuickOpenDialog workspaces={[{ id: "w", name: "Work", folderPaths: ["/work"] }]} activeWorkspaceId="w" scope="active" onOpen={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "ol");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await user.type(input, "d");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect([...responses.keys()]).toEqual(["ol", "old"]);

    await act(async () => { responses.get("old")!([file("old.ts")]); });
    await act(async () => { responses.get("ol")!([file("stale-ol.ts")]); });

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /old\.ts/ })).toBeInTheDocument();
    expect(screen.queryByText("stale-ol.ts")).not.toBeInTheDocument();
    expect(screen.getByText("1 files")).toBeInTheDocument();
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

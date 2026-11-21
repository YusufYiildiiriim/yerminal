import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeWorkspace, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";

afterEach(cleanup);

function tab(id: string): EditorFileTab {
  return {
    id, root: "C:/repo", path: `C:/repo/${id}.txt`, name: `${id}.txt`, status: "ready",
    content: "x", savedContent: "x", error: null, sourceLabel: null, sourceCommitId: null,
    snapshot: null, isSaving: false, saveError: null,
  };
}

function renderStrip(ids: string[], onClose = vi.fn()) {
  const group = { id: "group-1", name: "Editor 1", tabIds: ids, activeTabId: ids[0] ?? null };
  render(<CodeWorkspace workspaceId="workspace-1" tabs={ids.map(tab)} groups={[group]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={onClose} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
  return onClose;
}

function tabButton(id: string) {
  return screen.getByRole("tab", { name: new RegExp(`^${id}\\.txt`) });
}

function menuItem(label: string) {
  return screen.getByRole("menuitem", { name: label });
}

describe("editor tab context menu", () => {
  it("opens on a tab with Close, Close Others and Close All in order", () => {
    renderStrip(["a", "b", "c"]);

    fireEvent.contextMenu(tabButton("b"));

    expect(screen.getByRole("menu", { name: "Editor tab actions" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Close", "Close Others", "Close All"]);
  });

  it("Close closes only the right-clicked tab", () => {
    const onClose = renderStrip(["a", "b", "c"]);

    fireEvent.contextMenu(tabButton("b"));
    fireEvent.click(menuItem("Close"));

    expect(onClose.mock.calls.map(([id]) => id)).toEqual(["b"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Close Others closes every other tab in order and keeps the clicked one", () => {
    const onClose = renderStrip(["a", "b", "c"]);

    fireEvent.contextMenu(tabButton("b"));
    fireEvent.click(menuItem("Close Others"));

    expect(onClose.mock.calls.map(([id]) => id)).toEqual(["a", "c"]);
  });

  it("Close All closes every tab in the group in order", () => {
    const onClose = renderStrip(["a", "b", "c"]);

    fireEvent.contextMenu(tabButton("b"));
    fireEvent.click(menuItem("Close All"));

    expect(onClose.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
  });

  it("disables Close Others when only one tab is open, and a click does nothing", () => {
    const onClose = renderStrip(["a"]);

    fireEvent.contextMenu(tabButton("a"));

    expect(menuItem("Close Others")).toBeDisabled();
    fireEvent.click(menuItem("Close Others"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("on the empty strip, Close and Close Others are disabled and Close All closes the group", () => {
    const onClose = renderStrip(["a", "b"]);

    fireEvent.contextMenu(document.querySelector(".editor-file-tabs") as HTMLElement);

    expect(menuItem("Close")).toBeDisabled();
    expect(menuItem("Close Others")).toBeDisabled();
    expect(menuItem("Close All")).toBeEnabled();
    fireEvent.click(menuItem("Close All"));
    expect(onClose.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("Escape closes the menu without closing any tab", () => {
    const onClose = renderStrip(["a", "b"]);

    fireEvent.contextMenu(tabButton("a"));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a click outside the menu closes it without closing any tab", () => {
    const onClose = renderStrip(["a", "b"]);

    fireEvent.contextMenu(tabButton("a"));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("waits for each close to settle before starting the next, so an unsaved prompt is never skipped", async () => {
    const resolvers: Array<() => void> = [];
    const onClose = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    renderStrip(["a", "b", "c"], onClose);

    fireEvent.contextMenu(tabButton("a"));
    fireEvent.click(menuItem("Close All"));

    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { resolvers[0](); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(onClose.mock.calls[1][0]).toBe("b");
    await act(async () => { resolvers[1](); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(3));
    expect(onClose.mock.calls[2][0]).toBe("c");
  });
});

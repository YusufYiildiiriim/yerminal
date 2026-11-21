import { describe, expect, it, vi } from "vitest";

import { EDITOR_TAB_MENU_ACTIONS, editorTabMenuItems } from "../../src/features/editor/editorTabMenu";

const services = () => ({ closeTabs: vi.fn(async (_tabIds: readonly string[]) => {}) });

describe("editor tab menu action list", () => {
  it("lists Close, Close Others and Close All in that order", () => {
    expect(EDITOR_TAB_MENU_ACTIONS.map((action) => [action.id, action.label])).toEqual([
      ["close", "Close"],
      ["close-others", "Close Others"],
      ["close-all", "Close All"],
    ]);
  });

  it("builds one menu item per action, enabled when its condition holds", () => {
    const items = editorTabMenuItems({ tabId: "b", groupTabIds: ["a", "b", "c"] }, services());

    expect(items.map((item) => [item.label, Boolean(item.disabled)])).toEqual([
      ["Close", false],
      ["Close Others", false],
      ["Close All", false],
    ]);
  });

  it("disables Close Others when the group has a single tab", () => {
    const items = editorTabMenuItems({ tabId: "a", groupTabIds: ["a"] }, services());

    expect(items.map((item) => [item.label, Boolean(item.disabled)])).toEqual([
      ["Close", false],
      ["Close Others", true],
      ["Close All", false],
    ]);
  });

  it("disables the tab-specific actions on the empty strip and keeps Close All when tabs exist", () => {
    const items = editorTabMenuItems({ tabId: null, groupTabIds: ["a", "b"] }, services());

    expect(items.map((item) => [item.label, Boolean(item.disabled)])).toEqual([
      ["Close", true],
      ["Close Others", true],
      ["Close All", false],
    ]);
  });

  it("disables every action when the group has no tabs", () => {
    const items = editorTabMenuItems({ tabId: null, groupTabIds: [] }, services());

    expect(items.every((item) => item.disabled === true)).toBe(true);
  });
});

describe("editor tab menu actions run", () => {
  it("Close closes only the right-clicked tab", () => {
    const menu = services();
    const [close] = editorTabMenuItems({ tabId: "b", groupTabIds: ["a", "b", "c"] }, menu);

    close.onSelect();

    expect(menu.closeTabs).toHaveBeenCalledWith(["b"]);
  });

  it("Close Others closes every other tab in order and keeps the clicked one", () => {
    const menu = services();
    const [, closeOthers] = editorTabMenuItems({ tabId: "b", groupTabIds: ["a", "b", "c"] }, menu);

    closeOthers.onSelect();

    expect(menu.closeTabs).toHaveBeenCalledWith(["a", "c"]);
  });

  it("Close All closes every tab in the group in order", () => {
    const menu = services();
    const [, , closeAll] = editorTabMenuItems({ tabId: null, groupTabIds: ["a", "b", "c"] }, menu);

    closeAll.onSelect();

    expect(menu.closeTabs).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("does not run an action whose condition is false", () => {
    const menu = services();
    const [close, closeOthers] = editorTabMenuItems({ tabId: null, groupTabIds: ["a"] }, menu);

    close.onSelect();
    closeOthers.onSelect();

    expect(menu.closeTabs).not.toHaveBeenCalled();
  });
});

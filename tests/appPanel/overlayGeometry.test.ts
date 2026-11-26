import { afterEach, describe, expect, it } from "vitest";
import { overlapsContent, overlayBoxes } from "../../src/features/app-panel/overlayGeometry";

const CONTENT = { x: 1000, y: 112, width: 380, height: 700 };

function box(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

function element(role: string, rect: { x: number; y: number; width: number; height: number }, parent: ParentNode = document.body) {
  const el = document.createElement("div");
  el.setAttribute("role", role);
  el.getBoundingClientRect = () => ({
    left: rect.x, top: rect.y, width: rect.width, height: rect.height,
    right: rect.x + rect.width, bottom: rect.y + rect.height, x: rect.x, y: rect.y, toJSON: () => ({}),
  });
  parent.appendChild(el);
  return el;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("overlapsContent", () => {
  it("is false for a dialog that stays left of the dock content", () => {
    expect(overlapsContent([box(300, 100, 600, 500)], CONTENT, 1)).toBe(false);
  });

  it("is false when the boxes only touch at an edge", () => {
    expect(overlapsContent([box(400, 100, 600, 500)], CONTENT, 1)).toBe(false);
  });

  it("is true for a dialog that reaches into the dock content", () => {
    expect(overlapsContent([box(500, 100, 700, 500)], CONTENT, 1)).toBe(true);
  });

  it("is true for a menu that spills over the content from the strip above it", () => {
    expect(overlapsContent([box(1250, 70, 130, 100)], CONTENT, 1)).toBe(true);
  });

  it("is false for a menu that ends above the content", () => {
    expect(overlapsContent([box(1250, 40, 130, 60)], CONTENT, 1)).toBe(false);
  });

  it("is true when any of several overlays overlaps", () => {
    expect(overlapsContent([box(10, 10, 100, 100), box(1100, 300, 50, 50)], CONTENT, 1)).toBe(true);
    expect(overlapsContent([box(10, 10, 100, 100), box(20, 300, 50, 50)], CONTENT, 1)).toBe(false);
  });

  it("is false without overlays or with an empty content box", () => {
    expect(overlapsContent([], CONTENT, 1)).toBe(false);
    expect(overlapsContent([box(1000, 112, 50, 50)], box(1000, 112, 0, 700), 1)).toBe(false);
  });

  it("compares in rounded device pixels so a sliver below one pixel is not an overlap", () => {
    expect(overlapsContent([box(900, 100, 100.3, 500)], CONTENT, 1)).toBe(false);
    expect(overlapsContent([box(900, 100, 100.6, 500)], CONTENT, 1)).toBe(true);
    // 1.5 ratio: 0.4 CSS px = 0.6 device px, which rounds to one whole pixel of overlap.
    expect(overlapsContent([box(900, 100, 100.4, 500)], CONTENT, 1.5)).toBe(true);
  });
});

describe("overlayBoxes", () => {
  it("reads the box of the dialog itself, not of a full-screen wrapper around it", () => {
    const backdrop = document.createElement("div");
    backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1400, height: 900, right: 1400, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
    document.body.appendChild(backdrop);
    element("dialog", box(300, 100, 600, 500), backdrop);
    expect(overlayBoxes(document)).toEqual([box(300, 100, 600, 500)]);
  });

  it("collects dialogs, alert dialogs and menus, ignoring ones without a box", () => {
    element("dialog", box(300, 100, 600, 500));
    element("menu", box(10, 10, 100, 100));
    element("alertdialog", box(0, 0, 0, 0));
    expect(overlayBoxes(document)).toHaveLength(2);
  });

  it("forgets an overlay once it is removed from the DOM", () => {
    const dialog = element("dialog", box(300, 100, 600, 500));
    expect(overlayBoxes(document)).toHaveLength(1);
    dialog.remove();
    expect(overlayBoxes(document)).toHaveLength(0);
  });
});

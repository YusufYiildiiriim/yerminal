import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { AppPanelDock } from "../../src/features/app-panel/AppPanelDock";

function withState(state: { apps: string[]; active: string | null }) {
  tauri.invoke.mockImplementation(async (command: string, args?: { id?: string }) => {
    if (command === "app_panel_state") return state;
    if (command === "app_panel_activate") return { ...state, active: args?.id ?? null };
    return undefined;
  });
}

describe("AppPanelDock single row (title, tabs, add, collapse)", () => {
  const scrolled: HTMLElement[] = [];

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    tauri.invoke.mockReset();
    scrolled.length = 0;
    // jsdom has no scrollIntoView; record which element asked to be kept in view.
    Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement, options?: ScrollIntoViewOptions) {
      expect(options).toMatchObject({ inline: "nearest" });
      scrolled.push(this);
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mount = () => render(<AppPanelDock open onClose={() => undefined} />);

  it("has one header row holding the title, the tabs, the add button and the collapse button, in that order", async () => {
    withState({ apps: ["x", "youtube"], active: "x" });
    mount();
    await screen.findByRole("tab", { name: "X" });
    const header = document.querySelector(".app-panel-header") as HTMLElement;
    const order = [...header.children].map((el) => el.matches("h2") ? "title" : el.matches('[role="tablist"]') ? "tabs" : el.classList.contains("app-panel-add") ? "add" : (el as HTMLElement).getAttribute("aria-label"));
    expect(order).toEqual(["title", "tabs", "add", "Collapse app panel"]);
  });

  it("has no second strip for the tabs", async () => {
    withState({ apps: ["x"], active: "x" });
    mount();
    await screen.findByRole("tab", { name: "X" });
    expect(document.querySelector(".app-panel-tabs-row")).toBeNull();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getByRole("tablist").closest("header")).toBe(document.querySelector(".app-panel-header"));
  });

  it("works with zero, one and many tabs", async () => {
    withState({ apps: [], active: null });
    const first = mount();
    expect(screen.getByRole("heading", { name: "Apps" })).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add app" })).toBeTruthy();
    first.unmount();

    withState({ apps: ["x"], active: "x" });
    const second = mount();
    expect(await screen.findAllByRole("tab")).toHaveLength(1);
    second.unmount();

    withState({ apps: ["x", "youtube", "youtube-music"], active: "youtube" });
    mount();
    expect(await screen.findAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Collapse app panel" })).toBeTruthy();
  });

  it("keeps the plus menu opening from the add button inside the header", async () => {
    withState({ apps: ["x"], active: "x" });
    mount();
    await screen.findByRole("tab", { name: "X" });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    const menu = screen.getByRole("menu", { name: "Apps" });
    expect(menu.closest(".app-panel-add")).toBe(document.querySelector(".app-panel-header > .app-panel-add"));
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(0);
  });

  it("scrolls the active tab into view when it is restored and when another becomes active", async () => {
    withState({ apps: ["x", "youtube", "youtube-music"], active: "youtube-music" });
    mount();
    await screen.findByRole("tab", { name: "YouTube Music", selected: true });
    await waitFor(() => expect(scrolled.at(-1)?.getAttribute("data-active")).toBe("true"));
    expect(scrolled.at(-1)?.textContent).toContain("YouTube Music");

    scrolled.length = 0;
    fireEvent.click(screen.getByRole("tab", { name: "X" }));
    await screen.findByRole("tab", { name: "X", selected: true });
    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
    expect(scrolled.at(-1)?.textContent).toContain("X");
  });
});

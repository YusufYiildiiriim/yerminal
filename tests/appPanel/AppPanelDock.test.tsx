import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { AppPanelDock } from "../../src/features/app-panel/AppPanelDock";

const RECT = { x: 1000, y: 112, width: 380, height: 700 };
const empty = { apps: [], active: null };

/** Every element sits on the dock rect unless it carries its own box in data-box ("x,y,w,h"). */
function mockLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const own = this.getAttribute("data-box")?.split(",").map(Number);
    const [x, y, width, height] = own ?? [RECT.x, RECT.y, RECT.width, RECT.height];
    return { left: x, top: y, width, height, right: x + width, bottom: y + height, x, y, toJSON: () => ({}) } as DOMRect;
  });
}

function frame(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(8 + width * height * 4).fill(120);
  new DataView(bytes.buffer).setUint32(0, width, true);
  new DataView(bytes.buffer).setUint32(4, height, true);
  return bytes.buffer;
}

function dialogAt(box: string) {
  const dialog = document.createElement("section");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("data-box", box);
  return dialog;
}

const settle = () => new Promise((r) => setTimeout(r, 120));

function setup(props: Partial<{ open: boolean; onClose: () => void }> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(<AppPanelDock open={props.open ?? true} onClose={onClose} />);
  return { onClose };
}

describe("AppPanelDock", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => (command === "app_panel_state" ? empty : undefined));
    mockLayout();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("has a titled header and no path or argument fields", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Apps" })).toBeTruthy();
    expect(screen.queryByText("App path")).toBeNull();
    expect(screen.queryByText("Arguments")).toBeNull();
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByLabelText("App panel")).toBeNull();
  });

  it("collapses through the header button", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Collapse app panel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers the ready-made apps in the plus menu and opens one inside the dock content rect", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "app_panel_open" ? { apps: ["youtube-music"], active: "youtube-music" } : empty);
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    const menu = screen.getByRole("menu", { name: "Apps" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["YouTube Music", "YouTube", "X", "Add app…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "YouTube Music" }));

    // The page names an app by its id only: no url, no title hint, no path.
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_open", { id: "youtube-music", rect: RECT }));
    expect(await screen.findByRole("tab", { name: "YouTube Music", selected: true })).toBeTruthy();
  });

  it("shows the catalog as the empty state so no one types a path", () => {
    setup();
    const names = screen.getAllByRole("button", { name: /^Open / }).map((b) => b.textContent);
    expect(names).toEqual(expect.arrayContaining(["YouTube Music", "YouTube", "X"]));
  });

  it("restores open tabs from the backend and switches the active one", async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "app_panel_state") return { apps: ["youtube-music", "x"], active: "x" };
      if (command === "app_panel_activate") return { apps: ["youtube-music", "x"], active: "youtube-music" };
      return undefined;
    });
    setup();

    expect(await screen.findByRole("tab", { name: "X", selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "YouTube Music" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_activate", { id: "youtube-music", rect: RECT }));
    expect(await screen.findByRole("tab", { name: "YouTube Music", selected: true })).toBeTruthy();
  });

  it("closes an app from its tab", async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "app_panel_state") return { apps: ["x"], active: "x" };
      if (command === "app_panel_close") return empty;
      return undefined;
    });
    setup();

    fireEvent.click(await screen.findByRole("button", { name: "Close X" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_close", { id: "x", rect: RECT }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "X" })).toBeNull());
  });

  it("sends the dock rect in device pixels using the webview pixel ratio", async () => {
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(1.5);
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "app_panel_open" ? { apps: ["x"], active: "x" } : empty);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open X" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_open", expect.objectContaining({
      rect: { x: 1500, y: 168, width: 570, height: 1050 },
    })));
  });

  it("ignores a second launch while one is still opening", async () => {
    let finish: (value: unknown) => void = () => undefined;
    tauri.invoke.mockImplementation((command: string) =>
      command === "app_panel_open" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(command === "app_panel_state" ? empty : undefined));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open X" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_open", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    const item = screen.getByRole("menuitem", { name: "YouTube" });
    fireEvent.click(item);
    fireEvent.click(item);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "app_panel_open")).toHaveLength(1);
    await act(async () => { finish({ apps: ["x"], active: "x" }); });
  });

  it("activates the tab instead of opening an app that is already open", async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "app_panel_state") return { apps: ["x"], active: "x" };
      if (command === "app_panel_activate") return { apps: ["x"], active: "x" };
      return undefined;
    });
    setup();
    await screen.findByRole("tab", { name: "X" });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "X" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_activate", { id: "x", rect: RECT }));
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "app_panel_open")).toHaveLength(0);
  });

  it("merges placement requests into one per frame and numbers them upward", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "app_panel_state" ? { apps: ["x"], active: "x" } : undefined);
    setup();
    await screen.findByRole("tab", { name: "X" });
    await settle();
    const places = () => tauri.invoke.mock.calls.filter(([command]) => command === "app_panel_place");
    const flush = () => { frames.splice(0).forEach((cb) => cb(0)); };
    flush();
    tauri.invoke.mockClear();

    for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event("resize"));
    expect(places()).toHaveLength(0);
    flush();
    expect(places()).toHaveLength(1);

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(places()).toHaveLength(2);
    const seqs = places().map(([, args]) => (args as { seq: number }).seq);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
  });

  it("shows the start error in the panel instead of failing silently", async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "app_panel_open") throw "No supported browser found. Install Brave or Microsoft Edge.";
      return empty;
    });
    setup();
    fireEvent.click(screen.getAllByRole("button", { name: /^Open / })[0]);
    expect((await screen.findByRole("status")).textContent).toContain("No supported browser found");
  });

  it("hides the hosted window while an HTML dialog is open and shows it again afterwards", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "app_panel_state" ? { apps: ["x"], active: "x" } : undefined);
    setup();
    await screen.findByRole("tab", { name: "X" });
    tauri.invoke.mockClear();

    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    await act(async () => { document.body.appendChild(dialog); await new Promise((r) => setTimeout(r, 30)); });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_set_visible", { visible: false }));

    await act(async () => { dialog.remove(); await new Promise((r) => setTimeout(r, 30)); });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_set_visible", { visible: true }));
  });

  it("hides the hosted window while its own plus menu is open", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "app_panel_state" ? { apps: ["x"], active: "x" } : undefined);
    setup();
    await screen.findByRole("tab", { name: "X" });
    tauri.invoke.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_set_visible", { visible: false }));
    fireEvent.keyDown(screen.getByRole("menu", { name: "Apps" }), { key: "Escape" });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_set_visible", { visible: true }));
  });

  it("hides the hosted window when the dock is collapsed", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "app_panel_state" ? { apps: ["x"], active: "x" } : undefined);
    const view = render(<AppPanelDock open onClose={() => {}} />);
    await screen.findByRole("tab", { name: "X" });
    tauri.invoke.mockClear();
    view.rerender(<AppPanelDock open={false} onClose={() => {}} />);
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_set_visible", { visible: false }));
  });

  it("resizes with the keyboard and remembers the width", () => {
    setup();
    const handle = screen.getByRole("separator", { name: "Resize app panel" });
    const dock = screen.getByLabelText("App panel");
    const before = parseInt(dock.style.flexBasis, 10);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(parseInt(dock.style.flexBasis, 10)).toBe(before + 16);
    expect(JSON.parse(localStorage.getItem("yerminal.app-panel") ?? "{}").width).toBe(before + 16);
  });

  it("starts with the stored width", () => {
    localStorage.setItem("yerminal.app-panel", JSON.stringify({ open: true, width: 450 }));
    setup();
    expect(screen.getByLabelText("App panel").style.flexBasis).toBe("450px");
  });

  describe("own apps", () => {
    const READY = [
      { id: "youtube-music", name: "YouTube Music", kind: "builtin" },
      { id: "youtube", name: "YouTube", kind: "builtin" },
      { id: "x", name: "X", kind: "builtin" },
    ];
    const POSTMAN = { id: "custom-1", name: "Postman", kind: "custom" };
    const calls = (name: string) => tauri.invoke.mock.calls.filter(([command]) => command === name);

    /** Backend double: a list that add/rename/remove change, and a picker with a fixed answer. */
    function backend(initial: unknown[] = [], extra: Record<string, unknown> = {}) {
      let own = [...initial];
      tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command in extra) {
          const value = extra[command];
          if (value instanceof Error) throw value.message;
          return value;
        }
        switch (command) {
          case "app_panel_state": return empty;
          case "app_panel_apps_list": return [...READY, ...own];
          case "app_panel_app_pick": return { default_name: "charmap" };
          case "app_panel_app_register": own = [...own, { id: "custom-9", name: String(args?.name), kind: "custom" }]; return [...READY, ...own];
          case "app_panel_app_rename": own = own.map((app) => ((app as { id: string }).id === args?.id ? { ...(app as object), name: String(args?.name) } : app)); return [...READY, ...own];
          case "app_panel_app_remove": own = own.filter((app) => (app as { id: string }).id !== args?.id); return [...READY, ...own];
          default: return undefined;
        }
      });
    }

    const openMenu = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add app" }));
      return screen.getByRole("menu", { name: "Apps" });
    };

    it("lists ready-made apps, a separator, the saved apps and Add app at the bottom", async () => {
      backend([POSTMAN]);
      setup();
      await screen.findByRole("button", { name: "Open Postman" });
      const menu = await openMenu();
      const items = within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label") ?? item.textContent);
      expect(items).toEqual(["YouTube Music", "YouTube", "X", "Postman", "Rename Postman", "Remove Postman", "Add app…"]);
      expect(within(menu).getAllByRole("separator").length).toBeGreaterThanOrEqual(1);
      expect(within(menu).getAllByRole("menuitem").at(-1)?.textContent).toBe("Add app…");
    });

    it("opens a saved app by its id and nothing else", async () => {
      backend([POSTMAN], { app_panel_open: { apps: ["custom-1"], active: "custom-1" } });
      setup();
      await screen.findByRole("button", { name: "Open Postman" });
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Postman" }));
      await waitFor(() => expect(calls("app_panel_open")).toEqual([["app_panel_open", { id: "custom-1", rect: RECT }]]));
      expect(await screen.findByRole("tab", { name: "Postman", selected: true })).toBeTruthy();
    });

    it("ignores a double click on a saved app", async () => {
      backend([POSTMAN], { app_panel_open: new Promise(() => undefined) });
      setup();
      await screen.findByRole("button", { name: "Open Postman" });
      const menu = await openMenu();
      const item = within(menu).getByRole("menuitem", { name: "Postman" });
      fireEvent.click(item);
      fireEvent.click(item);
      expect(calls("app_panel_open")).toHaveLength(1);
    });

    it("adds an app: the picker is opened by the backend, the page only types a name", async () => {
      backend();
      setup();
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add app…" }));

      const input = await screen.findByRole("textbox", { name: "App name" });
      expect((input as HTMLInputElement).value).toBe("charmap");
      expect(calls("app_panel_app_pick")).toEqual([["app_panel_app_pick"]]);
      fireEvent.change(input, { target: { value: "Character Map" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(calls("app_panel_app_register")).toEqual([["app_panel_app_register", { name: "Character Map" }]]));
      expect(await screen.findByRole("button", { name: "Open Character Map" })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "App name" })).toBeNull();
      // No call ever carries a path or an argument.
      for (const [, args] of tauri.invoke.mock.calls) {
        expect(JSON.stringify(args ?? {})).not.toMatch(/path|exe|args|\.exe/i);
      }
    });

    it("saves with Enter and drops the pick with Escape", async () => {
      backend();
      setup();
      let menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add app…" }));
      let input = await screen.findByRole("textbox", { name: "App name" });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "App name" })).toBeNull();
      expect(calls("app_panel_app_register")).toHaveLength(0);

      menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add app…" }));
      input = await screen.findByRole("textbox", { name: "App name" });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      await waitFor(() => expect(calls("app_panel_app_register")).toHaveLength(1));
    });

    it("does nothing when the picker is cancelled", async () => {
      backend([], { app_panel_app_pick: null });
      setup();
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add app…" }));
      await waitFor(() => expect(calls("app_panel_app_pick")).toHaveLength(1));
      expect(screen.queryByRole("textbox", { name: "App name" })).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("shows a refused pick or a failed save in the message area", async () => {
      backend([], { app_panel_app_pick: new Error("Choose an .exe file on a local drive") });
      setup();
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add app…" }));
      expect((await screen.findByRole("status")).textContent).toContain("local drive");
    });

    it("does not save an empty name", async () => {
      backend();
      setup();
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add app…" }));
      const input = await screen.findByRole("textbox", { name: "App name" });
      fireEvent.change(input, { target: { value: "   " } });
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("renames a saved app and the open tab follows", async () => {
      backend([POSTMAN], { app_panel_state: { apps: ["custom-1"], active: "custom-1" } });
      setup();
      await screen.findByRole("tab", { name: "Postman" });
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename Postman" }));
      const input = await screen.findByRole("textbox", { name: "App name" });
      expect((input as HTMLInputElement).value).toBe("Postman");
      fireEvent.change(input, { target: { value: "Postman Agent" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(calls("app_panel_app_rename")).toEqual([["app_panel_app_rename", { id: "custom-1", name: "Postman Agent" }]]));
      expect(await screen.findByRole("tab", { name: "Postman Agent" })).toBeTruthy();
    });

    it("removes a saved app only after a confirmation, and never closes its window", async () => {
      backend([POSTMAN]);
      setup();
      await screen.findByRole("button", { name: "Open Postman" });
      let menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove Postman" }));
      expect(screen.getByText(/Remove Postman from the list/)).toBeTruthy();
      expect(calls("app_panel_app_remove")).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Keep" }));
      expect(screen.queryByText(/Remove Postman from the list/)).toBeNull();
      expect(calls("app_panel_app_remove")).toHaveLength(0);

      menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove Postman" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(calls("app_panel_app_remove")).toEqual([["app_panel_app_remove", { id: "custom-1" }]]));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Open Postman" })).toBeNull());
      expect(calls("app_panel_close")).toHaveLength(0);
    });

    it("keeps an open tab, with its name, after its app was removed from the list", async () => {
      backend([POSTMAN], { app_panel_state: { apps: ["custom-1"], active: "custom-1" } });
      setup();
      await screen.findByRole("tab", { name: "Postman" });
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove Postman" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(calls("app_panel_app_remove")).toHaveLength(1));
      expect(screen.getByRole("tab", { name: "Postman" })).toBeTruthy();
      expect(calls("app_panel_close")).toHaveLength(0);
    });

    it("shows a start error of a saved app in the message area", async () => {
      backend([POSTMAN], { app_panel_open: new Error("No new window appeared. The app may already be open: close it and try again.") });
      setup();
      fireEvent.click(await screen.findByRole("button", { name: "Open Postman" }));
      expect((await screen.findByRole("status")).textContent).toContain("may already be open");
    });
  });

  describe("dialog over the hosted window", () => {
    const hosted = async (extra: Record<string, unknown> = {}) => {
      const draws = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: draws,
      } as unknown as CanvasRenderingContext2D);
      tauri.invoke.mockImplementation(async (command: string) => {
        if (command === "app_panel_state") return { apps: ["x"], active: "x" };
        if (command in extra) return extra[command];
        return undefined;
      });
      setup();
      await screen.findByRole("tab", { name: "X" });
      tauri.invoke.mockClear();
      return draws;
    };
    const calls = (name: string) => tauri.invoke.mock.calls.filter(([command]) => command === name);
    const hides = () => calls("app_panel_set_visible").filter(([, args]) => (args as { visible: boolean }).visible === false);

    it("keeps the window when the dialog does not reach the dock content", async () => {
      await hosted({ app_panel_snapshot: frame(4, 4) });
      await act(async () => { document.body.appendChild(dialogAt("200,100,600,500")); await settle(); });
      expect(hides()).toHaveLength(0);
      expect(calls("app_panel_snapshot")).toHaveLength(0);
      expect(document.querySelector("[data-app-snapshot]")).toBeNull();
    });

    it("takes one frame before hiding when the dialog overlaps, shows it in the dock and drops it afterwards", async () => {
      const draws = await hosted({ app_panel_snapshot: frame(4, 4) });
      const dialog = dialogAt("800,100,600,500");
      await act(async () => { document.body.appendChild(dialog); await settle(); });

      expect(calls("app_panel_snapshot")).toHaveLength(1);
      const order = tauri.invoke.mock.calls.map(([command]) => command);
      expect(order.indexOf("app_panel_snapshot")).toBeLessThan(order.indexOf("app_panel_set_visible"));
      const canvas = document.querySelector<HTMLCanvasElement>("[data-app-snapshot] canvas");
      expect(canvas).not.toBeNull();
      expect(canvas?.closest(".app-panel-content")).not.toBeNull();
      expect(draws).toHaveBeenCalledTimes(1);

      await act(async () => { dialog.remove(); await settle(); });
      expect(calls("app_panel_set_visible").some(([, args]) => (args as { visible: boolean }).visible === true)).toBe(true);
      expect(document.querySelector("[data-app-snapshot]")).toBeNull();
      expect(calls("app_panel_snapshot")).toHaveLength(1);
    });

    it("falls back to a plain note when the frame could not be taken", async () => {
      await hosted();
      await act(async () => { document.body.appendChild(dialogAt("800,100,600,500")); await settle(); });
      expect(hides()).toHaveLength(1);
      expect(screen.getByText("Hidden while a dialog is open")).toBeTruthy();
      expect(document.querySelector("canvas")).toBeNull();
    });

    it("does not take a frame when the dock is collapsed", async () => {
      tauri.invoke.mockImplementation(async (command: string) =>
        command === "app_panel_state" ? { apps: ["x"], active: "x" } : command === "app_panel_snapshot" ? frame(4, 4) : undefined);
      const view = render(<AppPanelDock open onClose={() => {}} />);
      await screen.findByRole("tab", { name: "X" });
      await settle();
      tauri.invoke.mockClear();
      view.rerender(<AppPanelDock open={false} onClose={() => {}} />);
      await settle();
      expect(calls("app_panel_snapshot")).toHaveLength(0);
      expect(hides()).toHaveLength(1);
    });

    it("does not hide for a menu that stays outside the content", async () => {
      await hosted({ app_panel_snapshot: frame(4, 4) });
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("data-box", "10,10,200,300");
      await act(async () => { document.body.appendChild(menu); await settle(); });
      expect(hides()).toHaveLength(0);
    });
  });
});

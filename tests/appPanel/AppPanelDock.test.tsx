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
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["YouTube Music", "YouTube", "X"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "YouTube Music" }));

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_open", {
      id: "youtube-music",
      url: "https://music.youtube.com",
      titleHint: "YouTube Music",
      rect: RECT,
    }));
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

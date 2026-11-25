import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowTitleBar } from "../../src/shell/WindowTitleBar";

const windowMock = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  resizeHandler: null as null | (() => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: windowMock.minimize,
    toggleMaximize: windowMock.toggleMaximize,
    close: windowMock.close,
    isMaximized: windowMock.isMaximized,
    onResized: vi.fn(async (handler: () => void) => {
      windowMock.resizeHandler = handler;
      return () => {};
    }),
  }),
}));

beforeEach(() => {
  windowMock.isMaximized.mockResolvedValue(false);
  windowMock.resizeHandler = null;
});

afterEach(() => {
  cleanup();
});

function renderBar() {
  const { container } = render(<WindowTitleBar breadcrumb="Terminal · main" />);
  const header = container.querySelector("header.titlebar") as HTMLElement;
  return { header, container };
}

describe("window title bar", () => {
  it("shows the brand mark, bold name and location text in one header row", () => {
    const { header } = renderBar();
    const brand = header.querySelector(".brand") as HTMLElement;
    expect(brand).not.toBeNull();
    expect(brand.querySelector("svg")).not.toBeNull();
    expect(within(brand).getByText("yerminal")).toHaveClass("brand-name");
    expect(header.querySelector(".titlebar-breadcrumb")).toHaveTextContent("Terminal · main");
  });

  it("renders minimize, maximize and close as labelled icon buttons", () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Minimize window" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Maximize window" })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Close window" })).toHaveAttribute("type", "button");
  });

  it("marks the empty areas as drag regions and keeps the buttons out of them", () => {
    const { header } = renderBar();
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(header.querySelector(".brand")).toHaveAttribute("data-tauri-drag-region");
    expect(header.querySelector(".titlebar-breadcrumb")).toHaveAttribute("data-tauri-drag-region");
    for (const button of header.querySelectorAll("button")) {
      expect(button).not.toHaveAttribute("data-tauri-drag-region");
    }
  });

  it("minimizes, toggles maximize and closes through the native window", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    expect(windowMock.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    expect(windowMock.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(windowMock.close).toHaveBeenCalledTimes(1);
  });

  it("switches the maximize button to Restore when the window is maximized", async () => {
    renderBar();
    windowMock.isMaximized.mockResolvedValue(true);
    await act(async () => {
      windowMock.resizeHandler?.();
    });
    expect(await screen.findByRole("button", { name: "Restore window" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize window" })).toBeNull();
  });
});

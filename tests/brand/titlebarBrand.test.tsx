import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("../../src/features/terminal/TerminalPane", () => ({
  default: () => <div data-testid="mock-terminal">Terminal Pane</div>,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("app top bar", () => {
  it("shows the brand mark and name in the title bar next to the location text", () => {
    localStorage.clear();
    render(<App />);
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    const brand = titlebar.querySelector(".brand") as HTMLElement;
    expect(brand.querySelector("svg")).not.toBeNull();
    expect(within(brand).getByText("yerminal")).toHaveClass("brand-name");
    expect(titlebar.querySelector(".titlebar-breadcrumb")).not.toBeNull();
    expect(within(titlebar).getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });
});

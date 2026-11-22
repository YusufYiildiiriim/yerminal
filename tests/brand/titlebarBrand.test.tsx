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

describe("titlebar brand", () => {
  it("shows the geometric mark instead of the letter y", () => {
    localStorage.clear();
    render(<App />);
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    const logo = titlebar.querySelector(".brand-logo") as HTMLElement;
    expect(logo.querySelector("svg")).not.toBeNull();
    expect(logo.querySelectorAll("path")).toHaveLength(3);
    expect(logo.textContent).toBe("");
    expect(within(titlebar).getByText("yerminal", { selector: ".brand-name" })).toBeInTheDocument();
  });
});

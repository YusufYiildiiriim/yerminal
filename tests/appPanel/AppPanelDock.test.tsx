import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { AppPanelDock } from "../../src/features/app-panel/AppPanelDock";

describe("AppPanelDock spike", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens the configured app with its arguments inside the dock rectangle", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 560, top: 0, width: 340, height: 660, right: 900, bottom: 660, x: 560, y: 0, toJSON: () => ({}),
    } as DOMRect);
    render(<AppPanelDock />);

    fireEvent.click(screen.getByRole("button", { name: "Open app" }));

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("app_panel_open", expect.objectContaining({
      exe: expect.stringContaining("brave.exe"),
      args: ["--app=https://music.youtube.com", "--user-data-dir={profile}"],
      rect: { x: 560, y: 0, width: 340, height: 660 },
    })));
  });

  it("does not open anything while the dock has no size", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    render(<AppPanelDock />);

    fireEvent.click(screen.getByRole("button", { name: "Open app" }));

    expect(tauri.invoke).not.toHaveBeenCalledWith("app_panel_open", expect.anything());
  });
});

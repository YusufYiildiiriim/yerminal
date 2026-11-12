import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog, type AppSettings } from "../../src/features/settings/SettingsDialog";

const settings: AppSettings = {
  theme: "obsidian",
  editorFontFamily: "Consolas, monospace",
  editorFontSize: 14,
  terminalFontFamily: "Consolas, monospace",
  terminalFontSize: 13,
  quickOpenScope: "active",
  collapseOtherFolders: false,
  autoSave: true,
};

describe("SettingsDialog", () => {
  afterEach(cleanup);
  it("applies theme selection and clamps editor font size to its supported range", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Nordic Glass/ }));

    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, theme: "nordic" });
    await user.click(screen.getByRole("button", { name: /Editor/ }));
    const sizeInput = screen.getByRole("spinbutton");
    fireEvent.change(sizeInput, { target: { value: "99" } });

    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, editorFontSize: 32 });
  });

  it("persists auto-save, Quick Open scope, and Explorer expansion preferences through the change callback", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();

    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Editor/ }));
    await user.click(screen.getByRole("checkbox", { name: "Auto Save" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, autoSave: false });

    await user.selectOptions(screen.getByRole("combobox"), "all");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, quickOpenScope: "all" });

    await user.click(screen.getByRole("button", { name: /Explorer/ }));
    await user.click(screen.getByRole("checkbox", { name: /Collapse other folders/ }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, collapseOtherFolders: true });
  });
});

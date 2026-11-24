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
  autoSave: false,
  agentUsageEnabled: false,
};

async function openTerminalSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Terminal/ }));
}

describe("Terminal open settings", () => {
  afterEach(cleanup);

  it("shows the defaults switch off when the stored value is missing, and turning it on reports the change", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await openTerminalSection(user);

    const toggle = screen.getByRole("checkbox", { name: "Use defaults when opening a terminal" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, terminalUseDefaults: true });
  });

  it("shows the switch on only when the stored value is explicitly true", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={{ ...settings, terminalUseDefaults: false }} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await openTerminalSection(user);

    expect(screen.getByRole("checkbox", { name: "Use defaults when opening a terminal" })).not.toBeChecked();
  });

  it("reports the terminal default path and default group as typed", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={{ ...settings, terminalUseDefaults: true }} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await openTerminalSection(user);

    fireEvent.change(screen.getByRole("textbox", { name: "Terminal default path" }), { target: { value: "C:\\work\\api" } });
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, terminalUseDefaults: true, terminalDefaultPath: "C:\\work\\api" });

    fireEvent.change(screen.getByRole("textbox", { name: "Terminal default group" }), { target: { value: "API" } });
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, terminalUseDefaults: true, terminalDefaultGroup: "API" });
  });

  it("shows the stored default path and group values", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog settings={{ ...settings, terminalDefaultPath: "C:\\work", terminalDefaultGroup: "API" }} shortcuts={[]} onSettingsChange={vi.fn()} onClose={vi.fn()} />);
    await openTerminalSection(user);

    expect(screen.getByRole("textbox", { name: "Terminal default path" })).toHaveValue("C:\\work");
    expect(screen.getByRole("textbox", { name: "Terminal default group" })).toHaveValue("API");
  });
});

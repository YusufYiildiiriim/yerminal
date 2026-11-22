import { cleanup, render, screen } from "@testing-library/react";
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

describe("Restore terminals on startup setting", () => {
  afterEach(cleanup);

  it("is on by default and turning it off reports the change", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Terminal", exact: true }));

    const toggle = screen.getByRole("checkbox", { name: "Restore terminals on startup" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, terminalRestoreOnStartup: false });
  });
});

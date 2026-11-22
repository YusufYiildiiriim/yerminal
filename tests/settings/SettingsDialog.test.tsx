import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  agentUsageEnabled: false,
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
    const sizeInput = screen.getByRole("spinbutton", { name: "Editor font size" });
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

describe("SettingsDialog agent usage", () => {
  afterEach(cleanup);

  it("turns agent usage on from the Terminal section and says local logs are read without network use", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Terminal/ }));

    const toggle = screen.getByRole("checkbox", { name: "Agent usage" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Reads local .*log files/)).toHaveTextContent("Nothing is sent over the network.");
    await user.click(toggle);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, agentUsageEnabled: true });
  });
});

describe("SettingsDialog editor minimap", () => {
  afterEach(cleanup);

  it("turns the editor minimap off from the Editor section and back on", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={{ ...settings, editorMinimap: true }} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Editor/ }));

    const toggle = screen.getByRole("checkbox", { name: "Editor minimap" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, editorMinimap: false });
  });

  it("shows the minimap as on when the stored setting is missing", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Editor/ }));

    expect(screen.getByRole("checkbox", { name: "Editor minimap" })).toBeChecked();
  });
});

describe("SettingsDialog layout", () => {
  afterEach(cleanup);

  it("lists every section in the left nav and marks the selected one with aria-current", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog settings={settings} shortcuts={[{ keys: "Ctrl+P", label: "Quick Open" }]} onSettingsChange={vi.fn()} onClose={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(["Appearance", "Editor", "Languages", "Explorer", "Terminal", "Keyboard shortcuts"]);
    expect(within(nav).getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "true");

    await user.click(within(nav).getByRole("button", { name: "Terminal" }));
    expect(within(nav).getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-current", "true");
    expect(within(nav).getByRole("button", { name: "Appearance" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Quick Open")).toBeInTheDocument();
  });

  it("filters setting rows by label text with the search field and restores them when cleared", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={vi.fn()} onClose={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search settings" });

    await user.type(search, "collapse");
    expect(screen.getByRole("checkbox", { name: /Collapse other folders/ })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Editor font size" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Editor" })).not.toBeInTheDocument();

    await user.clear(search);
    expect(screen.getByRole("spinbutton", { name: "Editor font size" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Auto Save" })).toBeInTheDocument();
  });
});

it("offers language toggles with defaults, plain-text fallback and persistent changes", () => {
  const onSettingsChange = vi.fn();
  render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Languages" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Enable C#" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Enable Python" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Python" }));
  expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabledLanguages: expect.arrayContaining(["python", "csharp"]) }));
  expect(screen.getByText(/Disabled languages open as plain text/)).toBeInTheDocument();
  cleanup();
});

describe("interface size control", () => {
  afterEach(cleanup);
  it("offers Small, Default and Large and reports the chosen size", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);

    const group = screen.getByRole("group", { name: "Interface size" });
    expect(within(group).getByRole("button", { name: "Default" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "Small" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, interfaceSize: "small" });
    await user.click(within(group).getByRole("button", { name: "Large" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, interfaceSize: "large" });
  });

  it("does not change the editor or terminal font size when the interface size changes", async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(<SettingsDialog settings={settings} shortcuts={[]} onSettingsChange={onSettingsChange} onClose={vi.fn()} />);

    await user.click(within(screen.getByRole("group", { name: "Interface size" })).getByRole("button", { name: "Large" }));
    expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({ editorFontSize: 14, terminalFontSize: 13 }));
  });
});

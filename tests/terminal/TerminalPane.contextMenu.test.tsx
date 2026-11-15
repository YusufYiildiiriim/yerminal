import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  instance: null as null | {
    hasSelection: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
    keyHandler: ((e: KeyboardEvent) => boolean) | null;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    clearSelection = vi.fn();
    paste = vi.fn();
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) { this.keyHandler = h; }
    constructor(options?: Record<string, unknown>) { xterm.instance = this; xterm.options = options ?? null; }
    loadAddon() {}
    open() {}
    writeln() {}
    write() {}
    focus() {}
    onData() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../src/features/terminal/terminalLinks", () => ({ registerUrlLinks: () => ({ dispose: () => {} }) }));

import { TerminalPane } from "../../src/features/terminal/TerminalPane";

describe("terminal right-click", () => {
  const clipboard = { readText: vi.fn(), writeText: vi.fn() };
  beforeEach(() => {
    clipboard.readText.mockReset().mockResolvedValue("echo pasted");
    clipboard.writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  });
  afterEach(cleanup);

  function mount(onParentContextMenu = vi.fn()) {
    const view = render(<div onContextMenu={onParentContextMenu}><TerminalPane sessionId="s1" shell="powershell" workingDirectory={null} active visible onFocus={() => {}} onExit={() => {}} /></div>);
    return { host: view.container.querySelector(".terminal-fit") as HTMLElement, onParentContextMenu };
  }

  it("pastes the clipboard and does not bubble to the pane menu", async () => {
    const { host, onParentContextMenu } = mount();
    expect(fireEvent.contextMenu(host)).toBe(false);
    await waitFor(() => expect(xterm.instance!.paste).toHaveBeenCalledWith("echo pasted"));
    expect(onParentContextMenu).not.toHaveBeenCalled();
  });

  it("copies and clears an existing selection instead of pasting", async () => {
    const { host } = mount();
    xterm.instance!.hasSelection.mockReturnValue(true);
    xterm.instance!.getSelection.mockReturnValue("selected text");
    fireEvent.contextMenu(host);
    expect(clipboard.writeText).toHaveBeenCalledWith("selected text");
    expect(xterm.instance!.clearSelection).toHaveBeenCalled();
    expect(xterm.instance!.paste).not.toHaveBeenCalled();
  });
});

describe("terminal Ctrl+Shift+C / V", () => {
  const clipboard = { readText: vi.fn(), writeText: vi.fn() };
  beforeEach(() => {
    clipboard.readText.mockReset().mockResolvedValue("echo pasted");
    clipboard.writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    render(<TerminalPane sessionId="s3" shell="powershell" workingDirectory={null} active visible onFocus={() => {}} onExit={() => {}} />);
  });
  afterEach(cleanup);
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, cancelable: true, ...init });
    return { handled: xterm.instance!.keyHandler!(event) === false, event };
  };

  it("copies the selection, blocks ^C and the browser inspect shortcut", () => {
    xterm.instance!.hasSelection.mockReturnValue(true);
    xterm.instance!.getSelection.mockReturnValue("picked");
    const { handled, event } = press("C");
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("picked");
  });

  it("pastes the clipboard", async () => {
    const { handled, event } = press("V");
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(xterm.instance!.paste).toHaveBeenCalledWith("echo pasted"));
  });

  it("leaves plain Ctrl+C for the shell", () => {
    expect(press("c", { shiftKey: false }).handled).toBe(false);
  });
});

describe("terminal on Windows", () => {
  afterEach(cleanup);
  it("tells xterm the PTY is ConPTY so resizes do not garble or erase lines", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    render(<TerminalPane sessionId="s2" shell="powershell" workingDirectory={null} active visible onFocus={() => {}} onExit={() => {}} />);
    expect(xterm.options?.windowsPty).toMatchObject({ backend: "conpty" });
  });
});

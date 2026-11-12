import { describe, expect, it, vi } from "vitest";
import { appendTerminalToLayout, openFolderInNewTerminal, type TerminalLayoutNode } from "../../src/features/terminal/terminalWorkspaceActions";

describe("openFolderInNewTerminal", () => {
  it("creates a distinct terminal at the selected folder and activates it", async () => {
    const createTerminalAt = vi.fn(async (workingDirectory: string) => ({ id: "new-terminal", workingDirectory }));
    const activateTerminal = vi.fn();
    const onDesktopRequired = vi.fn();

    const result = await openFolderInNewTerminal({
      isDesktop: true,
      folderPath: "C:\\work\\repo\\src",
      createTerminalAt,
      activateTerminal,
      onDesktopRequired,
    });

    expect(createTerminalAt).toHaveBeenCalledOnce();
    expect(createTerminalAt).toHaveBeenCalledWith("C:\\work\\repo\\src");
    expect(result).toEqual({ id: "new-terminal", workingDirectory: "C:\\work\\repo\\src" });
    expect(activateTerminal).toHaveBeenCalledWith("new-terminal");
    expect(onDesktopRequired).not.toHaveBeenCalled();
  });

  it("does not create or activate a terminal outside Tauri", async () => {
    const createTerminalAt = vi.fn();
    const activateTerminal = vi.fn();
    const onDesktopRequired = vi.fn();

    await expect(openFolderInNewTerminal({
      isDesktop: false,
      folderPath: "/work/repo/src",
      createTerminalAt,
      activateTerminal,
      onDesktopRequired,
    })).resolves.toBeNull();

    expect(createTerminalAt).not.toHaveBeenCalled();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(onDesktopRequired).toHaveBeenCalledOnce();
  });

  it("keeps the current layout intact and adds the new terminal beside it", () => {
    const current: TerminalLayoutNode = {
      type: "split",
      id: "custom-root",
      direction: "vertical",
      ratio: 0.63,
      children: [
        { type: "terminal", sessionId: "first" },
        { type: "split", id: "custom-inner", direction: "horizontal", ratio: 0.4, children: [
          { type: "terminal", sessionId: "second" },
          { type: "terminal", sessionId: "third" },
        ] },
      ],
    };

    const result = appendTerminalToLayout(current, "fourth");

    expect(result).toEqual({
      type: "split",
      id: expect.any(String),
      direction: "horizontal",
      ratio: 0.5,
      children: [current, { type: "terminal", sessionId: "fourth" }],
    });
    expect(result.type === "split" && result.children[0]).toBe(current);
  });

  it("starts a layout when the workspace has no visible terminal yet", () => {
    expect(appendTerminalToLayout(null, "first")).toEqual({ type: "terminal", sessionId: "first" });
  });
});

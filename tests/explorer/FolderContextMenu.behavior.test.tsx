import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderContextMenu, type FolderContextMenuTarget } from "../../src/features/explorer/FolderContextMenu";

afterEach(cleanup);

const target: FolderContextMenuTarget = {
  root: "C:\\work\\repo",
  path: "C:\\work\\repo\\src",
  isWorkspaceRoot: false,
  x: 10,
  y: 10,
};

describe("FolderContextMenu keyboard and dismissal behavior", () => {
  it("closes on Escape and returns focus to the control that opened it", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [visible, setVisible] = useState(false);
      return (
        <div className="app-shell">
          <button type="button" onClick={() => setVisible(true)}>Open folder actions</button>
          <FolderContextMenu target={visible ? target : null} onAction={vi.fn()} onClose={() => setVisible(false)} />
        </div>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open folder actions" });
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "New File" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside the menu", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div className="app-shell">
        <button type="button">Outside</button>
        <FolderContextMenu target={target} onAction={vi.fn()} onClose={onClose} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cycles focus through menu items with ArrowDown and ArrowUp", async () => {
    const user = userEvent.setup();
    render(
      <div className="app-shell">
        <FolderContextMenu target={target} onAction={vi.fn()} onClose={vi.fn()} />
      </div>,
    );
    const items = screen.getAllByRole("menuitem");
    items[0]!.focus();

    await user.keyboard("{ArrowUp}");
    expect(items.at(-1)).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
  });

  it("clamps the menu inside the viewport", () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const originalHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() { return this.classList.contains("folder-context-menu") ? 100 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() { return this.classList.contains("folder-context-menu") ? 80 : 0; },
    });

    try {
      render(
        <div className="app-shell">
          <FolderContextMenu
            target={{ ...target, x: 290, y: 230 }}
            onAction={vi.fn()}
            onClose={vi.fn()}
          />
        </div>,
      );

      expect(screen.getByRole("menu")).toHaveStyle({ left: "192px", top: "152px" });
    } finally {
      cleanup();
      if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth);
      else delete (window as Window & { innerWidth?: number }).innerWidth;
      if (originalHeight) Object.defineProperty(window, "innerHeight", originalHeight);
      else delete (window as Window & { innerHeight?: number }).innerHeight;
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
      if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    }
  });
});

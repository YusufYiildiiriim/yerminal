import { describe, expect, it, vi } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";
import { findUrls, registerUrlLinks } from "../../src/features/terminal/terminalLinks";

describe("findUrls", () => {
  it("returns link offsets and removes trailing punctuation without trimming URL characters", () => {
    expect(findUrls("See https://example.com/a_(b), then http://localhost:1420/app.")).toEqual([
      { start: 4, end: 28, url: "https://example.com/a_(b" },
      { start: 36, end: 61, url: "http://localhost:1420/app" },
    ]);
  });

  it("ignores incomplete schemes and lines without URLs", () => {
    expect(findUrls("https:// http:// www.example.com")).toEqual([]);
  });
});

describe("registerUrlLinks", () => {
  it("registers links from the requested terminal line and gates opening on Ctrl or Meta", () => {
    const line = { translateToString: vi.fn(() => "open https://example.com/path") };
    const getLine = vi.fn(() => line);
    const registerLinkProvider = vi.fn();
    const terminal = { buffer: { active: { getLine } }, registerLinkProvider } as unknown as Terminal;
    const open = vi.fn();
    const hint = vi.fn();

    registerUrlLinks(terminal, { open, hint });
    const provider = registerLinkProvider.mock.calls[0]?.[0] as {
      provideLinks: (lineNumber: number, callback: (links: ILink[] | undefined) => void) => void;
    };
    const callback = vi.fn();
    provider.provideLinks(3, callback);

    expect(getLine).toHaveBeenCalledWith(2);
    const links = callback.mock.calls[0]?.[0] as ILink[];
    expect(links[0]).toMatchObject({
      text: "https://example.com/path",
      range: { start: { x: 6, y: 3 }, end: { x: 29, y: 3 } },
      decorations: { underline: true, pointerCursor: true },
    });

    links[0]?.activate({ ctrlKey: false, metaKey: false } as MouseEvent, links[0].text);
    expect(hint).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    links[0]?.activate({ ctrlKey: true, metaKey: false } as MouseEvent, links[0].text);
    links[0]?.activate({ ctrlKey: false, metaKey: true } as MouseEvent, links[0].text);
    expect(open).toHaveBeenNthCalledWith(1, "https://example.com/path");
    expect(open).toHaveBeenNthCalledWith(2, "https://example.com/path");
  });

  it("reports no links when the requested buffer line is missing", () => {
    const registerLinkProvider = vi.fn();
    const terminal = { buffer: { active: { getLine: vi.fn(() => undefined) } }, registerLinkProvider } as unknown as Terminal;
    registerUrlLinks(terminal, { open: vi.fn(), hint: vi.fn() });
    const provider = registerLinkProvider.mock.calls[0]?.[0] as {
      provideLinks: (lineNumber: number, callback: (links: ILink[] | undefined) => void) => void;
    };
    const callback = vi.fn();

    provider.provideLinks(1, callback);

    expect(callback).toHaveBeenCalledWith(undefined);
  });
});

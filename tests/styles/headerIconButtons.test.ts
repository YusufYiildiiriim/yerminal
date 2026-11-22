import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, THEMES, themeTokens, SURFACES } from "./contrastTokens";

const srcDir = join(process.cwd(), "src");

function listCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listCss(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

const css = listCss(srcDir)
  .map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");

/** Declarations of every rule whose selector list contains `selector` (whitespace-normalised), joined. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim().replace(/\s+/g, " ")).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

const HEADER_ICON = ".app-shell[data-theme] .workspace-terminal-groups-header .ib";
const HEADER_ICON_HOVER = ".app-shell[data-theme] .workspace-terminal-groups-header .ib:hover";
const HEADER_ICON_FOCUS = ".app-shell[data-theme] .workspace-terminal-groups-header .ib:focus-visible";
const HEADER = ".app-shell[data-theme] .workspace-terminal-groups-header";
const PANE_ICON = ".app-shell[data-theme] .pane-icon-button";
const HEADER_ICON_SVG = ".app-shell[data-theme] .workspace-terminal-groups-header .ib svg";
const PANE_ICON_SVG = ".app-shell[data-theme] .pane-icon-button svg";
const PANE_HEADER = ".app-shell[data-theme] .terminal-pane-frame.tiled-pane .terminal-pane-header";
const PANE_ICON_FOCUS = ".app-shell[data-theme] .pane-icon-button:focus-visible";

describe("terminal groups header icon buttons: size and colour", () => {
  it("defines a 32 px icon hit size as a shared token", () => {
    const typography = readFileSync(join(srcDir, "styles", "typography.css"), "utf8");
    expect(typography).toMatch(/--hit-icon:\s*32px/);
  });

  it("uses the same hit-size token for the pane header icon buttons", () => {
    const body = ruleBody(PANE_ICON);
    expect(body).toMatch(/width:\s*var\(--hit-icon\)/);
    expect(body).toMatch(/height:\s*var\(--hit-icon\)/);
    expect(body).not.toMatch(/(?<![\w-])(?:width|height):\s*\d+px/);
    expect(body).toMatch(/flex:\s*none/);
  });

  it("scales the glyph with the larger hit area (16 px svg in both headers)", () => {
    expect(ruleBody(HEADER_ICON_SVG)).toMatch(/width:\s*16px/);
    expect(ruleBody(HEADER_ICON_SVG)).toMatch(/height:\s*16px/);
    expect(ruleBody(PANE_ICON_SVG)).toMatch(/width:\s*16px/);
  });

  it("keeps the 36 px pane header tall enough for the 32 px button", () => {
    const height = Number(ruleBody(PANE_HEADER).match(/(?<![\w-])height:\s*(\d+)px/)?.[1] ?? 0);
    expect(height).toBeGreaterThanOrEqual(32);
  });

  it("uses the hit-size token for width and height and never a fixed pixel size", () => {
    const body = ruleBody(HEADER_ICON);
    expect(body).toMatch(/width:\s*var\(--hit-icon\)/);
    expect(body).toMatch(/height:\s*var\(--hit-icon\)/);
    expect(body).not.toMatch(/(?<![\w-])(?:width|height):\s*\d+px/);
  });

  it("draws the icon in the primary text token, not the muted one", () => {
    const body = ruleBody(HEADER_ICON);
    expect(body).toMatch(/color:\s*var\(--theme-text\)/);
    expect(body).not.toMatch(/color:\s*var\(--text-muted\)/);
  });

  it("keeps the header on one line so narrow panels truncate the title, not the icons", () => {
    expect(ruleBody(HEADER)).toMatch(/flex-wrap:\s*nowrap/);
    expect(ruleBody(".app-shell[data-theme] .workspace-section-header h2")).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe("terminal groups header icon buttons: hover and focus", () => {
  it("shows a background and a border on hover", () => {
    const body = ruleBody(HEADER_ICON_HOVER);
    expect(body).toMatch(/background:/);
    expect(body).toMatch(/border-color:/);
  });

  it("shows a visible keyboard focus outline in the accent token", () => {
    const body = ruleBody(HEADER_ICON_FOCUS);
    expect(body).toMatch(/outline:\s*(?:1|2)px solid var\(--theme-accent\)/);
    expect(body).toMatch(/outline-offset:/);
  });

  it("gives the pane header icon buttons the same primary colour and visible focus", () => {
    expect(ruleBody(PANE_ICON)).toMatch(/color:\s*var\(--theme-text\)/);
    expect(ruleBody(PANE_ICON_FOCUS)).toMatch(/outline:\s*(?:1|2)px solid var\(--theme-accent\)/);
  });
});

describe("terminal groups header icon contrast", () => {
  const tokens = themeTokens();
  for (const theme of THEMES) {
    it(`icon colour reaches 3:1 on every ${theme} surface`, () => {
      const icon = tokens[theme]["--theme-text"];
      const worst = Math.min(...SURFACES.map((surface) => contrast(icon, tokens[theme][surface])));
      expect(worst, `${theme} --theme-text ${icon}`).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("terminal groups header icon buttons: labels and tooltips", () => {
  const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
  const headerStart = app.indexOf("workspace-section-header workspace-terminal-groups-header");
  const headerEnd = app.indexOf("</header>", headerStart);
  const header = app.slice(headerStart, headerEnd);
  const buttons = header.split("<button").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("</button>")));

  it("finds the four header icon buttons (three actions and the collapse toggle)", () => {
    expect(buttons).toHaveLength(4);
  });

  it("gives every header icon button an aria-label and a title", () => {
    for (const button of buttons) {
      expect(button, button).toMatch(/aria-label=["{]/);
      expect(button, button).toMatch(/title=["{]/);
    }
  });
});

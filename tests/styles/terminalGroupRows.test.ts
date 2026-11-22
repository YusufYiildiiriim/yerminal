import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

const ROW = ".app-shell[data-theme] .workspace-terminal-group-header";
const ROW_SELECT = ".app-shell[data-theme] .workspace-terminal-group-select";
const ACT = ".app-shell[data-theme] .workspace-terminal-group-acts .ib";
const ACT_SVG = ".app-shell[data-theme] .workspace-terminal-group-acts .ib svg";
const ACT_HOVER = ".app-shell[data-theme] .workspace-terminal-group-acts .ib:hover";
const ACT_FOCUS = ".app-shell[data-theme] .workspace-terminal-group-acts .ib:focus-visible";
const NAME = ".app-shell[data-theme] .workspace-terminal-group-name";

describe("terminal group rows: action icon buttons", () => {
  it("uses the shared 32 px hit-size token for width and height", () => {
    const body = ruleBody(ACT);
    expect(body).toMatch(/width:\s*var\(--hit-icon\)/);
    expect(body).toMatch(/height:\s*var\(--hit-icon\)/);
    expect(body).toMatch(/flex(?:-basis)?:\s*(?:0 0 )?var\(--hit-icon\)|flex:\s*0 0 var\(--hit-icon\)/);
    expect(body).not.toMatch(/(?<![\w-])(?:width|height|flex-basis):\s*\d+px/);
  });

  it("draws the glyph at 16 px, like the header icon buttons", () => {
    const body = ruleBody(ACT_SVG);
    expect(body).toMatch(/width:\s*16px/);
    expect(body).toMatch(/height:\s*16px/);
  });

  it("draws the icons in the primary text token", () => {
    const body = ruleBody(ACT);
    expect(body).toMatch(/color:\s*var\(--theme-text\)/);
    expect(body).not.toMatch(/color:\s*var\(--text-muted\)/);
  });

  it("shows a background and a border on hover and a visible focus outline", () => {
    expect(ruleBody(ACT_HOVER)).toMatch(/background:/);
    expect(ruleBody(ACT_HOVER)).toMatch(/border-color:/);
    expect(ruleBody(ACT_FOCUS)).toMatch(/outline:\s*2px solid var\(--theme-accent\)/);
  });

  it("keeps the action icons visible when a row or the icon has keyboard focus", () => {
    const rules = ruleBody(".app-shell[data-theme] .workspace-terminal-group-acts:focus-within");
    expect(rules).toMatch(/display:\s*flex/);
  });
});

describe("terminal group rows: height and truncation", () => {
  it("sizes the row to the 32 px icon token instead of a fixed 26 px", () => {
    const body = ruleBody(ROW);
    expect(body).toMatch(/height:\s*var\(--hit-icon\)/);
    expect(body).not.toMatch(/(?<![\w-])height:\s*26px/);
    expect(ruleBody(ROW_SELECT)).toMatch(/height:\s*var\(--hit-icon\)/);
  });

  it("truncates the group name with an ellipsis instead of wrapping", () => {
    const body = ruleBody(NAME);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});

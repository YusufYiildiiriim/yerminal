import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES, themeTokens } from "./contrastTokens";

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

/** Splits a selector list on commas that are not inside parentheses, e.g. :not(a, b). */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim().replace(/\s+/g, " "));
}

/** Declarations of every rule whose selector list contains `selector` (whitespace-normalised), joined. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+){([^}]*)}/g)]
    .filter((match) => splitTopLevel(match[1]).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

/** The selector list of the shared scrollbar rule (scoped to the app chrome, excluding editor and terminal). */
const SHARED = ".app-shell[data-theme] :where(*):not(.xterm, .xterm *, .monaco-editor, .monaco-editor *, .code-editor-content, .terminal-instance, .terminal-instance *, .terminal-layout-scrollport, .terminal-layout-scrollport *)";
const SHARED_THUMB = `${SHARED}::-webkit-scrollbar-thumb`;
const SHARED_THUMB_HOVER = `${SHARED}::-webkit-scrollbar-thumb:hover`;
const SHARED_TRACK = `${SHARED}::-webkit-scrollbar-track`;

describe("shared sidebar scrollbar", () => {
  it("defines the thumb and hover tokens once on the app shell, from the text token", () => {
    const shell = ruleBody(".app-shell[data-theme]");
    expect(shell).toMatch(/--scroll-thumb:\s*color-mix\(in srgb, var\(--theme-text\) \d+%, transparent\)/);
    expect(shell).toMatch(/--scroll-thumb-hover:\s*color-mix\(in srgb, var\(--theme-text\) \d+%, transparent\)/);
  });

  it("applies a thin standard scrollbar in the thumb token on a transparent track to the app chrome", () => {
    const body = ruleBody(SHARED);
    expect(body).toMatch(/scrollbar-width:\s*thin/);
    expect(body).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/);
  });

  it("keeps the WebKit fallback thin, transparent on the track and corner, with a rounded thumb", () => {
    expect(ruleBody(`${SHARED}::-webkit-scrollbar`)).toMatch(/width:\s*8px/);
    expect(ruleBody(SHARED_TRACK)).toMatch(/background:\s*transparent/);
    expect(ruleBody(`${SHARED}::-webkit-scrollbar-corner`)).toMatch(/background:\s*transparent/);
    const thumb = ruleBody(SHARED_THUMB);
    expect(thumb).toMatch(/border-radius:\s*\d+px/);
    expect(thumb).toMatch(/background-color:\s*var\(--scroll-thumb\)/);
  });

  it("makes the thumb more visible on hover", () => {
    expect(ruleBody(SHARED_THUMB_HOVER)).toMatch(/background-color:\s*var\(--scroll-thumb-hover\)/);
  });

  it("no longer forces the system scrollbar with scrollbar-width: auto anywhere in the app chrome", () => {
    expect(css).not.toMatch(/\.app-shell\[data-theme\] \*\s*\{[^}]*scrollbar-width:\s*auto/);
  });

  it("leaves the editor and the terminal to their own scrollbar styling", () => {
    for (const excluded of [".xterm", ".monaco-editor", ".code-editor-content", ".terminal-instance"]) {
      expect(SHARED, excluded).toContain(excluded);
    }
  });

  it("defines the thumb token for all three themes through the text token", () => {
    const tokens = themeTokens();
    for (const theme of THEMES) expect(tokens[theme]["--theme-text"], theme).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("agent usage section at the bottom of the sidebar", () => {
  const SECTION = ".sidebar-agent-usage";
  const TOGGLE = ".sidebar-agent-toggle";

  it("does not shrink below its content, so the header is never pushed under the divider", () => {
    const body = ruleBody(SECTION);
    expect(body).toMatch(/flex:\s*0 0 auto/);
    expect(body).toMatch(/min-height:\s*auto/);
  });

  it("keeps the header a full row with its own background above neighbouring borders", () => {
    const toggle = ruleBody(TOGGLE);
    expect(toggle).toMatch(/flex:\s*(?:none|0 0 auto)/);
    expect(toggle).toMatch(/min-height:\s*3[2-9]px/);
    expect(toggle).toMatch(/position:\s*relative/);
    expect(toggle).toMatch(/z-index:\s*[1-9]/);
    expect(toggle).toMatch(/background:\s*var\(--theme-surface\)/);
  });

  it("draws the divider once, on the section, not on the header", () => {
    expect(ruleBody(SECTION)).toMatch(/border-top:\s*1px solid var\(--theme-border\)/);
    expect(ruleBody(TOGGLE)).not.toMatch(/border-(?:top|bottom):\s*1px/);
  });

  it("uses the type scale for the header, so Interface size Large grows it without clipping", () => {
    expect(ruleBody(TOGGLE)).toMatch(/font:\s*600 var\(--fs-sm\) var\(--font-ui\)/);
  });
});

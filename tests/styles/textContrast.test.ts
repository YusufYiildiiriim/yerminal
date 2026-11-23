import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const srcDir = join(root, "src");
const THEMES = ["obsidian", "nordic", "foundry"] as const;
const SURFACES = ["--theme-background", "--theme-surface", "--theme-raised", "--theme-chrome", "--theme-editor", "--theme-terminal"];
const TEXT_TOKENS = ["--text-muted", "--text-amber", "--text-green", "--text-violet"];
const FILL_TOKENS = ["--fill-amber", "--fill-green", "--fill-violet"];

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
function listCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listCss(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function parseDeclarations(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const part of body.split(";")) {
    const match = part.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s);
    if (match) decls[match[1]] = match[2];
  }
  return decls;
}

/** Effective custom properties per theme: the shared `.app-shell[data-theme]` block, then the theme block. */
function themeTokens(): Record<string, Record<string, string>> {
  const themesCss = stripComments(readFileSync(join(srcDir, "styles/themes.css"), "utf8"));
  const base: Record<string, string> = {};
  const overrides: Record<string, Record<string, string>> = {};
  for (const match of themesCss.matchAll(/\.app-shell\[data-theme(?:="(\w+)")?\]\s*\{([^}]*)\}/g)) {
    const [, theme, body] = match;
    const decls = parseDeclarations(body);
    if (theme) overrides[theme] = { ...(overrides[theme] ?? {}), ...decls };
    else Object.assign(base, decls);
  }
  return Object.fromEntries(THEMES.map((theme) => [theme, { ...base, ...(theme === "obsidian" ? {} : overrides[theme]) }]));
}

describe("WCAG contrast helper", () => {
  it("returns 21:1 for black on white and 1:1 for identical colors", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#808290", "#808290")).toBeCloseTo(1, 5);
  });
});

describe("theme text tokens", () => {
  const tokens = themeTokens();

  it("keeps the agreed Obsidian values", () => {
    const obsidian = tokens.obsidian;
    expect(obsidian["--text-muted"]).toBe("#808290");
    expect(obsidian["--text-amber"]).toBe("#d99a3e");
    expect(obsidian["--text-green"]).toBe("#2fb070");
    expect(obsidian["--text-violet"]).toBe("#a99cf7");
  });

  it("defines the dark fill tokens once for every theme", () => {
    for (const theme of THEMES) {
      for (const token of FILL_TOKENS) expect(tokens[theme][token], `${theme} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(tokens.obsidian["--fill-amber"]).toBe("#a3650f");
    expect(tokens.obsidian["--fill-green"]).toBe("#1c7a48");
    expect(tokens.obsidian["--fill-violet"]).toBe("#35227a");
  });

  for (const theme of THEMES) {
    for (const token of TEXT_TOKENS) {
      it(`${token} reaches 4.5:1 on every ${theme} surface`, () => {
        const value = tokens[theme][token];
        expect(value, `${theme} ${token} missing`).toMatch(/^#[0-9a-f]{6}$/i);
        const worst = Math.min(...SURFACES.map((surface) => contrast(value, tokens[theme][surface])));
        expect(worst, `${theme} ${token} ${value}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("text color usage", () => {
  const cssFiles = listCss(srcDir).map((file) => ({ file: relative(root, file), css: stripComments(readFileSync(file, "utf8")) }));

  it("sets muted text with --text-muted instead of the surface muted token", () => {
    const hits = cssFiles.flatMap(({ file, css }) => (css.match(/(?<![-\w])color\s*:\s*var\(--(?:theme-muted|muted)\b/g) ?? []).map(() => file));
    expect(hits).toEqual([]);
  });

  it("moves success text onto --text-green", () => {
    const hits = cssFiles.flatMap(({ file, css }) => (css.match(/(?<![-\w])color\s*:\s*var\(--(?:theme-success|green)\b/g) ?? []).map(() => file));
    expect(hits).toEqual([]);
  });

  it("does not keep grey text colors below 4.5:1 on the dark panels", () => {
    const failingGreys = ["#777984", "#777b88", "#777a85", "#767985", "#747782", "#747680", "#737580", "#727580", "#6e717c", "#656771", "#646772", "#62646d"];
    const hits = cssFiles.flatMap(({ file, css }) => {
      const found = [...css.matchAll(/(?<![-\w])color\s*:\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => m[1].toLowerCase());
      return found.filter((hex) => failingGreys.includes(hex)).map((hex) => `${file} ${hex}`);
    });
    expect(hits).toEqual([]);
  });

  it("maps hard-coded status and prompt accents onto the amber, green and violet text tokens", () => {
    const legacy = ["#d3ae70", "#d2ac79", "#7dc99a", "#8ccca5", "#8fcba6", "#aaa9dd", "#a99aff", "#afa0ff"];
    const hits = cssFiles.flatMap(({ file, css }) => {
      const found = [...css.matchAll(/(?<![-\w])color\s*:\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => m[1].toLowerCase());
      return found.filter((hex) => legacy.includes(hex)).map((hex) => `${file} ${hex}`);
    });
    expect(hits).toEqual([]);
  });
});

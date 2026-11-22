import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const srcDir = join(root, "src");

function listCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listCss(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const cssFiles = listCss(srcDir);
const cssText = cssFiles.map((file) => ({ file: relative(root, file), css: stripComments(readFileSync(file, "utf8")) }));

/** Type scale from the design decision (#24). Every literal UI font-size must land on one of these. */
const SCALE_PX = [11, 12, 13, 15, 18];

/** Literal px sizes used as font-size, either as a property or as the first value of a `font:` shorthand. */
function literalFontSizes(css: string): number[] {
  const sizes: number[] = [];
  for (const match of css.matchAll(/(?<![\w-])font-size\s*:\s*([^;}]+)/g)) {
    for (const px of match[1].matchAll(/(\d*\.?\d+)px/g)) sizes.push(Number(px[1]));
  }
  for (const match of css.matchAll(/(?<![\w-])font\s*:\s*([^;}]+)/g)) {
    // A px right after "/" is the line-height in `font: 12px/1.5`, not the font size.
    const px = match[1].match(/(?<![\/\w.-])(\d*\.?\d+)px/);
    if (px) sizes.push(Number(px[1]));
  }
  return sizes;
}

describe("typography tokens", () => {
  it("declares Geist UI and Geist Mono tokens exactly once", () => {
    const uiDeclarations = cssText.flatMap(({ file, css }) => (css.match(/--font-ui\s*:/g) ?? []).map(() => file));
    const monoDeclarations = cssText.flatMap(({ file, css }) => (css.match(/--font-mono-ui\s*:/g) ?? []).map(() => file));
    expect(uiDeclarations).toHaveLength(1);
    expect(monoDeclarations).toHaveLength(1);
    const typography = cssText.find(({ file }) => file.endsWith("typography.css"));
    expect(typography?.css).toMatch(/--font-ui\s*:\s*"Geist Variable"/);
    expect(typography?.css).toMatch(/--font-mono-ui\s*:\s*"Geist Mono Variable"/);
  });

  it("defines the five type scale tokens", () => {
    const typography = cssText.find(({ file }) => file.endsWith("typography.css"));
    expect(typography?.css).toMatch(/--fs-xs\s*:\s*11px/);
    expect(typography?.css).toMatch(/--fs-sm\s*:\s*12px/);
    expect(typography?.css).toMatch(/--fs-md\s*:\s*13px/);
    expect(typography?.css).toMatch(/--fs-lg\s*:\s*15px/);
    expect(typography?.css).toMatch(/--fs-xl\s*:\s*18px/);
  });

  it("bundles Geist and Geist Mono as npm packages instead of loading them remotely", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@fontsource-variable/geist"]).toBeDefined();
    expect(pkg.dependencies["@fontsource-variable/geist-mono"]).toBeDefined();
    expect(existsSync(join(root, "node_modules/@fontsource-variable/geist"))).toBe(true);
    expect(existsSync(join(root, "node_modules/@fontsource-variable/geist-mono"))).toBe(true);
  });

  it("does not reference remote font hosts or CSS imports from the network", () => {
    const remote = cssText.filter(({ css }) => /fonts\.googleapis|fonts\.gstatic|@import\s+url\(\s*["']?https?:/i.test(css));
    expect(remote.map(({ file }) => file)).toEqual([]);
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});

describe("font family usage", () => {
  it("leaves no bare Inter family in src css", () => {
    const hits = cssText.flatMap(({ file, css }) => (css.match(/(?<![\w-])Inter(?![\w-])/g) ?? []).map(() => file));
    expect(hits).toEqual([]);
  });
});

describe("font size scale", () => {
  it("never sets a literal font-size below 11px", () => {
    const small = cssText.flatMap(({ file, css }) => literalFontSizes(css).filter((px) => px < 11).map((px) => `${file}: ${px}px`));
    expect(small).toEqual([]);
  });

  it("uses only the five scale steps for literal font sizes", () => {
    const offScale = cssText.flatMap(({ file, css }) =>
      literalFontSizes(css).filter((px) => !SCALE_PX.includes(px)).map((px) => `${file}: ${px}px`),
    );
    expect(offScale).toEqual([]);
  });
});

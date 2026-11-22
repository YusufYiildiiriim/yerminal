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

function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim().replace(/\s+/g, " ")).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

describe("branch picker popover as an overlay", () => {
  it("is fixed-position above the content, so it never takes part in the row layout", () => {
    const popover = ruleBody(".bp-popover");
    expect(popover).toMatch(/position:\s*fixed/);
    expect(popover).not.toMatch(/position:\s*(?:absolute|static|relative)/);
    expect(popover).toMatch(/z-index:\s*\d{2,}/);
  });

  it("no longer flows the popover in the repository's action row", () => {
    expect(css).not.toMatch(/\.git-repository-branch-row \.bp-popover\s*\{[^}]*position:\s*static/);
  });

  it("scrolls its own list and keeps the popover inside the viewport height", () => {
    expect(ruleBody(".bp-list")).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody(".bp-popover")).toMatch(/max-height:/);
  });

  it("uses no literal pixel font sizes below 11 px in the picker", () => {
    const picker = readFileSync(join(srcDir, "features", "git", "branch-picker.css"), "utf8");
    for (const match of picker.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(match[1])).toBeGreaterThanOrEqual(11);
  });
});

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

const ROW = ".tool-content .change-row";
const ROW_HOVER = ".tool-content .change-row:hover";
const ROW_FOCUS = ".tool-content .change-row:focus-within";
const MAIN_HOVER = ".tool-content .change-row:hover .change-main-row";
const MAIN_FOCUS = ".tool-content .change-row:focus-within .change-main-row";
const ACTIONS = ".tool-content .change-row-actions";

describe("Git Changes row actions: overlay matches the row hover tint", () => {
  it("defines one row tint token on the row and uses it for hover and focus", () => {
    expect(ruleBody(ROW)).toMatch(/--change-row-tint:\s*color-mix\(in srgb, var\(--theme-accent, #b3a3ee\) 10%, var\(--theme-surface, #19191f\)\)/);
    expect(ruleBody(ROW_HOVER)).toMatch(/background:\s*var\(--change-row-tint\)/);
    expect(ruleBody(ROW_FOCUS)).toMatch(/background:\s*var\(--change-row-tint\)/);
  });

  it("paints the overlay with the row tint instead of the card body colour", () => {
    const body = ruleBody(ACTIONS);
    expect(body).toMatch(/background:\s*var\(--change-row-tint\)/);
    expect(body).not.toMatch(/background:\s*var\(--git-card-body\)/);
  });

  it("keeps the overlay pointer-free until the row is hovered or focused", () => {
    expect(ruleBody(ACTIONS)).toMatch(/pointer-events:\s*none/);
    expect(ruleBody(ROW_HOVER + " .change-row-actions")).toMatch(/pointer-events:\s*auto/);
  });
});

describe("Git Changes row actions: the file name and badge stay readable under the overlay", () => {
  it("reserves right padding on the main row while the overlay is shown", () => {
    for (const selector of [MAIN_HOVER, MAIN_FOCUS]) {
      const match = ruleBody(selector).match(/padding-right:\s*(\d+)px/);
      expect(match, selector).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThanOrEqual(48);
    }
  });
});

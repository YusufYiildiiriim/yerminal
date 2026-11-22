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

/** Spacing values (margin, padding, gap) of a rule. Each value must be 0, auto or a spacing token. */
function spacingValues(body: string): string[] {
  return [...body.matchAll(/(?<![\w-])(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?\s*:\s*([^;]+)/g)]
    .map((match) => match[1].trim());
}

const TOKEN_OR_ZERO = /^(?:0|auto|var\(--space-[1-4]\))(?:\s+(?:0|auto|var\(--space-[1-4]\)))*$/;

/** Git Changes and History rules that the spacing rhythm covers (repo block, toolbar, headings, commit and file rows). */
const RHYTHM_SELECTORS = [
  ".sync-bar",
  ".change-view-bar",
  ".git-changes-view .git-repository-list",
  ".git-repository-toggle",
  ".git-repository-branch-row",
  ".gb-sec",
  ".gb-commits",
  ".gb-commit",
  ".gb-detail",
  ".gb-file",
  ".hist-toggle",
  ".hist-section",
  ".gb-more",
];

describe("spacing tokens", () => {
  it("defines the four shared spacing steps in typography.css next to the type scale", () => {
    const typography = readFileSync(join(srcDir, "styles", "typography.css"), "utf8");
    expect(typography).toMatch(/--space-1:\s*4px/);
    expect(typography).toMatch(/--space-2:\s*8px/);
    expect(typography).toMatch(/--space-3:\s*12px/);
    expect(typography).toMatch(/--space-4:\s*16px/);
  });
});

describe("Git Changes and History spacing rhythm", () => {
  it.each(RHYTHM_SELECTORS)("%s uses only spacing tokens for margin, padding and gap", (selector) => {
    const values = spacingValues(ruleBody(selector));
    for (const value of values) expect(value, `${selector}: ${value}`).toMatch(TOKEN_OR_ZERO);
  });

  it("does not clamp rows or headings to fixed pixel heights", () => {
    for (const selector of [".gb-sec", ".gb-commit", ".gb-file", ".hist-toggle", ".gb-more", ".sync-button"]) {
      expect(ruleBody(selector), selector).not.toMatch(/(?<![\w-])height:\s*\d+px/);
    }
  });

  it("gives commit subject and hash/time lines their own gap", () => {
    expect(ruleBody(".gb-commit")).toMatch(/gap:\s*var\(--space-1\)/);
  });

  it("separates the section heading from its content with a token margin", () => {
    expect(ruleBody(".gb-sec")).toMatch(/margin:\s*var\(--space-3\)\s+0\s+var\(--space-1\)/);
  });
});

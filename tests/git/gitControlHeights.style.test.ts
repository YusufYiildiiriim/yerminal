import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom does not lay out boxes, so these guards check the shipped CSS: one control height ladder for the Git panels.
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

const typography = readFileSync(join(srcDir, "styles", "typography.css"), "utf8");

const BRANCH_TRIGGER = ".bp-trigger";
const BRANCH_ADD = ".bp-add";
const SEGMENT_TAB = ".app-shell[data-theme] .git-tool-switch .tool-primary-switch-item";
const REPO_SELECT = ".gg-repo-picker select";
const CARD_BAND = ".git-card-band";
const ACTION_ROW = ".git-action-row";
const HISTORY_TOGGLE = ".hist-toggle";

describe("shared control height ladder", () => {
  it("defines --control-h-md as the --hit-icon token (one source for 32 px) and --control-h-lg as 36 px", () => {
    expect(typography).toMatch(/--control-h-md:\s*var\(--hit-icon\)/);
    expect(typography).toMatch(/--control-h-lg:\s*36px/);
  });

  it("sets every sync button (push, pull, sync and the More button) to the 32 px token, keeping its 72 px minimum width", () => {
    const body = ruleBody(".sync-button");
    expect(body).toMatch(/(?<![\w-])min-height:\s*var\(--control-h-md\)/);
    expect(body).not.toMatch(/(?<![\w-])min-height:\s*\d+px/);
    expect(body).toMatch(/min-width:\s*72px/);
  });

  it("sets the branch trigger height from the 32 px token, not a fixed 24 px", () => {
    expect(ruleBody(BRANCH_TRIGGER)).toMatch(/(?<![\w-])height:\s*var\(--control-h-md\)/);
  });

  it("sets the Git Graph + button to the 32 px token on both sides", () => {
    const body = ruleBody(BRANCH_ADD);
    expect(body).toMatch(/(?<![\w-])width:\s*var\(--control-h-md\)/);
    expect(body).toMatch(/(?<![\w-])height:\s*var\(--control-h-md\)/);
  });

  it("gives the + glyph the 16 px size of the 32 px header icons", () => {
    expect(ruleBody(`${BRANCH_ADD} svg`)).toMatch(/width:\s*16px/);
    expect(ruleBody(`${BRANCH_ADD} svg`)).toMatch(/height:\s*16px/);
  });

  it("sets the Git Changes / Git Graph segment tabs to at least the 32 px token", () => {
    expect(ruleBody(SEGMENT_TAB)).toMatch(/(?<![\w-])height:\s*var\(--control-h-md\)/);
  });

  it("sets the repository select to the 36 px token", () => {
    expect(ruleBody(REPO_SELECT)).toMatch(/(?<![\w-])height:\s*var\(--control-h-lg\)/);
  });

  it("keeps none of the branch and tab controls on a fixed 22, 24 or 26 px height", () => {
    for (const selector of [BRANCH_TRIGGER, BRANCH_ADD, SEGMENT_TAB, REPO_SELECT]) {
      expect(ruleBody(selector), selector).not.toMatch(/(?<![\w-])height:\s*\d+px/);
    }
  });
});

describe("Git Changes card rhythm", () => {
  it("gives the card header band the 32 px control height and token padding", () => {
    const band = ruleBody(CARD_BAND);
    expect(band).toMatch(/min-height:\s*var\(--control-h-md\)/);
    expect(band).toMatch(/padding:\s*var\(--space-1\)\s+var\(--space-2\)/);
  });

  it("trims the action row bottom to the 8 px token so the branch row sits closer to History", () => {
    expect(ruleBody(ACTION_ROW)).toMatch(/padding:\s*var\(--space-3\)\s+var\(--space-3\)\s+var\(--space-2\)/);
  });

  it("uses a 4 px or 8 px token above the History toggle", () => {
    expect(ruleBody(HISTORY_TOGGLE)).toMatch(/margin-top:\s*var\(--space-[12]\)/);
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, THEMES, themeTokens } from "../styles/contrastTokens";

const srcDir = join(process.cwd(), "src");

function listCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listCss(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

const cardsCss = readFileSync(join(srcDir, "features", "git", "git-cards.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const themesCss = readFileSync(join(srcDir, "styles", "themes.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const allCss = listCss(srcDir)
  .map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");

/** Declarations of the rule whose selector list contains `selector` in the card stylesheet. */
function ruleBody(selector: string, source = cardsCss): string {
  const bodies = [...source.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim().replace(/\s+/g, " ")).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

describe("Git Changes section cards: tones come from the theme tokens, defined once", () => {
  for (const token of ["--git-card-band", "--git-card-body", "--git-card-rule"]) {
    it(`defines ${token} once in themes.css`, () => {
      expect(themesCss.match(new RegExp(`${token}\\s*:`, "g")) ?? []).toHaveLength(1);
    });
  }

  it("builds the band from the repository surface and the body from the recessed background token", () => {
    expect(themesCss).toMatch(/--git-card-band:\s*var\(--theme-surface\)/);
    expect(themesCss).toMatch(/--git-card-body:\s*var\(--theme-background\)/);
  });

  it("uses no literal colours in the card stylesheet", () => {
    expect(cardsCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(cardsCss).not.toMatch(/\brgba?\(/);
  });
});

describe("Git Changes section cards: structure and scroll", () => {
  it("separates cards by 16 px", () => {
    expect(ruleBody(".git-cards")).toMatch(/gap:\s*16px/);
  });

  it("gives the header band the surface tone, a rule under it and a 12 px / 600 title", () => {
    const band = ruleBody(".git-card-band");
    expect(band).toMatch(/background:\s*var\(--git-card-band\)/);
    expect(band).toMatch(/border-bottom:\s*1px solid var\(--git-card-rule\)/);
    expect(ruleBody(".git-card-title")).toMatch(/font:\s*600 var\(--fs-sm\)|font-size:\s*var\(--fs-sm\)[^}]*font-weight:\s*600|font-weight:\s*600[^}]*font-size:\s*var\(--fs-sm\)/);
    expect(ruleBody(".git-card-title")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("recesses the body with its own tone, rounded corners and 8 px padding", () => {
    const body = ruleBody(".git-card-body");
    expect(body).toMatch(/background:\s*var\(--git-card-body\)/);
    expect(body).toMatch(/border-radius:\s*8px/);
    expect(body).toMatch(/padding:\s*8px/);
  });

  it("bounds each body to about six and a half rows and scrolls it on its own", () => {
    const body = ruleBody(".git-card-body");
    expect(body).toMatch(/max-height:\s*198px/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it("turns the chevron when a card is collapsed", () => {
    expect(ruleBody(".git-card.is-collapsed .git-card-chev")).toMatch(/rotate\(-90deg\)/);
  });

  it("keeps the band a full button with a visible keyboard focus outline", () => {
    expect(ruleBody(".git-card-band:focus-visible")).toMatch(/outline:\s*2px solid var\(--theme-accent\)/);
  });
});

describe("Git Changes section cards: type, width and the narrow action row", () => {
  it("never sets text below 11 px in the card stylesheet", () => {
    const sizes = [...cardsCss.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11);
  });

  it("collapses the action row labels in a narrow container instead of clipping", () => {
    expect(ruleBody(".git-action-row")).toMatch(/container-type:\s*inline-size/);
    expect(cardsCss).toMatch(/@container \(max-width: \d+px\)\s*\{[^}]*\.git-action-label[^}]*display:\s*none/);
  });

  it("keeps the repository summary on one line that truncates", () => {
    const summary = ruleBody(".git-repository-counts", allCss);
    expect(summary).toMatch(/text-overflow:\s*ellipsis/);
    expect(summary).toMatch(/white-space:\s*nowrap/);
    expect(allCss).toMatch(/\.git-repository-counts/);
  });
});

describe("Git Changes section cards: text contrast in every theme", () => {
  const tokens = themeTokens();
  for (const theme of THEMES) {
    it(`reaches 4.5:1 for the title and the count on band and body in ${theme}`, () => {
      const band = tokens[theme]["--theme-surface"];
      const body = tokens[theme]["--theme-background"];
      const title = tokens[theme]["--theme-text"];
      const count = tokens[theme]["--text-muted"];
      for (const [name, value] of [["title", title], ["count", count]] as const) {
        expect(contrast(value, band), `${theme} ${name} on band`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(value, body), `${theme} ${name} on body`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("Git Changes action row: spacing under the header and a shared inset with the cards", () => {
  const horizontal = (body: string) => body.match(/padding:\s*[^;]*?(var\(--space-\d\)|\d+px)(?:\s+(?:var\(--space-\d\)|\d+px|0))*/)?.[0] ?? "";

  it("keeps a token gap between the repository summary and the action row", () => {
    expect(ruleBody(".git-action-row")).toMatch(/padding(?:-top)?:\s*var\(--space-3\)|padding:\s*var\(--space-3\)/);
  });

  it("keeps a token gap between the action row and the first card", () => {
    expect(ruleBody(".git-action-row")).toMatch(/padding:\s*var\(--space-3\)|padding-bottom:\s*var\(--space-3\)/);
  });

  it("insets the action row by the same token as the card stack", () => {
    const cards = ruleBody(".git-cards");
    const row = ruleBody(".git-action-row");
    expect(cards).toMatch(/padding:[^;]*var\(--space-3\)/);
    expect(row).toMatch(/var\(--space-3\)/);
    expect(horizontal(cards)).toMatch(/var\(--space-3\)/);
    expect(row).not.toMatch(/padding:\s*\d+px/);
  });

  it("does not use a literal pixel inset for the card stack", () => {
    expect(ruleBody(".git-cards")).not.toMatch(/padding:[^;]*\b\d+px\b/);
  });

  it("keeps the 32 px icon buttons in the action row", () => {
    expect(allCss).toMatch(/\.sync-bar \.sync-more \{[^}]*width:\s*var\(--hit-icon\)/);
  });
});

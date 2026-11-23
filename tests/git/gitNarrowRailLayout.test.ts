import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom does not lay out boxes, so these guards check the shipped CSS and markup for the Git Changes rail at its minimum width.
const srcDir = join(process.cwd(), "src");

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path, ext);
    return name.endsWith(ext) ? [path] : [];
  });
}

const css = listFiles(srcDir, ".css")
  .map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");

/** Declarations of every top-level rule whose selector list contains `selector`, joined. */
function ruleBody(selector: string, source = css): string {
  const bodies = [...source.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim().replace(/\s+/g, " ")).includes(selector))
    .map((match) => match[2]);
  return bodies.join(";");
}

/** Inner CSS of every @container block whose condition is `max-width` (the block closes with a `}` at column 0). */
function narrowContainers(): string {
  return [...css.matchAll(/@container\s*\(max-width:\s*\d+px\)\s*\{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");
}

const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
const outgoing = readFileSync(join(srcDir, "features", "git", "OutgoingCommits.tsx"), "utf8");
const history = readFileSync(join(srcDir, "features", "git", "HistorySection.tsx"), "utf8");
const sidebar = readFileSync(join(srcDir, "features", "workspace", "sidebarWidth.ts"), "utf8");

describe("Git Changes action row stacks in the narrow rail instead of crushing the branch picker", () => {
  it("makes the repository body the size container so the rail width can drive the layout", () => {
    expect(ruleBody(".git-repository-body")).toMatch(/container-type:\s*inline-size/);
  });

  it("stacks the branch picker and the sync toolbar on one column at narrow widths", () => {
    expect(narrowContainers()).toMatch(/\.git-action-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("keeps the branch picker out of absolute or fixed positioning", () => {
    for (const selector of [".branch-picker", ".bp-bar", ".bp-trigger", ".git-repository-branch-row"]) {
      expect(ruleBody(selector)).not.toMatch(/position:\s*(?:absolute|fixed)/);
    }
  });
});

describe("Outgoing and History commit rows keep the subject on one line and the author on its own ellipsis", () => {
  it("marks the author in the Outgoing commit row", () => {
    expect(outgoing).toMatch(/<span className="gb-author">\{commit\.author\}<\/span>/);
  });

  it("lets the metadata line wrap instead of squeezing the author", () => {
    expect(ruleBody(".gb-sub")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("truncates the author to one line with an ellipsis", () => {
    const author = ruleBody(".gb-author");
    expect(author).toMatch(/white-space:\s*nowrap/);
    expect(author).toMatch(/overflow:\s*hidden/);
    expect(author).toMatch(/text-overflow:\s*ellipsis/);
    expect(author).toMatch(/min-width:\s*0/);
  });

  it("keeps the subject to one line in both lists", () => {
    expect(ruleBody(".gb-msg")).toMatch(/white-space:\s*nowrap/);
    expect(ruleBody(".gb-msg")).toMatch(/text-overflow:\s*ellipsis/);
    expect(history).toMatch(/className="gb-msg"/);
  });
});

describe("Git Changes card header and counts can wrap instead of cutting words", () => {
  it("lets the card title wrap to a second line in the narrow rail", () => {
    expect(narrowContainers()).toMatch(/\.git-card-title\s*\{[^}]*white-space:\s*normal/);
  });

  it("lets the repository counts wrap instead of ending in an ellipsis", () => {
    expect(ruleBody(".git-repository-counts")).toMatch(/white-space:\s*normal/);
  });
});

describe("Hover-only row actions take no width while hidden", () => {
  it("takes the Git Changes row actions out of the flow and keeps them hidden by default", () => {
    const body = ruleBody(".tool-content .change-row-actions");
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/opacity:\s*0\b/);
  });

  it("anchors the row actions to their row", () => {
    expect(ruleBody(".tool-content .change-row")).toMatch(/position:\s*relative/);
  });

  it("overlays the terminal group actions on hover instead of pushing the group name", () => {
    const shown = ruleBody(".app-shell[data-theme] .workspace-terminal-group-header:hover .workspace-terminal-group-acts");
    expect(shown).toMatch(/position:\s*absolute/);
  });
});

describe("Git commit hint line truncates as a block, not an anonymous flex item", () => {
  it("renders the hint as a block so ellipsis applies to its text", () => {
    expect(ruleBody(".git-commit-min")).toMatch(/display:\s*block/);
  });
});

describe("sidebar minimum covers the Git Changes rail", () => {
  it("is 320 px so the Git Changes content column stays at about 236 px", () => {
    expect(sidebar).toMatch(/SIDEBAR_MIN_PX\s*=\s*320\b/);
  });
});

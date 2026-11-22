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
  return bodies.join(";");
}

describe("explorer root blocks when two folders are open", () => {
  it("separates each workspace root from the previous one with spacing and a divider", () => {
    const body = ruleBody(".app-shell[data-theme] .workspace-root + .workspace-root");
    expect(body).toMatch(/margin-top:\s*\d+px/);
    expect(body).toMatch(/border-top:\s*1px solid/);
  });

  it("keeps the first root without a divider", () => {
    expect(ruleBody(".app-shell[data-theme] .workspace-root")).toMatch(/border:\s*0/);
  });
});

describe("editor tab label layout", () => {
  it("keeps the file name on one line with an ellipsis and never wraps into a second line", () => {
    const body = ruleBody(".editor-file-tab-select > span:nth-child(2)");
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("lets the tab strip grow without clipping the tab row", () => {
    const body = ruleBody(".editor-file-tab-select");
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).not.toMatch(/height:\s*\d+px/);
  });
});

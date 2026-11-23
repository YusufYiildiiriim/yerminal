import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const srcDir = join(root, "src");

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

/** Declarations of every rule whose selector list contains `selector` (whitespace-normalised), joined. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim().replace(/\s+/g, " ")).includes(selector))
    .map((match) => match[2]);
  return bodies.join(";");
}

describe("explorer root row: name and path on separate lines", () => {
  it("does not clamp the root row to a fixed 26 px height", () => {
    const row = ruleBody(".app-shell[data-theme] .workspace-root-row");
    expect(row).not.toMatch(/(?<![\w-])height:\s*\d+px/);
    const minHeight = Number(row.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
    // Name line (--fs-md) plus path line (--fs-xs) with line-height and gap need roughly 34 px.
    expect(minHeight).toBeGreaterThanOrEqual(34);
  });

  it("lets the folder select grow with its content and keeps vertical padding", () => {
    const select = ruleBody(".app-shell[data-theme] .workspace-root-row > .workspace-folder-select");
    expect(select).not.toMatch(/(?<![\w-])height:\s*\d+px/);
    expect(select).toMatch(/padding:\s*[34]px\s+6px/);
  });

  it("spaces the name and path lines with a line-height and a gap", () => {
    const label = ruleBody(".app-shell[data-theme] .workspace-root-row .workspace-folder-label");
    expect(label).toMatch(/gap:\s*\d+px/);
    const path = ruleBody(".app-shell[data-theme] .workspace-root-row .workspace-folder-label small");
    expect(path).toMatch(/line-height:\s*1\.[3-9]/);
  });

  it("renders the path in the muted text token with an ellipsis", () => {
    const path = ruleBody(".app-shell[data-theme] .workspace-root-row .workspace-folder-label small");
    expect(path).toMatch(/color:\s*var\(--text-muted\)/);
    expect(path).toMatch(/text-overflow:\s*ellipsis/);
    expect(path).toMatch(/white-space:\s*nowrap/);
  });

  it("keeps the name on the --fs-md token and uses no literal font size", () => {
    const name = ruleBody(".app-shell[data-theme] .workspace-root-row[aria-expanded] .workspace-folder-label strong");
    expect(name).toMatch(/font-size:\s*var\(--fs-md\)/);
  });

  it("gives the path element the full folder path as its title", () => {
    const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
    expect(app).toMatch(/<small title=\{folder\}>\{folder\}<\/small>/);
  });

  it("keeps the divider between open folder roots", () => {
    expect(ruleBody(".app-shell[data-theme] .workspace-root + .workspace-root")).toMatch(/border-top:\s*1px solid/);
  });
});

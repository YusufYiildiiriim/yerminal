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

const SELECT = ".app-shell[data-theme] .workspace-name-select";
const BASE_SELECT = ".workspace-name-select";
const CHEVRON = ".app-shell[data-theme] .ws-chevron";
const ACTION = ".app-shell[data-theme] .ws-box";

describe("workspace selector: chevron stays inside the select box", () => {
  it("does not cap the workspace select at a viewport-relative width", () => {
    expect(ruleBody(BASE_SELECT)).not.toMatch(/max-width:\s*[\d.]+vw/);
  });

  it("lets the themed select fill its wrapper (max-width 100%)", () => {
    expect(ruleBody(SELECT)).toMatch(/max-width:\s*100%/);
  });

  it("places the chevron absolutely inside the wrapper with the shared --space-2 inset", () => {
    const body = ruleBody(CHEVRON);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/right:\s*var\(--space-2\)/);
    expect(body).not.toMatch(/(?<![\w-])right:\s*\d+px/);
    expect(body).toMatch(/pointer-events:\s*none/);
  });

  it("keeps select and chevron as siblings inside the same .ws-select wrapper", () => {
    const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
    expect(app).toMatch(
      /<div className="ws-select">\s*<select className="workspace-name-select"[\s\S]*?<\/select>\s*<svg className="ws-chevron"[\s\S]*?<\/div>/,
    );
  });

  it("truncates a long workspace name with an ellipsis at narrow sidebar widths", () => {
    const body = ruleBody(SELECT);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("keeps the + and ⋯ workspace buttons at a fixed 36 px size", () => {
    const body = ruleBody(ACTION);
    expect(body).toMatch(/width:\s*36px/);
    expect(body).toMatch(/flex:\s*0 0 36px/);
  });
});

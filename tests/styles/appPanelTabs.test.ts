import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/features/app-panel/app-panel.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function body(selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")).includes(`.app-shell[data-theme] ${selector}`))
    .map((m) => m[2]);
  if (found.length === 0) throw new Error(`rule ${selector} not found`);
  return found.join(";");
}

// The tab strip follows the editor file tabs: one flat strip with a single 1px divider, tabs
// separated by a hairline, a 2px accent line on the active tab, no rounded boxes inside the strip.
describe("app panel tab strip uses the editor tab language", () => {
  it("is a single flat strip: 36 px, chrome background, one bottom divider, no frame", () => {
    const row = body(".app-panel-tabs-row");
    expect(row).toMatch(/height:\s*36px/);
    expect(row).toContain("background: var(--theme-chrome)");
    expect(row).toContain("border-bottom: 1px solid var(--theme-border)");
    expect(row).not.toMatch(/border-radius/);
    expect(row).not.toMatch(/(^|[;\s])border:/);
    expect(body(".app-panel-header")).toContain("border-bottom: 1px solid var(--theme-border)");
  });

  it("tabs are not rounded boxes and mark the active one with the accent line", () => {
    const tab = body(".app-panel-tab");
    expect(tab).not.toMatch(/border-radius/);
    expect(tab).toContain("border-right: 1px solid var(--theme-border)");
    expect(body('.app-panel-tab[data-active="true"]')).toContain("box-shadow: inset 0 2px 0 var(--theme-accent)");
    expect(body(".app-panel-tab-select")).not.toMatch(/border-radius/);
  });

  it("keeps the 32 px hit area on the close and add buttons", () => {
    expect(body(".app-panel-tab-close")).toMatch(/width:\s*var\(--hit-icon\)/);
    expect(body(".app-panel-icon-button")).toMatch(/width:\s*var\(--hit-icon\)/);
  });
});

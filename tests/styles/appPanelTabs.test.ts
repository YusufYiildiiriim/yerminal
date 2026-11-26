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

// One 36 px row: title, tabs, add, collapse. The tabs follow the editor file tabs: hairline
// between tabs, a 2px accent line on the active one, no rounded boxes.
describe("app panel single row uses the editor tab language", () => {
  it("is one flat 36 px row: chrome background, one bottom divider, no frame, no second strip", () => {
    const row = body(".app-panel-header");
    expect(row).toMatch(/height:\s*36px/);
    expect(row).toContain("background: var(--theme-chrome)");
    expect(row).toContain("border-bottom: 1px solid var(--theme-border)");
    expect(row).not.toMatch(/border-radius/);
    expect(() => body(".app-panel-tabs-row")).toThrow();
  });

  it("keeps the title, the add button and the collapse button fixed while the tabs take the space", () => {
    expect(body(".app-panel-header h2")).toMatch(/flex:\s*none/);
    expect(body(".app-panel-add")).toMatch(/flex:\s*none/);
    expect(body(".app-panel-icon-button")).toMatch(/flex:\s*none/);
    const tabs = body(".app-panel-tabs");
    expect(tabs).toMatch(/flex:\s*1 1 auto/);
    expect(tabs).toMatch(/min-width:\s*0/);
    expect(tabs).toMatch(/overflow-x:\s*auto/);
  });

  it("sizes every tab to its content (no min-width gap, active included), caps long names with an ellipsis, then scrolls on a thin 3 px bar", () => {
    const tab = body(".app-panel-tab");
    expect(tab).toMatch(/flex:\s*0 0 auto/);
    expect(tab).not.toMatch(/min-width:\s*[1-9]/);
    expect(tab).toMatch(/max-width:\s*200px/);
    expect(body('.app-panel-tab[data-active="true"]')).not.toMatch(/min-width/);
    expect(body(".app-panel-tab-select")).toMatch(/text-overflow:\s*ellipsis/);
    expect(body(".app-panel-tab-select")).toMatch(/min-width:\s*0/);
    expect(body(".app-panel-tabs")).toMatch(/scrollbar-width:\s*thin/);
    expect(body(".app-panel-tabs::-webkit-scrollbar")).toMatch(/height:\s*3px/);
  });

  it("draws exactly one 1 px divider between neighbours: right border on every tab, left border only on the first", () => {
    const tab = body(".app-panel-tab");
    expect(tab).toContain("border-right: 1px solid var(--theme-border)");
    expect(tab).not.toMatch(/border-left/);
    expect(body(".app-panel-tab:first-child")).toMatch(/^\s*border-left: 1px solid var\(--theme-border\);?\s*$/);
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

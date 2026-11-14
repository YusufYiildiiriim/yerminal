import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/sidebar-ux.css"), "utf8");

describe("collapsed Explorer terminal groups", () => {
  it("shrinks the group panel to its header and gives the reclaimed space to the file tree", () => {
    expect(styles).toMatch(/\.app-shell\[data-theme\]\s+\.workspace-terminal-groups:has\(\.workspace-terminal-groups-toggle\[aria-expanded="false"\]\)\s*\{[^}]*flex:\s*0\s+0\s+34px;[^}]*min-height:\s*34px;/s);
    expect(styles).toMatch(/\.app-shell\[data-theme\]\s+\.workspace-explorer-tree:has\(\+ \.workspace-terminal-groups \.workspace-terminal-groups-toggle\[aria-expanded="false"\]\)\s*\{[^}]*flex:\s*1\s+1\s+36%;[^}]*max-height:\s*none;/s);
  });
});

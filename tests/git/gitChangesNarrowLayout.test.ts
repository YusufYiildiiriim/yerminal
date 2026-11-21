import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom does not lay out boxes, so these guards check the shipped CSS rules for the narrow left rail.
function allCss(): string {
  return readdirSync("src", { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(join("src", file), "utf8"))
    .join("\n");
}

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\}|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  return [...allCss().matchAll(pattern)].map((match) => match[1]).join(";");
}

describe("Git Changes panel keeps its controls readable in a narrow rail", () => {
  it("wraps the remote sync toolbar instead of overflowing it", () => {
    expect(declarations(".sync-bar")).toMatch(/flex-wrap:\s*wrap/);
    expect(declarations(".sync-button")).toMatch(/min-width:\s*\d+px/);
  });

  it("keeps the repository name at a readable width before truncating", () => {
    const minWidth = declarations(".git-repository-name").match(/min-width:\s*min\(100%,\s*(\d+(?:\.\d+)?)em\)/);
    expect(minWidth).not.toBeNull();
    expect(Number(minWidth?.[1])).toBeGreaterThanOrEqual(12);
    expect(declarations(".git-repository-name strong")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("truncates the commit button label instead of spilling out of the commit box", () => {
    expect(declarations(".git-commit-button")).toMatch(/max-width:\s*100%/);
    const label = declarations(".git-commit-label");
    expect(label).toMatch(/min-width:\s*0/);
    expect(label).toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("keeps the Git Changes header and its refresh button from shrinking into each other", () => {
    expect(declarations(".git-changes-view .tool-header > div")).toMatch(/min-width:\s*0/);
    expect(declarations(".git-changes-view .tool-header .refresh-button")).toMatch(/flex:\s*none/);
  });

  it("lets repository body, branch row and folder actions shrink without clipping the list", () => {
    expect(declarations(".git-repository-body")).toMatch(/min-width:\s*0/);
    expect(declarations(".git-repository-branch-row")).toMatch(/min-width:\s*0/);
    expect(declarations(".change-dir-actions")).toMatch(/flex:\s*none/);
  });
});

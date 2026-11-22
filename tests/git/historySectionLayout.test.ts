import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom does not lay out boxes, so these guards check the shipped CSS rules for the History section in the narrow rail.
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

describe("History section stays inside the narrow Git Changes rail", () => {
  it("lets the toggle label and the branch line truncate instead of widening the rail", () => {
    expect(declarations(".hist-section")).toMatch(/min-width:\s*0/);
    expect(declarations(".hist-toggle")).toMatch(/min-width:\s*0/);
    const branch = declarations(".hist-branch");
    expect(branch).toMatch(/overflow:\s*hidden/);
    expect(branch).toMatch(/text-overflow:\s*ellipsis/);
    expect(branch).toMatch(/white-space:\s*nowrap/);
  });

  it("keeps the pushed commit list within the rail width", () => {
    expect(declarations(".hist-section .gb-commits")).toMatch(/min-width:\s*0/);
    expect(declarations(".gb-commit")).toMatch(/min-width:\s*0/);
  });

  it("caps the pushed commit list with its own vertical scroll box", () => {
    const box = declarations(".hist-list-scroll");
    expect(box).toMatch(/max-height:\s*(?:2[89]\d|3[0-4]\d)px/);
    expect(box).toMatch(/overflow-y:\s*auto/);
    expect(box).toMatch(/overflow-x:\s*hidden/);
  });

  it("lays the branch picker popover over the content as a fixed overlay, so the repository block cannot clip it or shift", () => {
    expect(declarations(".bp-popover")).toMatch(/position:\s*fixed/);
    expect(declarations(".git-repository-branch-row .bp-popover")).not.toMatch(/position:\s*static/);
  });
});

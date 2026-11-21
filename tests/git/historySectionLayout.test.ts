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

  it("flows the branch picker popover under its trigger so the repository block cannot clip it", () => {
    expect(declarations(".git-repository-branch-row .bp-popover")).toMatch(/position:\s*static/);
  });
});

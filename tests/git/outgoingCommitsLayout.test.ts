import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom does not lay out boxes, so these guards check the shipped CSS rules for the Outgoing commits list.
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

describe("Outgoing commits list stays bounded in the Git Changes panel", () => {
  it("gives each opened commit's file list its own capped, vertically scrolling box", () => {
    const box = declarations(".gb-files-scroll");
    expect(box).toMatch(/max-height:\s*240px/);
    expect(box).toMatch(/overflow-y:\s*auto/);
    expect(box).toMatch(/overflow-x:\s*hidden/);
  });

  it("keeps the Outgoing commits header fully visible below the Push button", () => {
    const header = declarations(".outgoing-commits > .gb-sec");
    expect(header).toMatch(/min-height:\s*2[2-9]px/);
    expect(header).not.toMatch(/(?:^|;)\s*height:\s*22px/);
    expect(header).toMatch(/overflow:\s*visible/);
    expect(header).toMatch(/position:\s*relative/);
    expect(header).toMatch(/z-index:\s*\d+/);
  });
});

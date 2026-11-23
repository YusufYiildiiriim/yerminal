import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");

describe("workspace sidebar Panel limits", () => {
  it("takes its min and max from the pixel limits, not fixed percents", () => {
    expect(app).toContain("minSize={sidebarLimitPercent(SIDEBAR_MIN_PX, viewportWidth)}");
    expect(app).toContain("maxSize={sidebarLimitPercent(SIDEBAR_MAX_PX, viewportWidth)}");
    expect(app).not.toContain("minSize={20} maxSize={38}");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));

describe("native window configuration", () => {
  it("turns off the native title bar but keeps the window resizable", () => {
    const main = config.app.windows[0];
    expect(main.decorations).toBe(false);
    expect(main.resizable).not.toBe(false);
  });

  it("grants only the window permissions the custom title bar calls", () => {
    const permissions: string[] = capability.permissions;
    for (const permission of [
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
      "core:window:allow-close",
      "core:window:allow-start-dragging",
      "core:window:allow-is-maximized",
    ]) {
      expect(permissions).toContain(permission);
    }
  });
});

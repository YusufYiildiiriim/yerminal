import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { bundle: { icon: string[] } };

describe("desktop bundle icons", () => {
  it.each([["icons/32x32.png", 32], ["icons/128x128.png", 128], ["icons/128x128@2x.png", 256], ["icons/icon.png", 256]] as const)(
    "includes a square 32-bit RGBA PNG for Linux: %s", (path, size) => {
      expect(config.bundle.icon).toContain(path);
      const data = readFileSync(`src-tauri/${path}`);
      expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(data.readUInt32BE(16)).toBe(size);
      expect(data.readUInt32BE(20)).toBe(size);
      expect(data[24]).toBe(8);
      expect(data[25]).toBe(6);
    },
  );
  it("retains the Windows icon", () => {
    expect(config.bundle.icon).toContain("icons/icon.ico");
    expect(readFileSync("src-tauri/icons/icon.ico").length).toBeGreaterThan(0);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASES } from "../../src/features/releaseNotes/releaseNotes";

// Release gate: run with `npm run release:check`. Fails when the app version files disagree
// or the current version has no entry in the in-app version notes.
const root = fileURLToPath(new URL("../..", import.meta.url));

function cargoPackageVersion(text: string): string | undefined {
  const packageSection = text.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  return packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

describe("release check", () => {
  const packageVersion: string = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const tauriVersion: string = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8")).version;
  const cargoVersion = cargoPackageVersion(readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8"));

  it("has the same version in package.json, tauri.conf.json and Cargo.toml", () => {
    expect(tauriVersion).toBe(packageVersion);
    expect(cargoVersion).toBe(packageVersion);
  });

  it("has a version notes entry for the current version", () => {
    const entry = RELEASES.releases.find((release) => release.version === packageVersion);
    expect(entry, `no version notes entry for ${packageVersion}`).toBeDefined();
  });
});

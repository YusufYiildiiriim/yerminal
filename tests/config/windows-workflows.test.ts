import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

describe("Windows delivery workflows", () => {
  it("runs frontend and Rust checks on Windows", () => {
    expect(ci).toMatch(/runs-on:\s*windows-latest/);
    expect(ci).not.toMatch(/runs-on:\s*ubuntu/);
    for (const command of ["npm ci", "npm run build", "npm run test:run", "cargo test --locked", "cargo clippy"]) expect(ci).toContain(command);
  });
  it("builds both Windows installers without requiring a Linux job", () => {
    expect(release).toMatch(/platform:\s*windows-latest/);
    expect(release).toMatch(/bundles:\s*nsis,msi/);
    expect(release).not.toMatch(/platform:\s*ubuntu/);
    expect(release).not.toMatch(/appimage|bundles:\s*.*deb/i);
    expect(release).toContain("releaseDraft: true");
    expect(release).toContain("needs.build-upload.result == 'success'");
  });
});

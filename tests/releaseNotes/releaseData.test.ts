import { describe, expect, it } from "vitest";
import { RELEASES, validateReleaseData, type ReleaseNotesData } from "../../src/features/releaseNotes/releaseNotes";

describe("release notes data", () => {
  it("accepts the bundled release data", () => {
    expect(validateReleaseData(RELEASES)).toEqual([]);
  });

  it("lists the closed issues of 0.1.3 with their numbers and titles", () => {
    const current = RELEASES.releases.find((release) => release.version === "0.1.3");
    expect(current?.issues.map((issue) => issue.number)).toEqual([55, 56, 58, 59, 60, 61]);
    expect(current?.issues.find((issue) => issue.number === 59)?.title).toBe("Editor tabs of a removed workspace folder stay open");
  });

  it("lists 0.1.4 as an unreleased version with no date, holding issues 62, 63 and 64", () => {
    const upcoming = RELEASES.releases.find((release) => release.version === "0.1.4");
    expect(upcoming?.date).toBeNull();
    expect(upcoming?.issues).toEqual([
      { number: 62, title: "Custom title bar with bolder brand mark and name" },
      { number: 63, title: "Version notes page listing closed issues per release" },
      { number: 64, title: "Title bar logo renders broken and bar is too tall" },
    ]);
  });

  it("accepts an unreleased version whose date is null", () => {
    const data: ReleaseNotesData = {
      repository: "https://github.com/YusufYiildiiriim/yerminal",
      releases: [{ version: "1.0.0", date: null, issues: [] }],
    };
    expect(validateReleaseData(data)).toEqual([]);
  });

  it("rejects a date that is neither null nor YYYY-MM-DD", () => {
    const data: ReleaseNotesData = {
      repository: "https://github.com/YusufYiildiiriim/yerminal",
      releases: [{ version: "1.0.0", date: "2026/01/01", issues: [] }],
    };
    expect(validateReleaseData(data).length).toBeGreaterThan(0);
  });

  it("rejects an issue number that is not a positive integer", () => {
    const data: ReleaseNotesData = {
      repository: "https://github.com/YusufYiildiiriim/yerminal",
      releases: [{ version: "1.0.0", date: "2026-01-01", issues: [{ number: 0, title: "x" }] }],
    };
    expect(validateReleaseData(data).length).toBeGreaterThan(0);
  });

  it("rejects a version that is not x.y.z", () => {
    const data: ReleaseNotesData = {
      repository: "https://github.com/YusufYiildiiriim/yerminal",
      releases: [{ version: "v1", date: "2026-01-01", issues: [] }],
    };
    expect(validateReleaseData(data).length).toBeGreaterThan(0);
  });

  it("rejects the same version listed twice", () => {
    const release = { version: "1.0.0", date: "2026-01-01", issues: [] };
    const data: ReleaseNotesData = { repository: "https://github.com/YusufYiildiiriim/yerminal", releases: [release, { ...release }] };
    expect(validateReleaseData(data).length).toBeGreaterThan(0);
  });

  it("rejects a repository that is not a GitHub https URL", () => {
    const data: ReleaseNotesData = { repository: "http://example.com/repo", releases: [] };
    expect(validateReleaseData(data).length).toBeGreaterThan(0);
  });
});

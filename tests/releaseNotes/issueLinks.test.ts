import { beforeEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl, revealItemInDir: vi.fn() }));

import { isAllowedIssueUrl, issueUrl, openIssueUrl } from "../../src/features/releaseNotes/releaseNotes";

const REPO_ISSUE_55 = "https://github.com/YusufYiildiiriim/yerminal/issues/55";

beforeEach(() => {
  opener.openUrl.mockClear();
});

describe("release notes issue links", () => {
  it("builds the GitHub issue URL of this repository", () => {
    expect(issueUrl(55)).toBe(REPO_ISSUE_55);
  });

  it("returns null for an issue number that is not a positive integer", () => {
    expect(issueUrl(0)).toBeNull();
    expect(issueUrl(1.5)).toBeNull();
    expect(issueUrl(Number.NaN)).toBeNull();
  });

  it("opens the issue URL in the browser through the opener plugin", async () => {
    const opened = await openIssueUrl(REPO_ISSUE_55);
    expect(opened).toBe(true);
    expect(opener.openUrl).toHaveBeenCalledTimes(1);
    expect(opener.openUrl).toHaveBeenCalledWith(REPO_ISSUE_55);
  });

  it("refuses URLs that are not issues of this repository", async () => {
    const refused = [
      "https://example.com/YusufYiildiiriim/yerminal/issues/55",
      "https://github.com/someone-else/yerminal/issues/55",
      "https://github.com/YusufYiildiiriim/yerminal/pulls/55",
      "https://github.com/YusufYiildiiriim/yerminal/issues/abc",
      "https://github.com/YusufYiildiiriim/yerminal/issues/55?x=1",
      "http://github.com/YusufYiildiiriim/yerminal/issues/55",
      "file:///C:/Windows/system.ini",
      "javascript:alert(1)",
    ];
    for (const url of refused) {
      expect(isAllowedIssueUrl(url)).toBe(false);
      expect(await openIssueUrl(url)).toBe(false);
    }
    expect(opener.openUrl).not.toHaveBeenCalled();
  });
});

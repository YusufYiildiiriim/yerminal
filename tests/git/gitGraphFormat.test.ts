import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../../src/features/git/gitGraphFormat";

const now = Date.UTC(2026, 10, 14, 12, 0, 0);
const at = (secondsAgo: number) => Math.floor(now / 1000) - secondsAgo;

describe("formatRelativeTime", () => {
  it("reports seconds as just now and minutes as min ago", () => {
    expect(formatRelativeTime(at(10), now)).toBe("just now");
    expect(formatRelativeTime(at(30 * 60), now)).toBe("30 min ago");
  });

  it("reports hours, then yesterday, then days, then a date for older commits", () => {
    expect(formatRelativeTime(at(2 * 3600), now)).toBe("2 h ago");
    expect(formatRelativeTime(at(26 * 3600), now)).toBe("yesterday");
    expect(formatRelativeTime(at(3 * 86400 + 3600), now)).toBe("3 days ago");
    const older = formatRelativeTime(at(30 * 86400), now);
    expect(older).not.toMatch(/ago|yesterday/);
    expect(older.length).toBeGreaterThan(0);
  });
});

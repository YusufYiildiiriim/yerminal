import { describe, expect, it } from "vitest";
import { APP_CATALOG, findApp } from "../../src/features/app-panel/apps";

describe("app catalog", () => {
  it("ships YouTube Music, YouTube and X as ready-made apps", () => {
    expect(APP_CATALOG.map((app) => [app.id, app.name, app.url])).toEqual([
      ["youtube-music", "YouTube Music", "https://music.youtube.com"],
      ["youtube", "YouTube", "https://www.youtube.com"],
      ["x", "X", "https://x.com"],
    ]);
  });

  it("gives every app a unique id, an https url and a window title hint", () => {
    const ids = APP_CATALOG.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const app of APP_CATALOG) {
      expect(app.url.startsWith("https://")).toBe(true);
      expect(app.titleHint.length).toBeGreaterThan(0);
    }
  });

  it("finds an app by id and returns undefined for an unknown id", () => {
    expect(findApp("x")?.name).toBe("X");
    expect(findApp("missing")).toBeUndefined();
  });
});

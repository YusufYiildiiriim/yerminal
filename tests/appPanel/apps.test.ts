import { describe, expect, it } from "vitest";
import { READY_MADE_APPS, nameOf, splitApps, type AppInfo } from "../../src/features/app-panel/apps";

describe("app list", () => {
  it("knows the ready-made apps by id and name only (their urls live in the backend)", () => {
    expect(READY_MADE_APPS.map((app) => [app.id, app.name, app.kind])).toEqual([
      ["youtube-music", "YouTube Music", "builtin"],
      ["youtube", "YouTube", "builtin"],
      ["x", "X", "builtin"],
    ]);
    for (const app of READY_MADE_APPS) expect(Object.keys(app).sort()).toEqual(["id", "kind", "name"]);
  });

  it("splits the backend list into ready-made and own apps", () => {
    const list: AppInfo[] = [...READY_MADE_APPS, { id: "custom-1", name: "Postman", kind: "custom" }];
    const { ready, own } = splitApps(list);
    expect(ready.map((app) => app.id)).toEqual(["youtube-music", "youtube", "x"]);
    expect(own.map((app) => app.name)).toEqual(["Postman"]);
  });

  it("names an id from the list, then from what was seen before, then by the id itself", () => {
    const list: AppInfo[] = [{ id: "custom-1", name: "Postman", kind: "custom" }];
    expect(nameOf("custom-1", list, new Map())).toBe("Postman");
    expect(nameOf("custom-2", list, new Map([["custom-2", "Old name"]]))).toBe("Old name");
    expect(nameOf("custom-3", list, new Map())).toBe("custom-3");
  });
});

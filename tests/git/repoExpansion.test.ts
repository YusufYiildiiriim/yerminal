import { describe, expect, it } from "vitest";
import {
  COLLAPSED_REPOS_STORAGE_KEY,
  parseCollapsedRepos,
  readCollapsedRepos,
  repoExpansionKey,
  serializeCollapsedRepos,
  setRepoExpanded,
  writeCollapsedRepos,
} from "../../src/features/git/repoExpansion";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

describe("repo expansion", () => {
  it("normalises repo roots so the same repository always maps to one key", () => {
    expect(repoExpansionKey("C:\\Users\\Yusuf\\Repo\\")).toBe("c:/users/yusuf/repo");
    expect(repoExpansionKey("c:/users/yusuf/repo")).toBe(repoExpansionKey("C:\\Users\\Yusuf\\Repo"));
  });

  it("ignores malformed persisted values", () => {
    expect(parseCollapsedRepos(null)).toEqual(new Set());
    expect(parseCollapsedRepos("{not json")).toEqual(new Set());
    expect(parseCollapsedRepos('{"a":1}')).toEqual(new Set());
    expect(parseCollapsedRepos('["a", 2, null, "b"]')).toEqual(new Set(["a", "b"]));
  });

  it("toggles one repository without touching the others", () => {
    const collapsed = new Set(["a", "b"]);
    expect(setRepoExpanded(collapsed, "a", true)).toEqual(new Set(["b"]));
    expect(setRepoExpanded(collapsed, "c", false)).toEqual(new Set(["a", "b", "c"]));
    expect(collapsed).toEqual(new Set(["a", "b"]));
  });

  it("persists collapsed repositories across a fresh read (simulated reopen)", () => {
    const storage = memoryStorage();
    writeCollapsedRepos(new Set(["c:/one", "c:/two"]), storage);
    expect(storage.getItem(COLLAPSED_REPOS_STORAGE_KEY)).toBe(serializeCollapsedRepos(new Set(["c:/one", "c:/two"])));
    expect(readCollapsedRepos(storage)).toEqual(new Set(["c:/one", "c:/two"]));
  });

  it("keeps working when storage is unavailable or throws", () => {
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    } as unknown as Storage;
    expect(readCollapsedRepos(broken)).toEqual(new Set());
    expect(() => writeCollapsedRepos(new Set(["x"]), broken)).not.toThrow();
    expect(readCollapsedRepos(null)).toEqual(new Set());
  });
});

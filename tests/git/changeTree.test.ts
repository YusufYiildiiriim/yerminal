import { describe, expect, it } from "vitest";
import { buildChangeTree } from "../../src/features/git/changeTree";

const change = (path: string) => ({ path, kind: "modified", staged: false, unstaged: true });

describe("buildChangeTree", () => {
  it("groups files by folder, folders first, sorted, with per-folder file counts", () => {
    const tree = buildChangeTree([change("README.md"), change("src/b.ts"), change("src/a.ts"), change("src/ui/x.tsx"), change("docs/guide.md")]);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual(["dir:docs", "dir:src", "file:README.md"]);
    const src = tree[1];
    if (src.kind !== "dir") throw new Error("expected a folder");
    expect(src.files).toHaveLength(3);
    expect(src.children.map((node) => `${node.kind}:${node.name}`)).toEqual(["dir:ui", "file:a.ts", "file:b.ts"]);
  });

  it("collapses single-child folder chains into one a/b/c row, keeping the deepest folder path", () => {
    const tree = buildChangeTree([change("src/features/git/a.ts"), change("src/features/git/b.ts")]);
    expect(tree).toHaveLength(1);
    const node = tree[0];
    if (node.kind !== "dir") throw new Error("expected a folder");
    expect(node.name).toBe("src/features/git");
    expect(node.path).toBe("src/features/git");
    expect(node.children.map((child) => child.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("does not collapse a folder that also holds files of its own", () => {
    const tree = buildChangeTree([change("src/index.ts"), change("src/ui/x.tsx")]);
    const node = tree[0];
    if (node.kind !== "dir") throw new Error("expected a folder");
    expect(node.name).toBe("src");
    expect(node.children.map((child) => child.name)).toEqual(["ui", "index.ts"]);
  });
});

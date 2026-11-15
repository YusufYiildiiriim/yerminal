import { describe, expect, it } from "vitest";
import { classifyToast } from "../src/toastKind";

describe("classifyToast", () => {
  it.each([
    ["Pull: Already up to date", "success"],
    ["Fetch: Already up to date", "success"],
    ["Publish: Published feature to origin", "success"],
    ["Created commit abc1234", "success"],
    ["Created merge commit abc1234", "success"],
    ["Merged feature/login", "success"],
    ["Fast-forwarded to feature/login", "success"],
    ["Merge aborted", "success"],
    ["Merge conflicts in 2 files. Resolve them in Git Changes", "warning"],
    ["Pull: Pull stopped with merge conflicts. Resolve them in Git Changes", "warning"],
    ["Choose a unique workspace name.", "warning"],
    ["Launch the desktop app to create files.", "warning"],
    ["Pull failed: Your local changes would be overwritten by merge", "error"],
    ["Could not open terminal: boom", "error"],
    ["Cannot open folder: nope", "error"],
  ] as const)("%s -> %s", (message, kind) => expect(classifyToast(message)).toBe(kind));
});

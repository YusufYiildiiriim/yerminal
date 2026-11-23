import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(process.cwd(), "src");

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path, ext);
    return name.endsWith(ext) ? [path] : [];
  });
}

const css = listFiles(srcDir, ".css")
  .map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");

/** Declarations of every rule whose selector list contains `selector` (whitespace-normalised), joined. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim().replace(/\s+/g, " ")).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

const app = readFileSync(join(srcDir, "App.tsx"), "utf8");
const sync = readFileSync(join(srcDir, "features", "git", "SyncBar.tsx"), "utf8");

describe("Git Changes layout A: row actions show on hover and keyboard focus", () => {
  it("hides row actions by default instead of leaving them at 100% opacity", () => {
    expect(ruleBody(".tool-content .change-row-actions")).toMatch(/opacity:\s*0\b/);
    expect(ruleBody(".tool-content .change-row-actions")).not.toMatch(/opacity:\s*1\b/);
  });

  it("shows row actions on hover and on focus within the row", () => {
    expect(ruleBody(".tool-content .change-row:hover .change-row-actions")).toMatch(/opacity:\s*1\b/);
    expect(ruleBody(".tool-content .change-row:focus-within .change-row-actions")).toMatch(/opacity:\s*1\b/);
  });
});

describe("Git Changes layout A: calm section headings", () => {
  it("sets section headings in the muted token, without uppercase transform", () => {
    const body = ruleBody(".tool-content .change-group-heading");
    expect(body).toMatch(/color:\s*var\(--text-muted\)/);
    expect(body).toMatch(/text-transform:\s*none/);
    expect(body).toMatch(/font-weight:\s*(?:400|500)/);
  });
});

describe("Git Changes layout A: commit hint line", () => {
  it("renders a 24 px muted hint when nothing is staged", () => {
    const body = ruleBody(".git-commit-min");
    expect(body).toMatch(/height:\s*24px/);
    expect(body).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it("opens the commit box only when staged changes exist", () => {
    expect(app).toMatch(/stagedChanges\.length > 0 && <section className="git-commit-box"/);
    expect(app).toMatch(/className="git-commit-min"/);
  });
});

describe("Git Changes layout A: header summary and toolbar", () => {
  it("puts the ahead count after the staged and changes counts in the header", () => {
    expect(app).toMatch(/aheadCount > 0 \? ` · ↑\$\{aheadCount\}` : ""/);
  });

  it("keeps the More button on the shared 32 px token and never shrinks it", () => {
    const body = ruleBody(".sync-bar .sync-more");
    expect(body).toMatch(/width:\s*var\(--hit-icon\)/);
    expect(body).toMatch(/flex:\s*0 0 var\(--hit-icon\)|flex:\s*none/);
    expect(body).not.toMatch(/(?<![\w-])width:\s*\d+px/);
  });

  it("exposes the More menu with a label, a menu role and an expanded state", () => {
    expect(sync).toMatch(/aria-label="More git actions"/);
    expect(sync).toMatch(/aria-haspopup="menu"/);
    expect(sync).toMatch(/aria-expanded=\{menu !== null\}/);
  });

  it("truncates the repository counts with an ellipsis so the summary fits a 184 px panel", () => {
    const body = ruleBody(".git-repository-counts");
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
  });
});

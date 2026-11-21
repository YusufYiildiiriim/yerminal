import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeWorkspace, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";

afterEach(cleanup);

const group = { id: "group-1", name: "Editor 1", tabIds: ["tab-1"], activeTabId: "tab-1" };

function renderTab() {
  const tab: EditorFileTab = {
    id: "tab-1", root: "C:/repo", path: "C:/repo/src/app.ts", name: "app.ts", status: "ready",
    content: "const a = 1;", savedContent: "const a = 1;", error: null,
    sourceLabel: null, sourceCommitId: null, snapshot: null, isSaving: false, saveError: null,
  };
  return render(<CodeWorkspace workspaceId="workspace-1" tabs={[tab]} groups={[group]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={vi.fn()} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
}

function sourceCssFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".css"))
    .map((file) => join(dir, file));
}

describe("editor renders only Monaco's own minimap", () => {
  it("does not render a custom minimap column next to the Monaco editor", () => {
    renderTab();

    expect(document.querySelector(".code-editor-content")).not.toBeNull();
    expect(document.querySelector(".code-editor-minimap")).toBeNull();
    expect(document.querySelector(".code-editor-minimap-code")).toBeNull();
    expect(document.querySelector(".code-editor-minimap-window")).toBeNull();
  });

  it("ships no custom minimap styles", () => {
    const offenders = sourceCssFiles("src").filter((file) => readFileSync(file, "utf8").includes("code-editor-minimap"));

    expect(offenders).toEqual([]);
  });

  it("lets the editor content fill the whole editor width without a reserved right gutter", () => {
    const css = readFileSync("src/styles/themes.css", "utf8");
    const contentRules = [...css.matchAll(/\.code-editor-content\s*\{([^}]*)\}/g)].map((match) => match[1]);

    expect(contentRules.length).toBeGreaterThan(0);
    for (const body of contentRules) {
      expect(body).not.toMatch(/\b(?:right|inset)\s*:[^;]*\d+px/);
    }
  });
});

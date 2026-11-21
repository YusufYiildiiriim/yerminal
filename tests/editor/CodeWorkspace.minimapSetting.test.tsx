import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeWorkspace, type EditorFileTab } from "../../src/features/editor/CodeWorkspace";
import type { AppSettings } from "../../src/features/settings/SettingsDialog";

const seen = vi.hoisted(() => [] as Array<{ minimap?: boolean }>);
vi.mock("../../src/features/editor/MonacoCodeEditor", () => ({
  MonacoCodeEditor: (props: { minimap?: boolean }) => { seen.push({ minimap: props.minimap }); return null; },
}));

afterEach(() => { cleanup(); seen.length = 0; });

const group = { id: "group-1", name: "Editor 1", tabIds: ["tab-1"], activeTabId: "tab-1" };
const tab: EditorFileTab = {
  id: "tab-1", root: "C:/repo", path: "C:/repo/src/app.ts", name: "app.ts", status: "ready",
  content: "const a = 1;", savedContent: "const a = 1;", error: null,
  sourceLabel: null, sourceCommitId: null, snapshot: null, isSaving: false, saveError: null,
};
const settings: AppSettings = {
  theme: "obsidian", editorFontFamily: "Consolas", editorFontSize: 13, terminalFontFamily: "Consolas", terminalFontSize: 13,
  quickOpenScope: "active", collapseOtherFolders: false, autoSave: false, agentUsageEnabled: false, languageSetupComplete: true,
};

function renderWith(value: AppSettings) {
  return render(<CodeWorkspace workspaceId="workspace-1" settings={value} tabs={[tab]} groups={[group]} activeGroupId="group-1"
    onSelect={vi.fn()} onActivateGroup={vi.fn()} onClose={vi.fn()} onChange={vi.fn()} onSave={vi.fn()}
    onMoveTab={vi.fn()} onCloseGroup={vi.fn()} onModeState={vi.fn()} />);
}

describe("editor minimap setting reaches the open Monaco editor", () => {
  it("passes the stored off choice to the editor", () => {
    renderWith({ ...settings, editorMinimap: false });
    expect(seen.at(-1)).toEqual({ minimap: false });
  });

  it("keeps the minimap on when the setting is missing", () => {
    renderWith(settings);
    expect(seen.at(-1)).toEqual({ minimap: true });
  });
});

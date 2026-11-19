import type { ThemeId } from "../settings/SettingsDialog";

type ThemeTarget = { editor: { defineTheme(name: string, data: unknown): void; setTheme(name: string): void } };

/** Applies the app palette to Monaco (shared by the code editor and the diff editor). */
export function applyYerminalTheme(monaco: ThemeTarget, element: HTMLElement | null, theme: ThemeId): void {
  const style = element ? getComputedStyle(element) : null;
  const color = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  const name = "yerminal-" + theme;
  monaco.editor.defineTheme(name, { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": color("--theme-editor", "#141418"), "editor.foreground": color("--theme-text", "#d4d4d8"), "editorLineNumber.foreground": color("--theme-muted", "#85848e"), "editorCursor.foreground": color("--theme-accent", "#f59e0b") } });
  monaco.editor.setTheme(name);
}

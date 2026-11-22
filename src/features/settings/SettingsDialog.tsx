import { useEffect, useRef, useState, type ReactNode } from "react";
import "./settings.css";
import { DEFAULT_LANGUAGES, EDITOR_LANGUAGES, type EditorLanguageId } from "../editor/editorLanguages";
import { INTERFACE_SIZES, type InterfaceSize } from "./interfaceSize";

export type ThemeId = "obsidian" | "nordic" | "foundry";
export type AppSettings = { theme: ThemeId; editorFontFamily: string; editorFontSize: number; terminalFontFamily: string; terminalFontSize: number; quickOpenScope: "active" | "all"; collapseOtherFolders: boolean; autoSave: boolean; agentUsageEnabled: boolean; editorMinimap?: boolean; enabledLanguages?: readonly EditorLanguageId[]; languageSetupComplete?: boolean; interfaceSize?: InterfaceSize; terminalUseDefaults?: boolean; terminalDefaultPath?: string; terminalDefaultGroup?: string };
/** Supported font sizes (px) for the editor and terminal; also used when loading stored settings. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export function clampFontSize(value: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value));
}
type Shortcut = { keys: string; label: string };
export type SectionId = "languages" | "appearance" | "editor" | "explorer" | "terminal" | "shortcuts";
type Props = { initialSection?: SectionId; settings: AppSettings; shortcuts: readonly Shortcut[]; onSettingsChange: (value: AppSettings) => void; onClose: () => void };
type SettingRow = { id: string; section: SectionId; label: string; description?: string; control: ReactNode };

const sections: { id: SectionId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "languages", label: "Languages" },
  { id: "explorer", label: "Explorer" },
  { id: "terminal", label: "Terminal" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
];
const themes: { id: ThemeId; label: string; short: string }[] = [
  { id: "obsidian", label: "Obsidian Atelier", short: "Obsidian" },
  { id: "nordic", label: "Nordic Glass", short: "Nordic" },
  { id: "foundry", label: "Foundry", short: "Foundry" },
];

const interfaceSizeLabels: Record<InterfaceSize, string> = { small: "Small", default: "Default", large: "Large" };
export function SettingsDialog({ settings, shortcuts, onSettingsChange, onClose, initialSection = "appearance" }: Props) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const [query, setQuery] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<SectionId, HTMLElement>());
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const enabledLanguages = settings.enabledLanguages ?? DEFAULT_LANGUAGES;
  const rows: SettingRow[] = [
    ...EDITOR_LANGUAGES.map((language): SettingRow => ({ id: "language-" + language.id, section: "languages", label: language.label, control: <input className="settings-toggle" type="checkbox" aria-label={"Enable " + language.label} checked={enabledLanguages.includes(language.id)} onChange={(event) => onSettingsChange({ ...settings, languageSetupComplete: true, enabledLanguages: event.currentTarget.checked ? [...enabledLanguages, language.id] : enabledLanguages.filter((id) => id !== language.id) })} /> })),
    { id: "theme", section: "appearance", label: "Theme", description: "Colors for the whole window.", control: <div className="settings-seg" role="group" aria-label="Theme">{themes.map((theme) => <button key={theme.id} type="button" aria-label={theme.label} aria-pressed={settings.theme === theme.id} onClick={() => onSettingsChange({ ...settings, theme: theme.id })}>{theme.short}</button>)}</div> },
    { id: "interface-size", section: "appearance", label: "Interface size", description: "Text size for the window. Editor and terminal fonts keep their own size.", control: <div className="settings-seg" role="group" aria-label="Interface size">{INTERFACE_SIZES.map((size) => <button key={size} type="button" aria-label={interfaceSizeLabels[size]} aria-pressed={(settings.interfaceSize ?? "default") === size} onClick={() => onSettingsChange({ ...settings, interfaceSize: size })}>{interfaceSizeLabels[size]}</button>)}</div> },
    { id: "editor-font-family", section: "editor", label: "Font family", description: "Used by the code editor.", control: <input className="settings-text" type="text" aria-label="Editor font family" value={settings.editorFontFamily} maxLength={250} onChange={(event) => onSettingsChange({ ...settings, editorFontFamily: event.currentTarget.value })} /> },
    { id: "editor-font-size", section: "editor", label: "Font size", description: "Editor text size in pixels.", control: <span className="settings-number"><input type="number" aria-label="Editor font size" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} value={settings.editorFontSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) onSettingsChange({ ...settings, editorFontSize: clampFontSize(value) }); }} />px</span> },
    { id: "editor-minimap", section: "editor", label: "Minimap", description: "Show the code overview on the right edge of the editor. Open editors update at once.", control: <input className="settings-toggle" type="checkbox" aria-label="Editor minimap" checked={settings.editorMinimap !== false} onChange={(event) => onSettingsChange({ ...settings, editorMinimap: event.currentTarget.checked })} /> },
    { id: "auto-save", section: "editor", label: "Auto Save", description: "Save edited workspace files 1 second after typing stops. Ctrl+S still saves immediately.", control: <input className="settings-toggle" type="checkbox" aria-label="Auto Save" checked={settings.autoSave} onChange={(event) => onSettingsChange({ ...settings, autoSave: event.currentTarget.checked })} /> },
    { id: "quick-open-scope", section: "editor", label: "Quick Open scope", description: "Choose which workspace folders Ctrl+P searches.", control: <select className="settings-select" aria-label="Quick Open scope" value={settings.quickOpenScope} onChange={(event) => onSettingsChange({ ...settings, quickOpenScope: event.currentTarget.value === "all" ? "all" : "active" })}><option value="active">Active workspace</option><option value="all">All workspaces</option></select> },
    { id: "collapse-folders", section: "explorer", label: "Collapse other folders when expanding", description: "Keep the selected folder and its parent path open.", control: <input className="settings-toggle" type="checkbox" aria-label="Collapse other folders when expanding" checked={settings.collapseOtherFolders} onChange={(event) => onSettingsChange({ ...settings, collapseOtherFolders: event.currentTarget.checked })} /> },
    { id: "terminal-font-family", section: "terminal", label: "Font family", description: "Used by every terminal.", control: <input className="settings-text" type="text" aria-label="Terminal font family" value={settings.terminalFontFamily} maxLength={250} onChange={(event) => onSettingsChange({ ...settings, terminalFontFamily: event.currentTarget.value })} /> },
    { id: "terminal-font-size", section: "terminal", label: "Font size", description: "Terminal text size in pixels.", control: <span className="settings-number"><input type="number" aria-label="Terminal font size" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} value={settings.terminalFontSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) onSettingsChange({ ...settings, terminalFontSize: clampFontSize(value) }); }} />px</span> },
    { id: "terminal-use-defaults", section: "terminal", label: "Use defaults when opening a terminal", description: "On: new terminals use the default path and group below without asking. Off: opening a terminal asks for the folder and group first.", control: <input className="settings-toggle" type="checkbox" aria-label="Use defaults when opening a terminal" checked={settings.terminalUseDefaults !== false} onChange={(event) => onSettingsChange({ ...settings, terminalUseDefaults: event.currentTarget.checked })} /> },
    { id: "terminal-default-path", section: "terminal", label: "Terminal default path", description: "Folder for new terminals while defaults are used. Empty keeps the workspace root.", control: <input className="settings-text" type="text" aria-label="Terminal default path" placeholder="Workspace root" value={settings.terminalDefaultPath ?? ""} maxLength={500} onChange={(event) => onSettingsChange({ ...settings, terminalDefaultPath: event.currentTarget.value })} /> },
    { id: "terminal-default-group", section: "terminal", label: "Terminal default group", description: "Group for new terminals while defaults are used. Empty keeps the active group. A name that matches no group creates one.", control: <input className="settings-text" type="text" aria-label="Terminal default group" placeholder="Active group" value={settings.terminalDefaultGroup ?? ""} maxLength={80} onChange={(event) => onSettingsChange({ ...settings, terminalDefaultGroup: event.currentTarget.value })} /> },
    { id: "agent-usage", section: "terminal", label: "Agent usage", description: "Reads local Codex and Claude Code log files to show token use and limits. Nothing is sent over the network.", control: <input className="settings-toggle" type="checkbox" aria-label="Agent usage" checked={settings.agentUsageEnabled} onChange={(event) => onSettingsChange({ ...settings, agentUsageEnabled: event.currentTarget.checked })} /> },
    ...shortcuts.map((shortcut) => ({ id: "shortcut-" + shortcut.keys + "-" + shortcut.label, section: "shortcuts" as const, label: shortcut.label, control: <kbd className="settings-kbd">{shortcut.keys}</kbd> })),
  ];

  const needle = query.trim().toLowerCase();
  const visibleRows = (id: SectionId) => rows.filter((row) => row.section === id && (!needle || row.label.toLowerCase().includes(needle)));
  const anyVisible = sections.some((item) => visibleRows(item.id).length > 0);

  const selectSection = (id: SectionId) => {
    setSection(id);
    const main = mainRef.current;
    const target = sectionRefs.current.get(id);
    if (main && target) main.scrollTop = Math.max(0, target.offsetTop - 8);
  };

  useEffect(() => { selectSection(initialSection); }, [initialSection]);

  return <div className="settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <header className="settings-head">
        <h2 id="settings-heading">Settings</h2>
        <input type="search" className="settings-search" placeholder="Search settings" aria-label="Search settings" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        <button ref={closeRef} type="button" className="settings-close" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((item) => <button type="button" key={item.id} aria-current={section === item.id ? "true" : undefined} onClick={() => selectSection(item.id)}>{item.label}</button>)}
        </nav>
        <div className="settings-main" ref={mainRef}>
          {sections.map((item) => {
            const list = visibleRows(item.id);
            if (list.length === 0) return null;
            return <section key={item.id} className="settings-section" aria-labelledby={"settings-section-" + item.id} ref={(element) => { if (element) sectionRefs.current.set(item.id, element); else sectionRefs.current.delete(item.id); }}>
              <h3 id={"settings-section-" + item.id}>{item.label}</h3>
              {item.id === "languages" && <p>Languages load locally when a file is opened. Disabled languages open as plain text. Completion uses words from the current file.</p>}
              {list.map((row) => <div className="settings-row" key={row.id}>
                <div className="settings-row-text"><b>{row.label}</b>{row.description && <span>{row.description}</span>}</div>
                <div className="settings-row-control">{row.control}</div>
              </div>)}
            </section>;
          })}
          {!anyVisible && <p className="settings-empty">No settings match "{query.trim()}".</p>}
        </div>
      </div>
    </section>
  </div>;
}

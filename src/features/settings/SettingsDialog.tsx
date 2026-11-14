import { useEffect, useRef, useState, type ReactNode } from "react";
import "./settings.css";

export type ThemeId = "obsidian" | "nordic" | "foundry";
export type AppSettings = { theme: ThemeId; editorFontFamily: string; editorFontSize: number; terminalFontFamily: string; terminalFontSize: number; quickOpenScope: "active" | "all"; collapseOtherFolders: boolean; autoSave: boolean };
/** Supported font sizes (px) for the editor and terminal; also used when loading stored settings. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export function clampFontSize(value: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value));
}
type Shortcut = { keys: string; label: string };
type SectionId = "appearance" | "editor" | "explorer" | "terminal" | "shortcuts";
type Props = { settings: AppSettings; shortcuts: readonly Shortcut[]; onSettingsChange: (value: AppSettings) => void; onClose: () => void };
type SettingRow = { id: string; section: SectionId; label: string; description?: string; control: ReactNode };

const sections: { id: SectionId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "explorer", label: "Explorer" },
  { id: "terminal", label: "Terminal" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
];
const themes: { id: ThemeId; label: string; short: string }[] = [
  { id: "obsidian", label: "Obsidian Atelier", short: "Obsidian" },
  { id: "nordic", label: "Nordic Glass", short: "Nordic" },
  { id: "foundry", label: "Foundry", short: "Foundry" },
];

export function SettingsDialog({ settings, shortcuts, onSettingsChange, onClose }: Props) {
  const [section, setSection] = useState<SectionId>("appearance");
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

  const rows: SettingRow[] = [
    { id: "theme", section: "appearance", label: "Theme", description: "Colors for the whole window.", control: <div className="settings-seg" role="group" aria-label="Theme">{themes.map((theme) => <button key={theme.id} type="button" aria-label={theme.label} aria-pressed={settings.theme === theme.id} onClick={() => onSettingsChange({ ...settings, theme: theme.id })}>{theme.short}</button>)}</div> },
    { id: "editor-font-family", section: "editor", label: "Font family", description: "Used by the code editor.", control: <input className="settings-text" type="text" aria-label="Editor font family" value={settings.editorFontFamily} maxLength={250} onChange={(event) => onSettingsChange({ ...settings, editorFontFamily: event.currentTarget.value })} /> },
    { id: "editor-font-size", section: "editor", label: "Font size", description: "Editor text size in pixels.", control: <span className="settings-number"><input type="number" aria-label="Editor font size" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} value={settings.editorFontSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) onSettingsChange({ ...settings, editorFontSize: clampFontSize(value) }); }} />px</span> },
    { id: "auto-save", section: "editor", label: "Auto Save", description: "Save edited workspace files 1 second after typing stops. Ctrl+S still saves immediately.", control: <input className="settings-toggle" type="checkbox" aria-label="Auto Save" checked={settings.autoSave} onChange={(event) => onSettingsChange({ ...settings, autoSave: event.currentTarget.checked })} /> },
    { id: "quick-open-scope", section: "editor", label: "Quick Open scope", description: "Choose which workspace folders Ctrl+P searches.", control: <select className="settings-select" aria-label="Quick Open scope" value={settings.quickOpenScope} onChange={(event) => onSettingsChange({ ...settings, quickOpenScope: event.currentTarget.value === "all" ? "all" : "active" })}><option value="active">Active workspace</option><option value="all">All workspaces</option></select> },
    { id: "collapse-folders", section: "explorer", label: "Collapse other folders when expanding", description: "Keep the selected folder and its parent path open.", control: <input className="settings-toggle" type="checkbox" aria-label="Collapse other folders when expanding" checked={settings.collapseOtherFolders} onChange={(event) => onSettingsChange({ ...settings, collapseOtherFolders: event.currentTarget.checked })} /> },
    { id: "terminal-font-family", section: "terminal", label: "Font family", description: "Used by every terminal.", control: <input className="settings-text" type="text" aria-label="Terminal font family" value={settings.terminalFontFamily} maxLength={250} onChange={(event) => onSettingsChange({ ...settings, terminalFontFamily: event.currentTarget.value })} /> },
    { id: "terminal-font-size", section: "terminal", label: "Font size", description: "Terminal text size in pixels.", control: <span className="settings-number"><input type="number" aria-label="Terminal font size" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} value={settings.terminalFontSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) onSettingsChange({ ...settings, terminalFontSize: clampFontSize(value) }); }} />px</span> },
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

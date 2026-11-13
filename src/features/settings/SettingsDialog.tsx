import { useEffect, useRef, useState } from "react";
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
type Section = "appearance" | "editor" | "explorer" | "terminal" | "shortcuts";
type Props = { settings: AppSettings; shortcuts: readonly Shortcut[]; onSettingsChange: (value: AppSettings) => void; onClose: () => void };
const sections: { id: Section; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: "◈" }, { id: "editor", label: "Editor", icon: "⌘" },
  { id: "explorer", label: "Explorer", icon: "▤" },
  { id: "terminal", label: "Terminal", icon: "▣" },
  { id: "shortcuts", label: "Help & shortcuts", icon: "?" }
];
const themes: { id: ThemeId; label: string; description: string }[] = [
  { id: "obsidian", label: "Obsidian Atelier", description: "Graphite and amber" },
  { id: "nordic", label: "Nordic Glass", description: "Cool graphite and teal" },
  { id: "foundry", label: "Foundry", description: "Warm graphite and copper" }
];
function FontFields({ family, size, onFamily, onSize }: { family: string; size: number; onFamily: (value: string) => void; onSize: (value: number) => void }) {
  return <div className="settings-fields">
    <label className="settings-field"><span><strong>Font family</strong><small>A CSS font stack, in order of preference.</small></span><input type="text" value={family} maxLength={250} onChange={(event) => onFamily(event.currentTarget.value)} /></label>
    <label className="settings-field"><span><strong>Font size</strong><small>Choose a comfortable reading size.</small></span><span className="settings-size"><input type="number" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} value={size} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) onSize(clampFontSize(value)); }} /> px</span></label>
  </div>;
}
export function SettingsDialog({ settings, shortcuts, onSettingsChange, onClose }: Props) {
  const [section, setSection] = useState<Section>("appearance");
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return <div className="settings-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <aside className="settings-sidebar"><div className="settings-brand"><span>y</span> yerminal <small>SETTINGS</small></div><div className="settings-caption">PREFERENCES</div>
        <nav aria-label="Settings sections">{sections.map((item) => <button type="button" key={item.id} className={section === item.id ? "selected" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="settings-note">Made for your workspace.</div>
      </aside>
      <div className="settings-content"><header className="settings-header"><div><span className="settings-caption">YOUR SPACE, YOUR WAY</span><h2 id="settings-heading">{sections.find((item) => item.id === section)?.label}</h2></div><button ref={closeRef} type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>×</button></header>
        <div className="settings-body">
          {section === "appearance" && <><p>Choose a visual direction for your workspace. Your selection applies across the application.</p><div className="settings-caption">COLOR THEME</div><div className="settings-themes">{themes.map((theme) => <button key={theme.id} type="button" className={"settings-theme settings-theme-" + theme.id + (settings.theme === theme.id ? " selected" : "")} aria-pressed={settings.theme === theme.id} onClick={() => onSettingsChange({ ...settings, theme: theme.id })}><span className="settings-preview"><i /><i /><i /></span><strong>{theme.label} {settings.theme === theme.id ? "✓" : ""}</strong><small>{theme.description}</small></button>)}</div></>}
          {section === "editor" && <><p>Fine tune the type used when reading and editing code, and choose where Quick Open searches.</p><div className="settings-caption">TYPOGRAPHY</div><FontFields family={settings.editorFontFamily} size={settings.editorFontSize} onFamily={(editorFontFamily) => onSettingsChange({ ...settings, editorFontFamily })} onSize={(editorFontSize) => onSettingsChange({ ...settings, editorFontSize })} /><div className="settings-caption settings-quick-open-caption">SAVE</div><div className="settings-fields"><label className="settings-field"><span><strong>Auto Save</strong><small id="auto-save-description">Save edited workspace files 1 second after typing stops. Ctrl+S still saves immediately.</small></span><input className="settings-checkbox" type="checkbox" aria-label="Auto Save" aria-describedby="auto-save-description" checked={settings.autoSave} onChange={(event) => onSettingsChange({ ...settings, autoSave: event.currentTarget.checked })} /></label></div><div className="settings-caption settings-quick-open-caption">QUICK OPEN</div><div className="settings-fields"><label className="settings-field"><span><strong>Search scope</strong><small>Choose which workspace folders Ctrl+P searches.</small></span><select value={settings.quickOpenScope} onChange={(event) => onSettingsChange({ ...settings, quickOpenScope: event.currentTarget.value === "all" ? "all" : "active" })}><option value="active">Active workspace</option><option value="all">All workspaces</option></select></label></div></>}
          {section === "explorer" && <><p>Choose how expanded folders behave in the workspace tree.</p><div className="settings-caption">FOLDER EXPANSION</div><div className="settings-fields"><label className="settings-field"><span><strong>Collapse other folders when expanding</strong><small>Keep the selected folder and its parent path open.</small></span><input className="settings-checkbox" type="checkbox" checked={settings.collapseOtherFolders} onChange={(event) => onSettingsChange({ ...settings, collapseOtherFolders: event.currentTarget.checked })} /></label></div></>}
          {section === "terminal" && <><p>Make terminal sessions comfortable for long stretches of work.</p><div className="settings-caption">TYPOGRAPHY</div><FontFields family={settings.terminalFontFamily} size={settings.terminalFontSize} onFamily={(terminalFontFamily) => onSettingsChange({ ...settings, terminalFontFamily })} onSize={(terminalFontSize) => onSettingsChange({ ...settings, terminalFontSize })} /></>}

          {section === "shortcuts" && <><p>Find the actions you use most often.</p><div className="settings-caption">KEYBOARD SHORTCUTS</div><div className="settings-shortcuts">{shortcuts.map((shortcut) => <div key={shortcut.keys}><span>{shortcut.label}</span><kbd>{shortcut.keys}</kbd></div>)}</div></>}
        </div><footer className="settings-footer"><span>Changes are saved automatically</span><button type="button" onClick={onClose}>Done</button></footer>
      </div>
    </section>
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { PaneRenameInput } from "./TerminalPaneMenu";

/**
 * A terminal's name in its sidebar row. Double-click opens the same inline field as the pane title: Enter or
 * losing focus saves, Escape cancels, and a blank name keeps the previous one. The row is a button, so the
 * field stops pointer events from reaching it (no drag, no selection).
 */
export function TerminalSidebarName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return <span className="workspace-terminal-name" onDoubleClick={(event) => { event.stopPropagation(); setDraft(name); setEditing(true); }}>{name}</span>;
  }

  const save = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name) onRename(next);
  };

  return <span className="workspace-terminal-name-editor" onPointerDown={(event) => event.stopPropagation()}>
    <PaneRenameInput terminalName={name} value={draft} inputRef={inputRef} onChange={setDraft} onSave={save} onCancel={() => setEditing(false)} />
  </span>;
}

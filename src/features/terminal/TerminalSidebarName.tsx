import { useEffect, useRef, useState } from "react";
import { PaneRenameInput } from "./TerminalPaneMenu";

/**
 * A terminal's name in its sidebar row. Double-click starts renaming: the parent then draws the row without its
 * button and mounts TerminalSidebarNameEditor in its place, so the field never sits inside a button.
 */
export function TerminalSidebarName({ name, onEdit }: { name: string; onEdit: () => void }) {
  return <span className="workspace-terminal-name" onDoubleClick={(event) => { event.stopPropagation(); onEdit(); }}>{name}</span>;
}

/**
 * The inline rename field in a sidebar row. Enter or losing focus saves, Escape cancels, and a blank name keeps the
 * previous one. Keys and pointer events stop here, so typing (Space and arrows included) never reaches the row or
 * the document.
 */
export function TerminalSidebarNameEditor({ name, onRename, onDone }: { name: string; onRename: (name: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = () => {
    onDone();
    const next = draft.trim();
    if (next && next !== name) onRename(next);
  };

  return <span className="workspace-terminal-name-editor" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <PaneRenameInput terminalName={name} value={draft} inputRef={inputRef} onChange={setDraft} onSave={save} onCancel={onDone} />
  </span>;
}

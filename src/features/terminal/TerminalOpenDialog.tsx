import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { TerminalGroupChoice, TerminalOpenAsk, TerminalOpenChoice } from "./terminalOpenTarget";
import "./terminal-open-dialog.css";

type Props = {
  ask: TerminalOpenAsk;
  folders: readonly string[];
  initialFolder: string | null;
  groups: readonly { id: string; name: string }[];
  activeGroupId: string;
  onBrowse: () => Promise<string | null>;
  onConfirm: (choice: TerminalOpenChoice) => void;
  onCancel: () => void;
};

const NEW_GROUP = "__new__";

/** Asked before a terminal opens when "Use defaults when opening a terminal" is off. Cancel opens nothing. */
export function TerminalOpenDialog({ ask, folders, initialFolder, groups, activeGroupId, onBrowse, onConfirm, onCancel }: Props) {
  const titleId = useId();
  const [folderList, setFolderList] = useState<string[]>(() => [...folders]);
  const [folder, setFolder] = useState<string | null>(initialFolder ?? folders[0] ?? null);
  const [groupChoice, setGroupChoice] = useState<string>(activeGroupId);
  const [newName, setNewName] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { confirmRef.current?.focus(); }, []);

  const browse = async () => {
    const picked = await onBrowse();
    if (!picked) return;
    setFolderList((current) => (current.includes(picked) ? current : [...current, picked]));
    setFolder(picked);
  };

  const confirm = () => {
    const group: TerminalGroupChoice | null = !ask.group ? null
      : groupChoice === NEW_GROUP ? { kind: "new", name: newName.trim() }
      : { kind: "existing", id: groupChoice };
    onConfirm({ folder: ask.folder ? folder : null, group });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return <div className="terminal-open-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="terminal-open-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <h2 id={titleId}>Open terminal</h2>
      {ask.folder && <fieldset className="terminal-open-group">
        <legend>Folder</legend>
        <div className="terminal-open-options">
          {folderList.map((path) => <label className="terminal-open-option" key={path}>
            <input type="radio" name="terminal-open-folder" value={path} checked={folder === path} onChange={() => setFolder(path)} />
            <span title={path}>{path}</span>
          </label>)}
        </div>
        <button className="terminal-open-browse" type="button" aria-label="Browse for a folder" onClick={() => void browse()}>Browse…</button>
      </fieldset>}
      {ask.group && <fieldset className="terminal-open-group">
        <legend>Group</legend>
        <div className="terminal-open-options">
          {groups.map((group) => <label className="terminal-open-option" key={group.id}>
            <input type="radio" name="terminal-open-group" value={group.id} checked={groupChoice === group.id} onChange={() => setGroupChoice(group.id)} />
            <span>{group.name}{group.id === activeGroupId ? " (active)" : ""}</span>
          </label>)}
          <label className="terminal-open-option">
            <input type="radio" name="terminal-open-group" value={NEW_GROUP} checked={groupChoice === NEW_GROUP} onChange={() => setGroupChoice(NEW_GROUP)} />
            <span>New group</span>
          </label>
        </div>
        {groupChoice === NEW_GROUP && <input className="terminal-open-name" type="text" aria-label="New group name" placeholder="Terminal name" maxLength={80} value={newName} onChange={(event) => setNewName(event.currentTarget.value)} />}
      </fieldset>}
      <footer className="terminal-open-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button ref={confirmRef} className="is-primary" type="button" onClick={confirm} disabled={ask.folder && !folder}>Open terminal</button>
      </footer>
    </section>
  </div>;
}

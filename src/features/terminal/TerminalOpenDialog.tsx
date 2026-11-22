import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { normalizeTerminalName, TERMINAL_NAME_MAX_LENGTH, type TerminalGroupChoice, type TerminalOpenAsk, type TerminalOpenChoice } from "./terminalOpenTarget";
import "./terminal-open-dialog.css";

type Props = {
  ask: TerminalOpenAsk;
  folders: readonly string[];
  initialFolder: string | null;
  groups: readonly { id: string; name: string }[];
  activeGroupId: string;
  /** The group the entry point already knows (folder-only prompts); null when the group is chosen here. */
  fixedGroupId?: string | null;
  /** The automatic name for a group (null = a new group), shown as the name field's placeholder. */
  automaticNameFor: (groupId: string | null) => string;
  onBrowse: () => Promise<string | null>;
  onConfirm: (choice: TerminalOpenChoice) => void;
  onCancel: () => void;
};

const NEW_GROUP = "__new__";

/** Asked before a terminal opens when "Use defaults when opening a terminal" is off. Cancel opens nothing. */
export function TerminalOpenDialog({ ask, folders, initialFolder, groups, activeGroupId, fixedGroupId = null, automaticNameFor, onBrowse, onConfirm, onCancel }: Props) {
  const titleId = useId();
  const [folderList, setFolderList] = useState<string[]>(() => [...folders]);
  const [folder, setFolder] = useState<string | null>(initialFolder ?? folders[0] ?? null);
  const [groupChoice, setGroupChoice] = useState<string>(activeGroupId);
  const [newName, setNewName] = useState("");
  const [terminalName, setTerminalName] = useState("");
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
    const name = normalizeTerminalName(terminalName);
    onConfirm({ folder: ask.folder ? folder : null, group, ...(name ? { name } : {}) });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  // Enter in the name field confirms, as long as a folder is chosen when the prompt asks for one.
  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!ask.folder || folder) confirm();
  };

  // The group the new terminal will land in: the chosen one, the fixed one, or the active one. A new group has no terminals yet.
  const targetGroupId = ask.group ? (groupChoice === NEW_GROUP ? null : groupChoice) : (fixedGroupId ?? activeGroupId);

  return <div className="terminal-open-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="terminal-open-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <h2 id={titleId}>{ask.folder && !ask.group ? "Terminal Folder" : "Open terminal"}</h2>
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
      <label className="terminal-open-field">
        <span>Name (optional)</span>
        <input className="terminal-open-name" type="text" aria-label="Terminal name" placeholder={automaticNameFor(targetGroupId)} maxLength={TERMINAL_NAME_MAX_LENGTH} autoComplete="off" value={terminalName} onChange={(event) => setTerminalName(event.currentTarget.value)} onKeyDown={onNameKeyDown} />
      </label>
      <footer className="terminal-open-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button ref={confirmRef} className="is-primary" type="button" onClick={confirm} disabled={ask.folder && !folder}>Open terminal</button>
      </footer>
    </section>
  </div>;
}

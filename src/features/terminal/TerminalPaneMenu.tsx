import { useEffect, useRef, useState, type RefObject } from "react";
import { handleMenuNavigationKey } from "../workspace/menuKeyboard";

export type PaneMenuGroup = { id: string; name: string };

type TerminalPaneMenuProps = {
  terminalName: string;
  moveTargets: PaneMenuGroup[];
  onRename: () => void;
  onMove: (groupId: string) => void;
  onSplit: () => void;
  onClose: () => void;
};

// "More actions" popover for a terminal pane. Move to group expands an inline
// submenu of the other groups. Closes on outside pointer down and Escape;
// Escape returns focus to the trigger.
export function TerminalPaneMenu({ terminalName, moveTargets, onRename, onMove, onSplit, onClose }: TerminalPaneMenuProps) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (returnFocus: boolean) => {
      setOpen(false);
      setMoveOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      dismiss(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        if (menuRef.current?.contains(document.activeElement)) handleMenuNavigationKey(event, menuRef.current, () => dismiss(false));
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    setMoveOpen(false);
    triggerRef.current?.focus();
    action();
  };

  return <div className="pane-menu-wrap">
    <button ref={triggerRef} type="button" className="pane-icon-button pane-more" aria-label={`More actions for ${terminalName}`} title="More actions" aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" /></svg>
    </button>
    {open && <div ref={menuRef} className="pane-menu" role="menu" aria-label={`${terminalName} actions`}>
      <button type="button" role="menuitem" className="pane-menu-item" onClick={() => choose(onRename)}>Rename</button>
      {moveTargets.length > 0 && <>
        <button type="button" role="menuitem" className="pane-menu-item" aria-expanded={moveOpen} onClick={() => setMoveOpen((value) => !value)}>
          Move to group
          <svg className="pane-menu-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        {moveOpen && moveTargets.map((group) => <button key={group.id} type="button" role="menuitem" className="pane-menu-item pane-menu-sub" data-group-to={group.id} onClick={() => choose(() => onMove(group.id))}>{group.name}</button>)}
      </>}
      <button type="button" role="menuitem" className="pane-menu-item" onClick={() => choose(onSplit)}>Split right</button>
      <div className="pane-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="pane-menu-item" onClick={() => choose(onClose)}>Close</button>
    </div>}
  </div>;
}

type PaneRenameInputProps = {
  terminalName: string;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

// Inline rename field in a pane header. Enter saves, Escape cancels, and losing
// focus saves unless the field was just cancelled.
export function PaneRenameInput({ terminalName, value, inputRef, onChange, onSave, onCancel }: PaneRenameInputProps) {
  const cancelledRef = useRef(false);
  return <input
    ref={inputRef}
    className="pane-rename"
    aria-label={`New name for ${terminalName}`}
    autoComplete="off"
    maxLength={60}
    value={value}
    onChange={(event) => onChange(event.currentTarget.value)}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onSave();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelledRef.current = true;
        onCancel();
      }
    }}
    onBlur={() => {
      if (cancelledRef.current) return;
      onSave();
    }}
  />;
}

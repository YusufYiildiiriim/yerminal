import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./folder-context-menu.css";

export type FolderContextMenuAction =
  | "new-file"
  | "new-folder"
  | "open-terminal"
  | "reveal"
  | "copy-path"
  | "remove-folder";

export type FolderContextMenuTarget = {
  root: string;
  path: string;
  isWorkspaceRoot: boolean;
  x: number;
  y: number;
};

type FolderContextMenuItem = { action: FolderContextMenuAction; label: string };

const MENU_ITEMS: FolderContextMenuItem[] = [
  { action: "new-file", label: "New File" },
  { action: "new-folder", label: "New Folder" },
  { action: "open-terminal", label: "Open in Terminal" },
  { action: "reveal", label: "Reveal in File Explorer" },
  { action: "copy-path", label: "Copy Path" },
];

export function FolderContextMenu({ target, onClose, onAction }: {
  target: FolderContextMenuTarget | null;
  onClose: () => void;
  onAction: (action: FolderContextMenuAction) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => {
    if (target) {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, [target]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !target) return;
    const left = Math.max(8, Math.min(target.x, window.innerWidth - menu.offsetWidth - 8));
    const top = Math.max(8, Math.min(target.y, window.innerHeight - menu.offsetHeight - 8));
    setPosition({ left, top });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleScroll = () => onClose();
    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [target, onClose]);

  useEffect(() => {
    if (!target) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']")?.focus();
  }, [target]);

  if (!target) return null;

  const items: FolderContextMenuItem[] = [...MENU_ITEMS];
  if (target.isWorkspaceRoot) items.push({ action: "remove-folder", label: "Remove from Workspace" });

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? []);
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index <= 0 ? buttons.length - 1 : index - 1;
    buttons[next % buttons.length]?.focus();
  };

  return createPortal(
    <div className="folder-context-menu" role="menu" aria-label="Folder actions" ref={menuRef} style={{ left: position.left, top: position.top }} onKeyDown={handleMenuKeyDown}>
      {items.map((item) => (
        <Fragment key={item.action}>
          {item.action === "remove-folder" && <hr className="folder-context-menu-separator" />}
          <button role="menuitem" type="button" onClick={() => { onAction(item.action); onClose(); }}>
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

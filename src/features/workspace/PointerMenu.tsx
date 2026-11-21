import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../explorer/folder-context-menu.css";

export type PointerMenuItem = { label: string; onSelect: () => void; separatorBefore?: boolean; indent?: boolean; disabled?: boolean };
export type PointerMenuTarget = { x: number; y: number; label: string; items: PointerMenuItem[] };

// Right-click menu at the pointer. Replaces the webview's native menu (emoji, undo, ...).
export function PointerMenu({ target, onClose }: { target: PointerMenuTarget | null; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !target) return;
    setPosition({
      left: Math.max(8, Math.min(target.x, window.innerWidth - menu.offsetWidth - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - menu.offsetHeight - 8)),
    });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
    };
  }, [target, onClose]);

  if (!target) return null;
  const host = document.querySelector<HTMLElement>(".app-shell") ?? document.body;
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not(:disabled)") ?? []);
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index <= 0 ? buttons.length - 1 : index - 1;
    buttons[next % buttons.length]?.focus();
  };

  return createPortal(
    <div className="folder-context-menu" role="menu" aria-label={target.label} ref={menuRef} style={{ left: position.left, top: position.top }} onKeyDown={onMenuKeyDown}>
      {target.items.map((item, index) => <div key={`${index}:${item.label}`} style={{ display: "contents" }}>
        {item.separatorBefore && <hr className="folder-context-menu-separator" />}
        <button role="menuitem" type="button" disabled={item.disabled} style={item.indent ? { paddingLeft: 24 } : undefined} onClick={() => { onClose(); item.onSelect(); }}>{item.label}</button>
      </div>)}
    </div>,
    host,
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { handleMenuNavigationKey } from "./menuKeyboard";

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
};

type ActionMenuProps = {
  label: string;
  title: string;
  className: string;
  children: ReactNode;
  items: ActionMenuItem[];
};

// Small popover menu for the "..." buttons. Closes on outside click and Escape;
// Escape returns focus to the trigger.
export function ActionMenu({ label, title, className, children, items }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        if (menuRef.current?.contains(document.activeElement)) handleMenuNavigationKey(event, menuRef.current, () => setOpen(false));
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return <div className="shell-menu-wrap">
    <button ref={triggerRef} className={className} type="button" aria-label={label} title={title} aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}>
      {children}
    </button>
    {open && <div ref={menuRef} className="shell-menu" role="menu" aria-label={label}>
      {items.map((item) => <button key={item.label} className="shell-menu-item" type="button" role="menuitem" disabled={item.disabled} title={item.title} onClick={() => { setOpen(false); triggerRef.current?.focus(); item.onSelect(); }}>
        {item.label}
      </button>)}
    </div>}
  </div>;
}

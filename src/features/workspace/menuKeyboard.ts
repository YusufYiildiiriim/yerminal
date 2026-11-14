// Shared keyboard handling for small popover menus: arrow keys, Home and End
// move focus between enabled menu items; Tab closes the menu.
export function handleMenuNavigationKey(event: KeyboardEvent, menu: HTMLElement | null, close: () => void): boolean {
  if (!menu) return false;
  if (event.key === "Tab") {
    close();
    return false;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not(:disabled)"));
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = 0;
  if (event.key === "End") next = items.length - 1;
  else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
  else if (event.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
  event.preventDefault();
  items[next].focus();
  return true;
}

import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";

export function createTauriMocks() {
  return {
    invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined),
    isTauri: vi.fn(() => true),
    listen: vi.fn(async () => () => {}),
    open: vi.fn(async () => null),
    openUrl: vi.fn(async () => undefined),
    revealItemInDir: vi.fn(async () => undefined),
    onFocusChanged: vi.fn(async () => () => {}),
  };
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
}

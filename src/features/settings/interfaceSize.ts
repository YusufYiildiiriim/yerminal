/** Interface size for UI text only. Editor and terminal fonts use their own Settings values. */
export const INTERFACE_SIZES = ["small", "default", "large"] as const;
export type InterfaceSize = (typeof INTERFACE_SIZES)[number];

export const INTERFACE_SIZE_SCALE: Record<InterfaceSize, number> = { small: 0.92, default: 1, large: 1.1 };

/** Stored values that are not a known size fall back to Default. */
export function normalizeInterfaceSize(value: unknown): InterfaceSize {
  return (INTERFACE_SIZES as readonly unknown[]).includes(value) ? (value as InterfaceSize) : "default";
}

/** Sets --ui-scale; the --fs-* type tokens multiply by it. Editor and terminal variables are not touched. */
export function applyInterfaceSize(root: HTMLElement, size: InterfaceSize): void {
  root.style.setProperty("--ui-scale", String(INTERFACE_SIZE_SCALE[size]));
}

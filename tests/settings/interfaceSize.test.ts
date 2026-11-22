import { afterEach, describe, expect, it } from "vitest";
import {
  INTERFACE_SIZE_SCALE,
  INTERFACE_SIZES,
  applyInterfaceSize,
  normalizeInterfaceSize,
} from "../../src/features/settings/interfaceSize";

describe("interface size", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("offers Small, Default and Large with the agreed multipliers", () => {
    expect(INTERFACE_SIZES).toEqual(["small", "default", "large"]);
    expect(INTERFACE_SIZE_SCALE).toEqual({ small: 0.92, default: 1, large: 1.1 });
  });

  it("keeps stored values that are known and falls back to Default otherwise", () => {
    expect(normalizeInterfaceSize("small")).toBe("small");
    expect(normalizeInterfaceSize("large")).toBe("large");
    expect(normalizeInterfaceSize("huge")).toBe("default");
    expect(normalizeInterfaceSize(undefined)).toBe("default");
    expect(normalizeInterfaceSize(1.1)).toBe("default");
  });

  it("sets only the UI scale variable and leaves editor and terminal font sizes alone", () => {
    const root = document.documentElement;
    root.style.setProperty("--editor-font-size", "14px");
    root.style.setProperty("--terminal-font-size", "13px");

    applyInterfaceSize(root, "small");
    expect(root.style.getPropertyValue("--ui-scale")).toBe("0.92");
    applyInterfaceSize(root, "large");
    expect(root.style.getPropertyValue("--ui-scale")).toBe("1.1");
    applyInterfaceSize(root, "default");
    expect(root.style.getPropertyValue("--ui-scale")).toBe("1");

    expect(root.style.getPropertyValue("--editor-font-size")).toBe("14px");
    expect(root.style.getPropertyValue("--terminal-font-size")).toBe("13px");
  });
});

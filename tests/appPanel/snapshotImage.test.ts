import { describe, expect, it } from "vitest";
import { parseSnapshot } from "../../src/features/app-panel/snapshotImage";

function payload(width: number, height: number, pixels: number[]): ArrayBuffer {
  const bytes = new Uint8Array(8 + pixels.length);
  new DataView(bytes.buffer).setUint32(0, width, true);
  new DataView(bytes.buffer).setUint32(4, height, true);
  bytes.set(pixels, 8);
  return bytes.buffer;
}

describe("parseSnapshot", () => {
  it("reads the size and turns BGRA rows into RGBA", () => {
    const image = parseSnapshot(payload(2, 1, [10, 20, 30, 255, 1, 2, 3, 255]));
    expect(image).not.toBeNull();
    expect(image?.width).toBe(2);
    expect(image?.height).toBe(1);
    expect(Array.from(image?.rgba ?? [])).toEqual([30, 20, 10, 255, 3, 2, 1, 255]);
  });

  it("accepts typed arrays and plain number arrays too", () => {
    const raw = new Uint8Array(payload(1, 1, [1, 2, 3, 255]));
    expect(parseSnapshot(raw)?.rgba[0]).toBe(3);
    expect(parseSnapshot(Array.from(raw))?.rgba[0]).toBe(3);
  });

  it("rejects anything that is not a whole frame", () => {
    expect(parseSnapshot(undefined)).toBeNull();
    expect(parseSnapshot(new ArrayBuffer(4))).toBeNull();
    expect(parseSnapshot(payload(2, 2, [1, 2, 3, 255]))).toBeNull();
    expect(parseSnapshot(payload(0, 0, []))).toBeNull();
  });
});

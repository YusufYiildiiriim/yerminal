/** A still frame of the hosted window: RGBA rows ready for a canvas. */
export interface SnapshotImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

function toBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  return null;
}

/**
 * Reads the native payload: width and height as little-endian u32, then BGRA rows. Anything that
 * is not exactly one whole frame gives null (the caller shows its plain note instead).
 */
export function parseSnapshot(raw: unknown): SnapshotImage | null {
  const bytes = toBytes(raw);
  if (!bytes || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (width === 0 || height === 0 || bytes.length !== 8 + width * height * 4) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 8; i < rgba.length; i += 4, o += 4) {
    rgba[i] = bytes[o + 2];
    rgba[i + 1] = bytes[o + 1];
    rgba[i + 2] = bytes[o];
    rgba[i + 3] = bytes[o + 3];
  }
  return { width, height, rgba };
}

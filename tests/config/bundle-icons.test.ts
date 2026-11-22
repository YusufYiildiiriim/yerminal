import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { bundle: { icon: string[] } };

type DecodedPng = { width: number; height: number; pixels: Buffer };

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decodes an 8-bit RGBA, non-interlaced PNG (the only format Tauri emits for these files).
function decodePng(path: string): DecodedPng {
  const data = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("latin1");
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? current[x - 4] : 0;
      const b = previous[x];
      const c = x >= 4 ? previous[x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      current[x] = value & 255;
    }
    current.copy(pixels, y * stride);
    previous = current;
  }
  return { width, height, pixels };
}

// Samples by fraction of the icon grid (560-unit design), so every size reads the same points.
function sampleAt(png: DecodedPng, fx: number, fy: number) {
  const x = Math.floor(fx * png.width);
  const y = Math.floor(fy * png.height);
  const i = (y * png.width + x) * 4;
  return [...png.pixels.subarray(i, i + 4)];
}

// Icon-grid points: inside the green chevron (between the notch at x=26 and the tip at x=38, mark y=46),
// inside the amber arm, dark ground, outside the rounded corner.
const greenPoint = [188 / 560, 264 / 560];
const amberPoint = [412 / 560, 280 / 560];
const groundPoint = [140 / 560, 140 / 560];

describe("desktop bundle icons", () => {
  it.each([["icons/32x32.png", 32], ["icons/128x128.png", 128], ["icons/128x128@2x.png", 256], ["icons/icon.png", 256]] as const)(
    "includes a square 32-bit RGBA PNG for Linux: %s", (path, size) => {
      expect(config.bundle.icon).toContain(path);
      const data = readFileSync(`src-tauri/${path}`);
      expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(data.readUInt32BE(16)).toBe(size);
      expect(data.readUInt32BE(20)).toBe(size);
      expect(data[24]).toBe(8);
      expect(data[25]).toBe(6);
    },
  );
  it("retains the Windows icon", () => {
    expect(config.bundle.icon).toContain("icons/icon.ico");
    expect(readFileSync("src-tauri/icons/icon.ico").length).toBeGreaterThan(0);
  });
  it("ships a valid ICO container with the small sizes Windows uses in the taskbar", () => {
    const ico = readFileSync("src-tauri/icons/icon.ico");
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    // ICONDIRENTRY width byte: 0 means 256.
    const sizes = Array.from({ length: count }, (_, index) => ico[6 + index * 16] || 256);
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
  });
  it.each(["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"])(
    "paints the approved mark colors and a transparent rounded corner: %s", (path) => {
      const png = decodePng(`src-tauri/${path}`);
      // Downscaled sizes blend a little at fill edges; 12 per channel still rejects the old palette.
      const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]) <= 12);
      expect(near(sampleAt(png, greenPoint[0], greenPoint[1]), [0x1c, 0x7a, 0x48, 255])).toBe(true);
      expect(near(sampleAt(png, amberPoint[0], amberPoint[1]), [0xa3, 0x65, 0x0f, 255])).toBe(true);
      expect(near(sampleAt(png, groundPoint[0], groundPoint[1]), [0x17, 0x16, 0x1f, 255])).toBe(true);
      expect(sampleAt(png, 0, 0)[3]).toBe(0);
    },
  );
});

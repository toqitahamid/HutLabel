import { describe, expect, it } from "vitest";
import { deriveMaxLevel, levelSize, tileGrid, tileInRange } from "./tile-geometry";

// Example Site A: the real, TALL, non-square ortho (8684 x 31964). The square demo
// crop (4096 x 4096, level 12) would NOT surface a non-square / reference-level
// bug — these cases exist specifically to catch that (advisor's blind spot #4).
const FC_W = 8684;
const FC_H = 31964;

describe("deriveMaxLevel", () => {
  it("matches tiler.py: ceil(log2(max(W,H)))", () => {
    // 31964 -> log2 ~= 14.96 -> 15. This is the tall ortho's real max level.
    expect(deriveMaxLevel(FC_W, FC_H)).toBe(15);
  });
  it("square 4096 demo crop is level 12", () => {
    expect(deriveMaxLevel(4096, 4096)).toBe(12);
  });
  it("exact power of two is not rounded up spuriously", () => {
    expect(deriveMaxLevel(256, 256)).toBe(8); // log2(256)=8 exactly
  });
});

describe("levelSize", () => {
  it("native level == full dimensions", () => {
    const max = deriveMaxLevel(FC_W, FC_H);
    expect(levelSize(FC_W, FC_H, max, max)).toEqual({ w: FC_W, h: FC_H });
  });
  it("one level down halves each axis (ceil), preserving the tall aspect", () => {
    const max = deriveMaxLevel(FC_W, FC_H);
    expect(levelSize(FC_W, FC_H, max, max - 1)).toEqual({
      w: Math.ceil(FC_W / 2),
      h: Math.ceil(FC_H / 2),
    });
  });
  it("narrow axis collapses to 1 before the tall axis does", () => {
    const max = deriveMaxLevel(FC_W, FC_H); // 15
    // level 1: scale 2^14=16384 -> w=ceil(8684/16384)=1, h=ceil(31964/16384)=2.
    // Width is already a sliver while height still spans 2px. A square-only
    // test never exercises this asymmetric collapse.
    expect(levelSize(FC_W, FC_H, max, 1)).toEqual({ w: 1, h: 2 });
  });
});

describe("tileGrid", () => {
  it("native Example Site grid is 34 x 125 tiles at 256px", () => {
    const max = deriveMaxLevel(FC_W, FC_H);
    const { w, h } = levelSize(FC_W, FC_H, max, max);
    // ceil(8684/256)=34, ceil(31964/256)=125
    expect(tileGrid(w, h)).toEqual({ cols: 34, rows: 125 });
  });
  it("mid levels are 1 tile wide but many tall (non-square grid)", () => {
    const max = deriveMaxLevel(FC_W, FC_H); // 15
    // level 9: scale 2^6=64 -> w=136 (cols 1), h=500 (rows 2). One column,
    // multiple rows — the exact geometry the square demo tileset cannot show.
    const { w, h } = levelSize(FC_W, FC_H, max, 9);
    expect(tileGrid(w, h)).toEqual({ cols: 1, rows: 2 });
  });
});

describe("tileInRange", () => {
  const max = deriveMaxLevel(FC_W, FC_H);
  it("accepts an interior native tile", () => {
    expect(tileInRange(0, 0, max, FC_W, FC_H, max)).toBe(true);
    expect(tileInRange(33, 124, max, FC_W, FC_H, max)).toBe(true);
  });
  it("rejects a tile past the right edge (col 34 when cols==34)", () => {
    expect(tileInRange(34, 0, max, FC_W, FC_H, max)).toBe(false);
  });
  it("rejects a tile past the bottom edge (row 125 when rows==125)", () => {
    expect(tileInRange(0, 125, max, FC_W, FC_H, max)).toBe(false);
  });
  it("rejects out-of-band levels and negatives", () => {
    expect(tileInRange(0, 0, max + 1, FC_W, FC_H, max)).toBe(false);
    expect(tileInRange(-1, 0, max, FC_W, FC_H, max)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  TEMP_HUT_PREFIX,
  hutCenter,
  isTempHutId,
  isValidBox,
  isValidPosition,
} from "./model";

describe("isValidPosition", () => {
  const W = 8684;
  const H = 31964;
  it("accepts an in-bounds integer pixel", () => {
    expect(isValidPosition(0, 0, W, H)).toBe(true);
    expect(isValidPosition(8683, 31963, W, H)).toBe(true);
  });
  it("rejects out-of-bounds, negative, and non-integer coords", () => {
    expect(isValidPosition(8684, 0, W, H)).toBe(false); // x == width
    expect(isValidPosition(0, 31964, W, H)).toBe(false); // y == height
    expect(isValidPosition(-1, 0, W, H)).toBe(false);
    expect(isValidPosition(1.5, 0, W, H)).toBe(false);
  });
});

describe("isValidBox", () => {
  const W = 8684;
  const H = 31964;
  it("accepts an in-bounds box", () => {
    expect(isValidBox(100, 200, 50, 60, W, H)).toBe(true);
    expect(isValidBox(0, 0, W, H, W, H)).toBe(true); // box fills the whole image
  });
  it("rejects zero/negative extent, out-of-bounds far edge, and non-integers", () => {
    expect(isValidBox(0, 0, 0, 10, W, H)).toBe(false); // w == 0
    expect(isValidBox(0, 0, 10, -1, W, H)).toBe(false); // h < 0
    expect(isValidBox(W - 10, 0, 20, 10, W, H)).toBe(false); // x + w > width
    expect(isValidBox(0, 0, 10.5, 10, W, H)).toBe(false); // non-integer w
  });
});

describe("isTempHutId", () => {
  it("recognizes an optimistic-create id", () => {
    expect(isTempHutId(`${TEMP_HUT_PREFIX}${crypto.randomUUID()}`)).toBe(true);
  });
  it("rejects a server-assigned uuid", () => {
    expect(isTempHutId(crypto.randomUUID())).toBe(false);
  });
});

describe("hutCenter", () => {
  it("centers a box hut in its middle", () => {
    expect(hutCenter({ x: 100, y: 200, w: 50, h: 60 })).toEqual({
      cx: 125,
      cy: 230,
    });
  });
  it("centers a point hut on itself", () => {
    expect(hutCenter({ x: 4200, y: 15000, w: null, h: null })).toEqual({
      cx: 4200,
      cy: 15000,
    });
  });
});

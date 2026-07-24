// Pure pyramid/tile math for the orthomosaic viewer. No Leaflet, no DOM — so it
// is unit-testable in isolation, which is where the one dangerous class of bug
// in a deep-zoom viewer lives (off-by-a-power-of-two, non-square tile ranges).
//
// This MUST stay in lockstep with tiler.py, which emits the pyramid the viewer
// streams. tiler.py's contract:
//   maxLevel = ceil(log2(max(W, H)))
//   level `lvl`: scale = 2^(maxLevel - lvl); lw = ceil(W/scale), lh = ceil(H/scale)
//   grid: cols = ceil(lw/TS), rows = ceil(lh/TS); tile file = {col}_{row}.png
//   y counts from the TOP (no TMS flip); fully-transparent tiles are skipped.
// Leaflet reads this by treating pyramid level == Leaflet zoom, with maxLevel as
// the reference zoom for every pixel<->LatLng conversion (see OrthoMap).

export const TILE_SIZE = 256;

// The native (full-resolution) pyramid level for an image of W x H pixels.
// Equivalently the Leaflet zoom at which one CRS unit == one native pixel.
export function deriveMaxLevel(width: number, height: number): number {
  return Math.ceil(Math.log2(Math.max(width, height)));
}

// The pixel dimensions of one pyramid level (level == maxLevel is native W x H;
// each step down halves resolution, ceil-rounded, exactly like tiler.py).
export function levelSize(
  width: number,
  height: number,
  maxLevel: number,
  level: number,
): { w: number; h: number } {
  const scale = 2 ** (maxLevel - level);
  return {
    w: Math.max(1, Math.ceil(width / scale)),
    h: Math.max(1, Math.ceil(height / scale)),
  };
}

// The tile grid (columns x rows) covering a level of the given pixel size.
export function tileGrid(
  levelW: number,
  levelH: number,
  tileSize = TILE_SIZE,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.ceil(levelW / tileSize)),
    rows: Math.max(1, Math.ceil(levelH / tileSize)),
  };
}

// A tile (x=col, y=row) at `level` is in range iff it lies within that level's
// grid. Leaflet will still REQUEST out-of-range and transparent-skipped tiles;
// those 404 and render blank — expected, not an error. This predicate is for
// callers that want to reason about coverage without a network round-trip.
export function tileInRange(
  x: number,
  y: number,
  level: number,
  width: number,
  height: number,
  maxLevel: number,
  tileSize = TILE_SIZE,
): boolean {
  if (x < 0 || y < 0 || level < 0 || level > maxLevel) return false;
  const { w, h } = levelSize(width, height, maxLevel, level);
  const { cols, rows } = tileGrid(w, h, tileSize);
  return x < cols && y < rows;
}

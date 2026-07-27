// The hut geometry schema. A hut is purely a box (or point) label — no manual
// attributes; extent/size comes from the box itself, and the SAM mask derived
// offline from it on Delta, not a per-hut dropdown.
//
// Pure module (no React, no I/O) so the geometry validation is unit-testable
// and shared by the UI and the /api functions.

// A hut as persisted: identity + geometry + provenance. Geometry is in native
// crop/image pixels (the ortho's full-resolution space):
//   - box label:  (x, y) = top-left corner, (w, h) = size. This is the default —
//     a box is the strongest SAM prompt AND a ready detection label, and its
//     extent gives real size (mask/area) instead of a guessed diameter.
//   - point label: (x, y) = the point, w = h = null. A faster count-only mode.
// The SAM mask (polygon) is derived offline from the box on Delta, not drawn by
// hand — so no geometry beyond the box lives here yet.
export type Hut = {
  id: string;
  ortho_id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  labeler_id: string | null;
  created_at: string | null;
};

// The center of a hut in native pixels, for rendering a marker/label. A box's
// center is its middle; a point's center is itself.
export function hutCenter(hut: {
  x: number;
  y: number;
  w: number | null;
  h: number | null;
}): { cx: number; cy: number } {
  if (hut.w != null && hut.h != null) {
    return { cx: hut.x + hut.w / 2, cy: hut.y + hut.h / 2 };
  }
  return { cx: hut.x, cy: hut.y };
}

// Prefix marking a hut that exists only in local state, added optimistically
// while its createHut request is in flight and not yet backed by a server
// row. Mutating calls (PATCH/DELETE) against such an id would 404, so
// callers check this before reaching for the backend.
export const TEMP_HUT_PREFIX = "temp-";

export function isTempHutId(id: string): boolean {
  return id.startsWith(TEMP_HUT_PREFIX);
}

// Native-pixel coordinates are integers within the image bounds. The viewer
// rounds a click to the nearest pixel; this rejects anything off-image or
// non-integer before it is stored.
export function isValidPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height
  );
}

// Box-hut guard: (x, y) top-left + (w, h) size, all integers, positive extent,
// and fully inside the image (x + w <= width, not < — the box's far edge may
// touch the image boundary).
export function isValidBox(
  x: number,
  y: number,
  w: number,
  h: number,
  width: number,
  height: number,
): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    x >= 0 &&
    y >= 0 &&
    x + w <= width &&
    y + h <= height
  );
}

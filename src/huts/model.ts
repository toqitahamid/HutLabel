// The frozen hut annotation schema (HUTLABEL_HANDOFF.md). Attributes are cheap
// per click but a re-sweep of 41 gigapixel orthos is not, so the schema is fixed
// BEFORE anyone labels — changing it mid-project makes sites inconsistent. These
// const tuples are the single source of truth for both the DB check constraints
// (see supabase/migrations) and the attribute-panel dropdowns.
//
// Pure module (no React, no Supabase) so the value set and validation are
// unit-testable and shared by the UI and the backend.

export const STRUCTURE_TYPES = [
  "dwelling_hut",
  "feeding_platform",
  "uncertain_mound",
] as const;
export const CONFIDENCES = ["certain", "maybe"] as const;

export type StructureType = (typeof STRUCTURE_TYPES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

// The attributes a labeler sets on a hut. Extent/size comes from the SAM mask
// derived offline from the box, not a manual field — a wildlife-literature
// review found other candidate attributes aren't reliably judgeable from a
// single winter RGB orthomosaic.
export type HutAttributes = {
  structure_type: StructureType;
  confidence: Confidence;
};

// A hut as persisted: identity + geometry + attributes + provenance. Geometry is
// in native crop/image pixels (the ortho's full-resolution space):
//   - box label:  (x, y) = top-left corner, (w, h) = size. This is the default —
//     a box is the strongest SAM prompt AND a ready detection label, and its
//     extent gives real size (mask/area) instead of a guessed diameter.
//   - point label: (x, y) = the point, w = h = null. A faster count-only mode.
// The SAM mask (polygon) is derived offline from the box on Delta, not drawn by
// hand — so no geometry beyond the box lives here yet.
export type Hut = HutAttributes & {
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

// The default attributes for a freshly dropped hut. The labeler adjusts them in
// the panel; sensible defaults mean a fast "click, click, click" pass still
// yields usable rows (the common case is a certain dwelling hut).
export function defaultAttributes(): HutAttributes {
  return {
    structure_type: "dwelling_hut",
    confidence: "certain",
  };
}

// Guard used by both the panel (before enabling save) and the backend (before an
// insert/update reaches RLS). Rejects out-of-set enum values so a malformed
// attribute never silently persists.
export function isValidAttributes(a: HutAttributes): boolean {
  return (
    (STRUCTURE_TYPES as readonly string[]).includes(a.structure_type) &&
    (CONFIDENCES as readonly string[]).includes(a.confidence)
  );
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

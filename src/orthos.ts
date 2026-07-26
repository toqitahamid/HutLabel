// One orthomosaic the viewer can stream and label. Mirrors the `orthos` table
// (HUTLABEL_HANDOFF.md); the lock/status columns are added in phase 2 and are
// not needed to render or label.
export type Ortho = {
  id: string;
  site: string;
  visit: string; // "A" | "B" — the two field visits
  width: number; // native pixels
  height: number; // native pixels
  max_level: number; // pyramid native level == Leaflet reference zoom
};

// The tile URL template for an ortho, kept in lockstep with tiler.py's output
// layout: {base}/{ortho_id}/{z}/{x}_{y}.{ext}. `base` is VITE_TILE_BASE (R2 in
// prod, "/tiles-real" in dev); `ext` is VITE_TILE_EXT (webp from tiler.py).
// Leaflet fills {z}/{x}/{y} itself.
export function tileUrlTemplate(
  base: string,
  orthoId: string,
  ext: string,
): string {
  const trimmed = base.replace(/\/$/, "");
  return `${trimmed}/${orthoId}/{z}/{x}_{y}.${ext}`;
}

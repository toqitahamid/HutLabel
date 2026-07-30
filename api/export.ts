import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin, requireUser, sql } from "./_lib.js";

// GET /api/export — every ortho and hut in the database as one JSON file,
// admin-only. Shaped so a downstream SAM (Segment Anything) pipeline can
// consume the boxes directly: one row per ortho with its huts nested, so an
// ortho with zero huts still shows up (known-but-unlabeled) instead of
// silently vanishing.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await requireAdmin(userId, res))) return;

  const db = sql();
  // Two queries rather than one LEFT JOIN — nesting huts per ortho in SQL
  // would mean a json_agg, and grouping in JS is simpler to get right here.
  const [orthoRows, hutRows] = await Promise.all([
    db`select id, site, visit, width, height, max_level from orthos order by site asc, visit asc`,
    db`select id, ortho_id, x, y, w, h, confidence, labeler_id, created_at
       from huts order by ortho_id asc, created_at asc`,
  ]);

  const hutsByOrtho = new Map<string, typeof hutRows>();
  for (const hut of hutRows) {
    const existing = hutsByOrtho.get(hut.ortho_id);
    if (existing) existing.push(hut);
    else hutsByOrtho.set(hut.ortho_id, [hut]);
  }

  const orthos = orthoRows.map((o) => ({
    id: o.id,
    site: o.site,
    visit: o.visit,
    width: o.width,
    height: o.height,
    max_level: o.max_level,
    huts: (hutsByOrtho.get(o.id) ?? []).map((h) => ({
      id: h.id,
      // w/h are nullable in the DB (point labels have no extent) — pass
      // nulls through as-is rather than coercing to 0.
      x: h.x,
      y: h.y,
      w: h.w,
      h: h.h,
      confidence: h.confidence,
      labeler_id: h.labeler_id,
      created_at: h.created_at,
    })),
  }));

  const filename = `hutlabel-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).json({
    exported_at: new Date().toISOString(),
    hut_count: hutRows.length,
    coordinate_system: "pixels at native resolution; origin top-left; box = [x, y, w, h]",
    orthos,
  });
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, sql } from "../_lib.js";

// PATCH  /api/huts/:id — update geometry (any signed-in labeler, FlagLabel's
//                        shared-oversight model: the PI can fix anyone's label).
// DELETE /api/huts/:id — remove a hut.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "Hut id is required" });
    return;
  }

  if (req.method === "PATCH") {
    const body = req.body as {
      x?: unknown;
      y?: unknown;
      w?: unknown;
      h?: unknown;
    };

    const hasGeometry =
      body.x !== undefined ||
      body.y !== undefined ||
      body.w !== undefined ||
      body.h !== undefined;

    if (!hasGeometry) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const { x, y, w, h } = body;
    const validGeometry =
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      Number.isInteger(w) &&
      Number.isInteger(h) &&
      (x as number) >= 0 &&
      (y as number) >= 0 &&
      (w as number) > 0 &&
      (h as number) > 0;
    if (!validGeometry) {
      res.status(400).json({ error: "Invalid geometry" });
      return;
    }

    const rows = await sql()`
      update huts
      set x = ${x}, y = ${y}, w = ${w}, h = ${h}
      where id = ${id}
      returning id
    `;
    if (rows.length === 0) {
      res.status(404).json({ error: `No hut ${id} (already gone?)` });
      return;
    }
    res.status(200).json(rows[0]);
    return;
  }

  if (req.method === "DELETE") {
    const rows = await sql()`delete from huts where id = ${id} returning id`;
    if (rows.length === 0) {
      res.status(404).json({ error: `No hut ${id} (already gone?)` });
      return;
    }
    res.status(200).json(rows[0]);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

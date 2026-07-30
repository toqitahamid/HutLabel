import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidConfidence, type Confidence } from "../../src/huts/model.js";
import { requireUser, sql } from "../_lib.js";

// PATCH  /api/huts/:id — update geometry, confidence, or both (any signed-in
//                        labeler, FlagLabel's shared-oversight model: the PI
//                        can fix anyone's label).
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
      confidence?: unknown;
    };

    // The body may carry geometry (a corner-handle resize), confidence (the C
    // shortcut / panel toggle), or both in one call — figure out which groups
    // are present before validating either, so a request with neither is
    // rejected outright.
    const hasGeometry =
      body.x !== undefined ||
      body.y !== undefined ||
      body.w !== undefined ||
      body.h !== undefined;
    const hasConfidence = body.confidence !== undefined;

    if (!hasGeometry && !hasConfidence) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    let geometry: { x: number; y: number; w: number; h: number } | null = null;
    if (hasGeometry) {
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
      geometry = { x: x as number, y: y as number, w: w as number, h: h as number };
    }

    let confidence: Confidence | null = null;
    if (hasConfidence) {
      if (!isValidConfidence(body.confidence)) {
        res.status(400).json({ error: "Invalid confidence" });
        return;
      }
      confidence = body.confidence;
    }

    // The Neon serverless driver's template-tag `sql` doesn't compose dynamic
    // SET fragments, so each {geometry, confidence} combination runs its own
    // literal UPDATE instead of one built up piecemeal.
    if (geometry && confidence) {
      const rows = await sql()`
        update huts
        set x = ${geometry.x}, y = ${geometry.y}, w = ${geometry.w}, h = ${geometry.h},
            confidence = ${confidence}
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

    if (geometry) {
      const rows = await sql()`
        update huts
        set x = ${geometry.x}, y = ${geometry.y}, w = ${geometry.w}, h = ${geometry.h}
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

    // confidence only — hasGeometry/hasConfidence above already ruled out
    // "neither".
    const rows = await sql()`
      update huts
      set confidence = ${confidence!}
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

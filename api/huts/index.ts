import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, sql } from "../_lib.js";

// GET  /api/huts?ortho_id=... — all huts on one ortho (any signed-in labeler).
// POST /api/huts             — insert one hut; labeler_id comes from the token.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await requireUser(req, res);
  if (!userId) return;

  if (req.method === "GET") {
    const orthoId = req.query.ortho_id;
    if (typeof orthoId !== "string" || !orthoId) {
      res.status(400).json({ error: "ortho_id is required" });
      return;
    }
    const rows = await sql()`
      select id, ortho_id, x, y, w, h, labeler_id, created_at
      from huts where ortho_id = ${orthoId}
      order by created_at asc
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === "POST") {
    const body = req.body as {
      ortho_id?: unknown;
      x?: unknown;
      y?: unknown;
      w?: unknown;
      h?: unknown;
    };
    const { ortho_id, x, y, w, h } = body;

    const isInt = (v: unknown): v is number => Number.isInteger(v);
    const validGeometry =
      isInt(x) &&
      isInt(y) &&
      (x as number) >= 0 &&
      (y as number) >= 0 &&
      // point (w = h = null) or box (both positive ints)
      ((w == null && h == null) || (isInt(w) && isInt(h) && w > 0 && h > 0));
    if (typeof ortho_id !== "string" || !ortho_id || !validGeometry) {
      res.status(400).json({ error: "Invalid hut payload" });
      return;
    }

    try {
      const rows = await sql()`
        insert into huts (ortho_id, x, y, w, h, labeler_id)
        values (${ortho_id}, ${x}, ${y}, ${w ?? null}, ${h ?? null}, ${userId})
        returning id, ortho_id, x, y, w, h, labeler_id, created_at
      `;
      res.status(201).json(rows[0]);
    } catch (err) {
      // FK violation = unknown ortho; anything else is a real 500.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("violates foreign key")) {
        res.status(400).json({ error: `Unknown ortho: ${ortho_id}` });
      } else {
        res.status(500).json({ error: `createHut failed: ${msg}` });
      }
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

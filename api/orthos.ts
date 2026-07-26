import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin, requireUser, sql } from "./_lib.js";

// GET /api/orthos — the ortho catalog, admin-seeded via scripts/seed-orthos.
// PATCH /api/orthos — admin-only: mark an ortho done (or reopen it).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    if (!(await requireUser(req, res))) return;

    // hut_count is a LEFT JOIN + count so an ortho with zero huts still comes
    // back (not dropped by an inner join). count(*) is bigint and the Neon
    // serverless driver returns bigints as strings — cast to int so the client
    // gets a number.
    const rows = await sql()`
      select o.id, o.site, o.visit, o.width, o.height, o.max_level, o.done_at,
             count(h.id)::int as hut_count
      from orthos o
      left join huts h on h.ortho_id = o.id
      group by o.id, o.site, o.visit, o.width, o.height, o.max_level, o.done_at
      order by o.site asc, o.visit asc
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === "PATCH") {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!(await requireAdmin(userId, res))) return;

    const { id, done } = req.body as { id?: unknown; done?: unknown };
    if (typeof id !== "string" || id.length === 0 || typeof done !== "boolean") {
      res.status(400).json({ error: "id (string) and done (boolean) are required" });
      return;
    }

    // done_at is set to now (marking done) or cleared (reopening); marking an
    // ortho with zero huts done means surveyed-and-empty, no separate control.
    const doneAt = done ? new Date().toISOString() : null;
    const rows = await sql()`
      update orthos set done_at = ${doneAt} where id = ${id}
      returning id, done_at
    `;
    if (rows.length === 0) {
      res.status(404).json({ error: "Ortho not found" });
      return;
    }
    res.status(200).json(rows[0]);
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

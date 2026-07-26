import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, sql } from "./_lib.js";

// GET /api/orthos — the ortho catalog, admin-seeded via scripts/seed-orthos.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!(await requireUser(req, res))) return;

  // hut_count is a LEFT JOIN + count so an ortho with zero huts still comes
  // back (not dropped by an inner join). count(*) is bigint and the Neon
  // serverless driver returns bigints as strings — cast to int so the client
  // gets a number.
  const rows = await sql()`
    select o.id, o.site, o.visit, o.width, o.height, o.max_level,
           count(h.id)::int as hut_count
    from orthos o
    left join huts h on h.ortho_id = o.id
    group by o.id, o.site, o.visit, o.width, o.height, o.max_level
    order by o.site asc, o.visit asc
  `;
  res.status(200).json(rows);
}

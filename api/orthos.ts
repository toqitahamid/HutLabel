import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireUser, sql } from "./_lib";

// GET /api/orthos — the ortho catalog, admin-seeded via scripts/seed-orthos.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!(await requireUser(req, res))) return;

  const rows = await sql()`
    select id, site, visit, width, height, max_level
    from orthos
    order by site asc, visit asc
  `;
  res.status(200).json(rows);
}

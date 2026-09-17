import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidVerdict, type Verdict } from "../../../src/candidates/model.js";
import { requireUser, sql } from "../../_lib.js";

// PUT    /api/candidates/:id/review — record MY verdict on a candidate (any
//          signed-in user). Upsert, so re-deciding overwrites my own row.
// DELETE /api/candidates/:id/review — clear MY verdict.
//
// reviewer_id always comes from the verified token, never the body — the same
// rule huts.labeler_id follows — so one reviewer can neither write nor read
// another's verdict through this route. That is what keeps a second pass an
// independent opinion (see scripts/migrations/004-candidates.sql).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "Candidate id is required" });
    return;
  }

  if (req.method === "PUT") {
    const { verdict } = req.body as { verdict?: unknown };
    if (!isValidVerdict(verdict)) {
      res.status(400).json({ error: "Invalid verdict" });
      return;
    }
    try {
      const rows = await sql()`
        insert into candidate_reviews (candidate_id, reviewer_id, verdict)
        values (${id}, ${userId}, ${verdict as Verdict})
        on conflict (candidate_id, reviewer_id) do update
          set verdict = excluded.verdict, reviewed_at = now()
        returning candidate_id
      `;
      res.status(200).json(rows[0]);
    } catch (err) {
      res.status(statusForWriteError(err)).json({ error: describeWriteError(err, id) });
    }
    return;
  }

  if (req.method === "DELETE") {
    try {
      // Idempotent on purpose, unlike DELETE /api/huts/:id: Backspace clears the
      // verdict optimistically, and a reviewer who hits it twice (or whose row
      // was already gone) should not see an error banner for a state that is
      // exactly what they asked for.
      const rows = await sql()`
        delete from candidate_reviews
        where candidate_id = ${id} and reviewer_id = ${userId}
        returning candidate_id
      `;
      res.status(200).json({ candidate_id: id, cleared: rows.length > 0 });
    } catch (err) {
      res.status(statusForWriteError(err)).json({ error: describeWriteError(err, id) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

// A bad :id reaches Postgres two ways — a well-formed uuid that no longer names
// a candidate (FK violation on insert) and a string that isn't a uuid at all
// (cast failure). Both are the caller's fault, so neither should read as a 500.
function statusForWriteError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("violates foreign key")) return 404;
  if (msg.includes("invalid input syntax for type uuid")) return 400;
  return 500;
}

function describeWriteError(err: unknown, id: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("violates foreign key")) return `No candidate ${id} (already gone?)`;
  if (msg.includes("invalid input syntax for type uuid")) return `Malformed candidate id: ${id}`;
  return `Review write failed: ${msg}`;
}

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  adjustedBoxProblems,
  isLabelsVisible,
  isValidVerdict,
  type Box,
  type Verdict,
} from "../../../src/candidates/model.js";
import { requireUser, sql } from "../../_lib.js";

// PUT    /api/candidates/:id/review — record MY verdict on a candidate (any
//          signed-in user), and optionally MY correction of its box. Upsert, so
//          re-deciding overwrites my own row.
// DELETE /api/candidates/:id/review — clear MY verdict, and the correction with
//          it (they are one row).
//
// reviewer_id always comes from the verified token, never the body — the same
// rule huts.labeler_id follows — so one reviewer can neither write nor read
// another's verdict through this route. That is what keeps a second pass an
// independent opinion (see scripts/migrations/004-candidates.sql).
//
// The correction lands in candidate_reviews.adj_* (migration 005), never on the
// candidate itself: a run's proposals are the immutable thing its precision is
// measured against.
//
// `labels_visible` (migration 006) records whether the reviewer could see the
// existing labels at the moment they decided. It is required on every PUT, and
// it is written, never returned to a reviewer: like `score`, it leaves only
// through the admin export.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = req.query.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "Candidate id is required" });
    return;
  }

  if (req.method === "PUT") {
    const { verdict, box, labels_visible: labelsVisible } = req.body as {
      verdict?: unknown;
      box?: unknown;
      labels_visible?: unknown;
    };
    if (!isValidVerdict(verdict)) {
      res.status(400).json({ error: "Invalid verdict" });
      return;
    }
    // Rejected rather than defaulted, and a missing field is rejected too: the
    // column is nullable only so rows written before it existed can say "not
    // recorded". Guessing here would put a wrong answer where that null belongs.
    if (!isLabelsVisible(labelsVisible)) {
      res.status(400).json({ error: "labels_visible must be true or false" });
      return;
    }
    const db = sql();

    // A corrected box is checked against the ortho the candidate belongs to,
    // exactly as the proposal was on the way in. That size is only fetched when
    // a box is actually being written, so the common verdict-only PUT still
    // costs one round trip. The read of the label catalog is a read: this route
    // writes nothing but candidate_reviews.
    if (box !== undefined && box !== null) {
      let dims: { width: number; height: number } | null = null;
      try {
        const found = await db`
          select o.width, o.height
          from candidates c
          join orthos o on o.id = c.ortho_id
          where c.id = ${id}
        `;
        if (found.length > 0) {
          dims = { width: found[0].width as number, height: found[0].height as number };
        }
      } catch (err) {
        res.status(statusForWriteError(err)).json({ error: describeWriteError(err, id) });
        return;
      }
      if (dims === null) {
        res.status(404).json({ error: `No candidate ${id} (already gone?)` });
        return;
      }
      // Out of range is rejected, never clamped: a box the reviewer cannot see
      // is not a correction they made.
      const problems = adjustedBoxProblems(box, dims);
      if (problems.length) {
        res.status(400).json({ error: problems.join("; ") });
        return;
      }
    }

    const adjusted = box === undefined || box === null ? null : (box as Box);
    try {
      // Two literal statements rather than one composed string: the Neon
      // template tag cannot splice a conditional column list (see
      // api/huts/[id].ts). The no-box form deliberately leaves adj_* untouched
      // on conflict, so changing a verdict keeps a correction already made.
      // labels_visible rides with the verdict in both forms, including an
      // update: a re-decided candidate is a fresh call, made under whatever the
      // reviewer could see this time.
      const rows = adjusted
        ? await db`
            insert into candidate_reviews
              (candidate_id, reviewer_id, verdict, labels_visible,
               adj_x, adj_y, adj_w, adj_h)
            values (${id}, ${userId}, ${verdict as Verdict}, ${labelsVisible},
                    ${adjusted.x}, ${adjusted.y}, ${adjusted.w}, ${adjusted.h})
            on conflict (candidate_id, reviewer_id) do update
              set verdict = excluded.verdict, reviewed_at = now(),
                  labels_visible = excluded.labels_visible,
                  adj_x = excluded.adj_x, adj_y = excluded.adj_y,
                  adj_w = excluded.adj_w, adj_h = excluded.adj_h
            returning candidate_id
          `
        : await db`
            insert into candidate_reviews
              (candidate_id, reviewer_id, verdict, labels_visible)
            values (${id}, ${userId}, ${verdict as Verdict}, ${labelsVisible})
            on conflict (candidate_id, reviewer_id) do update
              set verdict = excluded.verdict, reviewed_at = now(),
                  labels_visible = excluded.labels_visible
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

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin, requireUser, sql } from "./_lib.js";

// GET /api/candidates-export — every candidate with EVERY reviewer's verdict,
// admin-only. The pipeline's read-back path: it posted the candidates, this
// hands the human verdicts (and the per-reviewer agreement they encode) back.
//
// Separate from /api/export on purpose — that one is the hut ground truth and
// stays byte-identical, so nothing downstream of it has to learn about
// candidates. Keyed by (batch, ortho_id, rank), the same natural key the
// pipeline sent, so a join back needs no id mapping.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await requireAdmin(userId, res))) return;

  const db = sql();
  // Two queries then group in JS, same shape as api/export.ts — a json_agg
  // would be one round trip but harder to read and to change.
  const [candidateRows, reviewRows] = await Promise.all([
    db`select id, batch, ortho_id, rank, x, y, w, h, score, created_at
       from candidates order by batch asc, ortho_id asc, rank asc`,
    db`select candidate_id, reviewer_id, verdict, reviewed_at, labels_visible,
              adj_x, adj_y, adj_w, adj_h
       from candidate_reviews order by candidate_id asc, reviewer_id asc`,
  ]);

  const reviewsByCandidate = new Map<string, typeof reviewRows>();
  for (const review of reviewRows) {
    const existing = reviewsByCandidate.get(review.candidate_id);
    if (existing) existing.push(review);
    else reviewsByCandidate.set(review.candidate_id, [review]);
  }

  const candidates = candidateRows.map((c) => ({
    batch: c.batch,
    ortho_id: c.ortho_id,
    rank: c.rank,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    // Nullable in the DB (a pipeline without a score still imports) — pass the
    // null through rather than coercing it to 0.
    score: c.score,
    created_at: c.created_at,
    // Every reviewer's verdict, unlike the blind per-reviewer read path: this
    // export is the whole point of collecting two independent passes.
    reviews: (reviewsByCandidate.get(c.id) ?? []).map((r) => ({
      reviewer_id: r.reviewer_id,
      verdict: r.verdict,
      reviewed_at: r.reviewed_at,
      // Whether this reviewer could see the existing labels when they decided
      // (scripts/migrations/007-review-labels-visible.sql). null = recorded
      // before the flag existed. Admin-only, like everything else here: it is
      // never handed to a reviewer, and this export is how the analysis tells a
      // blind call from an informed one.
      labels_visible: r.labels_visible,
      // The reviewer's own correction of the box above, null when they accepted
      // it as drawn (scripts/migrations/005-candidate-box-adjust.sql). All four
      // are set together or not at all, so one null means uncorrected.
      adj_box:
        r.adj_x == null ? null : { x: r.adj_x, y: r.adj_y, w: r.adj_w, h: r.adj_h },
    })),
  }));

  const filename = `hutlabel-candidates-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).json({
    exported_at: new Date().toISOString(),
    candidate_count: candidateRows.length,
    review_count: reviewRows.length,
    coordinate_system: "pixels at native resolution; origin top-left; box = [x, y, w, h]",
    candidates,
  });
}

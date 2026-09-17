import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  MAX_CANDIDATE_ROWS,
  candidateBatchProblems,
  type CandidateInput,
} from "../../src/candidates/model.js";
import { requireAdmin, requireUser, sql } from "../_lib.js";

// GET  /api/candidates?ortho_id=&batch=  — one ortho's candidates, in rank
//        order, each carrying THIS reviewer's own verdict. Without `batch`,
//        the ortho's most recent batch. Any signed-in user.
// GET  /api/candidates?summary=1         — per-ortho candidate/reviewed counts
//        for the review-mode toggle and progress display. Any signed-in user.
// POST /api/candidates                   — admin-only bulk insert of one
//        pipeline batch; idempotent on (batch, ortho_id, rank).
//
// Two things are deliberately never selected into a reviewer-facing response:
// `score`, and any other reviewer's verdict. The review is blind, so a second
// pass is an independent opinion rather than an agreement with the first (see
// src/candidates/model.ts). Keeping them out of the SQL — not out of the UI —
// means they cannot leak through a devtools network tab either.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await requireUser(req, res);
  if (!userId) return;

  if (req.method === "GET") {
    const db = sql();

    if (req.query.summary !== undefined) {
      // Scoped to each ortho's LATEST batch, matching what the list below
      // returns by default — otherwise the sidebar's "10 candidates" and the
      // rail's "reviewed 7 / 10" would disagree the moment a second batch
      // lands. distinct on picks one batch per ortho; the join then keeps only
      // that batch's rows.
      const rows = await db`
        with latest as (
          select distinct on (ortho_id) ortho_id, batch
          from candidates
          order by ortho_id asc, created_at desc, batch desc
        )
        select c.ortho_id,
               count(*)::int as candidate_count,
               count(r.candidate_id)::int as reviewed_count
        from candidates c
        join latest l on l.ortho_id = c.ortho_id and l.batch = c.batch
        left join candidate_reviews r
          on r.candidate_id = c.id and r.reviewer_id = ${userId}
        group by c.ortho_id
        order by c.ortho_id asc
      `;
      res.status(200).json(rows);
      return;
    }

    const orthoId = req.query.ortho_id;
    if (typeof orthoId !== "string" || !orthoId) {
      res.status(400).json({ error: "ortho_id is required" });
      return;
    }
    const requestedBatch = req.query.batch;
    if (requestedBatch !== undefined && typeof requestedBatch !== "string") {
      res.status(400).json({ error: "batch must be a single value" });
      return;
    }

    // Resolve the batch first rather than running two literal SELECT variants
    // (the Neon template tag can't compose a conditional WHERE fragment — see
    // api/huts/[id].ts). One extra round trip only when `batch` was omitted.
    let batch = requestedBatch;
    if (batch === undefined) {
      const latest = await db`
        select batch from candidates
        where ortho_id = ${orthoId}
        order by created_at desc, batch desc
        limit 1
      `;
      if (latest.length === 0) {
        res.status(200).json([]); // no candidates for this ortho at all
        return;
      }
      batch = latest[0].batch as string;
    }

    // adj_* comes off the SAME left join as the verdict, so it is this
    // reviewer's own correction and nobody else's — a box another reviewer
    // moved is as invisible as their verdict. The proposal's own x/y/w/h stay
    // in the response too: the client draws the correction when there is one
    // (candidateBox) and still has the immutable proposal to fall back on, and
    // to roll back to if a write fails.
    const rows = await db`
      select c.id, c.ortho_id, c.batch, c.rank, c.x, c.y, c.w, c.h,
             r.verdict, r.adj_x, r.adj_y, r.adj_w, r.adj_h
      from candidates c
      left join candidate_reviews r
        on r.candidate_id = c.id and r.reviewer_id = ${userId}
      where c.ortho_id = ${orthoId} and c.batch = ${batch}
      order by c.rank asc
    `;
    res.status(200).json(rows);
    return;
  }

  if (req.method === "POST") {
    if (!(await requireAdmin(userId, res))) return;

    const body = req.body as { batch?: unknown; candidates?: unknown };
    const { batch, candidates } = body;
    if (typeof batch !== "string" || !batch) {
      res.status(400).json({ error: "batch must be a non-empty string" });
      return;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      res.status(400).json({ error: "candidates must be a non-empty array" });
      return;
    }
    if (candidates.length > MAX_CANDIDATE_ROWS) {
      res.status(400).json({
        error: `Too many candidates: ${candidates.length} > ${MAX_CANDIDATE_ROWS}. Split the batch.`,
      });
      return;
    }

    const db = sql();
    // Geometry is checked against the ortho each row claims, so the sizes are
    // fetched up front. The whole catalog rather than a filtered-by-id query:
    // it is a few dozen rows, and the Neon template tag has no clean way to
    // pass a list. An id that isn't here is unknown, and
    // candidateInputProblems reports it as such.
    const orthoRows = await db`select id, width, height from orthos`;
    const dims = new Map<string, { width: number; height: number }>(
      orthoRows.map((o) => [o.id as string, { width: o.width as number, height: o.height as number }]),
    );

    // Validate EVERY row before inserting any: a half-applied batch would leave
    // the reviewer working through a queue with holes in it, and re-running the
    // importer after a fix would then be ambiguous. The rule itself is pure and
    // unit-tested (src/candidates/model.ts), including the repeated
    // (ortho_id, rank) that the insert's `on conflict` would otherwise swallow.
    const invalid = candidateBatchProblems(candidates, dims);
    if (invalid.length) {
      res.status(400).json({
        error: `${invalid.length} of ${candidates.length} candidate rows are invalid; nothing was inserted`,
        invalid,
      });
      return;
    }

    const rows = candidates as CandidateInput[];
    try {
      // One multi-row insert, the whole batch handed over as a SINGLE json
      // parameter. The Neon template tag can't build a multi-row VALUES list,
      // and 2000 single-row round trips over HTTP would blow the function's
      // execution budget; json_to_recordset does it in one statement using one
      // ordinary string parameter, so nothing depends on how the driver
      // serializes arrays. Keys the recordset doesn't name are ignored, and a
      // missing `score` key becomes NULL.
      const inserted = await db`
        insert into candidates (ortho_id, batch, rank, x, y, w, h, score)
        select r.ortho_id, ${batch}::text, r.rank, r.x, r.y, r.w, r.h, r.score
        from json_to_recordset(${JSON.stringify(rows)}::json)
          as r(ortho_id text, rank int, x int, y int, w int, h int, score real)
        on conflict (batch, ortho_id, rank) do nothing
        returning id
      `;
      res.status(201).json({
        batch,
        received: rows.length,
        inserted: inserted.length,
        // Re-importing the same batch is a no-op, not an error — the skipped
        // count is how the importer reports that.
        skipped: rows.length - inserted.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Candidate insert failed: ${msg}` });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

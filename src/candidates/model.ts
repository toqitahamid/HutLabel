// The candidate-review schema. A candidate is a box the research pipeline
// proposed; a reviewer gives it a verdict. Candidates live in their own tables
// (scripts/migrations/004-candidates.sql) and never become huts — the pipeline
// reads the verdicts back out through /api/candidates-export.
//
// Pure module (no React, no I/O), same as huts/model.ts, so the validation and
// the review-queue rules are unit-testable and shared by the UI and the /api
// functions.

import { isValidBox } from "../huts/model.js";

// What a reviewer can say about a candidate. "unsure" mirrors the hut label's
// own doubtful flag: a box the reviewer cannot call either way, which the
// pipeline should count separately rather than fold into a no.
export const VERDICTS = ["hut", "not_hut", "unsure"] as const;
export type Verdict = (typeof VERDICTS)[number];

// Guard for a PUT body's verdict field, so a malformed value never persists
// (the DB check constraint is the backstop, this is the readable error).
export function isValidVerdict(v: unknown): v is Verdict {
  return (VERDICTS as readonly unknown[]).includes(v);
}

// Guard for a PUT body's `labels_visible` field — whether the reviewer could
// see the existing labels when they gave this verdict
// (scripts/migrations/006-review-labels-visible.sql). Same job isValidVerdict
// does above, and the same reason: a malformed value must never persist.
//
// A MISSING field fails too, deliberately. The column is nullable only so rows
// written before it existed can say "not recorded"; a client that forgot to
// send the flag should be told, not handed that null as if the question had
// been answered.
export function isLabelsVisible(v: unknown): v is boolean {
  return typeof v === "boolean";
}

// Short label for a verdict, used by the candidate list and the map legend.
export function verdictLabel(verdict: Verdict | null): string {
  if (verdict === "hut") return "hut";
  if (verdict === "not_hut") return "not hut";
  if (verdict === "unsure") return "unsure";
  return "unreviewed";
}

// A rectangle in native pixels of an ortho, origin top-left — the one geometry
// shape this module passes around (a candidate's proposal, a reviewer's
// correction, a hut's box).
export type Box = { x: number; y: number; w: number; h: number };

// A candidate as the REVIEWER sees it. Geometry is native pixels of that ortho
// (origin top-left), the same space huts use.
//
// Two fields are deliberately absent, and the API leaves them out of its
// SELECT rather than the UI dropping them, so they cannot leak by accident:
//   - `score`: showing the pipeline's own confidence would bias the review.
//     Rank already orders the queue; that is as much of a hint as a reviewer
//     gets.
//   - other reviewers' verdicts: the review is blind, so two passes give a
//     real agreement measure instead of the second agreeing with the first.
// `verdict` is THIS reviewer's own call, null until they make one.
//
// x/y/w/h are the box the PIPELINE proposed and never change — that is what a
// run's precision has to be measured against. adj_* is THIS reviewer's own
// correction of it (scripts/migrations/005-candidate-box-adjust.sql), null when
// they have not moved it, and all four are null or all four are set. What to
// DRAW is neither field on its own: use candidateBox().
export type Candidate = {
  id: string;
  ortho_id: string;
  batch: string;
  rank: number;
  x: number;
  y: number;
  w: number;
  h: number;
  verdict: Verdict | null;
  adj_x: number | null;
  adj_y: number | null;
  adj_w: number | null;
  adj_h: number | null;
};

// This reviewer's correction, or null when they have not moved the box. The
// all-or-none check lives in the database too (migration 005); reading all four
// here means a row that somehow half-set them is treated as uncorrected rather
// than drawn at a nonsense position.
export function adjustedBox(candidate: Candidate): Box | null {
  const { adj_x, adj_y, adj_w, adj_h } = candidate;
  if (adj_x == null || adj_y == null || adj_w == null || adj_h == null) return null;
  return { x: adj_x, y: adj_y, w: adj_w, h: adj_h };
}

// The box to draw and to judge: the reviewer's correction when they made one,
// the pipeline's proposal otherwise.
export function candidateBox(candidate: Candidate): Box {
  return (
    adjustedBox(candidate) ?? {
      x: candidate.x,
      y: candidate.y,
      w: candidate.w,
      h: candidate.h,
    }
  );
}

// Same box, to the pixel? Used to tell a real drag from a nudge that landed
// back where it started, and to spot a stale rollback.
export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Do two boxes share any AREA? Strictly positive overlap: boxes that merely
// touch along an edge or meet at a corner do not overlap, since a candidate
// abutting an existing label is not a duplicate of it. Fully contained counts.
//
// Restored from 6c99015 (it was deleted in da8058e once the post-verdict label
// reveal went away and left it with no caller). Same rule, same edges: what it
// decides now is whether a candidate is hidden from the review queue as
// already labelled — see partitionQueue below.
export function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

// The ortho's existing labels as plain boxes, which is all the overlap test
// needs. Structural in `huts` rather than typed to Hut so this module keeps its
// single import (it is loaded by the serverless runtime — see
// src/api-imports.test.ts).
//
// A POINT label (w/h null, the count-only labeling mode) is dropped rather than
// read as a pixel-sized box: a point has no area, so under the strictly
// positive rule above nothing could overlap it anyway, and a point says where a
// hut is without claiming any candidate duplicates it.
export function labelledBoxes(
  huts: readonly { x: number; y: number; w: number | null; h: number | null }[],
): Box[] {
  const boxes: Box[] = [];
  for (const hut of huts) {
    if (hut.w != null && hut.h != null) {
      boxes.push({ x: hut.x, y: hut.y, w: hut.w, h: hut.h });
    }
  }
  return boxes;
}

// The review queue split in two: the candidates the reviewer actually works,
// and the ones hidden because they sit on a box that is already labelled.
//
// The reviewer drew every existing label herself, so a candidate overlapping
// one asks her a question she has already answered. The comparison uses the
// candidate's DRAWN box — her correction when she moved it, the proposal
// otherwise (candidateBox) — so a box she nudged onto a label is treated the
// same as one the pipeline put there.
//
// A candidate that ALREADY carries her verdict is never hidden, whatever it
// overlaps. A verdict she can no longer see is one she can neither revisit nor
// clear, and a box she dragged onto a label AFTER deciding would otherwise
// vanish with her decision still recorded. It also keeps the progress counter
// honest: every hidden candidate is unreviewed, so hiding them lowers the
// denominator without touching the numerator, and reviewedCount is the same
// number over `visible` as over the whole list.
export function partitionQueue(
  candidates: Candidate[],
  hutBoxes: readonly Box[],
): { visible: Candidate[]; hidden: Candidate[] } {
  // Nothing labelled on this ortho — the overwhelmingly common case (32 of the
  // 49 orthos have no huts at all). Hand back the same array reference so the
  // map and the list skip a re-render.
  if (hutBoxes.length === 0) return { visible: candidates, hidden: [] };
  const visible: Candidate[] = [];
  const hidden: Candidate[] = [];
  for (const candidate of candidates) {
    if (isAlreadyLabelled(candidate, hutBoxes)) hidden.push(candidate);
    else visible.push(candidate);
  }
  return hidden.length === 0 ? { visible: candidates, hidden } : { visible, hidden };
}

// One candidate's half of that rule, split out so the "never hide a decided
// candidate" clause is testable on its own.
export function isAlreadyLabelled(
  candidate: Candidate,
  hutBoxes: readonly Box[],
): boolean {
  if (candidate.verdict !== null) return false;
  const box = candidateBox(candidate);
  return hutBoxes.some((hut) => boxesOverlap(box, hut));
}

// Per-ortho progress for the review-mode toggle and the counter: how many
// candidates the latest batch holds, and how many of them this reviewer has
// already judged.
export type CandidateSummary = {
  ortho_id: string;
  candidate_count: number;
  reviewed_count: number;
};

// One proposed row as the pipeline hands it over (POST /api/candidates, and
// the import script's file format). `batch` is not per row — it names the whole
// request/file.
export type CandidateInput = {
  ortho_id: string;
  rank: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score?: number | null;
};

// Cap on one bulk insert, so a runaway pipeline can't post a million rows into
// a serverless function with a fixed execution budget. A per-ortho batch is a
// few hundred boxes at most; the importer splits larger files itself.
export const MAX_CANDIDATE_ROWS = 2000;

// `rank` is an int4 column (scripts/migrations/004-candidates.sql, `check (rank
// >= 1)`). Bounding it here turns a pipeline that emits a nonsense rank into a
// 400 naming the row, rather than a Postgres "integer out of range" surfacing
// as a 500.
export const MIN_RANK = 1;
export const MAX_INT4 = 2147483647;
export const MAX_RANK = MAX_INT4;

// `score` is a float4 column, so anything past this overflows on insert
// ("value out of range") — a 500 for what is really a malformed request.
export const MAX_SCORE = 3.4028235e38;

// Everything wrong with one proposed row, as a list rather than a bool, so the
// caller can reject the WHOLE request naming each bad row instead of inserting
// a partial batch. `dims` is the claimed ortho's size, or null when no such
// ortho exists. An empty list means the row is good.
export function candidateInputProblems(
  row: unknown,
  dims: { width: number; height: number } | null,
): string[] {
  const problems: string[] = [];
  if (typeof row !== "object" || row === null) {
    return ["row must be an object"];
  }
  const { ortho_id, rank, x, y, w, h, score } = row as Record<string, unknown>;

  if (typeof ortho_id !== "string" || !ortho_id) {
    problems.push("ortho_id must be a non-empty string");
  } else if (dims === null) {
    problems.push(`unknown ortho: ${ortho_id}`);
  }
  if (!Number.isInteger(rank)) {
    problems.push("rank must be an integer");
  } else if ((rank as number) < MIN_RANK || (rank as number) > MAX_RANK) {
    problems.push(`rank must be between ${MIN_RANK} and ${MAX_RANK}`);
  }
  // Same geometry rule the hut POST enforces, minus the point-label branch: a
  // candidate is always a box, and it must sit inside the ortho it claims.
  // Without dims there's nothing to check it against, and the unknown-ortho
  // problem above already fails the row.
  if (dims !== null) {
    if (!isValidBox(x as number, y as number, w as number, h as number, dims.width, dims.height)) {
      problems.push(
        `box must be positive integers inside the ${dims.width}x${dims.height} image, got ` +
          `[${String(x)}, ${String(y)}, ${String(w)}, ${String(h)}]`,
      );
    }
  }
  // score is optional (a pipeline without one still imports), but if present it
  // must be a real number — NaN/Infinity would round-trip as null through JSON.
  if (score !== undefined && score !== null) {
    if (!Number.isFinite(score)) {
      problems.push("score must be a finite number when present");
    } else if (Math.abs(score as number) > MAX_SCORE) {
      problems.push(`score must be within the float4 range (±${MAX_SCORE})`);
    }
  }
  return problems;
}

// Everything wrong with a reviewer's corrected box, as a list, mirroring
// candidateInputProblems above. `dims` is the size of the ortho the candidate
// belongs to, or null when that lookup found nothing. An empty list means the
// box is good.
//
// Same geometry rule the proposal itself had to satisfy — a correction is still
// a box inside the same image — plus the int4 ceiling, so a client sending a
// number past the column's range gets a 400 naming the problem rather than a
// Postgres "integer out of range" surfacing as a 500. isValidBox already pins
// x+w to the image width, so the ceiling only ever bites on nonsense input; it
// is checked first for exactly that reason.
export function adjustedBoxProblems(
  box: unknown,
  dims: { width: number; height: number } | null,
): string[] {
  if (typeof box !== "object" || box === null) return ["box must be an object"];
  const { x, y, w, h } = box as Record<string, unknown>;
  for (const [name, v] of [["x", x], ["y", y], ["w", w], ["h", h]] as const) {
    if (!Number.isInteger(v)) return [`box.${name} must be an integer`];
    if (Math.abs(v as number) > MAX_INT4) {
      return [`box.${name} must be within the int4 range (±${MAX_INT4})`];
    }
  }
  if (dims === null) return ["unknown ortho for this candidate"];
  if (!isValidBox(x as number, y as number, w as number, h as number, dims.width, dims.height)) {
    return [
      `box must be positive integers inside the ${dims.width}x${dims.height} image, got ` +
        `[${String(x)}, ${String(y)}, ${String(w)}, ${String(h)}]`,
    ];
  }
  return [];
}

// One bad row in a batch, as reported to the caller.
export type CandidateRowProblem = {
  index: number;
  ortho_id: unknown;
  rank: unknown;
  problems: string[];
};

// Validate a whole POST body's rows. Pure, so the rule that decides whether a
// batch lands is unit-tested rather than only exercised against a live
// database. `dims` holds the size of every ortho that exists; a row naming
// anything else is reported as unknown.
//
// Catching a repeated (ortho_id, rank) here matters: the insert's
// `on conflict do nothing` would swallow the second row silently and count it
// as "already present", so a pipeline bug that emitted a rank twice would look
// like a successful import with a hole in the reviewer's queue.
export function candidateBatchProblems(
  rows: unknown[],
  dims: Map<string, { width: number; height: number }>,
): CandidateRowProblem[] {
  const invalid: CandidateRowProblem[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const orthoId = (row as { ortho_id?: unknown } | null)?.ortho_id;
    const problems = candidateInputProblems(
      row,
      typeof orthoId === "string" ? (dims.get(orthoId) ?? null) : null,
    );
    const rank = (row as { rank?: unknown } | null)?.rank;
    const key = JSON.stringify([orthoId, rank]);
    if (seen.has(key)) problems.push("duplicate (ortho_id, rank) within this batch");
    seen.add(key);
    if (problems.length) invalid.push({ index, ortho_id: orthoId, rank, problems });
  });
  return invalid;
}

// What a review key means for a candidate that currently carries `current`.
// Pressing the key a candidate ALREADY has is a no-op rather than a toggle —
// Backspace is the one way to clear — so a reviewer leaning on Y never fires a
// request that changes nothing, and never accidentally un-reviews a box.
export type VerdictChange =
  | { kind: "set"; verdict: Verdict }
  | { kind: "clear" }
  | { kind: "none" };

export function verdictChange(
  current: Verdict | null,
  pressed: Verdict | "clear",
): VerdictChange {
  if (pressed === "clear") {
    return current === null ? { kind: "none" } : { kind: "clear" };
  }
  return current === pressed ? { kind: "none" } : { kind: "set", verdict: pressed };
}

// Review-mode key table, kept here (not in the component) so the shortcuts, the
// help modal and the tests all read the same map. Returns null for a key that
// review mode doesn't claim, which is the caller's signal to let it through to
// the rest of the app (ortho nav, the magnifier, Esc).
export function verdictForKey(key: string): Verdict | "clear" | null {
  switch (key) {
    case "y":
    case "Y":
      return "hut";
    case "n":
    case "N":
      return "not_hut";
    case "u":
    case "U":
      return "unsure";
    case "Backspace":
      return "clear";
    default:
      return null;
  }
}

// The next candidate this reviewer hasn't judged, starting AFTER `fromId` and
// wrapping to the top — a reviewer who jumped around mid-list still gets walked
// through the leftovers instead of falling off the end. Returns null when
// nothing is left unreviewed (the queue is done).
export function nextUnreviewedId(
  candidates: Candidate[],
  fromId: string | null,
): string | null {
  if (candidates.length === 0) return null;
  const from = fromId === null ? -1 : candidates.findIndex((c) => c.id === fromId);
  for (let step = 1; step <= candidates.length; step += 1) {
    const candidate = candidates[(from + step + candidates.length) % candidates.length];
    if (candidate.verdict === null) return candidate.id;
  }
  return null;
}

// Explicit prev/next stepping (J / K, ] / [). Clamped, NOT wrapping: walking
// off either end of a review queue should feel like hitting the end of the
// list, not silently teleport to the far side. Returns null only for an empty
// list.
export function stepCandidateId(
  candidates: Candidate[],
  currentId: string | null,
  delta: number,
): string | null {
  if (candidates.length === 0) return null;
  const current = currentId === null ? -1 : candidates.findIndex((c) => c.id === currentId);
  if (current === -1) return candidates[0].id;
  const next = Math.max(0, Math.min(current + delta, candidates.length - 1));
  return candidates[next].id;
}

// Progress counter ("reviewed 7 / 10"): how many of these carry a verdict.
export function reviewedCount(candidates: Candidate[]): number {
  return candidates.filter((c) => c.verdict !== null).length;
}

// What one write put on a candidate row: the reviewer's verdict and their box
// correction, which travel together because the database stores them in one row
// (verdict is NOT NULL, so a correction cannot be written without one).
export type ReviewState = { verdict: Verdict | null; box: Box | null };

// Put ONE candidate's review state back after its write failed, leaving every
// other row alone. Deliberately not "restore the whole array from a snapshot
// taken before the request": a reviewer decides faster than a round trip, so a
// snapshot rollback would also undo whatever verdicts landed in the meantime —
// and if the reviewer has since arrowed to another ortho, it would replace that
// ortho's queue with the previous one's entirely.
//
// `optimistic` is the state the failed write had put on screen, and it is what
// makes this safe to call late. Three things can have happened by the time a
// rejection arrives, and only the first should roll anything back:
//   - the row still shows `optimistic`  -> that failed write is what is on
//     screen, so put `previous` back;
//   - the row shows something else      -> a LATER decision on the same
//     candidate has already landed (Y then N, with the Y's PUT failing after
//     the N's succeeded; or a second drag after the first one's PUT went out).
//     Rolling back would reset the row while the database holds the newer
//     state — the screen would be wrong and the reviewer would never know;
//   - the row is gone, or belongs to another ortho -> nothing to do.
// Both halves are compared, so a verdict write that failed cannot silently undo
// a correction the reviewer dragged while it was in flight, and vice versa.
// Returns the same array reference when there is nothing to change, so React
// can skip the re-render.
export function restoreVerdict(
  candidates: Candidate[],
  orthoId: string,
  candidateId: string,
  optimistic: ReviewState,
  previous: ReviewState,
): Candidate[] {
  const target = candidates.find((c) => c.id === candidateId);
  if (!target || target.ortho_id !== orthoId) return candidates;
  const onScreen: ReviewState = { verdict: target.verdict, box: adjustedBox(target) };
  // A newer decision (or a newer drag) won — leave the screen alone.
  if (onScreen.verdict !== optimistic.verdict) return candidates;
  if (!sameBox(onScreen.box, optimistic.box)) return candidates;
  if (onScreen.verdict === previous.verdict && sameBox(onScreen.box, previous.box)) {
    return candidates;
  }
  return candidates.map((c) =>
    c.id === candidateId ? { ...c, verdict: previous.verdict, ...boxColumns(previous.box) } : c,
  );
}

// A Box (or its absence) as the four nullable columns a Candidate carries.
export function boxColumns(box: Box | null): Pick<
  Candidate,
  "adj_x" | "adj_y" | "adj_w" | "adj_h"
> {
  return {
    adj_x: box?.x ?? null,
    adj_y: box?.y ?? null,
    adj_w: box?.w ?? null,
    adj_h: box?.h ?? null,
  };
}

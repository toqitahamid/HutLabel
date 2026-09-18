import { describe, expect, it } from "vitest";
import {
  MAX_INT4,
  MAX_RANK,
  MAX_SCORE,
  VERDICTS,
  VERDICT_KEY,
  adjustedBox,
  adjustedBoxProblems,
  boxColumns,
  candidateBatchProblems,
  candidateBox,
  boxesOverlap,
  candidateInputProblems,
  isAlreadyLabelled,
  isLabelsVisible,
  isValidVerdict,
  labelledBoxes,
  nextUnreviewedId,
  partitionQueue,
  queueNav,
  restoreVerdict,
  reviewedCount,
  sameBox,
  stepCandidateId,
  verdictChange,
  verdictForKey,
  verdictLabel,
  type Box,
  type Candidate,
  type Verdict,
} from "./model";

// Minimal candidate rows — only the fields the queue logic reads. `adj` is the
// reviewer's own box correction, absent on nearly every fixture here.
function candidate(
  id: string,
  rank: number,
  verdict: Verdict | null = null,
  adj: Box | null = null,
): Candidate {
  return {
    id,
    ortho_id: "demo-site-a",
    batch: "demo-batch",
    rank,
    x: 100 * rank,
    y: 200,
    w: 180,
    h: 180,
    verdict,
    ...boxColumns(adj),
  };
}

describe("isValidVerdict", () => {
  it("accepts the three known values", () => {
    for (const v of VERDICTS) expect(isValidVerdict(v)).toBe(true);
  });
  it("rejects near-misses, other strings, and non-strings", () => {
    expect(isValidVerdict("nothut")).toBe(false); // the underscore matters
    expect(isValidVerdict("Hut")).toBe(false);
    expect(isValidVerdict("certain")).toBe(false); // a hut confidence, not a verdict
    expect(isValidVerdict("")).toBe(false);
    expect(isValidVerdict(undefined)).toBe(false);
    expect(isValidVerdict(null)).toBe(false);
    expect(isValidVerdict(1)).toBe(false);
  });
});

describe("isLabelsVisible", () => {
  it("accepts either boolean", () => {
    expect(isLabelsVisible(true)).toBe(true);
    expect(isLabelsVisible(false)).toBe(true);
  });

  it("rejects a missing field rather than reading it as false", () => {
    // A client that forgot the flag gets a 400. Writing null for it would
    // claim "recorded before the column existed", which is a different and
    // false statement about a verdict that was in fact given under one of the
    // two settings.
    expect(isLabelsVisible(undefined)).toBe(false);
    expect(isLabelsVisible(null)).toBe(false);
  });

  it("rejects the values a sloppy client would send instead", () => {
    for (const v of ["true", "false", "", 0, 1, [], {}]) {
      expect(isLabelsVisible(v)).toBe(false);
    }
  });
});

describe("verdictLabel", () => {
  it("reads as prose, including the unreviewed case", () => {
    expect(verdictLabel("hut")).toBe("hut");
    expect(verdictLabel("not_hut")).toBe("not hut");
    expect(verdictLabel("unsure")).toBe("unsure");
    expect(verdictLabel(null)).toBe("unreviewed");
  });
});

describe("candidateInputProblems", () => {
  const dims = { width: 8684, height: 31964 };
  const good = { ortho_id: "demo-site-a", rank: 1, x: 100, y: 200, w: 180, h: 180, score: 7.3 };

  it("accepts a well-formed row, with or without a score", () => {
    expect(candidateInputProblems(good, dims)).toEqual([]);
    expect(candidateInputProblems({ ...good, score: undefined }, dims)).toEqual([]);
    expect(candidateInputProblems({ ...good, score: null }, dims)).toEqual([]);
  });

  it("rejects a row for an ortho that doesn't exist", () => {
    const problems = candidateInputProblems(good, null);
    expect(problems.some((p) => p.includes("unknown ortho"))).toBe(true);
  });

  it("rejects a missing or empty ortho_id", () => {
    expect(candidateInputProblems({ ...good, ortho_id: "" }, dims).length).toBeGreaterThan(0);
    expect(candidateInputProblems({ ...good, ortho_id: 7 }, dims).length).toBeGreaterThan(0);
  });

  it("rejects a non-integer rank", () => {
    expect(candidateInputProblems({ ...good, rank: 1.5 }, dims)).toContain(
      "rank must be an integer",
    );
  });

  it("bounds rank to the int4 range so Postgres never sees an overflow", () => {
    // Out of range is the caller's error (400), not an "integer out of range"
    // surfacing as a 500 halfway through the insert.
    for (const rank of [0, -1, MAX_RANK + 1, Number.MAX_SAFE_INTEGER]) {
      expect(candidateInputProblems({ ...good, rank }, dims)).toContain(
        `rank must be between 1 and ${MAX_RANK}`,
      );
    }
    expect(candidateInputProblems({ ...good, rank: 1 }, dims)).toEqual([]);
    expect(candidateInputProblems({ ...good, rank: MAX_RANK }, dims)).toEqual([]);
  });

  it("rejects geometry that is non-integer, degenerate, or off-image", () => {
    for (const bad of [
      { ...good, x: -1 },
      { ...good, w: 0 },
      { ...good, h: -5 },
      { ...good, w: 180.5 },
      { ...good, x: dims.width - 10, w: 20 }, // far edge crosses the boundary
    ]) {
      expect(candidateInputProblems(bad, dims).length).toBeGreaterThan(0);
    }
  });

  it("accepts a box whose far edge exactly touches the image boundary", () => {
    expect(
      candidateInputProblems({ ...good, x: dims.width - 180, y: dims.height - 180 }, dims),
    ).toEqual([]);
  });

  it("rejects a non-finite score but not a missing one", () => {
    expect(candidateInputProblems({ ...good, score: Number.NaN }, dims)).toContain(
      "score must be a finite number when present",
    );
    expect(candidateInputProblems({ ...good, score: Number.POSITIVE_INFINITY }, dims).length)
      .toBeGreaterThan(0);
  });

  it("bounds score to the float4 range the column can hold", () => {
    // 1e40 is finite in JS but overflows a float4 — a 400, not a 500 from
    // Postgres halfway through the insert.
    for (const score of [1e40, -1e40, 1e308]) {
      expect(candidateInputProblems({ ...good, score }, dims)).toContain(
        `score must be within the float4 range (±${MAX_SCORE})`,
      );
    }
    expect(candidateInputProblems({ ...good, score: MAX_SCORE }, dims)).toEqual([]);
    expect(candidateInputProblems({ ...good, score: -MAX_SCORE }, dims)).toEqual([]);
    expect(candidateInputProblems({ ...good, score: 0 }, dims)).toEqual([]);
  });

  it("rejects a non-object row outright", () => {
    expect(candidateInputProblems(null, dims)).toEqual(["row must be an object"]);
    expect(candidateInputProblems("nope", dims)).toEqual(["row must be an object"]);
  });
});

describe("candidateBatchProblems", () => {
  const dims = new Map([
    ["demo-site-a", { width: 8684, height: 31964 }],
    ["demo-site-b", { width: 4096, height: 4096 }],
  ]);
  const row = { ortho_id: "demo-site-a", rank: 1, x: 100, y: 200, w: 180, h: 180, score: 7.3 };

  it("passes a clean batch", () => {
    expect(
      candidateBatchProblems([row, { ...row, rank: 2 }, { ...row, ortho_id: "demo-site-b" }], dims),
    ).toEqual([]);
  });

  it("names every bad row rather than stopping at the first", () => {
    const invalid = candidateBatchProblems(
      [row, { ...row, rank: 2, w: 0 }, { ...row, ortho_id: "nope", rank: 3 }],
      dims,
    );
    expect(invalid.map((bad) => bad.index)).toEqual([1, 2]);
  });

  it("rejects a repeated (ortho_id, rank) inside one batch", () => {
    // `on conflict do nothing` would swallow the second row and report it as
    // "already present", leaving a hole in the reviewer's queue.
    const invalid = candidateBatchProblems([row, { ...row, x: 900 }], dims);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].index).toBe(1);
    expect(invalid[0].problems).toContain("duplicate (ortho_id, rank) within this batch");
  });

  it("allows the same rank on two different orthos", () => {
    expect(candidateBatchProblems([row, { ...row, ortho_id: "demo-site-b" }], dims)).toEqual([]);
  });

  it("reports the offending ortho_id and rank so the caller can point at the row", () => {
    const invalid = candidateBatchProblems([{ ...row, ortho_id: "nope", rank: 9 }], dims);
    expect(invalid[0]).toMatchObject({ index: 0, ortho_id: "nope", rank: 9 });
  });

  it("survives junk rows without throwing", () => {
    const invalid = candidateBatchProblems([null, "nope", 7, {}], dims);
    expect(invalid).toHaveLength(4);
  });
});

describe("restoreVerdict", () => {
  // Arguments are (candidates, orthoId, candidateId, optimistic, previous),
  // where each state is { verdict, box }: `optimistic` is what the failed write
  // put on screen, `previous` is what to put back. A verdict-only write passes
  // the same box on both sides, since it never moved the box.
  const list = [
    candidate("a", 1, "hut"),
    candidate("b", 2, "not_hut"),
    candidate("c", 3),
  ];
  const state = (verdict: Verdict | null, box: Box | null = null) => ({ verdict, box });

  it("puts one row's verdict back, leaving the others alone", () => {
    const restored = restoreVerdict(list, "demo-site-a", "a", state("hut"), state(null));
    expect(restored.map((c) => c.verdict)).toEqual([null, "not_hut", null]);
  });

  it("does not disturb a verdict landed on ANOTHER candidate meanwhile", () => {
    // 'b' was decided after 'a''s write went out; rolling 'a' back must not
    // take 'b' with it, which a whole-array snapshot restore would.
    const later = list.map((c) => (c.id === "b" ? { ...c, verdict: "unsure" as Verdict } : c));
    const restored = restoreVerdict(later, "demo-site-a", "a", state("hut"), state(null));
    expect(restored.find((c) => c.id === "b")?.verdict).toBe("unsure");
  });

  it("does not clobber a NEWER verdict on the SAME candidate", () => {
    // Y on 'a' (PUT#1), then N on 'a' (PUT#2 succeeds), then PUT#1 rejects.
    // Rolling back would show 'a' unreviewed while the database holds not_hut,
    // and nothing would tell the reviewer the screen had gone stale.
    const afterSecondDecision = list.map((c) =>
      c.id === "a" ? { ...c, verdict: "not_hut" as Verdict } : c,
    );
    expect(
      restoreVerdict(afterSecondDecision, "demo-site-a", "a", state("hut"), state(null)),
    ).toBe(afterSecondDecision);
  });

  it("still rolls back when the row holds exactly what the failed write put there", () => {
    const restored = restoreVerdict(list, "demo-site-a", "a", state("hut"), state("unsure"));
    expect(restored.find((c) => c.id === "a")?.verdict).toBe("unsure");
  });

  it("leaves another ortho's queue completely untouched", () => {
    const otherOrtho = list.map((c) => ({ ...c, ortho_id: "demo-site-b" }));
    expect(restoreVerdict(otherOrtho, "demo-site-a", "a", state("hut"), state(null))).toBe(
      otherOrtho,
    );
  });

  it("is a no-op when the row is gone or already holds the previous value", () => {
    expect(restoreVerdict(list, "demo-site-a", "missing", state("hut"), state(null))).toBe(list);
    expect(restoreVerdict(list, "demo-site-a", "a", state("hut"), state("hut"))).toBe(list);
    expect(restoreVerdict([], "demo-site-a", "a", state("hut"), state(null))).toEqual([]);
  });

  it("rolls a failed CLEAR back to the verdict it removed", () => {
    const cleared = list.map((c) => (c.id === "a" ? { ...c, verdict: null } : c));
    const restored = restoreVerdict(cleared, "demo-site-a", "a", state(null), state("hut"));
    expect(restored.find((c) => c.id === "a")?.verdict).toBe("hut");
  });

  // --- the box half ----------------------------------------------------

  const moved: Box = { x: 40, y: 50, w: 60, h: 70 };
  const movedAgain: Box = { x: 41, y: 51, w: 60, h: 70 };

  it("puts the previous box back when a drag's write failed", () => {
    // The drag re-sent an existing verdict with a new box; the write failed, so
    // the box goes back to uncorrected and the verdict stays put.
    const dragged = [candidate("a", 1, "hut", moved), candidate("b", 2)];
    const restored = restoreVerdict(
      dragged,
      "demo-site-a",
      "a",
      { verdict: "hut", box: moved },
      { verdict: "hut", box: null },
    );
    const back = restored.find((c) => c.id === "a")!;
    expect(adjustedBox(back)).toBeNull();
    expect(back.verdict).toBe("hut");
  });

  it("restores an EARLIER correction rather than clearing it outright", () => {
    const dragged = [candidate("a", 1, "hut", movedAgain)];
    const restored = restoreVerdict(
      dragged,
      "demo-site-a",
      "a",
      { verdict: "hut", box: movedAgain },
      { verdict: "hut", box: moved },
    );
    expect(adjustedBox(restored[0])).toEqual(moved);
  });

  it("does not clobber a NEWER drag on the same candidate", () => {
    // Drag #1's PUT is still in flight when drag #2 lands and succeeds. When #1
    // rejects, rolling back would move the box out from under the reviewer and
    // disagree with what the database now holds.
    const afterSecondDrag = [candidate("a", 1, "hut", movedAgain)];
    expect(
      restoreVerdict(
        afterSecondDrag,
        "demo-site-a",
        "a",
        { verdict: "hut", box: moved },
        { verdict: "hut", box: null },
      ),
    ).toBe(afterSecondDrag);
  });

  it("does not let a failed VERDICT write undo a correction dragged meanwhile", () => {
    // Y went out with no box; the reviewer then dragged the box (which re-sent
    // the verdict with it) and that landed. The Y's rejection must not roll the
    // row back to unreviewed AND uncorrected.
    const afterDrag = [candidate("a", 1, "hut", moved)];
    expect(
      restoreVerdict(
        afterDrag,
        "demo-site-a",
        "a",
        { verdict: "hut", box: null },
        { verdict: null, box: null },
      ),
    ).toBe(afterDrag);
  });

  it("carries a pending correction through a verdict rollback untouched", () => {
    // The reviewer dragged before deciding (nothing sent), then pressed Y and
    // that PUT failed. The verdict goes back to null; the pending box stays,
    // ready to ride along with whatever they press next.
    const pending = [candidate("a", 1, "hut", moved)];
    const restored = restoreVerdict(
      pending,
      "demo-site-a",
      "a",
      { verdict: "hut", box: moved },
      { verdict: null, box: moved },
    );
    expect(restored[0].verdict).toBeNull();
    expect(adjustedBox(restored[0])).toEqual(moved);
  });

  it("is a no-op when both halves already hold the previous state", () => {
    const dragged = [candidate("a", 1, "hut", moved)];
    expect(
      restoreVerdict(
        dragged,
        "demo-site-a",
        "a",
        { verdict: "hut", box: moved },
        { verdict: "hut", box: moved },
      ),
    ).toBe(dragged);
  });
});

describe("adjustedBox / candidateBox / boxColumns", () => {
  const moved: Box = { x: 40, y: 50, w: 60, h: 70 };

  it("draws the proposal when the reviewer has not moved it", () => {
    const c = candidate("a", 1);
    expect(adjustedBox(c)).toBeNull();
    expect(candidateBox(c)).toEqual({ x: 100, y: 200, w: 180, h: 180 });
  });

  it("draws the reviewer's correction when there is one, leaving the proposal intact", () => {
    const c = candidate("a", 1, "hut", moved);
    expect(adjustedBox(c)).toEqual(moved);
    expect(candidateBox(c)).toEqual(moved);
    // The immutable record of what the model proposed is still right there.
    expect({ x: c.x, y: c.y, w: c.w, h: c.h }).toEqual({ x: 100, y: 200, w: 180, h: 180 });
  });

  it("treats a half-set correction as no correction at all", () => {
    // The database forbids this (migration 005's all-or-none check); the reader
    // still refuses to draw a box out of three numbers and a null.
    const half = { ...candidate("a", 1, "hut", moved), adj_h: null };
    expect(adjustedBox(half)).toBeNull();
    expect(candidateBox(half)).toEqual({ x: 100, y: 200, w: 180, h: 180 });
  });

  it("round-trips a box through the four nullable columns", () => {
    expect(boxColumns(moved)).toEqual({ adj_x: 40, adj_y: 50, adj_w: 60, adj_h: 70 });
    expect(boxColumns(null)).toEqual({
      adj_x: null,
      adj_y: null,
      adj_w: null,
      adj_h: null,
    });
  });
});

describe("sameBox", () => {
  it("compares all four numbers", () => {
    expect(sameBox({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(sameBox({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
  });
  it("treats absence as its own value", () => {
    expect(sameBox(null, null)).toBe(true);
    expect(sameBox(null, { x: 1, y: 2, w: 3, h: 4 })).toBe(false);
    expect(sameBox({ x: 1, y: 2, w: 3, h: 4 }, null)).toBe(false);
  });
});

describe("boxesOverlap", () => {
  // The rule that decides whether a candidate is hidden from the review queue
  // as already labelled, so its edges matter.
  const base: Box = { x: 100, y: 100, w: 100, h: 100 }; // 100..200 on both axes

  it("sees a partial overlap from every side", () => {
    expect(boxesOverlap(base, { x: 150, y: 150, w: 100, h: 100 })).toBe(true);
    expect(boxesOverlap(base, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(boxesOverlap(base, { x: 150, y: 50, w: 100, h: 100 })).toBe(true);
    expect(boxesOverlap(base, { x: 50, y: 150, w: 100, h: 100 })).toBe(true);
  });

  it("is symmetric", () => {
    const other: Box = { x: 150, y: 150, w: 100, h: 100 };
    expect(boxesOverlap(base, other)).toBe(boxesOverlap(other, base));
  });

  it("counts a fully contained box, either way round", () => {
    const inner: Box = { x: 120, y: 120, w: 10, h: 10 };
    expect(boxesOverlap(base, inner)).toBe(true);
    expect(boxesOverlap(inner, base)).toBe(true);
  });

  it("counts an identical box", () => {
    expect(boxesOverlap(base, { ...base })).toBe(true);
  });

  it("does NOT count boxes that merely touch along an edge", () => {
    // Shared edge, zero area in common — abutting an existing label is not
    // duplicating it.
    expect(boxesOverlap(base, { x: 200, y: 100, w: 100, h: 100 })).toBe(false); // right
    expect(boxesOverlap(base, { x: 0, y: 100, w: 100, h: 100 })).toBe(false); // left
    expect(boxesOverlap(base, { x: 100, y: 200, w: 100, h: 100 })).toBe(false); // bottom
    expect(boxesOverlap(base, { x: 100, y: 0, w: 100, h: 100 })).toBe(false); // top
  });

  it("does NOT count boxes meeting at a single corner", () => {
    expect(boxesOverlap(base, { x: 200, y: 200, w: 100, h: 100 })).toBe(false);
    expect(boxesOverlap(base, { x: 0, y: 0, w: 100, h: 100 })).toBe(false);
  });

  it("keeps boxes well apart apart", () => {
    expect(boxesOverlap(base, { x: 1000, y: 1000, w: 100, h: 100 })).toBe(false);
    expect(boxesOverlap(base, { x: 100, y: 1000, w: 100, h: 100 })).toBe(false); // same column
  });
});

describe("labelledBoxes", () => {
  it("keeps the box labels, in order", () => {
    expect(
      labelledBoxes([
        { x: 10, y: 20, w: 30, h: 40 },
        { x: 50, y: 60, w: 70, h: 80 },
      ]),
    ).toEqual([
      { x: 10, y: 20, w: 30, h: 40 },
      { x: 50, y: 60, w: 70, h: 80 },
    ]);
  });

  it("drops a point label rather than reading it as a zero-sized box", () => {
    // A point has no area, so nothing overlaps it under the strictly positive
    // rule — dropping it here says that once instead of at every comparison.
    expect(labelledBoxes([{ x: 10, y: 20, w: null, h: null }])).toEqual([]);
    // A half-set row (no schema allows it, but the type does) is not a box.
    expect(labelledBoxes([{ x: 10, y: 20, w: 30, h: null }])).toEqual([]);
    expect(labelledBoxes([{ x: 10, y: 20, w: null, h: 40 }])).toEqual([]);
  });

  it("handles an ortho with no labels at all", () => {
    expect(labelledBoxes([])).toEqual([]);
  });
});

describe("partitionQueue", () => {
  // Geometry spelled out rather than derived from rank: which box sits on which
  // label is the whole subject here.
  function at(id: string, rank: number, box: Box, verdict: Verdict | null = null, adj: Box | null = null) {
    return { ...candidate(id, rank, verdict, adj), ...box };
  }
  const label: Box = { x: 1000, y: 1000, w: 200, h: 200 }; // 1000..1200
  const onLabel: Box = { x: 1100, y: 1100, w: 200, h: 200 };
  const elsewhere: Box = { x: 5000, y: 5000, w: 200, h: 200 };

  it("hides an unreviewed candidate that overlaps a label", () => {
    const rows = [at("a", 1, elsewhere), at("b", 2, onLabel)];
    const { visible, hidden } = partitionQueue(rows, [label]);
    expect(visible.map((c) => c.id)).toEqual(["a"]);
    expect(hidden.map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps everything, by reference, when the ortho has no labels", () => {
    const rows = [at("a", 1, onLabel), at("b", 2, elsewhere)];
    const { visible, hidden } = partitionQueue(rows, []);
    expect(visible).toBe(rows); // same array: nothing for React to re-render
    expect(hidden).toEqual([]);
  });

  it("keeps the same array when labels exist but nothing overlaps", () => {
    const rows = [at("a", 1, elsewhere)];
    expect(partitionQueue(rows, [label]).visible).toBe(rows);
  });

  it("never hides a candidate that already carries a verdict", () => {
    // She decided on it; a verdict she cannot see is one she cannot revisit or
    // clear. True however it came to overlap — including a box she dragged onto
    // a label after deciding.
    for (const verdict of VERDICTS) {
      const rows = [at("a", 1, onLabel, verdict)];
      expect(partitionQueue(rows, [label]).hidden).toEqual([]);
    }
    const dragged = [at("a", 1, elsewhere, "hut", onLabel)];
    expect(partitionQueue(dragged, [label]).hidden).toEqual([]);
  });

  it("judges the DRAWN box, so an unreviewed nudge onto a label hides it", () => {
    const nudged = [at("a", 1, elsewhere, null, onLabel)];
    expect(partitionQueue(nudged, [label]).hidden.map((c) => c.id)).toEqual(["a"]);
  });

  it("judges the DRAWN box the other way too: nudged OFF a label, it stays", () => {
    const moved = [at("a", 1, onLabel, null, elsewhere)];
    expect(partitionQueue(moved, [label]).hidden).toEqual([]);
  });

  it("does not hide a candidate that merely touches a label's edge", () => {
    const touching = [at("a", 1, { x: 1200, y: 1000, w: 200, h: 200 })];
    expect(partitionQueue(touching, [label]).hidden).toEqual([]);
  });

  it("hides a candidate that contains a label, or is contained by one", () => {
    const around = [at("a", 1, { x: 900, y: 900, w: 500, h: 500 })];
    expect(partitionQueue(around, [label]).hidden.map((c) => c.id)).toEqual(["a"]);
    const inside = [at("a", 1, { x: 1050, y: 1050, w: 20, h: 20 })];
    expect(partitionQueue(inside, [label]).hidden.map((c) => c.id)).toEqual(["a"]);
  });

  it("checks every label, not just the first", () => {
    const second: Box = { x: 4000, y: 4000, w: 200, h: 200 };
    const rows = [at("a", 1, { x: 4100, y: 4100, w: 100, h: 100 })];
    expect(partitionQueue(rows, [label, second]).hidden.map((c) => c.id)).toEqual(["a"]);
  });

  it("agrees with isAlreadyLabelled row by row", () => {
    const rows = [at("a", 1, elsewhere), at("b", 2, onLabel), at("c", 3, onLabel, "not_hut")];
    const { hidden } = partitionQueue(rows, [label]);
    expect(rows.filter((c) => isAlreadyLabelled(c, [label]))).toEqual(hidden);
  });

  it("keeps rank order within each half", () => {
    const rows = [at("a", 1, onLabel), at("b", 2, elsewhere), at("c", 3, onLabel), at("d", 4, elsewhere)];
    const { visible, hidden } = partitionQueue(rows, [label]);
    expect(visible.map((c) => c.id)).toEqual(["b", "d"]);
    expect(hidden.map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("the queue helpers over a filtered queue", () => {
  // What App feeds stepCandidateId / nextUnreviewedId / reviewedCount once the
  // already-labelled candidates are out: the reviewer must never land on one,
  // and the progress denominator must not count one.
  function at(id: string, rank: number, box: Box, verdict: Verdict | null = null) {
    return { ...candidate(id, rank, verdict), ...box };
  }
  const label: Box = { x: 1000, y: 1000, w: 200, h: 200 };
  const on: Box = { x: 1100, y: 1100, w: 100, h: 100 };
  const off = (n: number): Box => ({ x: 5000 + 500 * n, y: 5000, w: 100, h: 100 });

  // a, c, e are reviewable; b and d sit on the existing label.
  const rows = [
    at("a", 1, off(1)),
    at("b", 2, on),
    at("c", 3, off(2)),
    at("d", 4, on),
    at("e", 5, off(3)),
  ];
  const { visible, hidden } = partitionQueue(rows, [label]);

  it("filters to exactly the reviewable rows", () => {
    expect(visible.map((c) => c.id)).toEqual(["a", "c", "e"]);
    expect(hidden.map((c) => c.id)).toEqual(["b", "d"]);
  });

  it("steps over the hidden rows instead of stopping on them", () => {
    expect(stepCandidateId(visible, "a", 1)).toBe("c");
    expect(stepCandidateId(visible, "c", 1)).toBe("e");
    expect(stepCandidateId(visible, "c", -1)).toBe("a");
    // Clamped at the ends of the VISIBLE queue, not the full one.
    expect(stepCandidateId(visible, "e", 1)).toBe("e");
    expect(stepCandidateId(visible, "a", -1)).toBe("a");
  });

  it("never offers a hidden row as the next unreviewed one", () => {
    expect(nextUnreviewedId(visible, null)).toBe("a");
    expect(nextUnreviewedId(visible, "a")).toBe("c");
    expect(nextUnreviewedId(visible, "c")).toBe("e");
    // Wraps within the visible queue, same as it always did.
    expect(nextUnreviewedId(visible, "e")).toBe("a");
  });

  it("reports the queue as finished once the visible rows are judged", () => {
    const judged = visible.map((c) => ({ ...c, verdict: "hut" as Verdict }));
    expect(nextUnreviewedId(judged, null)).toBeNull();
  });

  it("counts progress against the visible denominator", () => {
    const withOne = partitionQueue(
      rows.map((c) => (c.id === "a" ? { ...c, verdict: "hut" as Verdict } : c)),
      [label],
    ).visible;
    expect(reviewedCount(withOne)).toBe(1);
    expect(withOne.length).toBe(3); // "reviewed 1 / 3", not "1 / 5"
  });

  it("counts the same numerator either way, since a hidden row is unreviewed", () => {
    // Nothing hidden carries a verdict (partitionQueue never hides a decided
    // candidate), so the numerator cannot change when the filter comes off.
    const decided = rows.map((c) => (c.id === "c" ? { ...c, verdict: "unsure" as Verdict } : c));
    expect(reviewedCount(partitionQueue(decided, [label]).visible)).toBe(reviewedCount(decided));
  });
});

describe("adjustedBoxProblems", () => {
  const dims = { width: 8684, height: 31964 };

  it("accepts a box inside the image", () => {
    expect(adjustedBoxProblems({ x: 100, y: 200, w: 180, h: 180 }, dims)).toEqual([]);
    // Touching the far edge is inside, the same rule isValidBox uses.
    expect(adjustedBoxProblems({ x: 8684 - 10, y: 31964 - 10, w: 10, h: 10 }, dims)).toEqual([]);
  });

  it("rejects a non-object body", () => {
    expect(adjustedBoxProblems(null, dims)).toEqual(["box must be an object"]);
    expect(adjustedBoxProblems("nope", dims)).toEqual(["box must be an object"]);
  });

  it("rejects non-integers and missing fields, naming the field", () => {
    expect(adjustedBoxProblems({ x: 1.5, y: 0, w: 10, h: 10 }, dims)).toEqual([
      "box.x must be an integer",
    ]);
    expect(adjustedBoxProblems({ x: 0, y: 0, w: 10 }, dims)).toEqual([
      "box.h must be an integer",
    ]);
    expect(adjustedBoxProblems({ x: 0, y: 0, w: 10, h: Number.NaN }, dims)).toEqual([
      "box.h must be an integer",
    ]);
  });

  it("rejects a number past the int4 range before it reaches Postgres", () => {
    const problems = adjustedBoxProblems({ x: MAX_INT4 + 1, y: 0, w: 10, h: 10 }, dims);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("int4 range");
  });

  it("rejects a box that leaves the image, or has no extent", () => {
    for (const box of [
      { x: -1, y: 0, w: 10, h: 10 },
      { x: 0, y: -1, w: 10, h: 10 },
      { x: 0, y: 0, w: 0, h: 10 },
      { x: 0, y: 0, w: 10, h: 0 },
      { x: dims.width - 5, y: 0, w: 10, h: 10 },
      { x: 0, y: dims.height - 5, w: 10, h: 10 },
    ]) {
      expect(adjustedBoxProblems(box, dims)).toHaveLength(1);
    }
  });

  it("rejects everything when the candidate's ortho could not be resolved", () => {
    expect(adjustedBoxProblems({ x: 1, y: 1, w: 10, h: 10 }, null)).toEqual([
      "unknown ortho for this candidate",
    ]);
  });
});

describe("verdictChange", () => {
  it("sets a verdict on an unreviewed candidate", () => {
    expect(verdictChange(null, "hut")).toEqual({ kind: "set", verdict: "hut" });
  });
  it("replaces a verdict with a different one", () => {
    expect(verdictChange("hut", "not_hut")).toEqual({ kind: "set", verdict: "not_hut" });
  });
  it("treats re-pressing the current verdict as a no-op, not a toggle", () => {
    expect(verdictChange("hut", "hut")).toEqual({ kind: "none" });
    expect(verdictChange("unsure", "unsure")).toEqual({ kind: "none" });
  });
  it("clears only when there is something to clear", () => {
    expect(verdictChange("not_hut", "clear")).toEqual({ kind: "clear" });
    expect(verdictChange(null, "clear")).toEqual({ kind: "none" });
  });
});

describe("verdictForKey", () => {
  it("maps the review keys in both cases", () => {
    expect(verdictForKey("y")).toBe("hut");
    expect(verdictForKey("Y")).toBe("hut");
    expect(verdictForKey("n")).toBe("not_hut");
    expect(verdictForKey("N")).toBe("not_hut");
    expect(verdictForKey("u")).toBe("unsure");
    expect(verdictForKey("U")).toBe("unsure");
    expect(verdictForKey("Backspace")).toBe("clear");
  });
  it("leaves every other key to the rest of the app", () => {
    // These are App's / OrthoMap's own bindings and must pass through.
    for (const key of ["ArrowLeft", "ArrowRight", "0", "Escape", "?", "j", "k", "[", "]", "z", "c"]) {
      expect(verdictForKey(key)).toBeNull();
    }
  });
});

describe("nextUnreviewedId", () => {
  it("starts at the first unreviewed candidate when nothing is selected", () => {
    const list = [candidate("a", 1, "hut"), candidate("b", 2), candidate("c", 3)];
    expect(nextUnreviewedId(list, null)).toBe("b");
  });

  it("advances past the candidate just decided", () => {
    const list = [candidate("a", 1, "hut"), candidate("b", 2, "not_hut"), candidate("c", 3)];
    expect(nextUnreviewedId(list, "b")).toBe("c");
  });

  it("skips candidates that already carry a verdict", () => {
    const list = [
      candidate("a", 1),
      candidate("b", 2, "hut"),
      candidate("c", 3, "unsure"),
      candidate("d", 4),
    ];
    expect(nextUnreviewedId(list, "a")).toBe("d");
  });

  it("wraps to the top so a reviewer who jumped around still finishes", () => {
    const list = [candidate("a", 1), candidate("b", 2, "hut"), candidate("c", 3, "hut")];
    expect(nextUnreviewedId(list, "c")).toBe("a");
  });

  it("returns null when the queue is done, and for an empty list", () => {
    const done = [candidate("a", 1, "hut"), candidate("b", 2, "not_hut")];
    expect(nextUnreviewedId(done, "a")).toBeNull();
    expect(nextUnreviewedId(done, null)).toBeNull();
    expect(nextUnreviewedId([], null)).toBeNull();
  });

  it("never returns the candidate it started from when that one is reviewed", () => {
    const list = [candidate("a", 1, "hut"), candidate("b", 2, "hut")];
    expect(nextUnreviewedId(list, "a")).toBeNull();
  });

  it("does come back to the starting candidate if it is still unreviewed", () => {
    // Clearing a verdict and pressing on should not strand the reviewer.
    const list = [candidate("a", 1), candidate("b", 2, "hut")];
    expect(nextUnreviewedId(list, "a")).toBe("a");
  });
});

describe("stepCandidateId", () => {
  const list = [candidate("a", 1), candidate("b", 2), candidate("c", 3)];

  it("steps forward and back", () => {
    expect(stepCandidateId(list, "a", 1)).toBe("b");
    expect(stepCandidateId(list, "b", -1)).toBe("a");
  });
  it("clamps at both ends rather than wrapping", () => {
    expect(stepCandidateId(list, "c", 1)).toBe("c");
    expect(stepCandidateId(list, "a", -1)).toBe("a");
  });
  it("starts at the head when nothing (or nothing known) is selected", () => {
    expect(stepCandidateId(list, null, 1)).toBe("a");
    expect(stepCandidateId(list, "gone", -1)).toBe("a");
  });
  it("returns null for an empty list", () => {
    expect(stepCandidateId([], null, 1)).toBeNull();
  });
  it("ignores verdicts — stepping walks the whole queue", () => {
    const reviewed = [candidate("a", 1, "hut"), candidate("b", 2, "not_hut")];
    expect(stepCandidateId(reviewed, "a", 1)).toBe("b");
  });
});

describe("VERDICT_KEY", () => {
  it("prints, for every verdict, a key that actually sets it", () => {
    for (const v of VERDICTS) {
      const key = VERDICT_KEY[v];
      expect(verdictForKey(key)).toBe(v);
      expect(verdictForKey(key.toLowerCase())).toBe(v);
    }
  });
});

describe("queueNav", () => {
  const list = [candidate("a", 1), candidate("b", 2), candidate("c", 3)];

  it("numbers the selected candidate 1-based within the visible queue", () => {
    expect(queueNav(list, "a").label).toBe("1 / 3");
    expect(queueNav(list, "b").label).toBe("2 / 3");
    expect(queueNav(list, "c").label).toBe("3 / 3");
  });
  it("counts the queue it is given, not the ortho", () => {
    // What App passes once partitionQueue has taken the already-labelled ones
    // out: the indicator has to agree with the list's own "#n" positions.
    const { visible } = partitionQueue(
      [candidate("a", 1), candidate("b", 2), candidate("c", 3)],
      // Sits inside b's box alone (a ends at x=280, c starts at x=300).
      [{ x: 282, y: 200, w: 16, h: 180 }],
    );
    expect(visible.map((c) => c.id)).toEqual(["a", "c"]);
    expect(queueNav(visible, "c").label).toBe("2 / 2");
  });
  it("shows the total with a dash for the index when nothing is selected", () => {
    expect(queueNav(list, null).label).toBe("– / 3");
    expect(queueNav(list, "gone").label).toBe("– / 3");
  });
  it("disables each button exactly where stepping clamps", () => {
    expect(queueNav(list, "a")).toMatchObject({ canPrev: false, canNext: true });
    expect(queueNav(list, "b")).toMatchObject({ canPrev: true, canNext: true });
    expect(queueNav(list, "c")).toMatchObject({ canPrev: true, canNext: false });
  });
  it("leaves both live with nothing selected — either lands on the head", () => {
    expect(queueNav(list, null)).toMatchObject({ canPrev: true, canNext: true });
  });
  it("offers no move on a one-candidate queue, and none on an empty one", () => {
    const one = [candidate("a", 1)];
    expect(queueNav(one, "a")).toEqual({ label: "1 / 1", canPrev: false, canNext: false });
    expect(queueNav([], null)).toEqual({ label: "– / 0", canPrev: false, canNext: false });
  });
});

describe("reviewedCount", () => {
  it("counts every verdict, including unsure", () => {
    expect(
      reviewedCount([
        candidate("a", 1, "hut"),
        candidate("b", 2, "unsure"),
        candidate("c", 3, "not_hut"),
        candidate("d", 4),
      ]),
    ).toBe(3);
    expect(reviewedCount([])).toBe(0);
  });
});

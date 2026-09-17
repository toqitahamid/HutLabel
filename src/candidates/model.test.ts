import { describe, expect, it } from "vitest";
import {
  VERDICTS,
  candidateInputProblems,
  isValidVerdict,
  nextUnreviewedId,
  reviewedCount,
  stepCandidateId,
  verdictChange,
  verdictForKey,
  verdictLabel,
  type Candidate,
  type Verdict,
} from "./model";

// Minimal candidate rows — only the fields the queue logic reads.
function candidate(id: string, rank: number, verdict: Verdict | null = null): Candidate {
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

  it("rejects a non-object row outright", () => {
    expect(candidateInputProblems(null, dims)).toEqual(["row must be an object"]);
    expect(candidateInputProblems("nope", dims)).toEqual(["row must be an object"]);
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

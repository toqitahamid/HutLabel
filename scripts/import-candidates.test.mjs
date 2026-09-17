import { describe, expect, it } from "vitest";
import {
  MAX_CANDIDATE_ROWS,
  candidateRowProblems,
  countByOrtho,
  validateCandidateFile,
} from "./import-candidates.mjs";

// Validation only: these are the pure halves of the import script, so nothing
// here opens a DATABASE_URL connection (the script's main() is guarded to run
// only when invoked directly, which is what makes this import safe).
//
// Fixtures are synthetic throughout — made-up ortho ids, made-up geometry.

const DIMS = new Map([
  ["demo-site-a", { width: 8684, height: 31964 }],
  ["demo-site-b", { width: 4096, height: 4096 }],
]);

const ROW = { ortho_id: "demo-site-a", rank: 1, x: 100, y: 200, w: 180, h: 180, score: 7.3 };

function file(candidates, batch = "demo-batch") {
  return {
    batch,
    created_at: "2026-09-17T00:00:00Z",
    coordinate_system: "pixels at native resolution; origin top-left; box = [x, y, w, h]",
    candidates,
  };
}

describe("candidateRowProblems", () => {
  const dims = DIMS.get("demo-site-a");

  it("accepts a well-formed row, with or without a score", () => {
    expect(candidateRowProblems(ROW, dims)).toEqual([]);
    expect(candidateRowProblems({ ...ROW, score: undefined }, dims)).toEqual([]);
    expect(candidateRowProblems({ ...ROW, score: null }, dims)).toEqual([]);
  });

  it("flags an ortho the database doesn't have", () => {
    expect(candidateRowProblems(ROW, null)).toContain("unknown ortho: demo-site-a");
  });

  it("flags non-integer and degenerate geometry", () => {
    expect(candidateRowProblems({ ...ROW, x: 1.5 }, dims)).toContain("x must be an integer");
    expect(candidateRowProblems({ ...ROW, w: 0 }, dims)).toContain("w must be > 0");
    expect(candidateRowProblems({ ...ROW, y: -3 }, dims)).toContain("y must be >= 0");
  });

  it("flags a box that runs off the edge of its ortho", () => {
    const problems = candidateRowProblems({ ...ROW, ortho_id: "demo-site-b", x: 4000, w: 200 },
      DIMS.get("demo-site-b"));
    expect(problems.some((p) => p.includes("exceeds ortho width"))).toBe(true);
  });

  it("accepts a box whose far edge exactly touches the boundary", () => {
    expect(
      candidateRowProblems(
        { ortho_id: "demo-site-b", rank: 1, x: 3896, y: 3896, w: 200, h: 200 },
        DIMS.get("demo-site-b"),
      ),
    ).toEqual([]);
  });

  it("flags a non-finite score", () => {
    expect(candidateRowProblems({ ...ROW, score: Number.NaN }, dims)).toContain(
      "score must be a finite number when present",
    );
  });
});

describe("validateCandidateFile envelope", () => {
  it("rejects a file that isn't an object with the two required fields", () => {
    expect(() => validateCandidateFile(null, DIMS)).toThrow(/must be a JSON object/);
    expect(() => validateCandidateFile([ROW], DIMS)).toThrow(/must be a JSON object/);
    expect(() => validateCandidateFile({ candidates: [ROW] }, DIMS)).toThrow(/batch/);
    expect(() => validateCandidateFile(file([]), DIMS)).toThrow(/non-empty array/);
    expect(() => validateCandidateFile({ batch: "b" }, DIMS)).toThrow(/non-empty array/);
  });

  it("rejects a file past the row cap rather than half-importing it", () => {
    const many = Array.from({ length: MAX_CANDIDATE_ROWS + 1 }, (_, i) => ({ ...ROW, rank: i + 1 }));
    expect(() => validateCandidateFile(file(many), DIMS)).toThrow(/exceeds the 2000-row cap/);
  });
});

describe("validateCandidateFile rows", () => {
  it("accepts a good file and hands back its batch and rows", () => {
    const result = validateCandidateFile(
      file([ROW, { ...ROW, rank: 2, x: 500 }, { ...ROW, ortho_id: "demo-site-b", rank: 1 }]),
      DIMS,
    );
    expect(result.batch).toBe("demo-batch");
    expect(result.rows).toHaveLength(3);
    expect(result.invalid).toEqual([]);
  });

  it("names every bad row instead of failing on the first", () => {
    const result = validateCandidateFile(
      file([ROW, { ...ROW, rank: 2, w: -1 }, { ...ROW, ortho_id: "nope", rank: 3 }]),
      DIMS,
    );
    expect(result.invalid.map((bad) => bad.index)).toEqual([1, 2]);
    expect(result.invalid[1].problems).toContain("unknown ortho: nope");
  });

  it("catches a duplicate (ortho_id, rank) inside one file", () => {
    const result = validateCandidateFile(file([ROW, { ...ROW, x: 900 }]), DIMS);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].problems).toContain("duplicate (ortho_id, rank) within this file");
  });

  it("allows the same rank on two different orthos", () => {
    const result = validateCandidateFile(file([ROW, { ...ROW, ortho_id: "demo-site-b" }]), DIMS);
    expect(result.invalid).toEqual([]);
  });

  it("skips the ortho checks when no sizes are supplied", () => {
    // The shape-only pass: unknown ids and off-image boxes are not errors yet.
    const result = validateCandidateFile(file([{ ...ROW, ortho_id: "whatever", x: 999999 }]), null);
    expect(result.invalid).toEqual([]);
  });
});

describe("countByOrtho", () => {
  it("counts rows per ortho for the --dry-run report", () => {
    const counts = countByOrtho([
      ROW,
      { ...ROW, rank: 2 },
      { ...ROW, ortho_id: "demo-site-b", rank: 1 },
    ]);
    expect([...counts]).toEqual([
      ["demo-site-a", 2],
      ["demo-site-b", 1],
    ]);
  });
});

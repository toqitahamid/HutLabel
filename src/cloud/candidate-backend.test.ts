import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDevCandidateBackend } from "./candidate-backend";

// The offline backend is the one implementation that can be exercised without
// Clerk and Neon, so it carries the tests for the whole interface's contract:
// rank ordering, per-ortho scoping, this-session verdicts, and the counts the
// progress display reads.
//
// All fixtures are synthetic — made-up ortho ids, made-up geometry. No real
// site ever appears in this repo.

// Stands in for the fetch of public/tiles/candidates.dev.json. `null` means the
// file isn't there (the normal dev case).
function stubDevFile(file: unknown | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      file === null
        ? ({ ok: false, status: 404, json: async () => ({}) } as Response)
        : ({ ok: true, status: 200, json: async () => file } as Response),
    ),
  );
}

const DEV_FILE = {
  batch: "demo-batch",
  created_at: "2026-09-17T00:00:00Z",
  coordinate_system: "pixels at native resolution; origin top-left; box = [x, y, w, h]",
  candidates: [
    { ortho_id: "demo-site-a", rank: 2, x: 400, y: 500, w: 160, h: 160, score: 4.1 },
    { ortho_id: "demo-site-a", rank: 1, x: 100, y: 200, w: 180, h: 180, score: 7.3 },
    { ortho_id: "demo-site-b", rank: 1, x: 900, y: 900, w: 200, h: 200, score: 6.0 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalDevCandidateBackend without a dev file", () => {
  it("reports no candidates rather than failing", async () => {
    stubDevFile(null);
    const backend = new LocalDevCandidateBackend();
    expect(await backend.listCandidates("demo-site-a")).toEqual([]);
    expect(await backend.candidateSummary()).toEqual([]);
  });

  it("survives a fetch that throws outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const backend = new LocalDevCandidateBackend();
    expect(await backend.listCandidates("demo-site-a")).toEqual([]);
  });

  it("only asks for the dev file once, even across many calls", async () => {
    stubDevFile(null);
    const backend = new LocalDevCandidateBackend();
    await backend.listCandidates("demo-site-a");
    await backend.listCandidates("demo-site-b");
    await backend.candidateSummary();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("LocalDevCandidateBackend with a dev file", () => {
  it("returns one ortho's candidates in rank order, unreviewed", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const rows = await backend.listCandidates("demo-site-a");
    expect(rows.map((c) => c.rank)).toEqual([1, 2]);
    expect(rows.map((c) => c.verdict)).toEqual([null, null]);
    expect(rows[0]).toMatchObject({ ortho_id: "demo-site-a", x: 100, y: 200, w: 180, h: 180 });
  });

  it("never leaks the pipeline's score to the reviewer", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");
    expect(first).not.toHaveProperty("score");
  });

  it("scopes to the requested ortho, and to a batch when one is named", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    expect(await backend.listCandidates("demo-site-b")).toHaveLength(1);
    expect(await backend.listCandidates("demo-site-a", "demo-batch")).toHaveLength(2);
    expect(await backend.listCandidates("demo-site-a", "other-batch")).toHaveLength(0);
    expect(await backend.listCandidates("demo-site-z")).toHaveLength(0);
  });

  it("remembers a verdict, replaces it, and clears it", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");

    await backend.setVerdict(first.id, "hut");
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBe("hut");

    await backend.setVerdict(first.id, "not_hut");
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBe("not_hut");

    await backend.clearVerdict(first.id);
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBeNull();
  });

  it("counts candidates and my reviews per ortho", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");
    await backend.setVerdict(first.id, "unsure");

    expect(await backend.candidateSummary()).toEqual([
      { ortho_id: "demo-site-a", candidate_count: 2, reviewed_count: 1 },
      { ortho_id: "demo-site-b", candidate_count: 1, reviewed_count: 0 },
    ]);
  });

  it("gives candidates on different orthos distinct ids", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const a = await backend.listCandidates("demo-site-a");
    const b = await backend.listCandidates("demo-site-b");
    const ids = new Set([...a, ...b].map((c) => c.id));
    expect(ids.size).toBe(3);
  });
});

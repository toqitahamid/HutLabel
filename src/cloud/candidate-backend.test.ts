import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiCandidateBackend,
  LocalDevCandidateBackend,
  SerializedCandidateBackend,
  type CandidateBackend,
  type VerdictOptions,
} from "./candidate-backend";
import { adjustedBox, type Box, type Candidate, type CandidateSummary, type Verdict } from "../candidates/model";

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

// Every verdict write says whether the reviewer could see the existing labels
// when they gave it. Most tests here are about ordering and storage rather than
// about that flag, so they pass the default (shown) and name it once.
const SHOWN: VerdictOptions = { labelsVisible: true };

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

    await backend.setVerdict(first.id, "hut", SHOWN);
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBe("hut");

    await backend.setVerdict(first.id, "not_hut", SHOWN);
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBe("not_hut");

    await backend.clearVerdict(first.id);
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBeNull();
  });

  it("counts candidates and my reviews per ortho", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");
    await backend.setVerdict(first.id, "unsure", SHOWN);

    expect(await backend.candidateSummary()).toEqual([
      { ortho_id: "demo-site-a", candidate_count: 2, reviewed_count: 1 },
      { ortho_id: "demo-site-b", candidate_count: 1, reviewed_count: 0 },
    ]);
  });

  it("stores the reviewer's corrected box alongside their verdict", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");
    expect(adjustedBox(first)).toBeNull(); // the proposal, uncorrected

    const moved: Box = { x: 120, y: 240, w: 150, h: 150 };
    await backend.setVerdict(first.id, "hut", { box: moved, labelsVisible: true });
    const [corrected] = await backend.listCandidates("demo-site-a");
    expect(adjustedBox(corrected)).toEqual(moved);
    // The proposal itself is untouched — it is what the run's precision is
    // measured against.
    expect({ x: corrected.x, y: corrected.y, w: corrected.w, h: corrected.h }).toEqual({
      x: 100,
      y: 200,
      w: 180,
      h: 180,
    });
  });

  it("keeps a correction when a later verdict arrives without one", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");
    const moved: Box = { x: 120, y: 240, w: 150, h: 150 };

    await backend.setVerdict(first.id, "hut", { box: moved, labelsVisible: true });
    await backend.setVerdict(first.id, "unsure", SHOWN); // changed their mind, same box
    const [after] = await backend.listCandidates("demo-site-a");
    expect(after.verdict).toBe("unsure");
    expect(adjustedBox(after)).toEqual(moved);
  });

  it("drops the correction when the verdict is cleared — they are one row", async () => {
    stubDevFile(DEV_FILE);
    const backend = new LocalDevCandidateBackend();
    const [first] = await backend.listCandidates("demo-site-a");
    await backend.setVerdict(first.id, "hut", {
      box: { x: 120, y: 240, w: 150, h: 150 },
      labelsVisible: true,
    });

    await backend.clearVerdict(first.id);
    const [cleared] = await backend.listCandidates("demo-site-a");
    expect(cleared.verdict).toBeNull();
    expect(adjustedBox(cleared)).toBeNull();
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

// A backend whose writes finish only when the test says so, and in whatever
// order it chooses — the point being that a reviewer can fire Y then N on one
// box inside a single round trip, and both are unconditional upserts.
class DeferredBackend implements CandidateBackend {
  started: string[] = [];
  finished: string[] = [];
  // Every options object handed to setVerdict, in call order — the flag is not
  // part of the labels below (they encode ordering), so this is where a test
  // checks it survived the wrapper.
  options: VerdictOptions[] = [];
  private pending: { label: string; resolve: () => void; reject: (e: Error) => void }[] = [];

  async listCandidates(): Promise<Candidate[]> {
    return [];
  }
  async candidateSummary(): Promise<CandidateSummary[]> {
    return [];
  }
  setVerdict(id: string, verdict: Verdict, opts: VerdictOptions): Promise<void> {
    this.options.push(opts);
    // The box only enters the label when there is one, so the ordering
    // assertions below read the same as before this feature existed.
    const { box } = opts;
    return this.defer(
      box ? `set:${id}:${verdict}:${box.x},${box.y},${box.w},${box.h}` : `set:${id}:${verdict}`,
    );
  }
  clearVerdict(id: string): Promise<void> {
    return this.defer(`clear:${id}`);
  }

  private defer(label: string): Promise<void> {
    this.started.push(label);
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        label,
        resolve: () => {
          this.finished.push(label);
          resolve();
        },
        reject,
      });
    });
  }

  settle(label: string, error?: Error) {
    const at = this.pending.findIndex((p) => p.label === label);
    if (at === -1) throw new Error(`nothing in flight called ${label}`);
    const [entry] = this.pending.splice(at, 1);
    if (error) entry.reject(error);
    else entry.resolve();
  }
}

// Lets the microtask queue drain so a chained .then() has actually run.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SerializedCandidateBackend", () => {
  it("does not start a second write on one candidate until the first finishes", async () => {
    const inner = new DeferredBackend();
    const backend = new SerializedCandidateBackend(inner);

    const first = backend.setVerdict("a", "hut", SHOWN);
    const second = backend.setVerdict("a", "not_hut", SHOWN);
    await tick();

    // Without serialization both would be in flight, and the server would end
    // up holding whichever response happened to land last.
    expect(inner.started).toEqual(["set:a:hut"]);

    inner.settle("set:a:hut");
    await first;
    await tick();
    expect(inner.started).toEqual(["set:a:hut", "set:a:not_hut"]);

    inner.settle("set:a:not_hut");
    await second;
    // The newer verdict is the one that reaches the server last, which is what
    // makes the unconditional upsert safe.
    expect(inner.finished).toEqual(["set:a:hut", "set:a:not_hut"]);
  });

  it("orders a clear behind an earlier verdict on the same candidate", async () => {
    const inner = new DeferredBackend();
    const backend = new SerializedCandidateBackend(inner);

    const first = backend.setVerdict("a", "hut", SHOWN);
    const second = backend.clearVerdict("a");
    await tick();
    expect(inner.started).toEqual(["set:a:hut"]);

    inner.settle("set:a:hut");
    await first;
    await tick();
    inner.settle("clear:a");
    await second;
    expect(inner.finished).toEqual(["set:a:hut", "clear:a"]);
  });

  it("does not make different candidates wait on each other", async () => {
    const inner = new DeferredBackend();
    const backend = new SerializedCandidateBackend(inner);

    const a = backend.setVerdict("a", "hut", SHOWN);
    const b = backend.setVerdict("b", "not_hut", SHOWN);
    await tick();
    expect(inner.started).toEqual(["set:a:hut", "set:b:not_hut"]);

    // Out of order on purpose: independent boxes have no ordering to preserve.
    inner.settle("set:b:not_hut");
    inner.settle("set:a:hut");
    await Promise.all([a, b]);
  });

  it("surfaces a failure to the caller but keeps the chain usable", async () => {
    const inner = new DeferredBackend();
    const backend = new SerializedCandidateBackend(inner);

    const first = backend.setVerdict("a", "hut", SHOWN);
    const second = backend.setVerdict("a", "not_hut", SHOWN);
    await tick();

    inner.settle("set:a:hut", new Error("boom"));
    // App's optimistic rollback depends on this rejecting.
    await expect(first).rejects.toThrow("boom");
    await tick();

    // One failed write must not strand every later write on that candidate.
    expect(inner.started).toEqual(["set:a:hut", "set:a:not_hut"]);
    inner.settle("set:a:not_hut");
    await expect(second).resolves.toBeUndefined();
  });

  it("carries the corrected box through to the wrapped backend, in order", async () => {
    const inner = new DeferredBackend();
    const backend = new SerializedCandidateBackend(inner);

    const first = backend.setVerdict("a", "hut", { box: { x: 10, y: 20, w: 30, h: 40 }, labelsVisible: true });
    const second = backend.setVerdict("a", "hut", { box: { x: 11, y: 21, w: 30, h: 40 }, labelsVisible: true });
    await tick();
    // Two drags inside one round trip: the LATER box must be the one that
    // reaches the server last, for exactly the reason a later verdict must.
    expect(inner.started).toEqual(["set:a:hut:10,20,30,40"]);

    inner.settle("set:a:hut:10,20,30,40");
    await first;
    await tick();
    inner.settle("set:a:hut:11,21,30,40");
    await second;
    expect(inner.finished).toEqual(["set:a:hut:10,20,30,40", "set:a:hut:11,21,30,40"]);
  });

  it("carries each write's label-visibility flag through unchanged", async () => {
    const inner = new DeferredBackend();
    const backend = new SerializedCandidateBackend(inner);

    // A reviewer who hides the labels mid-queue: the two verdicts were given
    // under different conditions, and the wrapper must not smear one over the
    // other while it is ordering them.
    const first = backend.setVerdict("a", "hut", { labelsVisible: true });
    const second = backend.setVerdict("a", "not_hut", { labelsVisible: false });
    await tick();
    inner.settle("set:a:hut");
    await first;
    await tick();
    inner.settle("set:a:not_hut");
    await second;

    expect(inner.options).toEqual([{ labelsVisible: true }, { labelsVisible: false }]);
  });

  it("passes reads straight through", async () => {
    stubDevFile(DEV_FILE);
    const backend = new SerializedCandidateBackend(new LocalDevCandidateBackend());
    expect(await backend.listCandidates("demo-site-a")).toHaveLength(2);
    expect(await backend.candidateSummary()).toHaveLength(2);
  });

  it("writes through to the wrapped backend", async () => {
    stubDevFile(DEV_FILE);
    const backend = new SerializedCandidateBackend(new LocalDevCandidateBackend());
    const [first] = await backend.listCandidates("demo-site-a");
    await backend.setVerdict(first.id, "hut", SHOWN);
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBe("hut");
    await backend.clearVerdict(first.id);
    expect((await backend.listCandidates("demo-site-a"))[0].verdict).toBeNull();
  });
});

// The /api backend needs no Clerk and no Neon to be checked at the seam that
// matters here: what it actually PUTs. The verdict route rejects a body whose
// labels_visible is anything but a boolean (isLabelsVisible, unit-tested in
// src/candidates/model.test.ts), so a client that quietly omitted it would 400
// every verdict — the one thing no test would otherwise catch until a reviewer
// hit it.
describe("ApiCandidateBackend request bodies", () => {
  function stubOk() {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ candidate_id: "c1" }) } as Response;
      }),
    );
    return calls;
  }

  const backend = () => new ApiCandidateBackend(async () => "test-token");

  function bodyOf(init: RequestInit): Record<string, unknown> {
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it("sends labels_visible on a verdict-only write", async () => {
    const calls = stubOk();
    await backend().setVerdict("c1", "hut", { labelsVisible: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PUT");
    expect(bodyOf(calls[0].init)).toEqual({ verdict: "hut", labels_visible: true });
  });

  it("sends false as false, not as an omitted field", async () => {
    // The hidden-labels case is the blind one, so it is the case the analysis
    // most needs recorded; dropping it would make it indistinguishable from a
    // row written before the column existed.
    const calls = stubOk();
    await backend().setVerdict("c1", "not_hut", { labelsVisible: false });
    expect(bodyOf(calls[0].init)).toEqual({ verdict: "not_hut", labels_visible: false });
  });

  it("sends the corrected box alongside it when there is one", async () => {
    const calls = stubOk();
    const box: Box = { x: 10, y: 20, w: 30, h: 40 };
    await backend().setVerdict("c1", "unsure", { box, labelsVisible: false });
    expect(bodyOf(calls[0].init)).toEqual({
      verdict: "unsure",
      labels_visible: false,
      box,
    });
  });

  it("omits box entirely when the reviewer did not move it", async () => {
    // Not `box: null`: the route leaves an existing correction alone only when
    // the field is absent.
    const calls = stubOk();
    await backend().setVerdict("c1", "hut", { box: undefined, labelsVisible: true });
    expect(bodyOf(calls[0].init)).not.toHaveProperty("box");
  });

  it("clears with a DELETE and no body at all", async () => {
    const calls = stubOk();
    await backend().clearVerdict("c1");
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("asks for no batch, so the route serves the ortho's newest one", async () => {
    // Two batches now live in the database side by side. The client never names
    // one: api/candidates/index.ts resolves the ortho's most recent batch
    // (created_at desc, batch desc) and returns only that batch's rows, so the
    // reviewer's queue is one batch rather than both merged.
    const calls = stubOk();
    await backend().listCandidates("demo-site-a");
    expect(calls[0].url).toBe("/api/candidates?ortho_id=demo-site-a");
    expect(calls[0].url).not.toContain("batch");
  });

  it("still passes an explicit batch through when one is given", async () => {
    const calls = stubOk();
    await backend().listCandidates("demo-site-a", "demo-batch-2");
    expect(calls[0].url).toBe("/api/candidates?ortho_id=demo-site-a&batch=demo-batch-2");
  });
});

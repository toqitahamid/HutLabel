import { boxColumns, type Box, type Candidate, type CandidateSummary, type Verdict } from "../candidates/model";
import { isCloudConfigured } from "./config";

// The candidate-review persistence seam, shaped exactly like HutBackend next
// door: an /api implementation for the real backend and an in-memory one so
// `npm run dev` exercises the whole review flow with no Clerk and no Neon.
//
// Reads are per (ortho, batch) and always scoped to the CALLING reviewer —
// `listCandidates` returns only this user's own verdicts, so the review stays
// blind (see src/candidates/model.ts).
export interface CandidateBackend {
  // `batch` omitted = the most recent batch for that ortho, which is what the
  // UI always wants; the parameter exists so a reviewer can be pointed at an
  // older batch later without reshaping the interface.
  listCandidates(orthoId: string, batch?: string): Promise<Candidate[]>;
  // Per-ortho counts for the review-mode toggle and progress display. One call
  // covering every ortho, so the app doesn't probe each one it shows.
  candidateSummary(): Promise<CandidateSummary[]>;
  // `box` is the reviewer's own correction of the proposed geometry, sent WITH
  // the verdict because the row holding it has a NOT NULL verdict — there is no
  // such thing as a stored correction without a decision. Omitted = leave any
  // correction already on the row alone.
  setVerdict(id: string, verdict: Verdict, box?: Box): Promise<void>;
  clearVerdict(id: string): Promise<void>;
}

type GetToken = () => Promise<string | null>;

export class ApiCandidateBackend implements CandidateBackend {
  constructor(private getToken: GetToken) {}

  // Same bearer-token + unwrap-{error} transport as ApiHutBackend.call. Copied
  // rather than shared: each backend class owns its own transport here (see
  // also cloud/admin-users.ts's invokeAdmin), and one import between the two
  // files would couple them for eight lines.
  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getToken();
    if (!token) throw new Error("Not signed in.");
    const res = await fetch(path, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // non-JSON error body; keep the status code
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  }

  listCandidates(orthoId: string, batch?: string): Promise<Candidate[]> {
    const query = new URLSearchParams({ ortho_id: orthoId });
    if (batch) query.set("batch", batch);
    return this.call<Candidate[]>(`/api/candidates?${query.toString()}`);
  }

  candidateSummary(): Promise<CandidateSummary[]> {
    return this.call<CandidateSummary[]>("/api/candidates?summary=1");
  }

  async setVerdict(id: string, verdict: Verdict, box?: Box): Promise<void> {
    await this.call<{ candidate_id: string }>(
      `/api/candidates/${encodeURIComponent(id)}/review`,
      { method: "PUT", body: JSON.stringify(box ? { verdict, box } : { verdict }) },
    );
  }

  async clearVerdict(id: string): Promise<void> {
    await this.call<{ candidate_id: string }>(
      `/api/candidates/${encodeURIComponent(id)}/review`,
      { method: "DELETE" },
    );
  }
}

// The shape of the pipeline's hand-off file — the same fixed contract
// scripts/import-candidates.mjs reads, so a dev tileset is just a copy of a
// real import file with the ortho ids swapped for demo ones.
type CandidateFile = {
  batch?: string;
  candidates?: Array<{
    ortho_id?: string;
    rank?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }>;
};

// In-memory backend for offline dev, mirroring LocalDevHutBackend. Candidates
// come from public/tiles/candidates.dev.json if it exists (absent = the feature
// simply doesn't appear, which is the normal dev case); verdicts live only in
// the tab's memory. Enough to exercise review -> verdict -> next-unreviewed
// without Clerk or Neon.
export class LocalDevCandidateBackend implements CandidateBackend {
  private verdicts = new Map<string, Verdict>();
  // Box corrections, keyed the same way. Kept in a SEPARATE map from the loaded
  // candidates so the dev store mirrors the real schema: the proposal is
  // immutable, the correction belongs to the review.
  private boxes = new Map<string, Box>();
  private loaded: Promise<Candidate[]> | null = null;

  // The dev file is fetched at most once per session and cached even when it
  // 404s, so a missing tileset doesn't re-request on every ortho switch.
  private async load(): Promise<Candidate[]> {
    if (!this.loaded) {
      this.loaded = (async () => {
        let file: CandidateFile;
        try {
          const res = await fetch("/tiles/candidates.dev.json");
          if (!res.ok) return [];
          file = (await res.json()) as CandidateFile;
        } catch {
          return []; // no dev candidates configured — review mode stays hidden
        }
        const batch = file.batch ?? "dev";
        return (file.candidates ?? []).map((row, i) => ({
          // The real backend's ids are server-assigned uuids; dev ids only have
          // to be stable within the session and unique across orthos.
          id: `dev-${batch}-${row.ortho_id ?? "?"}-${row.rank ?? i}`,
          ortho_id: row.ortho_id ?? "",
          batch,
          rank: row.rank ?? i + 1,
          x: row.x ?? 0,
          y: row.y ?? 0,
          w: row.w ?? 0,
          h: row.h ?? 0,
          verdict: null,
          adj_x: null,
          adj_y: null,
          adj_w: null,
          adj_h: null,
        }));
      })();
    }
    return this.loaded;
  }

  async listCandidates(orthoId: string, batch?: string): Promise<Candidate[]> {
    const all = await this.load();
    return all
      .filter((c) => c.ortho_id === orthoId && (batch === undefined || c.batch === batch))
      .sort((a, b) => a.rank - b.rank)
      .map((c) => ({
        ...c,
        verdict: this.verdicts.get(c.id) ?? null,
        ...boxColumns(this.boxes.get(c.id) ?? null),
      }));
  }

  async candidateSummary(): Promise<CandidateSummary[]> {
    const all = await this.load();
    const byOrtho = new Map<string, CandidateSummary>();
    for (const c of all) {
      const row = byOrtho.get(c.ortho_id) ?? {
        ortho_id: c.ortho_id,
        candidate_count: 0,
        reviewed_count: 0,
      };
      row.candidate_count += 1;
      if (this.verdicts.has(c.id)) row.reviewed_count += 1;
      byOrtho.set(c.ortho_id, row);
    }
    return [...byOrtho.values()].sort((a, b) => a.ortho_id.localeCompare(b.ortho_id));
  }

  async setVerdict(id: string, verdict: Verdict, box?: Box): Promise<void> {
    this.verdicts.set(id, verdict);
    // Omitting the box leaves an existing correction in place, matching the
    // API route's `on conflict do update` which only touches the columns it was
    // given.
    if (box) this.boxes.set(id, box);
  }

  async clearVerdict(id: string): Promise<void> {
    this.verdicts.delete(id);
    // The correction lives in the review row, so clearing the verdict drops it
    // too — the same cascade the real DELETE gets for free.
    this.boxes.delete(id);
  }
}

// Serializes the WRITES on each candidate, one chain per id, and passes reads
// straight through.
//
// A reviewer leaning on the keys can fire Y then N on the same box inside a
// single round trip. Both are unconditional upserts, so if the responses come
// back out of order the database is left holding the OLDER verdict while the
// screen shows the newer one, and nothing anywhere reports a problem. Ordering
// the two requests is enough to rule that out, and it needs no schema change,
// no version column and no extra round trip.
//
// Per candidate, not global: two different boxes have no ordering relationship,
// and making them wait on each other would throttle a fast reviewer for
// nothing.
export class SerializedCandidateBackend implements CandidateBackend {
  private chains = new Map<string, Promise<void>>();

  constructor(private inner: CandidateBackend) {}

  listCandidates(orthoId: string, batch?: string): Promise<Candidate[]> {
    return this.inner.listCandidates(orthoId, batch);
  }

  candidateSummary(): Promise<CandidateSummary[]> {
    return this.inner.candidateSummary();
  }

  setVerdict(id: string, verdict: Verdict, box?: Box): Promise<void> {
    return this.enqueue(id, () => this.inner.setVerdict(id, verdict, box));
  }

  clearVerdict(id: string): Promise<void> {
    return this.enqueue(id, () => this.inner.clearVerdict(id));
  }

  private enqueue(id: string, run: () => Promise<void>): Promise<void> {
    const prior = this.chains.get(id) ?? Promise.resolve();
    // The chain swallows rejections so one failed write doesn't strand every
    // later write on that candidate; the promise HANDED BACK still rejects, so
    // App's optimistic rollback runs as normal.
    const next = prior.then(run);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.chains.set(id, settled);
    // Drop the entry once this is the last write in flight for that candidate,
    // so a long session doesn't accumulate one promise per box reviewed.
    void settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id);
    });
    return next;
  }
}

// Same pick-once rule as makeHutBackend: the /api backend when Clerk is
// configured, else the offline dev store — wrapped either way, since the dev
// store is what the review flow is rehearsed against.
export function makeCandidateBackend(getToken: GetToken | null): CandidateBackend {
  const inner =
    isCloudConfigured() && getToken
      ? new ApiCandidateBackend(getToken)
      : new LocalDevCandidateBackend();
  return new SerializedCandidateBackend(inner);
}

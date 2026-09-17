import type { Candidate, CandidateSummary, Verdict } from "../candidates/model";
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
  setVerdict(id: string, verdict: Verdict): Promise<void>;
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

  async setVerdict(id: string, verdict: Verdict): Promise<void> {
    await this.call<{ candidate_id: string }>(
      `/api/candidates/${encodeURIComponent(id)}/review`,
      { method: "PUT", body: JSON.stringify({ verdict }) },
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
      .map((c) => ({ ...c, verdict: this.verdicts.get(c.id) ?? null }));
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

  async setVerdict(id: string, verdict: Verdict): Promise<void> {
    this.verdicts.set(id, verdict);
  }

  async clearVerdict(id: string): Promise<void> {
    this.verdicts.delete(id);
  }
}

// Same pick-once rule as makeHutBackend: the /api backend when Clerk is
// configured, else the offline dev store.
export function makeCandidateBackend(getToken: GetToken | null): CandidateBackend {
  return isCloudConfigured() && getToken
    ? new ApiCandidateBackend(getToken)
    : new LocalDevCandidateBackend();
}

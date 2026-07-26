import type { Ortho } from "../orthos";
import {
  defaultAttributes,
  type Hut,
  type HutAttributes,
} from "../huts/model";
import { isCloudConfigured } from "./config";

// The persistence seam. Huts are ROWS, not a per-image blob (FlagLabel's shape):
// each edit is its own CRUD call, which is what makes the PI's live oversight
// actually live and keeps writes small. Two implementations:
//   - ApiHutBackend: the real backend — Vercel functions under /api backed by
//     Neon Postgres, authenticated with the Clerk session token.
//   - LocalDevHutBackend: in-memory, seeded from the decoded demo manifest, used
//     when Clerk is not configured so `npm run dev` runs end-to-end offline.
export interface HutBackend {
  listOrthos(): Promise<Ortho[]>;
  listHuts(orthoId: string): Promise<Hut[]>;
  createHut(
    orthoId: string,
    x: number,
    y: number,
    w: number | null,
    h: number | null,
    attrs: HutAttributes,
  ): Promise<Hut>;
  updateHut(id: string, attrs: HutAttributes): Promise<void>;
  updateHutBox(id: string, x: number, y: number, w: number, h: number): Promise<void>;
  deleteHut(id: string): Promise<void>;
}

type GetToken = () => Promise<string | null>;

export class ApiHutBackend implements HutBackend {
  constructor(private getToken: GetToken) {}

  // All routes require the Clerk session JWT; the functions verify it and fill
  // `labeler_id` server-side from the token, never from the request body.
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

  listOrthos(): Promise<Ortho[]> {
    return this.call<Ortho[]>("/api/orthos");
  }

  listHuts(orthoId: string): Promise<Hut[]> {
    return this.call<Hut[]>(`/api/huts?ortho_id=${encodeURIComponent(orthoId)}`);
  }

  createHut(
    orthoId: string,
    x: number,
    y: number,
    w: number | null,
    h: number | null,
    attrs: HutAttributes,
  ): Promise<Hut> {
    return this.call<Hut>("/api/huts", {
      method: "POST",
      body: JSON.stringify({ ortho_id: orthoId, x, y, w, h, ...attrs }),
    });
  }

  async updateHut(id: string, attrs: HutAttributes): Promise<void> {
    await this.call<{ id: string }>(`/api/huts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(attrs),
    });
  }

  async updateHutBox(id: string, x: number, y: number, w: number, h: number): Promise<void> {
    await this.call<{ id: string }>(`/api/huts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ x, y, w, h }),
    });
  }

  async deleteHut(id: string): Promise<void> {
    await this.call<{ id: string }>(`/api/huts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
}

// In-memory backend for offline dev. Orthos come from the decoded demo manifest
// (public/tiles/orthos.dev.json); huts live only in the tab's memory (lost on
// reload) — enough to exercise place -> attribute -> select -> delete visually.
export class LocalDevHutBackend implements HutBackend {
  private huts = new Map<string, Hut>();

  async listOrthos(): Promise<Ortho[]> {
    const res = await fetch("/tiles/orthos.dev.json");
    if (!res.ok) {
      throw new Error(
        "No dev tileset. Configure Clerk + the API, or point VITE_TILE_BASE at a local data/tiles run.",
      );
    }
    return (await res.json()) as Ortho[];
  }

  async listHuts(orthoId: string): Promise<Hut[]> {
    return [...this.huts.values()].filter((h) => h.ortho_id === orthoId);
  }

  async createHut(
    orthoId: string,
    x: number,
    y: number,
    w: number | null,
    h: number | null,
    attrs: HutAttributes,
  ): Promise<Hut> {
    const hut: Hut = {
      id: crypto.randomUUID(),
      ortho_id: orthoId,
      x,
      y,
      w,
      h,
      ...attrs,
      labeler_id: "dev",
      created_at: new Date().toISOString(),
    };
    this.huts.set(hut.id, hut);
    return hut;
  }

  async updateHut(id: string, attrs: HutAttributes): Promise<void> {
    const hut = this.huts.get(id);
    if (hut) this.huts.set(id, { ...hut, ...attrs });
  }

  async updateHutBox(id: string, x: number, y: number, w: number, h: number): Promise<void> {
    const hut = this.huts.get(id);
    if (hut) this.huts.set(id, { ...hut, x, y, w, h });
  }

  async deleteHut(id: string): Promise<void> {
    this.huts.delete(id);
  }
}

// Pick the backend once: the /api backend when Clerk is configured (getToken
// comes from the signed-in account), else the offline dev store.
// `defaultAttributes` is re-exported for convenience at call sites.
export function makeHutBackend(getToken: GetToken | null): HutBackend {
  return isCloudConfigured() && getToken
    ? new ApiHutBackend(getToken)
    : new LocalDevHutBackend();
}

export { defaultAttributes };

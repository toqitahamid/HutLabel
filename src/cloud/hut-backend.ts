import type { Ortho } from "../orthos";
import {
  defaultAttributes,
  type Hut,
  type HutAttributes,
} from "../huts/model";
import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client";

// The persistence seam. Huts are ROWS, not a per-image blob (FlagLabel's shape):
// each edit is its own CRUD call, which is what makes the PI's live oversight
// actually live and keeps writes small. Two implementations:
//   - SupabaseHutBackend: the real backend (orthos admin-seeded, huts open to
//     labelers under RLS).
//   - LocalDevHutBackend: in-memory, seeded from the decoded demo manifest, used
//     when Supabase is not configured so `npm run dev` runs end-to-end offline.
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
  deleteHut(id: string): Promise<void>;
}

const HUT_COLUMNS =
  "id, ortho_id, x, y, w, h, structure_type, confidence, labeler_id, created_at";

export class SupabaseHutBackend implements HutBackend {
  async listOrthos(): Promise<Ortho[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("orthos")
      .select("id, site, visit, width, height, max_level")
      .order("site", { ascending: true })
      .order("visit", { ascending: true });
    if (error) throw new Error(`listOrthos failed: ${error.message}`);
    return (data ?? []) as Ortho[];
  }

  async listHuts(orthoId: string): Promise<Hut[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("huts")
      .select(HUT_COLUMNS)
      .eq("ortho_id", orthoId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`listHuts failed: ${error.message}`);
    return (data ?? []) as Hut[];
  }

  // Insert one hut. `labeler_id` is filled server-side (DEFAULT auth.uid()); the
  // insert returns the full row so the UI gets the DB-assigned id + timestamp.
  async createHut(
    orthoId: string,
    x: number,
    y: number,
    w: number | null,
    h: number | null,
    attrs: HutAttributes,
  ): Promise<Hut> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("huts")
      .insert({ ortho_id: orthoId, x, y, w, h, ...attrs })
      .select(HUT_COLUMNS)
      .single();
    if (error) throw new Error(`createHut failed: ${error.message}`);
    return data as Hut;
  }

  async updateHut(id: string, attrs: HutAttributes): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("huts")
      .update(attrs)
      .eq("id", id)
      .select("id");
    if (error) throw new Error(`updateHut failed: ${error.message}`);
    if (!data || data.length === 0) {
      throw new Error(`updateHut: no hut ${id} (already gone, or not permitted).`);
    }
  }

  async deleteHut(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("huts")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw new Error(`deleteHut failed: ${error.message}`);
    if (!data || data.length === 0) {
      throw new Error(`deleteHut: no hut ${id} (already gone, or not permitted).`);
    }
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
        "No dev tileset. Run `npm run tiles:demo`, or configure Supabase.",
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

  async deleteHut(id: string): Promise<void> {
    this.huts.delete(id);
  }
}

// Pick the backend once: real Supabase when configured, else the offline dev
// store. `defaultAttributes` is re-exported for convenience at call sites.
export function makeHutBackend(): HutBackend {
  return isSupabaseConfigured()
    ? new SupabaseHutBackend()
    : new LocalDevHutBackend();
}

export { defaultAttributes };

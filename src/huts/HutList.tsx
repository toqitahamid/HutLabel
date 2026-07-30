import { useEffect, useRef } from "react";
import type { Hut } from "./model";

// Compact per-ortho list of huts, docked at the bottom of the right rail.
// Renders straight off the same `huts` array the map draws its markers from
// (ordered by created_at, same as the server's GET /api/huts) — so a create,
// delete, box edit, or confidence flip shows up here automatically, with no
// fetch or subscription of its own.
export function HutList({
  huts,
  selectedHutId,
  onSelectHut,
}: {
  huts: Hut[];
  selectedHutId: string | null;
  // Clicking a row both selects that hut and re-centers the map on it — see
  // App's onFocusHut, which bumps a focus signal OrthoMap watches even when
  // the clicked row is already selected (so "where was it again?" always
  // re-centers, rather than being a no-op on the second click).
  onSelectHut: (id: string) => void;
}) {
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  // A selection made elsewhere (map click, keyboard) should scroll its row
  // into view too. Always scrolling on every selectedHutId change — even
  // when the click originated in this list — is harmless: the row is
  // already visible then, so scrollIntoView is a no-op.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedHutId]);

  return (
    <div className="rail-section hut-list-section">
      <div className="rail-label">
        <span>Huts ({huts.length})</span>
      </div>
      {huts.length === 0 ? (
        <p className="rail-hint">No huts on this ortho yet.</p>
      ) : (
        <div className="hut-list">
          {huts.map((hut, i) => {
            const selected = hut.id === selectedHutId;
            // Legacy point-labeled huts (w/h null) have no extent to show —
            // fall back to "point" rather than printing "null×null px".
            const extent =
              hut.w != null && hut.h != null ? `${hut.w}×${hut.h} px` : "point";
            // Certain rows stay clean (the common case); an "unsure" suffix
            // is the signal worth scanning the list for, so it's the only
            // one that gets a marker. Appended to the same `label` used for
            // both the row text and its title, so the two never drift apart.
            const label = hut.confidence === "unsure" ? `${extent} · unsure` : extent;
            return (
              <button
                type="button"
                key={hut.id}
                ref={selected ? selectedRowRef : undefined}
                className={"hut-row" + (selected ? " active" : "")}
                onClick={() => onSelectHut(hut.id)}
                title={`#${i + 1} · ${label}`}
              >
                #{i + 1} · {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { CONFIDENCES, hutCenter, type Hut } from "./model";
import { HutList } from "./HutList";

// Side panel for the selected hut. A hut is a pure box (or point) label, with
// one manual field left — confidence — so this panel is mostly a thin shell:
// the magnifier slot, the hut's header/dimensions readout, the confidence
// toggle, the delete button, and the hut list.
export function AttributePanel({
  hut,
  huts,
  selectedHutId,
  onToggleConfidence,
  onDelete,
  onFocusHut,
  zoomSlot,
}: {
  hut: Hut | null;
  huts: Hut[];
  selectedHutId: string | null;
  // Flips the selected hut's certain/unsure flag — same handler the C
  // shortcut calls, so the panel button and the key are always in sync.
  onToggleConfidence: () => void;
  onDelete: () => void;
  // Row click in the hut list below: selects that hut AND re-centers the map
  // on it (App's focusRequest signal, consumed by OrthoMap's fly-to effect).
  onFocusHut: (id: string) => void;
  // The magnifier (OrthoMap's second Leaflet map) portals its panel + zoom
  // controls in here, at the top of the rail — the same position FlagLabel's
  // canvas-based zoom panel occupies, independent of hut selection.
  zoomSlot?: React.ReactNode;
}) {
  if (!hut) {
    return (
      <aside className="right-rail">
        {zoomSlot}
        <div className="rail-section">
          <p className="rail-count">
            {huts.length} hut{huts.length === 1 ? "" : "s"} on this ortho
          </p>
          <p className="rail-hint">
            Drag on the map to draw a box around a hut. Click an existing box
            to select, resize, or delete it.
          </p>
        </div>
        <HutList huts={huts} selectedHutId={selectedHutId} onSelectHut={onFocusHut} />
      </aside>
    );
  }

  const isBox = hut.w != null && hut.h != null;
  const { cx, cy } = hutCenter(hut);

  return (
    <aside className="right-rail">
      {zoomSlot}
      <div className="rail-section head">
        <span className="rail-title">Hut</span>
        <span className="rail-coord">
          {isBox ? `${hut.w}×${hut.h} px` : `${cx}, ${cy}`}
        </span>
      </div>

      <div className="rail-section">
        <span className="rail-label">Confidence</span>
        <div className="confidence-toggle" role="group" aria-label="Confidence">
          {CONFIDENCES.map((c) => (
            <button
              type="button"
              key={c}
              className={"confidence-option" + (c === "unsure" ? " unsure" : "")}
              aria-pressed={hut.confidence === c}
              onClick={() => {
                if (hut.confidence !== c) onToggleConfidence();
              }}
            >
              {c === "certain" ? "Certain" : "Unsure"}
            </button>
          ))}
        </div>
      </div>

      <div className="rail-section">
        <button className="btn danger rail-delete" onClick={onDelete}>
          Delete hut
        </button>
      </div>

      <HutList huts={huts} selectedHutId={selectedHutId} onSelectHut={onFocusHut} />
    </aside>
  );
}

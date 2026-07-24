import {
  CONFIDENCES,
  STRUCTURE_TYPES,
  hutCenter,
  type Hut,
  type HutAttributes,
  type StructureType,
} from "./model";

const STRUCTURE_LABELS: Record<StructureType, string> = {
  dwelling_hut: "Dwelling hut",
  feeding_platform: "Feeding platform",
  uncertain_mound: "Uncertain mound",
};

// Side panel for the selected hut. Every change is committed immediately
// (per-edit CRUD) via `onChange`; there is no save button — the frozen schema's
// dropdowns are the whole surface. Editing the two attributes here is what turns
// a bare point into the rows that unlock the downstream papers.
export function AttributePanel({
  hut,
  huts,
  onChange,
  onDelete,
  zoomSlot,
}: {
  hut: Hut | null;
  huts: Hut[];
  onChange: (attrs: HutAttributes) => void;
  onDelete: () => void;
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
          <p className="rail-count">{huts.length} huts on this ortho</p>
          <p className="rail-hint">
            Click a bull's-eye on the map to drop a hut. Click an existing marker
            to edit or delete it.
          </p>
        </div>
      </aside>
    );
  }

  const attrs: HutAttributes = {
    structure_type: hut.structure_type,
    confidence: hut.confidence,
  };
  const set = (patch: Partial<HutAttributes>) => onChange({ ...attrs, ...patch });

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
        <Field label="Structure type">
          <Select
            value={hut.structure_type}
            options={STRUCTURE_TYPES}
            labels={STRUCTURE_LABELS}
            onChange={(v) => set({ structure_type: v })}
          />
        </Field>
        <Field label="Confidence">
          <Select
            value={hut.confidence}
            options={CONFIDENCES}
            onChange={(v) => set({ confidence: v })}
          />
        </Field>
      </div>

      <div className="rail-section">
        <button className="btn danger rail-delete" onClick={onDelete}>
          Delete hut
        </button>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="rail-field">
      <span className="rail-label">{label}</span>
      {children}
    </label>
  );
}

function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
}: {
  value: T;
  options: readonly T[];
  labels?: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <select
      className="rail-select"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels ? labels[o] : o}
        </option>
      ))}
    </select>
  );
}

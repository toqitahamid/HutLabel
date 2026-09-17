import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Ortho } from "../orthos";
import { tileUrlTemplate } from "../orthos";
import type { Confidence, Hut } from "../huts/model";
import { candidateBox, type Box, type Candidate, type Verdict } from "../candidates/model";

// Slippy-map viewer over a pre-baked tile pyramid (tiler.py) in Leaflet's
// CRS.Simple pixel space. The single invariant that makes this correct:
//
//   EVERY pixel<->LatLng conversion uses `ortho.max_level` as the reference
//   zoom — NEVER map.getZoom(). project(ll, maxLevel) -> native px;
//   unproject([x,y], maxLevel) -> ll. Because Leaflet's own tile-range math also
//   resolves against that reference, tile {col}_{row} and marker positions share
//   one pixel space and stay aligned at any zoom (including over-zoom).
//
// max_level is PER ORTHO (15 for a 31964px-tall one, 12 for a 4096px square),
// so it drives
// maxNativeZoom on the TileLayer, read from the row — not a constant.

const OVERZOOM = 2; // allow zooming past native so ~66px huts are easy to click
const TILE_BASE = import.meta.env.VITE_TILE_BASE ?? "/tiles";
const TILE_EXT = import.meta.env.VITE_TILE_EXT ?? "png";

// The magnifier always shows a tighter view than the main map — its zoom is
// mainMap.getZoom() + magnifyBoost, capped at the same overzoom ceiling the
// main tile layer allows. magnifyBoost is user-adjustable (rail slider, [ / ]
// keys), mirroring FlagLabel's zoomRadius control.
const MAGNIFY_BOOST_MIN = 1;
const MAGNIFY_BOOST_MAX = 6;
const MAGNIFY_BOOST_DEFAULT = 3;

// The magnifier's OWN zoom ceiling — levels above native it may reach. Must
// be higher than OVERZOOM (the main map's ceiling), or a boost of +6 clamps
// to the same cap the main map already sits at once mainZoom is high enough,
// making the slider/[ / ] a no-op past that point. Only the magnifier map +
// its tile layer use this; the main map keeps max_level + OVERZOOM.
const MAGNIFY_MAX = 6;

// A minimum drag extent (native px) to keep a stray click-and-release in box
// mode from creating a degenerate hut.
const MIN_BOX_PX = 4;

// A 1x1 transparent PNG. tiler.py skips fully-transparent tiles, so panning the
// ragged ortho edges requests tiles that 404; pointing errorTileUrl here renders
// them blank instead of flashing a broken-image icon (expected, not an error).
const BLANK_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Marker fill by confidence — the one manual field left on a hut. "certain"
// (the common case) draws in the same accent color as everything else;
// "unsure" draws amber so the PI can scan the map for doubtful boxes at a
// glance, the same way the hut list flags them with a suffix.
const MARKER_COLOR = "#34a382"; // accent, certain
const UNSURE_COLOR = "#d29922"; // amber, unsure

// Single source of truth for confidence -> color, so the main map, its
// selected-box handles, and the magnifier mirror can never draw the same hut
// in two different colors.
function confidenceColor(confidence: Confidence): string {
  return confidence === "unsure" ? UNSURE_COLOR : MARKER_COLOR;
}

// Machine candidates (review mode) draw in a third hue, well clear of both hut
// colors above and legible over open water and vegetation alike — so a
// proposal can never be mistaken for a human label.
const CANDIDATE_COLOR = "#e845c8"; // magenta, machine candidate

// Candidates are drawn as OUTLINES ONLY. A tinted fill over a 2 m box at review
// zoom is exactly the thing the reviewer is trying to look at, and judging
// whether a smudge of vegetation is a hut through a magenta wash is guesswork.
// So the verdict rides entirely in the stroke — weight and dash — rather than in
// fill opacity as it did before:
//
//   unreviewed  weight 2    solid
//   hut         weight 3.5  solid          (the heaviest outline: a decision)
//   not hut     weight 1.5  dashed, dimmed
//   unsure      weight 2    dotted
//
// Selection is +1.5 on the weight and NOT a color change: the selected
// candidate is the one with white corner handles on it, and turning its outline
// white too would cost the one cue that says "this is a machine proposal".
function candidateStyle(verdict: Verdict | null, selected: boolean): L.PathOptions {
  let weight = 2;
  let dashArray: string | undefined;
  let opacity = 1;
  if (verdict === "hut") {
    weight = 3.5;
  } else if (verdict === "not_hut") {
    weight = 1.5;
    dashArray = "4 4";
    opacity = 0.65;
  } else if (verdict === "unsure") {
    dashArray = "2 5";
  }
  return {
    color: CANDIDATE_COLOR,
    weight: selected ? weight + 1.5 : weight,
    opacity,
    // fillOpacity 0 rather than `fill: false`: an unpainted fill still answers
    // pointer events in SVG, so the whole box stays clickable to select it,
    // where `fill: none` would leave only the 2 px stroke as a target.
    fillOpacity: 0,
    dashArray,
  };
}

// An EXISTING hut label as review mode draws it (see the redraw effect).
// Deliberately unlike a candidate in every channel: the hut confidence colors,
// no fill, thin, long-dashed, and inert — there is nothing to click, because in
// review mode there is nothing a reviewer may do to a human label.
function existingLabelStyle(confidence: Confidence): L.PathOptions {
  return {
    color: confidenceColor(confidence),
    weight: 1,
    opacity: 0.9,
    dashArray: "6 4",
    fill: false,
    interactive: false,
  };
}

// The existing labels review mode draws: every BOX hut of this ortho. Point
// huts (w/h null) are left out — there is no box to outline, and a dot in the
// hut colors sitting among the candidates reads as something the reviewer could
// act on — which is also why the return type is narrowed to box huts.
type BoxHut = Hut & { w: number; h: number };

function boxHuts(huts: Hut[]): BoxHut[] {
  return huts.filter((hut): hut is BoxHut => hut.w != null && hut.h != null);
}

type Corner = "NW" | "NE" | "SW" | "SE";

const OPPOSITE_CORNER: Record<Corner, Corner> = {
  NW: "SE",
  NE: "SW",
  SW: "NE",
  SE: "NW",
};

// Four corner handles to resize a box plus a centre handle to move it, drawn
// onto `layer` and dragging `rect` with them. Extracted from the selected-hut
// code below so the selected CANDIDATE gets exactly the same gesture — same
// divIcon, same "the opposite corner is pinned for this drag" rule, same
// clamp-each-corner-then-derive commit, same minimum extent.
//
// The centre handle is the one thing huts never had: a candidate is usually the
// right size in the wrong place (the pipeline's box centred on the wrong
// clump), and dragging two opposite corners to translate it is four gestures
// where one will do. It preserves w/h exactly and gives way at the image edge.
//
// `commit` is called once, on dragend, with the box in native pixels. A drag
// that ends smaller than MIN_BOX_PX commits the ORIGINAL geometry instead —
// re-submitting a no-op, which is how the caller is asked to snap the rectangle
// back from an accidental nudge.
function attachBoxHandles(opts: {
  map: L.Map;
  layer: L.LayerGroup;
  rect: L.Rectangle;
  box: Box;
  maxLevel: number;
  imageWidth: number;
  imageHeight: number;
  onDragStart: () => void;
  onDragEnd: () => void;
  commit: (x: number, y: number, w: number, h: number) => void;
}): void {
  const { map, layer, rect, box, maxLevel, imageWidth, imageHeight } = opts;

  const cornerPx: Record<Corner, [number, number]> = {
    NW: [box.x, box.y],
    NE: [box.x + box.w, box.y],
    SW: [box.x, box.y + box.h],
    SE: [box.x + box.w, box.y + box.h],
  };

  // Moving the whole box: a wider, round handle at the centre, so it reads as
  // "grab here" rather than as a fifth corner (see .box-handle-move in App.css).
  const moveHandle = L.marker(
    map.unproject([box.x + box.w / 2, box.y + box.h / 2], maxLevel),
    {
      draggable: true,
      icon: L.divIcon({
        className: "box-handle box-handle-move",
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    },
  );

  const handles = {} as Record<Corner, L.Marker>;
  const syncCorners = (bounds: L.LatLngBounds) => {
    handles.NW.setLatLng(bounds.getNorthWest());
    handles.NE.setLatLng(bounds.getNorthEast());
    handles.SW.setLatLng(bounds.getSouthWest());
    handles.SE.setLatLng(bounds.getSouthEast());
  };

  // The corner LatLng that stays put for the current resize gesture — computed
  // at dragstart from the box's STORED geometry, not from the live handle.
  let fixedCornerLatLng: L.LatLng | null = null;

  (Object.keys(cornerPx) as Corner[]).forEach((corner) => {
    const marker = L.marker(map.unproject(cornerPx[corner], maxLevel), {
      draggable: true,
      icon: L.divIcon({
        className: "box-handle",
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
    });
    handles[corner] = marker;

    marker.on("dragstart", () => {
      opts.onDragStart();
      const [ox, oy] = cornerPx[OPPOSITE_CORNER[corner]];
      fixedCornerLatLng = map.unproject([ox, oy], maxLevel);
    });

    // Live-update the rectangle and all handles from [the pinned corner, this
    // handle's current position] — the simplest way to keep the visual a
    // coherent rectangle without tracking each handle's motion individually.
    marker.on("drag", () => {
      if (!fixedCornerLatLng) return;
      const bounds = L.latLngBounds(fixedCornerLatLng, marker.getLatLng());
      rect.setBounds(bounds);
      syncCorners(bounds);
      moveHandle.setLatLng(bounds.getCenter());
    });

    marker.on("dragend", () => {
      opts.onDragEnd(); // re-arm whatever the drag suppressed, first
      if (!fixedCornerLatLng) return;
      const p1 = map.project(fixedCornerLatLng, maxLevel);
      const p2 = map.project(marker.getLatLng(), maxLevel);
      fixedCornerLatLng = null;
      // Clamp EACH corner into the image extent first, then derive x/y/w/h: a
      // drag that ends offscreen must shrink the box, not drag the far corner
      // after it.
      const cx1 = Math.max(0, Math.min(p1.x, imageWidth));
      const cy1 = Math.max(0, Math.min(p1.y, imageHeight));
      const cx2 = Math.max(0, Math.min(p2.x, imageWidth));
      const cy2 = Math.max(0, Math.min(p2.y, imageHeight));
      const x = Math.round(Math.min(cx1, cx2));
      const y = Math.round(Math.min(cy1, cy2));
      const w = Math.round(Math.abs(cx2 - cx1));
      const h = Math.round(Math.abs(cy2 - cy1));
      if (w < MIN_BOX_PX || h < MIN_BOX_PX) opts.commit(box.x, box.y, box.w, box.h);
      else opts.commit(x, y, w, h);
    });

    marker.addTo(layer);
  });

  moveHandle.on("dragstart", opts.onDragStart);

  moveHandle.on("drag", () => {
    const centre = map.project(moveHandle.getLatLng(), maxLevel);
    const bounds = L.latLngBounds(
      map.unproject([centre.x - box.w / 2, centre.y - box.h / 2], maxLevel),
      map.unproject([centre.x + box.w / 2, centre.y + box.h / 2], maxLevel),
    );
    rect.setBounds(bounds);
    syncCorners(bounds); // NOT moveHandle itself — Leaflet is dragging it
  });

  moveHandle.on("dragend", () => {
    opts.onDragEnd();
    const centre = map.project(moveHandle.getLatLng(), maxLevel);
    // A move preserves the size exactly; it is the POSITION that gives way at
    // the image edge, unlike a resize, where the far corner is pinned.
    const x = Math.round(Math.max(0, Math.min(centre.x - box.w / 2, imageWidth - box.w)));
    const y = Math.round(Math.max(0, Math.min(centre.y - box.h / 2, imageHeight - box.h)));
    opts.commit(x, y, box.w, box.h);
  });

  moveHandle.addTo(layer);
}

// Global key handlers (Space-to-pan, Z-toggle) must ignore keystrokes meant
// for a text field elsewhere in the app (e.g. typing "z" while a text input
// has focus shouldn't toggle the magnifier).
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "SELECT" ||
    tag === "TEXTAREA" ||
    target.isContentEditable
  );
}

export type OrthoMapProps = {
  ortho: Ortho;
  huts: Hut[];
  selectedHutId: string | null;
  onPlace: (x: number, y: number, w: number | null, h: number | null) => void;
  onSelectHut: (id: string) => void;
  // Commits a resize of the SELECTED box hut's geometry (native px), fired
  // once on corner-handle dragend — see the redraw effect below.
  onEditBox: (id: string, x: number, y: number, w: number, h: number) => void;
  // DOM node (rendered by AttributePanel, at the top of the right rail) that
  // the magnifier panel + zoom-level slider portal into. Null until the first
  // paint's ref callback resolves it — the magnifier effect below re-runs
  // once it does.
  magnifierSlotEl: HTMLDivElement | null;
  // Bumped by App's `0` shortcut to re-fit the map to the whole ortho. The
  // initial value (however it's chosen) never triggers a reset by itself —
  // only a change after mount does (see the effect below).
  resetSignal?: number;
  // Set by App when a hut-list row is clicked: fly/pan the map to that hut's
  // box. `nonce` (not just `hutId`) so clicking the SAME already-selected row
  // still re-fires the effect below — "where was it again?" always re-centers.
  // In review mode the id names a CANDIDATE instead; the fly effect resolves it
  // against whichever list is on screen (hut and candidate ids are server uuids
  // from two different tables, so they can never collide).
  focusRequest?: { hutId: string; nonce: number } | null;
  // Candidate review: the machine proposals for this ortho, and the review-mode
  // switch. While `reviewMode` is on, the box-drawing gesture is inert and the
  // human huts are drawn as inert outlines behind the candidates — the reviewer
  // judges candidates and can touch nothing else. Off, every one of these is
  // ignored and the map behaves exactly as it did before the feature existed.
  candidates?: Candidate[];
  reviewMode?: boolean;
  // Review mode only: draw this ortho's existing labels, or leave them off (the
  // `L` toggle). Default true — the owner asked to see them from the start.
  // Hiding them is what a blind pass wants; see labels_visible on the verdict.
  showLabels?: boolean;
  selectedCandidateId?: string | null;
  onSelectCandidate?: (id: string) => void;
  // Commits the reviewer's correction of the SELECTED candidate's box (native
  // px), fired once on handle dragend — the candidate twin of onEditBox. Absent
  // = the candidate boxes are read-only and no handles are drawn.
  onAdjustCandidateBox?: (id: string, x: number, y: number, w: number, h: number) => void;
};

export function OrthoMap({
  ortho,
  huts,
  selectedHutId,
  onPlace,
  onSelectHut,
  onEditBox,
  magnifierSlotEl,
  resetSignal,
  focusRequest,
  candidates = [],
  reviewMode = false,
  showLabels = true,
  selectedCandidateId = null,
  onSelectCandidate,
  onAdjustCandidateBox,
}: OrthoMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  // Latest huts array for the focus-fly effect below, which deliberately
  // depends only on [focusRequest] — reading huts fresh via a ref (rather
  // than adding it to the deps) means clicking the SAME hut twice in a row
  // (nonce bump, same hutId) still re-fires without the effect also re-firing
  // on every unrelated huts update (box edits, other creates).
  const hutsRef = useRef(huts);
  hutsRef.current = huts;
  // Same idea for the magnifier redraw (see drawMagnifierHuts below): it can
  // run from the magnifier-build effect, whose deps don't include
  // selectedHutId, so it must read the current selection via a ref too.
  const selectedHutIdRef = useRef(selectedHutId);
  selectedHutIdRef.current = selectedHutId;
  // Same reason again for the review-mode state: the map/key handlers below are
  // bound once (mount-only effects) and must see the CURRENT mode, not the one
  // that was in force when they were created — otherwise entering review mode
  // would leave box-drawing armed underneath it.
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const selectedCandidateIdRef = useRef(selectedCandidateId);
  selectedCandidateIdRef.current = selectedCandidateId;
  const reviewModeRef = useRef(reviewMode);
  reviewModeRef.current = reviewMode;
  const showLabelsRef = useRef(showLabels);
  showLabelsRef.current = showLabels;
  // Latest callback without re-binding the map handlers (which would
  // otherwise force a map teardown just because a parent re-rendered).
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;
  const onEditBoxRef = useRef(onEditBox);
  onEditBoxRef.current = onEditBox;
  const onAdjustCandidateBoxRef = useRef(onAdjustCandidateBox);
  onAdjustCandidateBoxRef.current = onAdjustCandidateBox;

  // Box-drag scratch state — a live preview rectangle (mirrored on the
  // magnifier map so the draw is visible there too) plus the press-down
  // corner, all native to the mousedown/mousemove/mouseup handlers below.
  const boxStartRef = useRef<L.LatLng | null>(null);
  const previewRectRef = useRef<L.Rectangle | null>(null);
  const magPreviewRectRef = useRef<L.Rectangle | null>(null);
  // Set by the map-build effect; lets the Space handler (a separate,
  // mount-only effect) clear the live preview from both maps.
  const clearPreviewRef = useRef<() => void>(() => {});

  // Hold-Space-to-pan: spaceHeldRef is read inside the mousedown/move/up box
  // handlers (defined once, so they need a ref rather than the state to avoid
  // stale closures); the state twin only exists to drive the cursor style on
  // re-render.
  const spaceHeldRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isDragging, setIsDragging] = useState(false); // grab vs grabbing

  // True while a selected box hut's corner handle is being dragged (see the
  // redraw effect below). Guards the box-drawing mousedown/mousemove/mouseup
  // handlers the same way spaceHeldRef does, so grabbing a handle never also
  // starts drawing a new box underneath it.
  const editingHandleRef = useRef(false);

  // Magnifier: a second, independent Leaflet map over the same tile pyramid,
  // portaled into the right rail (see magnifierSlotEl) at the same position
  // FlagLabel's own zoom panel occupies. Built in its own effect, separate
  // from the main map, since the portal target may not exist on the very
  // first render.
  const magnifierContainerRef = useRef<HTMLDivElement | null>(null);
  const magnifierMapRef = useRef<L.Map | null>(null);
  // Saved-box mirror layer for the magnifier (separate from magPreviewRectRef,
  // which only ever holds the live in-progress draw rectangle). Built
  // alongside the magnifier map itself — see the magnifier-build effect.
  const magnifierMarkerLayerRef = useRef<L.LayerGroup | null>(null);
  const [magnifierOn, setMagnifierOn] = useState(true); // Z toggles this
  const magnifierOnRef = useRef(true);
  const [cursorOverMap, setCursorOverMap] = useState(false);
  const [coordLabel, setCoordLabel] = useState("—, —");
  // Magnifier zoom = mainMap.getZoom() + magnifyBoost (capped at the overzoom
  // ceiling) — FlagLabel's zoomRadius equivalent, adjustable the same way
  // ([ / ] keys, a rail slider).
  const [magnifyBoost, setMagnifyBoost] = useState(MAGNIFY_BOOST_DEFAULT);
  const magnifyBoostRef = useRef(MAGNIFY_BOOST_DEFAULT);
  // Latest cursor latlng plus an rAF-throttle flag, so a burst of mousemove
  // events collapses to one magnifier.setView per animation frame.
  const latestLatLngRef = useRef<L.LatLng | null>(null);
  const rafPendingRef = useRef(false);

  useEffect(() => {
    magnifierOnRef.current = magnifierOn;
  }, [magnifierOn]);

  useEffect(() => {
    magnifyBoostRef.current = magnifyBoost;
    // The slider (or [ / ]) should feel live, not wait for the next
    // mousemove: re-apply the last known cursor position immediately.
    const map = mapRef.current;
    const mag = magnifierMapRef.current;
    const ll = latestLatLngRef.current;
    if (!map || !mag || !ll) return;
    const magnifyZoom = Math.min(
      map.getZoom() + magnifyBoost,
      ortho.max_level + MAGNIFY_MAX,
    );
    mag.setView(ll, magnifyZoom, { animate: false });
  }, [magnifyBoost, ortho.max_level]);

  // Build (and rebuild only when the ORTHO changes) the map + tile layer.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height, max_level } = ortho;

    // See the "Magnifier sync" comment below for why these are native
    // mouseenter/mouseleave on the container, not Leaflet mouseover/mouseout.
    const handleContainerEnter = () => setCursorOverMap(true);
    const handleContainerLeave = () => setCursorOverMap(false);

    const map = L.map(el, {
      crs: L.CRS.Simple,
      minZoom: 0,
      maxZoom: max_level + OVERZOOM,
      zoomControl: true,
      attributionControl: false,
    });
    mapRef.current = map;
    // ponytail: dev-only hook so automated/manual tests can drive Leaflet-level
    // map events (synthetic DOM events don't reach Leaflet's drag pipeline).
    if (import.meta.env.DEV) (window as unknown as { __orthomap?: L.Map }).__orthomap = map;

    // Image corners in LatLng, via the reference zoom. Native px (0,0)=top-left,
    // (W,H)=bottom-right.
    const bounds = L.latLngBounds(
      map.unproject([0, 0], max_level),
      map.unproject([width, height], max_level),
    );
    map.setMaxBounds(bounds.pad(0.25));
    map.fitBounds(bounds);

    L.tileLayer(tileUrlTemplate(TILE_BASE, ortho.id, TILE_EXT), {
      tileSize: 256,
      minZoom: 0,
      maxZoom: max_level + OVERZOOM,
      maxNativeZoom: max_level, // upscale native tiles past this for over-zoom
      bounds,
      noWrap: true,
      errorTileUrl: BLANK_TILE,
    }).addTo(map);

    const markerLayer = L.layerGroup().addTo(map);
    markerLayerRef.current = markerLayer;

    // Box drawing is the only labeling gesture, so native map dragging stays
    // OFF and mousedown/mousemove/mouseup draw the box by hand; hold Space to
    // pan instead (the keydown/keyup effect below temporarily re-enables
    // dragging and cancels any box drag that was mid-flight).
    map.dragging.disable();

    // Clear the live preview from BOTH maps (main + magnifier mirror).
    const clearPreview = () => {
      if (previewRectRef.current) {
        previewRectRef.current.remove();
        previewRectRef.current = null;
      }
      if (magPreviewRectRef.current) {
        magPreviewRectRef.current.remove();
        magPreviewRectRef.current = null;
      }
    };
    clearPreviewRef.current = clearPreview;

    map.on("mousedown", (e: L.LeafletMouseEvent) => {
      // Review mode is read-only for huts: never arm a box draw. Guarding at
      // mousedown is enough for the gesture as a whole (mousemove/mouseup both
      // bail on a null boxStartRef), but the two below check as well so a drag
      // already in flight when review mode turns on can't still commit.
      if (reviewModeRef.current) return;
      if (spaceHeldRef.current || editingHandleRef.current) return;
      // The map's own "mousedown" fires BEFORE a marker's "dragstart" (that
      // only fires once Leaflet's Draggable recognizes real movement), so
      // editingHandleRef isn't set yet on the very press that starts a handle
      // drag — check the DOM target directly so that press never arms
      // box-drawing.
      if ((e.originalEvent.target as HTMLElement | null)?.closest?.(".box-handle")) return;
      if (e.originalEvent.button !== 0) return; // left button only
      boxStartRef.current = e.latlng;
    });

    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (reviewModeRef.current) return;
      if (!boxStartRef.current || spaceHeldRef.current || editingHandleRef.current) return;
      const previewBounds = L.latLngBounds(boxStartRef.current, e.latlng);
      const style = {
        color: "#ffffff",
        weight: 1.5,
        fillOpacity: 0.08,
        dashArray: "4 3",
        interactive: false, // overlay only — never steal the mouseup below it
      } as const;
      if (previewRectRef.current) {
        previewRectRef.current.setBounds(previewBounds);
      } else {
        previewRectRef.current = L.rectangle(previewBounds, style).addTo(map);
      }
      // Mirror the draw on the magnifier so the box is visible there too. Both
      // maps share CRS.Simple + the same reference zoom, so the LatLng bounds
      // transfer as-is.
      const mag = magnifierMapRef.current;
      if (mag && magnifierOnRef.current) {
        if (magPreviewRectRef.current) {
          magPreviewRectRef.current.setBounds(previewBounds);
        } else {
          // Accent green here — white was invisible against the magnifier's
          // white crosshair (the visible corner sits at its center).
          magPreviewRectRef.current = L.rectangle(previewBounds, {
            ...style,
            color: MARKER_COLOR,
            weight: 2.5,
          }).addTo(mag);
        }
      }
    });

    map.on("mouseup", (e: L.LeafletMouseEvent) => {
      if (reviewModeRef.current) {
        boxStartRef.current = null;
        clearPreview();
        return;
      }
      if (!boxStartRef.current || spaceHeldRef.current || editingHandleRef.current) return;
      const start = boxStartRef.current;
      boxStartRef.current = null;
      clearPreview();
      const p1 = map.project(start, max_level);
      const p2 = map.project(e.latlng, max_level);
      // Clamp EACH corner into the image extent first, then derive x/y/w/h —
      // maxBounds padding lets mousedown/mouseup land outside the image, and
      // clamping only x/y after the fact would widen the box instead of
      // shrinking it (the offscreen corner drags x left without moving w).
      const cx1 = Math.max(0, Math.min(p1.x, width));
      const cy1 = Math.max(0, Math.min(p1.y, height));
      const cx2 = Math.max(0, Math.min(p2.x, width));
      const cy2 = Math.max(0, Math.min(p2.y, height));
      const x = Math.round(Math.min(cx1, cx2));
      const y = Math.round(Math.min(cy1, cy2));
      const w = Math.round(Math.abs(cx2 - cx1));
      const h = Math.round(Math.abs(cy2 - cy1));
      if (w >= MIN_BOX_PX && h >= MIN_BOX_PX) {
        onPlaceRef.current(x, y, w, h);
      } // else: accidental click-and-release, ignore
    });

    // If the button is released outside the map, mouseup never fires — clear
    // the in-progress drag on mouseout so the preview doesn't keep tracking
    // the cursor after it re-enters.
    map.on("mouseout", () => {
      if (!boxStartRef.current) return;
      boxStartRef.current = null;
      clearPreview();
    });

    // Cursor feedback: "grabbing" while a Space-held pan drag is active,
    // "grab" the rest of the hold.
    map.on("dragstart", () => setIsDragging(true));
    map.on("dragend", () => setIsDragging(false));

    // --- Magnifier sync -------------------------------------------------
    // The magnifier Leaflet instance itself is built by a separate effect
    // (below, keyed on [ortho, magnifierSlotEl]) — but its sync lives here,
    // reading magnifierMapRef at call time, so it doesn't care which effect
    // created the instance or whether it exists yet.
    //
    // cursorOverMap is intentionally NOT driven by Leaflet's own
    // mouseover/mouseout: those are plain DOM events that bubble from child
    // tile <img> elements, so crossing a tile boundary (or just sitting still
    // on one while it repaints) fires a spurious "mouseout" and flickers the
    // crosshair off. mouseenter/mouseleave on the container element don't
    // fire on child-internal transitions — only when the pointer actually
    // crosses the container's own boundary — so they're wired up below on
    // `el` instead, once, alongside this effect's other native listeners.
    el.addEventListener("mouseenter", handleContainerEnter);
    el.addEventListener("mouseleave", handleContainerLeave);

    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      latestLatLngRef.current = e.latlng;
      if (!magnifierOnRef.current || rafPendingRef.current) return;
      rafPendingRef.current = true;
      requestAnimationFrame(() => {
        rafPendingRef.current = false;
        const ll = latestLatLngRef.current;
        if (!ll) return;
        // Same reference-zoom invariant as everywhere else in this file:
        // project/unproject always against max_level, never map.getZoom().
        const p = map.project(ll, max_level);
        setCoordLabel(`${Math.round(p.x)}, ${Math.round(p.y)}`);
        const mag = magnifierMapRef.current;
        if (mag) {
          const magnifyZoom = Math.min(
            map.getZoom() + magnifyBoostRef.current,
            max_level + MAGNIFY_MAX,
          );
          mag.setView(ll, magnifyZoom, { animate: false });
        }
      });
    });

    return () => {
      el.removeEventListener("mouseenter", handleContainerEnter);
      el.removeEventListener("mouseleave", handleContainerLeave);
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      boxStartRef.current = null;
      previewRectRef.current = null;
      magPreviewRectRef.current = null;
      clearPreviewRef.current = () => {};
      latestLatLngRef.current = null;
      rafPendingRef.current = false;
    };
  }, [ortho]);

  // Reset view (`0` shortcut, owned by App): re-fit the map to the whole
  // ortho on every CHANGE of resetSignal, skipping the value it already had
  // on mount — otherwise App's initial resetNonce (0) would fire a reset on
  // first paint, fighting the fitBounds the build effect above just did.
  const firstResetRef = useRef(true);
  useEffect(() => {
    if (firstResetRef.current) {
      firstResetRef.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const { width, height, max_level } = ortho;
    const bounds = L.latLngBounds(
      map.unproject([0, 0], max_level),
      map.unproject([width, height], max_level),
    );
    map.fitBounds(bounds);
  }, [resetSignal]);

  // Fly/pan to a hut-list row's hut (App's focusRequest signal). Depends only
  // on focusRequest — huts is read via hutsRef so an unrelated huts update
  // never re-triggers this, and re-clicking the same already-selected row
  // (same hutId, bumped nonce) does.
  //
  // The first-mount guard is the same one resetSignal uses, and it is load
  // bearing: App keys this component on the ortho id, so arrowing to the next
  // ortho REMOUNTS it while focusRequest still names a box from the ortho just
  // left. Without the guard that stale request fires on mount and flies to the
  // old box's pixel coordinates in the new image. App bumps the nonce again as
  // soon as the new ortho's list loads, and that request is honoured normally.
  const firstFocusRef = useRef(true);
  useEffect(() => {
    if (firstFocusRef.current) {
      firstFocusRef.current = false;
      return;
    }
    if (!focusRequest) return;
    const map = mapRef.current;
    if (!map) return;
    // Huts first, then candidates: the id names whichever list is on screen
    // (see the focusRequest prop comment). Both carry the same native-pixel
    // geometry, so one piece of fly-to math serves both — a candidate resolves
    // through candidateBox, so flying to a corrected box lands on where it now
    // IS rather than on where the pipeline first put it.
    const hut = hutsRef.current.find((h) => h.id === focusRequest.hutId);
    const candidate = hut
      ? undefined
      : candidatesRef.current.find((c) => c.id === focusRequest.hutId);
    const target = hut
      ? { x: hut.x, y: hut.y, w: hut.w, h: hut.h }
      : candidate
        ? candidateBox(candidate)
        : null;
    if (!target) return;
    const { max_level } = ortho;
    // Same box-vs-point unproject math the marker-draw effect below uses: a
    // box's bounds are its two corners; a point's "bounds" collapse to one
    // LatLng, which flyToBounds centers on directly. (Candidates are always
    // boxes, so only huts ever take the second branch.)
    const bounds =
      target.w != null && target.h != null
        ? L.latLngBounds(
            map.unproject([target.x, target.y], max_level),
            map.unproject([target.x + target.w, target.y + target.h], max_level),
          )
        : L.latLngBounds(
            map.unproject([target.x, target.y], max_level),
            map.unproject([target.x, target.y], max_level),
          );
    map.flyToBounds(bounds, { maxZoom: max_level + 1, padding: [80, 80], duration: 0.4 });
  }, [focusRequest, ortho]);

  // Mirrors saved BOX huts onto the magnifier's own marker layer — a labeler
  // judges box tightness there, so the magnifier needs the same rectangles
  // the main map draws (point huts aren't mirrored; there's no tightness to
  // judge and the magnifier stays a viewport, not a second labeling surface).
  // In review mode it mirrors the CANDIDATES instead, for the same reason: the
  // magnifier is where the reviewer actually decides whether a box is a hut.
  // Reads huts/candidates/selection via refs rather than closing over props:
  // this is called from two effects with different dep arrays (the redraw
  // effect below, and the magnifier-build effect right after this), so it
  // must be correct no matter which one's closure last ran.
  function drawMagnifierBoxes() {
    const mag = magnifierMapRef.current;
    const layer = magnifierMarkerLayerRef.current;
    if (!mag || !layer) return; // magnifier not built yet (or torn down)
    layer.clearLayers();
    if (reviewModeRef.current) {
      // Same two passes as the main map, in the same order: existing labels
      // underneath, candidates on top. No handles here — the magnifier is a
      // viewport, and editing happens on the map.
      for (const hut of showLabelsRef.current ? boxHuts(hutsRef.current) : []) {
        const topLeft = mag.unproject([hut.x, hut.y], ortho.max_level);
        const bottomRight = mag.unproject(
          [hut.x + hut.w, hut.y + hut.h],
          ortho.max_level,
        );
        L.rectangle(L.latLngBounds(topLeft, bottomRight), existingLabelStyle(hut.confidence)).addTo(
          layer,
        );
      }
      for (const candidate of candidatesRef.current) {
        const box = candidateBox(candidate);
        const topLeft = mag.unproject([box.x, box.y], ortho.max_level);
        const bottomRight = mag.unproject([box.x + box.w, box.y + box.h], ortho.max_level);
        L.rectangle(L.latLngBounds(topLeft, bottomRight), {
          ...candidateStyle(candidate.verdict, candidate.id === selectedCandidateIdRef.current),
          interactive: false, // viewport only — no click/select here
        }).addTo(layer);
      }
      return;
    }
    for (const hut of hutsRef.current) {
      if (hut.w == null || hut.h == null) continue;
      const selected = hut.id === selectedHutIdRef.current;
      const color = confidenceColor(hut.confidence);
      const topLeft = mag.unproject([hut.x, hut.y], ortho.max_level);
      const bottomRight = mag.unproject(
        [hut.x + hut.w, hut.y + hut.h],
        ortho.max_level,
      );
      L.rectangle(L.latLngBounds(topLeft, bottomRight), {
        color: selected ? "#ffffff" : color,
        weight: selected ? 3 : 1.5,
        fillColor: color,
        fillOpacity: 0.15,
        interactive: false, // viewport only — no click/select/drag here
      }).addTo(layer);
    }
  }

  // The magnifier's own Leaflet instance: same tile pyramid, independent map
  // object, mounted into magnifierSlotEl (portaled from the right rail) once
  // that node exists. Separate from the main-map effect above because the
  // portal target can lag one render behind on first mount (see the
  // magnifierSlotEl prop comment) — keying on it here lets this effect just
  // re-run when it resolves, instead of the main map effect having to wait.
  useEffect(() => {
    const map = mapRef.current;
    const el = magnifierContainerRef.current;
    if (!map || !el) return;
    const { width, height, max_level } = ortho;

    const bounds = L.latLngBounds(
      map.unproject([0, 0], max_level),
      map.unproject([width, height], max_level),
    );

    const magnifier = L.map(el, {
      crs: L.CRS.Simple,
      minZoom: 0,
      maxZoom: max_level + MAGNIFY_MAX,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      inertia: false,
    });
    magnifierMapRef.current = magnifier;

    L.tileLayer(tileUrlTemplate(TILE_BASE, ortho.id, TILE_EXT), {
      tileSize: 256,
      minZoom: 0,
      maxZoom: max_level + MAGNIFY_MAX,
      maxNativeZoom: max_level, // upscaling past this IS the magnification
      bounds,
      noWrap: true,
      errorTileUrl: BLANK_TILE,
    }).addTo(magnifier);

    const magnifierMarkerLayer = L.layerGroup().addTo(magnifier);
    magnifierMarkerLayerRef.current = magnifierMarkerLayer;

    magnifier.setView(bounds.getCenter(), max_level, { animate: false });
    // The panel is sized by CSS (and may have just appeared via the portal);
    // Leaflet needs a nudge once that layout has actually taken effect.
    const raf = requestAnimationFrame(() => magnifier.invalidateSize());
    // This map instance is brand new (or just got rebuilt) — the box-redraw
    // effect below won't re-run just because THIS effect did, so the newly
    // (re)built magnifier needs its own draw pass here rather than waiting
    // for the next huts/selection change.
    drawMagnifierBoxes();

    return () => {
      cancelAnimationFrame(raf);
      magnifier.remove(); // also removes magnifierMarkerLayer, no separate cleanup needed
      magnifierMapRef.current = null;
      magnifierMarkerLayerRef.current = null; // died with its map
      magPreviewRectRef.current = null; // died with its map
    };
  }, [ortho, magnifierSlotEl]);

  // Hold-Space-to-pan, plus a Z toggle for the magnifier panel. One
  // mount-only listener pair — everything it touches (mapRef, boxStartRef,
  // clearPreviewRef) is a ref, so it never goes stale.
  useEffect(() => {
    // Undoing a hut edit is Cmd/Ctrl+Z; back/forward nav is often Cmd+[ / ].
    // Space needs no such guard (nothing else binds a bare Space).
    function restoreFromSpaceHold() {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      mapRef.current?.dragging.disable(); // back to box-drawing
    }
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        if (spaceHeldRef.current) return; // ignore key-repeat while held
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        mapRef.current?.dragging.enable();
        // A box drag that was mid-flight when Space came down must not
        // survive: releasing the mouse after a Space-pan shouldn't drop it.
        boxStartRef.current = null;
        clearPreviewRef.current();
        return;
      }
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd) return; // don't shadow Cmd/Ctrl+Z (undo) or +[ / +] (nav)
      if (e.key === "z" || e.key === "Z") {
        setMagnifierOn((v) => !v);
        return;
      }
      // Magnifier zoom-level, mirroring FlagLabel's [ / ] zoomRadius keys.
      // Review mode rebinds [ / ] to prev/next candidate (App owns those), so
      // step aside rather than doing both at once. Z still toggles the panel.
      if (reviewModeRef.current) return;
      if (e.key === "[") {
        e.preventDefault();
        setMagnifyBoost((b) => Math.max(MAGNIFY_BOOST_MIN, b - 1));
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        setMagnifyBoost((b) => Math.min(MAGNIFY_BOOST_MAX, b + 1));
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      if (!spaceHeldRef.current) return;
      restoreFromSpaceHold();
    }
    function onBlur() {
      // Window lost focus (alt-tab, dialog) while Space was held — keyup
      // will never fire, so restore here or dragging/box-drawing stays stuck.
      if (spaceHeldRef.current) restoreFromSpaceHold();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Z can hide the panel (display:none), which zeroes its measured size;
  // Leaflet caches that and won't notice a later CSS-driven resize on its
  // own. Re-measure every time it toggles back on, or it stays blank.
  useEffect(() => {
    if (!magnifierOn) return;
    const raf = requestAnimationFrame(() => {
      magnifierMapRef.current?.invalidateSize();
    });
    return () => cancelAnimationFrame(raf);
  }, [magnifierOn]);

  // Redraw whenever the boxes or the selection change (cheap; no map rebuild).
  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    // Review mode draws the candidates over this ortho's existing labels, which
    // the reviewer can hide again with `L` (showLabels). The labels are inert
    // either way — existingLabelStyle sets interactive: false — so there is
    // nothing here to select, resize or delete; the only thing a reviewer may
    // move is a candidate's own box. Whether they were on screen when a verdict
    // was given is recorded with that verdict (labels_visible), so an analysis
    // can still tell a blind call from an informed one.
    if (reviewMode) {
      for (const hut of showLabels ? boxHuts(huts) : []) {
        const topLeft = map.unproject([hut.x, hut.y], ortho.max_level);
        const bottomRight = map.unproject(
          [hut.x + hut.w, hut.y + hut.h],
          ortho.max_level,
        );
        L.rectangle(L.latLngBounds(topLeft, bottomRight), existingLabelStyle(hut.confidence)).addTo(
          layer,
        );
      }
      for (const candidate of candidates) {
        const selected = candidate.id === selectedCandidateId;
        const box = candidateBox(candidate);
        const topLeft = map.unproject([box.x, box.y], ortho.max_level);
        const bottomRight = map.unproject([box.x + box.w, box.y + box.h], ortho.max_level);
        const rect = L.rectangle(
          L.latLngBounds(topLeft, bottomRight),
          candidateStyle(candidate.verdict, selected),
        );
        rect.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          onSelectCandidate?.(candidate.id);
        });
        rect.addTo(layer);

        // The SELECTED candidate gets the same corner handles a selected hut
        // gets, plus a centre handle to move it — the reviewer's correction of
        // a box that is right about the hut and wrong about its extent. Drawn
        // for one candidate only, and torn down with everything else on the
        // next layer.clearLayers(). The map's own draw gesture stays disabled
        // throughout: this is handle-driven, never a drag on open ground.
        if (selected && onAdjustCandidateBoxRef.current) {
          attachBoxHandles({
            map,
            layer,
            rect,
            box,
            maxLevel: ortho.max_level,
            imageWidth: ortho.width,
            imageHeight: ortho.height,
            onDragStart: () => {
              // Belt and braces, exactly as for huts: review mode already
              // refuses to arm a box draw, but a stray mousedown that preceded
              // this dragstart is cleared here too.
              boxStartRef.current = null;
              clearPreviewRef.current();
              editingHandleRef.current = true;
            },
            onDragEnd: () => {
              editingHandleRef.current = false;
            },
            commit: (x, y, w, h) => onAdjustCandidateBoxRef.current?.(candidate.id, x, y, w, h),
          });
        }
      }
      drawMagnifierBoxes();
      return;
    }

    for (const hut of huts) {
      const selected = hut.id === selectedHutId;
      const hutColor = confidenceColor(hut.confidence);
      const color = selected ? "#ffffff" : hutColor;
      const weight = selected ? 3 : 1.5;

      if (hut.w != null && hut.h != null) {
        const topLeft = map.unproject([hut.x, hut.y], ortho.max_level);
        const bottomRight = map.unproject(
          [hut.x + hut.w, hut.y + hut.h],
          ortho.max_level,
        );
        const rect = L.rectangle(L.latLngBounds(topLeft, bottomRight), {
          color,
          weight,
          fillColor: hutColor,
          fillOpacity: 0.15,
        });
        rect.on("click", (e) => {
          L.DomEvent.stopPropagation(e); // don't also drop a new hut under it
          onSelectHut(hut.id);
        });
        rect.addTo(layer);

        // The selected box hut gets 4 draggable corner handles so it can be
        // resized in place. Only ever drawn for ONE hut (the selection), and
        // torn down with everything else on the next layer.clearLayers().
        if (selected) {
          const hutX = hut.x;
          const hutY = hut.y;
          const hutW = hut.w;
          const hutH = hut.h;
          type Corner = "NW" | "NE" | "SW" | "SE";
          const cornerPx: Record<Corner, [number, number]> = {
            NW: [hutX, hutY],
            NE: [hutX + hutW, hutY],
            SW: [hutX, hutY + hutH],
            SE: [hutX + hutW, hutY + hutH],
          };
          const oppositeOf: Record<Corner, Corner> = {
            NW: "SE",
            NE: "SW",
            SW: "NE",
            SE: "NW",
          };
          const handles = {} as Record<Corner, L.Marker>;
          // The corner LatLng that stays put for the current drag gesture —
          // computed at dragstart from the hut's STORED geometry (not the
          // live handle position), and read by both this handle's "drag"
          // ticks and its "dragend" commit.
          let fixedCornerLatLng: L.LatLng | null = null;

          (Object.keys(cornerPx) as Corner[]).forEach((corner) => {
            const ll = map.unproject(cornerPx[corner], ortho.max_level);
            const marker = L.marker(ll, {
              draggable: true,
              icon: L.divIcon({
                className: "box-handle",
                iconSize: [10, 10],
                iconAnchor: [5, 5],
              }),
            });
            handles[corner] = marker;

            marker.on("dragstart", () => {
              // Defensively clear any box-draw already armed by the
              // mousedown that preceded this dragstart (see the ".box-handle"
              // target check above — belt-and-suspenders against the same
              // event-ordering hazard, including the tail case where a stray
              // "mouseup" lands after a "dragend" already reset the guard).
              boxStartRef.current = null;
              clearPreviewRef.current();
              editingHandleRef.current = true;
              const [ox, oy] = cornerPx[oppositeOf[corner]];
              fixedCornerLatLng = map.unproject([ox, oy], ortho.max_level);
            });

            // Live-update the rectangle and all 4 handles from
            // [fixedCornerLatLng, the dragged handle's current position] —
            // simplest way to keep the visual a coherent rectangle without
            // tracking each handle's motion individually.
            marker.on("drag", () => {
              if (!fixedCornerLatLng) return;
              const bounds = L.latLngBounds(fixedCornerLatLng, marker.getLatLng());
              rect.setBounds(bounds);
              handles.NW.setLatLng(bounds.getNorthWest());
              handles.NE.setLatLng(bounds.getNorthEast());
              handles.SW.setLatLng(bounds.getSouthWest());
              handles.SE.setLatLng(bounds.getSouthEast());
            });

            marker.on("dragend", () => {
              editingHandleRef.current = false; // re-arm box-drawing first
              if (!fixedCornerLatLng) return;
              const p1 = map.project(fixedCornerLatLng, ortho.max_level);
              const p2 = map.project(marker.getLatLng(), ortho.max_level);
              // Same clamp-then-derive order as the box-draw mouseup handler
              // above: clamp EACH corner into the image extent first, so a
              // drag that ends offscreen shrinks the box instead of the far
              // corner chasing it.
              const cx1 = Math.max(0, Math.min(p1.x, ortho.width));
              const cy1 = Math.max(0, Math.min(p1.y, ortho.height));
              const cx2 = Math.max(0, Math.min(p2.x, ortho.width));
              const cy2 = Math.max(0, Math.min(p2.y, ortho.height));
              const x = Math.round(Math.min(cx1, cx2));
              const y = Math.round(Math.min(cy1, cy2));
              const w = Math.round(Math.abs(cx2 - cx1));
              const h = Math.round(Math.abs(cy2 - cy1));
              if (w < MIN_BOX_PX || h < MIN_BOX_PX) {
                // Degenerate resize (accidental nudge) — don't commit.
                // Re-submitting the hut's ORIGINAL geometry is a no-op at
                // the backend but still bumps the huts array identity, which
                // re-runs this effect and snaps the rect/handles back.
                onEditBoxRef.current(hut.id, hutX, hutY, hutW, hutH);
              } else {
                onEditBoxRef.current(hut.id, x, y, w, h);
              }
              fixedCornerLatLng = null;
            });

            marker.addTo(layer);
          });
        }
      } else {
        const ll = map.unproject([hut.x, hut.y], ortho.max_level);
        const marker = L.circleMarker(ll, {
          radius: selected ? 9 : 6,
          color: selected ? "#ffffff" : "#0c0c0d",
          weight,
          fillColor: hutColor,
          fillOpacity: 0.9,
        });
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e); // don't also drop a new hut under it
          onSelectHut(hut.id);
        });
        marker.addTo(layer);
      }
    }
    // Mirror the saved boxes onto the magnifier too — a no-op if it isn't
    // built yet (drawMagnifierBoxes no-ops on missing refs); the
    // magnifier-build effect covers that case with its own draw pass.
    drawMagnifierBoxes();
  }, [
    huts,
    selectedHutId,
    ortho.max_level,
    candidates,
    selectedCandidateId,
    reviewMode,
    showLabels,
  ]);

  // Cursor hints what's active: grab/grabbing while Space-panning, the
  // box-drawing crosshair the rest of the time — and a plain arrow in review
  // mode, where there is nothing to draw.
  const cursor = spaceHeld
    ? isDragging
      ? "grabbing"
      : "grab"
    : reviewMode
      ? "default"
      : "crosshair";

  // The magnifier panel + its zoom-level slider, portaled into AttributePanel's
  // right rail at magnifierSlotEl — the same top-of-rail position FlagLabel's
  // own zoom panel occupies (see AttributePanel's `zoomSlot` prop).
  const magnifierPanel = (
    <>
      <div
        className="zoom-panel"
        style={{ display: magnifierOn ? "block" : "none" }}
      >
        <div ref={magnifierContainerRef} className="zoom-panel-map" />
        <div className="zoom-crosshair" aria-hidden="true">
          <span className="zoom-crosshair-seg zoom-crosshair-top" />
          <span className="zoom-crosshair-seg zoom-crosshair-bottom" />
          <span className="zoom-crosshair-seg zoom-crosshair-left" />
          <span className="zoom-crosshair-seg zoom-crosshair-right" />
        </div>
        {!cursorOverMap && <div className="zoom-empty" />}
        <div className="zoom-panel-coord">{coordLabel}</div>
      </div>
      {magnifierOn && (
        <div className="rail-section">
          <div className="rail-label">
            <span>Zoom level</span>
            <span className="key-hint">[ · ]</span>
          </div>
          <div className="slider-row">
            <input
              type="range"
              min={MAGNIFY_BOOST_MIN}
              max={MAGNIFY_BOOST_MAX}
              step={1}
              value={magnifyBoost}
              onChange={(e) => setMagnifyBoost(Number(e.currentTarget.value))}
              className="slider"
            />
            <span className="slider-value">+{magnifyBoost}</span>
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      <div ref={containerRef} className="ortho-map" style={{ cursor }} />
      {magnifierSlotEl && createPortal(magnifierPanel, magnifierSlotEl)}
    </>
  );
}

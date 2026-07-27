import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Ortho } from "../orthos";
import { tileUrlTemplate } from "../orthos";
import type { Hut } from "../huts/model";

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

// Marker fill: every hut is drawn in the same accent color — there's no
// per-hut attribute left to distinguish by.
const MARKER_COLOR = "#34a382"; // accent

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
  focusRequest?: { hutId: string; nonce: number } | null;
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
  // Latest callback without re-binding the map handlers (which would
  // otherwise force a map teardown just because a parent re-rendered).
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;
  const onEditBoxRef = useRef(onEditBox);
  onEditBoxRef.current = onEditBox;

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
  // (same hutId, bumped nonce) does. No first-mount guard needed: unlike
  // resetSignal, focusRequest starts out null and only becomes non-null from
  // an explicit row click.
  useEffect(() => {
    if (!focusRequest) return;
    const map = mapRef.current;
    if (!map) return;
    const hut = hutsRef.current.find((h) => h.id === focusRequest.hutId);
    if (!hut) return;
    const { max_level } = ortho;
    // Same box-vs-point unproject math the marker-draw effect below uses: a
    // box's bounds are its two corners; a point's "bounds" collapse to one
    // LatLng, which flyToBounds centers on directly.
    const bounds =
      hut.w != null && hut.h != null
        ? L.latLngBounds(
            map.unproject([hut.x, hut.y], max_level),
            map.unproject([hut.x + hut.w, hut.y + hut.h], max_level),
          )
        : L.latLngBounds(
            map.unproject([hut.x, hut.y], max_level),
            map.unproject([hut.x, hut.y], max_level),
          );
    map.flyToBounds(bounds, { maxZoom: max_level + 1, padding: [80, 80], duration: 0.4 });
  }, [focusRequest, ortho]);

  // Mirrors saved BOX huts onto the magnifier's own marker layer — a labeler
  // judges box tightness there, so the magnifier needs the same rectangles
  // the main map draws (point huts aren't mirrored; there's no tightness to
  // judge and the magnifier stays a viewport, not a second labeling surface).
  // Reads huts/selection via refs rather than closing over props: this is
  // called from two effects with different dep arrays (the huts-redraw
  // effect below, and the magnifier-build effect right after this), so it
  // must be correct no matter which one's closure last ran.
  function drawMagnifierHuts() {
    const mag = magnifierMapRef.current;
    const layer = magnifierMarkerLayerRef.current;
    if (!mag || !layer) return; // magnifier not built yet (or torn down)
    layer.clearLayers();
    for (const hut of hutsRef.current) {
      if (hut.w == null || hut.h == null) continue;
      const selected = hut.id === selectedHutIdRef.current;
      const topLeft = mag.unproject([hut.x, hut.y], ortho.max_level);
      const bottomRight = mag.unproject(
        [hut.x + hut.w, hut.y + hut.h],
        ortho.max_level,
      );
      L.rectangle(L.latLngBounds(topLeft, bottomRight), {
        color: selected ? "#ffffff" : MARKER_COLOR,
        weight: selected ? 3 : 1.5,
        fillColor: MARKER_COLOR,
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
    // This map instance is brand new (or just got rebuilt) — the huts-redraw
    // effect below won't re-run just because THIS effect did, so the newly
    // (re)built magnifier needs its own draw pass here rather than waiting
    // for the next huts/selection change.
    drawMagnifierHuts();

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

  // Redraw huts whenever they or the selection change (cheap; no map rebuild).
  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const hut of huts) {
      const selected = hut.id === selectedHutId;
      const color = selected ? "#ffffff" : MARKER_COLOR;
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
          fillColor: MARKER_COLOR,
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
          fillColor: MARKER_COLOR,
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
    // built yet (drawMagnifierHuts no-ops on missing refs); the
    // magnifier-build effect covers that case with its own draw pass.
    drawMagnifierHuts();
  }, [huts, selectedHutId, ortho.max_level]);

  // Cursor hints what's active: grab/grabbing while Space-panning, the
  // box-drawing crosshair the rest of the time.
  const cursor = spaceHeld ? (isDragging ? "grabbing" : "grab") : "crosshair";

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

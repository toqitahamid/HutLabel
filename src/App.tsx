import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { Ortho } from "./orthos";
import { type Hut, type HutAttributes, defaultAttributes } from "./huts/model";
import { OrthoMap, type OrthoMode } from "./viewer/OrthoMap";
import { AttributePanel } from "./huts/AttributePanel";
import { makeHutBackend } from "./cloud/hut-backend";
import { useAccount } from "./cloud/AuthGate";

const MODES: { id: OrthoMode; label: string }[] = [
  { id: "pan", label: "Pan" },
  { id: "point", label: "Point" },
  { id: "box", label: "Box" },
];

// Global shortcuts must ignore keystrokes meant for a text field elsewhere in
// the app (e.g. typing "b" while editing a hut's structure-type select
// shouldn't switch to box mode). Same guard OrthoMap uses for its own keys
// (Space, Z, [ / ]), kept in lockstep so no input field is ever shadowed.
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

// Sections for the keyboard-help modal (`?`), grouped the way FlagLabel's
// KeyboardHelp groups its own — one row per action, keys rendered in a <kbd>.
// Space, Z and [ / ] live in OrthoMap; listed here too since they're still
// part of the app's one shortcut surface from the labeler's point of view.
const HELP_SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Modes",
    rows: [
      ["Box", "B"],
      ["Point", "P"],
      ["Pan", "V"],
      ["Hold to pan", "Space"],
    ],
  },
  {
    title: "Placement",
    rows: [
      ["Draw box (box mode)", "drag"],
      ["Drop point (point mode)", "click"],
    ],
  },
  {
    title: "Selected hut",
    rows: [
      ["Dwelling hut", "1"],
      ["Feeding platform", "2"],
      ["Uncertain mound", "3"],
      ["Toggle confidence", "C"],
      ["Delete", "Del / ⌫"],
      ["Deselect", "Esc"],
    ],
  },
  {
    title: "Navigation",
    rows: [
      ["Previous / next ortho", "← / →"],
      ["Reset view", "0"],
      ["Zoom", "scroll / + −"],
    ],
  },
  {
    title: "Magnifier",
    rows: [
      ["Toggle", "Z"],
      ["Zoom level − / +", "[ / ]"],
    ],
  },
  {
    title: "Help",
    rows: [
      ["Open", "?"],
      ["Close", "Esc"],
    ],
  },
];

// Keyboard-shortcut reference, ported from FlagLabel's KeyboardHelp. Backdrop
// click, the × button, and Esc (handled by App's keydown effect) all close it.
function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard reference"
      >
        <div className="help-header">
          <div className="help-title">HutLabel · Keyboard reference</div>
          <button
            className="help-close"
            onClick={onClose}
            aria-label="Close"
            title="Esc"
          >
            ×
          </button>
        </div>

        <p className="help-intro">
          Choose Box or Point mode, then draw or click on the map to drop a
          hut. Set its structure type and confidence from the keyboard or the
          right rail — the magnifier and shortcuts below stay live the whole
          time.
        </p>

        <div className="help-grid">
          {HELP_SECTIONS.map((section) => (
            <div key={section.title} className="help-section">
              <div className="help-section-title">{section.title}</div>
              <dl className="help-rows">
                {section.rows.map(([action, keys]) => (
                  <div key={action} className="help-row">
                    <dt>{action}</dt>
                    <dd>
                      <kbd>{keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Titlebar brand mark: a bull's-eye, echoing the marker a placed hut draws on
// the map. Inherits `currentColor`; the titlebar tints it with the accent.
function HutMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth={1.7} />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth={1.7} />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function SiteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function VisitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <circle cx="12" cy="9" r="3" />
      <path d="M12 21s6-5.5 6-10.5A6 6 0 0 0 6 10.5C6 15.5 12 21 12 21Z" />
    </svg>
  );
}

export default function App() {
  const backendRef = useRef(makeHutBackend());
  const account = useAccount();

  const [orthos, setOrthos] = useState<Ortho[]>([]);
  const [activeOrtho, setActiveOrtho] = useState<Ortho | null>(null);
  const [huts, setHuts] = useState<Hut[]>([]);
  const [selectedHutId, setSelectedHutId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Box is the default — it doubles as a detection label and a SAM prompt.
  const [mode, setMode] = useState<OrthoMode>("box");

  // Keyboard-help modal (`?`), and a reset-view "signal" that OrthoMap watches
  // (`0` shortcut) — a counter rather than a boolean so pressing it twice in a
  // row (already reset) still re-fits the view each time.
  const [helpOpen, setHelpOpen] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);

  // OrthoMap's magnifier portals its panel + zoom-level slider into this DOM
  // node, rendered by AttributePanel at the top of the right rail — the same
  // position FlagLabel's zoom panel occupies. A ref callback (not a ref
  // object) so OrthoMap re-renders once the node exists, instead of racing it.
  const [zoomSlotEl, setZoomSlotEl] = useState<HTMLDivElement | null>(null);

  // Explorer-tree collapse state, keyed by site name. Default = all expanded
  // (empty set), mirroring FlagLabel's folder-sidebar tree.
  const [collapsedSites, setCollapsedSites] = useState<Set<string>>(new Set());

  // Load the ortho list once; auto-select the first so the map shows immediately.
  useEffect(() => {
    backendRef.current
      .listOrthos()
      .then((list) => {
        setOrthos(list);
        setActiveOrtho((prev) => prev ?? list[0] ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Load huts whenever the active ortho changes.
  useEffect(() => {
    if (!activeOrtho) return;
    let cancelled = false;
    setHuts([]);
    setSelectedHutId(null);
    backendRef.current
      .listHuts(activeOrtho.id)
      .then((rows) => {
        if (!cancelled) setHuts(rows);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [activeOrtho]);

  const selectedHut = useMemo(
    () => huts.find((h) => h.id === selectedHutId) ?? null,
    [huts, selectedHutId],
  );

  // Orthos grouped by site, each site's visits sorted, for the explorer tree.
  // Sites are sorted alphabetically so the tree is stable across reloads.
  const sitesWithOrthos = useMemo(() => {
    const bySite = new Map<string, Ortho[]>();
    for (const o of orthos) {
      const arr = bySite.get(o.site);
      if (arr) arr.push(o);
      else bySite.set(o.site, [o]);
    }
    for (const arr of bySite.values()) {
      arr.sort((a, b) => a.visit.localeCompare(b.visit));
    }
    return Array.from(bySite.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((site) => ({ site, orthos: bySite.get(site)! }));
  }, [orthos]);

  const toggleSite = useCallback((site: string) => {
    setCollapsedSites((prev) => {
      const next = new Set(prev);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });
  }, []);

  const expandSite = useCallback((site: string) => {
    setCollapsedSites((prev) => {
      if (!prev.has(site)) return prev;
      const next = new Set(prev);
      next.delete(site);
      return next;
    });
  }, []);

  // Keep the active ortho's site expanded, e.g. right after load or a jump.
  useEffect(() => {
    if (activeOrtho) expandSite(activeOrtho.site);
  }, [activeOrtho, expandSite]);

  // Drop a new hut at the placed native-pixel geometry, optimistically, then
  // persist. On failure the optimistic row is rolled back so the map never
  // lies. w/h are null for a point hut, set for a box hut.
  const handlePlace = useCallback(
    async (x: number, y: number, w: number | null, h: number | null) => {
      if (!activeOrtho) return;
      const attrs = defaultAttributes();
      try {
        const hut = await backendRef.current.createHut(
          activeOrtho.id,
          x,
          y,
          w,
          h,
          attrs,
        );
        setHuts((prev) => [...prev, hut]);
        setSelectedHutId(hut.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activeOrtho],
  );

  const handleChangeAttrs = useCallback(
    async (attrs: HutAttributes) => {
      if (!selectedHutId) return;
      const prev = huts;
      setHuts((cur) =>
        cur.map((h) => (h.id === selectedHutId ? { ...h, ...attrs } : h)),
      );
      try {
        await backendRef.current.updateHut(selectedHutId, attrs);
      } catch (e) {
        setHuts(prev); // roll back
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [selectedHutId, huts],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedHutId) return;
    const prev = huts;
    const id = selectedHutId;
    setHuts((cur) => cur.filter((h) => h.id !== id));
    setSelectedHutId(null);
    try {
      await backendRef.current.deleteHut(id);
    } catch (e) {
      setHuts(prev); // roll back
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedHutId, huts]);

  // Global shortcuts: mode switches, per-hut attribute keys, ortho nav, reset
  // view, and the help modal. Space (hold-to-pan), Z (magnifier toggle) and
  // [ / ] (magnifier zoom) are bound inside OrthoMap instead — coordinate,
  // don't rebind. Depends on the state/handlers it reads, so it always closes
  // over the latest values; the listener itself is cheap to re-bind.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey) return; // let Cmd/Ctrl shortcuts pass through

      // Esc: close the help modal first if it's open; otherwise deselect.
      if (e.key === "Escape") {
        if (helpOpen) setHelpOpen(false);
        else setSelectedHutId(null);
        return;
      }

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (e.key === "b" || e.key === "B") {
        setMode("box");
        return;
      }
      if (e.key === "p" || e.key === "P") {
        setMode("point");
        return;
      }
      if (e.key === "v" || e.key === "V") {
        setMode("pan");
        return;
      }

      if (e.key === "1" || e.key === "2" || e.key === "3") {
        if (!selectedHut) return;
        const structure_type =
          e.key === "1"
            ? "dwelling_hut"
            : e.key === "2"
              ? "feeding_platform"
              : "uncertain_mound";
        handleChangeAttrs({ structure_type, confidence: selectedHut.confidence });
        return;
      }

      if (e.key === "c" || e.key === "C") {
        if (!selectedHut) return;
        const confidence =
          selectedHut.confidence === "certain" ? "maybe" : "certain";
        handleChangeAttrs({ structure_type: selectedHut.structure_type, confidence });
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (!selectedHutId) return;
        e.preventDefault();
        handleDelete();
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (!activeOrtho || orthos.length === 0) return;
        const idx = orthos.findIndex((o) => o.id === activeOrtho.id);
        if (idx === -1) return;
        const nextIdx = e.key === "ArrowLeft" ? idx - 1 : idx + 1;
        if (nextIdx < 0 || nextIdx >= orthos.length) return;
        e.preventDefault();
        setActiveOrtho(orthos[nextIdx]);
        return;
      }

      if (e.key === "0") {
        setResetNonce((n) => n + 1);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    helpOpen,
    selectedHut,
    selectedHutId,
    activeOrtho,
    orthos,
    handleChangeAttrs,
    handleDelete,
  ]);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <HutMark className="brand-mark" />
          <span className="brand-name">HutLabel</span>
        </div>
        {activeOrtho && (
          <span className="title-info">
            {activeOrtho.site} <span className="sep">·</span> Visit {activeOrtho.visit}
          </span>
        )}
        <div className="title-actions">
          <button
            type="button"
            className="title-btn ghost"
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
          {account && (
            <span className="title-account">
              <span className="title-account-email" title={account.email}>
                {account.email}
              </span>
              <button className="title-btn ghost" onClick={account.signOut}>
                Sign out
              </button>
            </span>
          )}
        </div>
      </header>

      <aside className="folder-sidebar">
        <div className="folder-header">
          <span className="folder-title">Sites</span>
          <span className="folder-meta">
            <span className="mono">{orthos.length}</span> ortho
            {orthos.length === 1 ? "" : "s"} ·{" "}
            <span className="mono">{sitesWithOrthos.length}</span> site
            {sitesWithOrthos.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="tree">
          {sitesWithOrthos.map(({ site, orthos: siteOrthos }) => {
            const collapsed = collapsedSites.has(site);
            return (
              <div className={`folder ${collapsed ? "" : "open"}`} key={site}>
                <button
                  type="button"
                  className="folder-row"
                  onClick={() => toggleSite(site)}
                  aria-expanded={!collapsed}
                  title={site}
                >
                  <ChevronIcon className="chev" />
                  <SiteIcon className="folder-icon" />
                  <span className="folder-name">{site}</span>
                  <span className="folder-badge mono">{siteOrthos.length}</span>
                </button>
                {!collapsed && (
                  <div className="folder-children">
                    {siteOrthos.map((o) => {
                      const isActive = activeOrtho?.id === o.id;
                      return (
                        <button
                          type="button"
                          key={o.id}
                          className={"image-item" + (isActive ? " active" : "")}
                          onClick={() => setActiveOrtho(o)}
                          aria-current={isActive ? "true" : undefined}
                          title={`${o.site} · Visit ${o.visit}`}
                        >
                          <VisitIcon className="img-icon" />
                          <span className="image-item-name">Visit {o.visit}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {orthos.length === 0 && !error && (
            <p className="sb-empty">Loading orthos…</p>
          )}
        </div>
      </aside>

      <main className="stage">
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button className="banner-x" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}
        {activeOrtho ? (
          <>
            <div className="mode-toolbar segmented">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={"segmented-btn" + (mode === m.id ? " active" : "")}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <OrthoMap
              key={activeOrtho.id}
              ortho={activeOrtho}
              huts={huts}
              selectedHutId={selectedHutId}
              mode={mode}
              onPlace={handlePlace}
              onSelectHut={setSelectedHutId}
              magnifierSlotEl={zoomSlotEl}
              resetSignal={resetNonce}
            />
          </>
        ) : (
          <div className="stage-empty">
            {error ? "Could not load orthos." : "No ortho selected."}
          </div>
        )}
      </main>

      <AttributePanel
        hut={selectedHut}
        huts={huts}
        onChange={handleChangeAttrs}
        onDelete={handleDelete}
        zoomSlot={<div className="zoom-slot" ref={setZoomSlotEl} />}
      />

      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

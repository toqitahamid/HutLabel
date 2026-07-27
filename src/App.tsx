import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type { Ortho } from "./orthos";
import { type Hut, TEMP_HUT_PREFIX, isTempHutId } from "./huts/model";
import { OrthoMap } from "./viewer/OrthoMap";
import { AttributePanel } from "./huts/AttributePanel";
import { makeHutBackend } from "./cloud/hut-backend";
import { useAccount } from "./cloud/AuthGate";
import { AdminPanel } from "./cloud/AdminPanel";
import {
  EMPTY_HISTORY,
  dropEntry,
  invertForRedo,
  invertForUndo,
  recordChange,
  remapEntry,
  remapHistory,
  settleRedo,
  settleUndo,
  takeRedo,
  takeUndo,
  updateEntry,
  type HistoryState,
} from "./huts/history";

// Global shortcuts must ignore keystrokes meant for a text field elsewhere in
// the app (e.g. the admin panel's inputs, or the magnifier's zoom slider).
// Same guard OrthoMap uses for its own keys (Space, Z, [ / ]), kept in
// lockstep so no input field is ever shadowed.
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
    title: "Labeling",
    rows: [
      ["Draw box", "drag"],
      ["Hold to pan", "Space"],
      ["Undo", "⌘Z"],
      ["Redo", "⌘⇧Z"],
    ],
  },
  {
    title: "Selected hut",
    rows: [
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
          Drag on the map to draw a box around a hut (hold Space to pan) — the
          magnifier and shortcuts below stay live the whole time.
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

// Sidebar done indicator: a plain check, shown next to the hut-count badge
// once an admin has marked the ortho done (see doneStatusLabel below).
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

// The sidebar's four display states, derived from done_at + hut_count rather
// than stored — there's no separate "in progress" column (see
// scripts/migrations/001-orthos-done-at.sql). Marking an ortho with zero huts
// done means surveyed-and-empty, not "not yet done".
function doneStatusLabel(doneAt: string | null | undefined, hutCount: number): string {
  if (doneAt == null) return hutCount > 0 ? "In progress" : "Unlabeled";
  return hutCount > 0 ? "Done" : "Done — no huts found";
}

export default function App() {
  const account = useAccount();
  // Constructed once on mount; `account` is stable by then (App only renders
  // inside a signed-in AuthGate in cloud mode, pass-through in local dev).
  const backendRef = useRef(makeHutBackend(account?.getToken ?? null));

  const [orthos, setOrthos] = useState<Ortho[]>([]);
  const [activeOrtho, setActiveOrtho] = useState<Ortho | null>(null);
  const [huts, setHuts] = useState<Hut[]>([]);
  const [selectedHutId, setSelectedHutId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Undo/redo stacks, scoped to the active ortho — cleared whenever it
  // changes (see the huts-loading effect below), since entries reference hut
  // ids that only make sense within that ortho's row set.
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY);

  // Keyboard-help modal (`?`), and a reset-view "signal" that OrthoMap watches
  // (`0` shortcut) — a counter rather than a boolean so pressing it twice in a
  // row (already reset) still re-fits the view each time.
  const [helpOpen, setHelpOpen] = useState(false);
  // Web-only admin user-management panel (gated on account.isAdmin in the titlebar).
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  // Disables the Export button for the duration of the /api/export download.
  const [exporting, setExporting] = useState(false);
  // Disables the Mark done/Reopen button for the duration of that PATCH.
  const [markingDone, setMarkingDone] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);
  // Hut-list row-click signal for OrthoMap's fly-to effect. `nonce` (not just
  // hutId) so clicking the ALREADY-selected row still re-fires it — see
  // handleFocusHut below and OrthoMap's focusRequest prop.
  const [focusRequest, setFocusRequest] = useState<{ hutId: string; nonce: number } | null>(
    null,
  );

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
    setHistory(EMPTY_HISTORY);
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

  // Hut-list row click: select the hut (same as clicking its map marker) AND
  // bump the focus nonce so OrthoMap flies/pans to it — every click bumps,
  // even a re-click on the row that's already selected, so "where was it
  // again?" always re-centers instead of being a no-op the second time.
  const handleFocusHut = useCallback((id: string) => {
    setSelectedHutId(id);
    setFocusRequest((prev) => ({ hutId: id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

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

  // Per-ortho hut counts for the sidebar rows. Seeded from the server-reported
  // hut_count on each ortho, then the active ortho's entry is overridden with
  // the live `huts` array length so a just-drawn or undone box shows up
  // immediately instead of waiting on a re-fetch.
  const hutCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of orthos) counts.set(o.id, o.hut_count ?? 0);
    if (activeOrtho) counts.set(activeOrtho.id, huts.length);
    return counts;
  }, [orthos, activeOrtho, huts.length]);

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
  // persist. A temp-id row renders immediately (and is auto-selected, same as
  // the server-backed flow, so the attribute panel opens right away); once
  // createHut resolves the temp row is swapped for the real one, carrying the
  // selection across the id change. On failure the temp row is removed so the
  // map never lies. w/h are null for a point hut, set for a box hut.
  const handlePlace = useCallback(
    async (x: number, y: number, w: number | null, h: number | null) => {
      if (!activeOrtho) return;
      const tempId = `${TEMP_HUT_PREFIX}${crypto.randomUUID()}`;
      const tempHut: Hut = {
        id: tempId,
        ortho_id: activeOrtho.id,
        x,
        y,
        w,
        h,
        labeler_id: null,
        created_at: null,
      };
      setHuts((prev) => [...prev, tempHut]);
      setSelectedHutId(tempId);
      // Pushed at the optimistic moment under the temp id, same as the huts
      // array above; the entryId lets us find-and-fix it below regardless of
      // where it ends up in the stack.
      const entryId = crypto.randomUUID();
      setHistory((h) =>
        recordChange(h, { entryId, type: "create", hutId: tempId, snapshot: tempHut }),
      );
      try {
        const hut = await backendRef.current.createHut(activeOrtho.id, x, y, w, h);
        setHuts((cur) => cur.map((existing) => (existing.id === tempId ? hut : existing)));
        setSelectedHutId((cur) => (cur === tempId ? hut.id : cur));
        // Swap the temp id for the server id in the history entry too, so a
        // later undo targets the real row instead of the vanished temp one.
        setHistory((h) =>
          updateEntry(h, entryId, (e) => ({ ...e, hutId: hut.id, snapshot: hut }) as typeof e),
        );
      } catch (e) {
        setHuts((cur) => cur.filter((existing) => existing.id !== tempId));
        setSelectedHutId((cur) => (cur === tempId ? null : cur));
        setHistory((h) => dropEntry(h, entryId));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activeOrtho],
  );

  // Corner-handle resize of the selected box hut (OrthoMap's onEditBox),
  // optimistic-then-revert like handleDelete below.
  const handleEditBox = useCallback(
    async (id: string, x: number, y: number, w: number, h: number) => {
      // Same temp-id guard as handleDelete below.
      if (isTempHutId(id)) return;
      const target = huts.find((hut) => hut.id === id);
      if (!target || target.w == null || target.h == null) return;
      const before = { x: target.x, y: target.y, w: target.w, h: target.h };
      const prev = huts;
      setHuts((cur) =>
        cur.map((hut) => (hut.id === id ? { ...hut, x, y, w, h } : hut)),
      );
      const entryId = crypto.randomUUID();
      setHistory((hist) =>
        recordChange(hist, { entryId, type: "box", hutId: id, before, after: { x, y, w, h } }),
      );
      try {
        await backendRef.current.updateHutBox(id, x, y, w, h);
      } catch (e) {
        setHuts(prev); // roll back
        setHistory((hist) => dropEntry(hist, entryId));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [huts],
  );

  const handleDelete = useCallback(async () => {
    // Same temp-id guard as handleEditBox above — also avoids racing the
    // in-flight createHut, which would otherwise leave an orphaned server row
    // once the swap in handlePlace finds no temp row left to replace.
    if (!selectedHutId || isTempHutId(selectedHutId)) return;
    const target = huts.find((h) => h.id === selectedHutId);
    if (!target) return;
    const prev = huts;
    const id = selectedHutId;
    setHuts((cur) => cur.filter((h) => h.id !== id));
    setSelectedHutId(null);
    const entryId = crypto.randomUUID();
    setHistory((h) => recordChange(h, { entryId, type: "delete", hutId: id, snapshot: target }));
    try {
      await backendRef.current.deleteHut(id);
    } catch (e) {
      setHuts(prev); // roll back
      setHistory((h) => dropEntry(h, entryId));
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedHutId, huts]);

  // Apply one history entry's inverse (undo: `invertForUndo`, redo:
  // `invertForRedo`) to state + backend, optimistically. `recreate` always
  // yields a new server id (INSERT, not a restore-by-id), so on success we
  // remap every remaining entry in both stacks — and the selection — from
  // the old id to the new one. `settle` moves the entry to the opposite
  // stack; on failure the entry is simply left off both (already popped by
  // `take*`), matching the drop-on-failure convention the three handlers use.
  const handleUndo = useCallback(async () => {
    const popped = takeUndo(history);
    if (!popped) return;
    const { entry, rest } = popped;
    // A create entry carries a temp id until its createHut round-trip
    // resolves (see handlePlace's updateEntry swap below) — same window
    // where handleEditBox/handleDelete refuse to touch the hut. Leave the
    // stack alone rather than popping an entry the in-flight create is still
    // about to claim.
    if (isTempHutId(entry.hutId)) return;
    setHistory(rest);
    const action = invertForUndo(entry);
    if (action.kind === "remove") {
      const prevHuts = huts;
      setHuts((cur) => cur.filter((h) => h.id !== action.hutId));
      setSelectedHutId((cur) => (cur === action.hutId ? null : cur));
      try {
        await backendRef.current.deleteHut(action.hutId);
        setHistory((h) => settleUndo(h, entry));
      } catch (e) {
        setHuts(prevHuts);
        setError(e instanceof Error ? e.message : String(e));
      }
    } else if (action.kind === "recreate") {
      const oldId = action.snapshot.id;
      try {
        const newHut = await backendRef.current.createHut(
          action.snapshot.ortho_id,
          action.snapshot.x,
          action.snapshot.y,
          action.snapshot.w,
          action.snapshot.h,
        );
        setHuts((cur) => [...cur, newHut]);
        setSelectedHutId((cur) => (cur === oldId ? newHut.id : cur));
        const remapped = remapEntry(entry, oldId, newHut.id);
        setHistory((h) => settleUndo(remapHistory(h, oldId, newHut.id), remapped));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } else {
      const prevHuts = huts;
      setHuts((cur) =>
        cur.map((hut) =>
          hut.id === action.hutId ? { ...hut, x: action.x, y: action.y, w: action.w, h: action.h } : hut,
        ),
      );
      try {
        await backendRef.current.updateHutBox(action.hutId, action.x, action.y, action.w, action.h);
        setHistory((h) => settleUndo(h, entry));
      } catch (e) {
        setHuts(prevHuts);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [history, huts]);

  const handleRedo = useCallback(async () => {
    const popped = takeRedo(history);
    if (!popped) return;
    const { entry, rest } = popped;
    // Same in-flight-create guard as handleUndo above.
    if (isTempHutId(entry.hutId)) return;
    setHistory(rest);
    const action = invertForRedo(entry);
    if (action.kind === "remove") {
      const prevHuts = huts;
      setHuts((cur) => cur.filter((h) => h.id !== action.hutId));
      setSelectedHutId((cur) => (cur === action.hutId ? null : cur));
      try {
        await backendRef.current.deleteHut(action.hutId);
        setHistory((h) => settleRedo(h, entry));
      } catch (e) {
        setHuts(prevHuts);
        setError(e instanceof Error ? e.message : String(e));
      }
    } else if (action.kind === "recreate") {
      const oldId = action.snapshot.id;
      try {
        const newHut = await backendRef.current.createHut(
          action.snapshot.ortho_id,
          action.snapshot.x,
          action.snapshot.y,
          action.snapshot.w,
          action.snapshot.h,
        );
        setHuts((cur) => [...cur, newHut]);
        setSelectedHutId((cur) => (cur === oldId ? newHut.id : cur));
        const remapped = remapEntry(entry, oldId, newHut.id);
        setHistory((h) => settleRedo(remapHistory(h, oldId, newHut.id), remapped));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } else {
      const prevHuts = huts;
      setHuts((cur) =>
        cur.map((hut) =>
          hut.id === action.hutId ? { ...hut, x: action.x, y: action.y, w: action.w, h: action.h } : hut,
        ),
      );
      try {
        await backendRef.current.updateHutBox(action.hutId, action.x, action.y, action.w, action.h);
        setHistory((h) => settleRedo(h, entry));
      } catch (e) {
        setHuts(prevHuts);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [history, huts]);

  // Downloads every label in the database as one JSON file, admin-only (the
  // Export button only renders for account.isAdmin — see the titlebar below).
  // Same bearer-token pattern as ApiHutBackend.call, but the response is a
  // file to save, not JSON to parse, so it can't reuse that helper directly.
  const handleExport = useCallback(async () => {
    if (!account) return;
    setExporting(true);
    try {
      const token = await account.getToken();
      if (!token) throw new Error("Not signed in.");
      const res = await fetch("/api/export", {
        headers: { Authorization: `Bearer ${token}` },
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
      const disposition = res.headers.get("Content-Disposition");
      const filename =
        disposition?.match(/filename="([^"]+)"/)?.[1] ??
        `hutlabel-export-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [account]);

  // Toggle the active ortho's done_at, admin-only (the button only renders
  // for account.isAdmin — see the titlebar below). Updates `orthos` (the
  // sidebar's source) and `activeOrtho` together from the one server
  // response, so both reflect the change immediately without a refetch.
  const handleToggleDone = useCallback(async () => {
    if (!activeOrtho) return;
    const nextDone = activeOrtho.done_at == null;
    setMarkingDone(true);
    try {
      const { done_at } = await backendRef.current.setOrthoDone(
        activeOrtho.id,
        nextDone,
      );
      setOrthos((cur) =>
        cur.map((o) => (o.id === activeOrtho.id ? { ...o, done_at } : o)),
      );
      setActiveOrtho((cur) => (cur ? { ...cur, done_at } : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarkingDone(false);
    }
  }, [activeOrtho]);

  // Global shortcuts: mode switches, per-hut attribute keys, ortho nav, reset
  // view, and the help modal. Space (hold-to-pan), Z (magnifier toggle) and
  // [ / ] (magnifier zoom) are bound inside OrthoMap instead — coordinate,
  // don't rebind. Depends on the state/handlers it reads, so it always closes
  // over the latest values; the listener itself is cheap to re-bind.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;
      if (adminPanelOpen) return; // the panel owns the keyboard (incl. its own Esc)

      // Undo/redo: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, and Ctrl+Y (the common
      // Windows/Linux redo binding). Checked ahead of the generic
      // Cmd/Ctrl-passthrough below so this one combo is intercepted instead
      // of falling through to the browser's own undo.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (e.metaKey || e.ctrlKey) return; // let other Cmd/Ctrl shortcuts pass through

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
    adminPanelOpen,
    selectedHutId,
    activeOrtho,
    orthos,
    handleDelete,
    handleUndo,
    handleRedo,
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
            className="key-btn"
            onClick={handleUndo}
            disabled={history.undoStack.length === 0}
            title="Undo (⌘Z)"
            aria-label="Undo"
          >
            <kbd className="key-cap">⌘Z</kbd>
            <span>Undo</span>
          </button>
          <button
            type="button"
            className="key-btn"
            onClick={handleRedo}
            disabled={history.redoStack.length === 0}
            title="Redo (⌘⇧Z)"
            aria-label="Redo"
          >
            <kbd className="key-cap">⌘⇧Z</kbd>
            <span>Redo</span>
          </button>
          <span className="title-divider" aria-hidden="true" />
          <button
            type="button"
            className="key-btn"
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <kbd className="key-cap">?</kbd>
            <span>Help</span>
          </button>
          {account && (
            <>
              <span className="title-divider" aria-hidden="true" />
              <span className="title-account">
                <span className="title-account-email" title={account.email}>
                  {account.email}
                </span>
                {account.isAdmin && (
                  <>
                    <button
                      type="button"
                      className="key-btn"
                      onClick={handleExport}
                      disabled={exporting}
                      title="Export all labels as JSON"
                    >
                      <span>{exporting ? "Exporting…" : "Export"}</span>
                    </button>
                    <button
                      type="button"
                      className="key-btn"
                      onClick={() => setAdminPanelOpen(true)}
                      title="Manage users"
                    >
                      <span>Admin</span>
                    </button>
                    {activeOrtho && (
                      <button
                        type="button"
                        className="key-btn"
                        onClick={handleToggleDone}
                        disabled={markingDone}
                        title={
                          activeOrtho.done_at == null
                            ? "Mark this ortho done"
                            : "Reopen this ortho"
                        }
                      >
                        <span>
                          {activeOrtho.done_at == null ? "Mark done" : "Reopen"}
                        </span>
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="key-btn"
                  onClick={account.signOut}
                  title="Sign out of HutLabel"
                >
                  <span>Sign out</span>
                </button>
              </span>
            </>
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
                </button>
                {!collapsed && (
                  <div className="folder-children">
                    {siteOrthos.map((o) => {
                      const isActive = activeOrtho?.id === o.id;
                      const hutCount = hutCounts.get(o.id) ?? 0;
                      const hutLabel = `${hutCount} hut${hutCount === 1 ? "" : "s"}`;
                      const statusLabel = doneStatusLabel(o.done_at, hutCount);
                      const isDone = o.done_at != null;
                      return (
                        <button
                          type="button"
                          key={o.id}
                          className={"image-item" + (isActive ? " active" : "")}
                          onClick={() => setActiveOrtho(o)}
                          aria-current={isActive ? "true" : undefined}
                          title={`${o.site} · Visit ${o.visit} — ${hutLabel} · ${statusLabel}`}
                        >
                          <VisitIcon className="img-icon" />
                          <span className="image-item-name">Visit {o.visit}</span>
                          {isDone && (
                            <CheckIcon className="image-item-done" />
                          )}
                          <span
                            className={
                              "image-item-count mono" + (hutCount === 0 ? " zero" : "")
                            }
                            aria-label={`${hutLabel} · ${statusLabel}`}
                          >
                            {hutCount}
                          </span>
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
          <OrthoMap
            key={activeOrtho.id}
            ortho={activeOrtho}
            huts={huts}
            selectedHutId={selectedHutId}
            onPlace={handlePlace}
            onSelectHut={setSelectedHutId}
            onEditBox={handleEditBox}
            magnifierSlotEl={zoomSlotEl}
            resetSignal={resetNonce}
            focusRequest={focusRequest}
          />
        ) : (
          <div className="stage-empty">
            {error ? "Could not load orthos." : "No ortho selected."}
          </div>
        )}
      </main>

      <AttributePanel
        hut={selectedHut}
        huts={huts}
        selectedHutId={selectedHutId}
        onDelete={handleDelete}
        onFocusHut={handleFocusHut}
        zoomSlot={<div className="zoom-slot" ref={setZoomSlotEl} />}
      />

      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
      {adminPanelOpen && account && (
        <AdminPanel account={account} onClose={() => setAdminPanelOpen(false)} />
      )}
    </div>
  );
}

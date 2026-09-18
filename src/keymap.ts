// Which app-level action a keystroke means. Pure (no React, no DOM), so the
// one property the candidate-review feature must not get wrong is provable by
// a test instead of by reading App.tsx: in review mode NO key resolves to a
// hut mutation. Existing labels are never changed or removed by a reviewer.
//
// Scope is App's own handler. Space (hold-to-pan), Z (magnifier) and, outside
// review mode, [ / ] (magnifier zoom) are bound inside OrthoMap and never
// reach this — coordinate, don't rebind.

import type { Verdict } from "./candidates/model";
import { verdictForKey } from "./candidates/model";

export type KeyAction =
  // Nothing to do. Paired with preventDefault: true it means "swallowed on
  // purpose" (e.g. ⌘Z during review), with false it means "not ours".
  | { kind: "none" }
  | { kind: "undo" }
  | { kind: "redo" }
  // Esc: close the help modal if open, else deselect whatever this mode has
  // selected. App owns that precedence; the key only means "escape".
  | { kind: "escape" }
  | { kind: "openHelp" }
  | { kind: "toggleConfidence" }
  | { kind: "deleteHut" }
  | { kind: "stepOrtho"; delta: -1 | 1 }
  | { kind: "resetView" }
  | { kind: "verdict"; pressed: Verdict | "clear" }
  | { kind: "stepCandidate"; delta: -1 | 1 }
  // Show/hide the ortho's existing labels while reviewing. A view switch and
  // nothing more: it reads no hut and writes none.
  | { kind: "toggleLabels" }
  // Put the candidates that sit on an existing label back into the queue (and
  // take them out again). Also a view switch: it changes which candidates the
  // reviewer is walked through, and writes nothing anywhere.
  | { kind: "toggleHidden" };

export type KeyResolution = { action: KeyAction; preventDefault: boolean };

// Every action that writes to the `huts` table, directly or by replaying an
// earlier write. None of these may ever be produced in review mode — see
// src/keymap.test.ts, which asserts it over the whole keyboard.
export const HUT_MUTATING_ACTIONS: readonly KeyAction["kind"][] = [
  "toggleConfidence",
  "deleteHut",
  "undo",
  "redo",
];

export type KeyMode = "label" | "review";

// `hutSelected` only affects whether C / Delete are swallowed: with no hut
// selected they were never the app's keys to take.
export type KeyContext = { mode: KeyMode; hutSelected: boolean };

const NOT_OURS: KeyResolution = { action: { kind: "none" }, preventDefault: false };
const SWALLOWED: KeyResolution = { action: { kind: "none" }, preventDefault: true };

export function resolveKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ctx: KeyContext,
): KeyResolution {
  const review = ctx.mode === "review";

  // Undo/redo: ⌘/Ctrl+Z, ⌘/Ctrl+⇧Z, and Ctrl+Y (the common Windows/Linux redo
  // binding). Checked ahead of the generic ⌘/Ctrl pass-through below so these
  // combos are intercepted rather than falling through to the browser's own
  // undo. In review mode they are swallowed and dropped: hut editing is off,
  // so an undo could only replay a change from before the review began.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    if (review) return SWALLOWED;
    return { action: { kind: e.shiftKey ? "redo" : "undo" }, preventDefault: true };
  }
  if (e.ctrlKey && e.key.toLowerCase() === "y") {
    if (review) return SWALLOWED;
    return { action: { kind: "redo" }, preventDefault: true };
  }
  if (e.metaKey || e.ctrlKey) return NOT_OURS; // let other ⌘/Ctrl shortcuts pass

  if (e.key === "Escape") return { action: { kind: "escape" }, preventDefault: false };
  if (e.key === "?" || (e.shiftKey && e.key === "/")) {
    return { action: { kind: "openHelp" }, preventDefault: true };
  }

  // Review mode claims the verdict and queue-walking keys, and deliberately
  // falls through for the rest, so ortho nav, reset-view and the help modal
  // keep working exactly as they do while labeling.
  if (review) {
    const pressed = verdictForKey(e.key);
    if (pressed) return { action: { kind: "verdict", pressed }, preventDefault: true };
    if (e.key === "j" || e.key === "J" || e.key === "]") {
      return { action: { kind: "stepCandidate", delta: 1 }, preventDefault: true };
    }
    if (e.key === "k" || e.key === "K" || e.key === "[") {
      return { action: { kind: "stepCandidate", delta: -1 }, preventDefault: true };
    }
    // L shows/hides the existing labels. Review mode only — while labeling, the
    // labels are the work, so there is nothing to hide and L stays free.
    if (e.key === "l" || e.key === "L") {
      return { action: { kind: "toggleLabels" }, preventDefault: true };
    }
    // H reveals the candidates hidden as already labelled, and hides them
    // again. Free in both modes and in OrthoMap's own bindings; claimed for
    // review mode only, next to L, because that is the only mode with a queue
    // to filter. ⌘/Ctrl+H (the browser's history) never reaches here — the
    // modifier pass-through above returns first.
    if (e.key === "h" || e.key === "H") {
      return { action: { kind: "toggleHidden" }, preventDefault: true };
    }
  } else {
    if (e.key === "c" || e.key === "C") {
      return ctx.hutSelected
        ? { action: { kind: "toggleConfidence" }, preventDefault: true }
        : NOT_OURS;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      return ctx.hutSelected
        ? { action: { kind: "deleteHut" }, preventDefault: true }
        : NOT_OURS;
    }
  }

  // Ortho nav carries preventDefault: false because whether the step is even
  // possible depends on the ortho list, which this module has no business
  // knowing — App calls preventDefault once it has checked the bounds.
  if (e.key === "ArrowLeft") {
    return { action: { kind: "stepOrtho", delta: -1 }, preventDefault: false };
  }
  if (e.key === "ArrowRight") {
    return { action: { kind: "stepOrtho", delta: 1 }, preventDefault: false };
  }
  if (e.key === "0") return { action: { kind: "resetView" }, preventDefault: false };

  return NOT_OURS;
}

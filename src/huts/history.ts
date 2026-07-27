// Pure undo/redo logic for labeling operations (create/delete/box-edit). No
// React, no I/O — App.tsx owns the state and the backend calls; this module
// only decides what an undo/redo *means* and how the two stacks are threaded
// through an id remap. Kept separate so the invert/remap rules are
// unit-testable without a component harness (the repo has none).
//
// Id remap matters because re-creating a hut (undoing a delete, or redoing a
// create) always inserts a fresh server row — the new id never matches the
// old one. `remapHistory` rewrites every remaining entry in both stacks (plus
// the moving entry itself) so later undo/redo steps keep targeting the right
// row. Callers are responsible for remapping `selectedHutId` too.

import type { Hut } from "./model";

type EntryBase = { entryId: string; hutId: string };

export type CreateEntry = EntryBase & { type: "create"; snapshot: Hut };
export type DeleteEntry = EntryBase & { type: "delete"; snapshot: Hut };
export type BoxEntry = EntryBase & {
  type: "box";
  before: { x: number; y: number; w: number; h: number };
  after: { x: number; y: number; w: number; h: number };
};

export type HistoryEntry = CreateEntry | DeleteEntry | BoxEntry;

export type HistoryState = {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
};

export const EMPTY_HISTORY: HistoryState = { undoStack: [], redoStack: [] };

// Cap so a marathon labeling session doesn't grow the stack unboundedly.
// Well past anything a real undo chain would reach for.
const MAX_HISTORY = 200;

// What applying an entry (in either direction) actually does to the world.
// App.tsx pattern-matches on `kind` to pick the optimistic state update and
// the backend call.
export type UndoRedoAction =
  | { kind: "recreate"; snapshot: Hut }
  | { kind: "remove"; hutId: string }
  | { kind: "setBox"; hutId: string; x: number; y: number; w: number; h: number };

export function invertForUndo(entry: HistoryEntry): UndoRedoAction {
  switch (entry.type) {
    case "create":
      return { kind: "remove", hutId: entry.hutId };
    case "delete":
      return { kind: "recreate", snapshot: entry.snapshot };
    case "box":
      return { kind: "setBox", hutId: entry.hutId, ...entry.before };
  }
}

export function invertForRedo(entry: HistoryEntry): UndoRedoAction {
  switch (entry.type) {
    case "create":
      return { kind: "recreate", snapshot: entry.snapshot };
    case "delete":
      return { kind: "remove", hutId: entry.hutId };
    case "box":
      return { kind: "setBox", hutId: entry.hutId, ...entry.after };
  }
}

// Record a user-initiated change: push onto the undo stack, clear the redo
// stack (the standard "new action invalidates the redo branch" rule).
export function recordChange(history: HistoryState, entry: HistoryEntry): HistoryState {
  const undoStack = [...history.undoStack, entry];
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  return { undoStack, redoStack: [] };
}

// Drop an entry (by id) from wherever it lives — used when an optimistic
// change that was already pushed turns out to fail its backend call, so the
// stacks never carry an entry for a change that didn't actually happen.
export function dropEntry(history: HistoryState, entryId: string): HistoryState {
  return {
    undoStack: history.undoStack.filter((e) => e.entryId !== entryId),
    redoStack: history.redoStack.filter((e) => e.entryId !== entryId),
  };
}

// Rewrite an already-pushed entry in place (by id) — used for the create
// flow's temp-id -> server-id swap, mirroring the same swap App.tsx does to
// the `huts` array.
export function updateEntry(
  history: HistoryState,
  entryId: string,
  fn: (entry: HistoryEntry) => HistoryEntry,
): HistoryState {
  const apply = (entries: HistoryEntry[]) =>
    entries.map((e) => (e.entryId === entryId ? fn(e) : e));
  return { undoStack: apply(history.undoStack), redoStack: apply(history.redoStack) };
}

// Pop the top of the undo stack. Returns the entry plus the history with it
// already removed — the caller pushes it onto the redo stack itself, once
// its (possibly async) apply succeeds, via `settleUndo`.
export function takeUndo(
  history: HistoryState,
): { entry: HistoryEntry; rest: HistoryState } | undefined {
  const { undoStack, redoStack } = history;
  if (undoStack.length === 0) return undefined;
  const entry = undoStack[undoStack.length - 1];
  return { entry, rest: { undoStack: undoStack.slice(0, -1), redoStack } };
}

export function takeRedo(
  history: HistoryState,
): { entry: HistoryEntry; rest: HistoryState } | undefined {
  const { undoStack, redoStack } = history;
  if (redoStack.length === 0) return undefined;
  const entry = redoStack[redoStack.length - 1];
  return { entry, rest: { undoStack, redoStack: redoStack.slice(0, -1) } };
}

// After an undo's apply succeeds, the entry (possibly remapped, see below)
// moves onto the redo stack so it can be replayed forward.
export function settleUndo(history: HistoryState, entry: HistoryEntry): HistoryState {
  return { undoStack: history.undoStack, redoStack: [...history.redoStack, entry] };
}

// After a redo's apply succeeds, the entry moves back onto the undo stack.
export function settleRedo(history: HistoryState, entry: HistoryEntry): HistoryState {
  return { undoStack: [...history.undoStack, entry], redoStack: history.redoStack };
}

// Rewrite a single entry's hut reference(s) after a recreate produced a new
// server id. Only create/delete entries carry a `snapshot`, whose own `id`
// needs the same rewrite as `hutId`.
export function remapEntry(entry: HistoryEntry, oldId: string, newId: string): HistoryEntry {
  const hutId = entry.hutId === oldId ? newId : entry.hutId;
  switch (entry.type) {
    case "create":
    case "delete": {
      const snapshot =
        entry.snapshot.id === oldId ? { ...entry.snapshot, id: newId } : entry.snapshot;
      return { ...entry, hutId, snapshot };
    }
    case "box":
      return { ...entry, hutId };
  }
}

// Rewrite every entry in both stacks — used after a recreate so every other
// undo/redo step still targets the row under its new id.
export function remapHistory(history: HistoryState, oldId: string, newId: string): HistoryState {
  const apply = (entries: HistoryEntry[]) => entries.map((e) => remapEntry(e, oldId, newId));
  return { undoStack: apply(history.undoStack), redoStack: apply(history.redoStack) };
}

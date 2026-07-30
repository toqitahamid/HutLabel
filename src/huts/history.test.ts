import { describe, expect, it } from "vitest";
import type { Hut } from "./model";
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
  type BoxEntry,
  type ConfidenceEntry,
  type CreateEntry,
  type DeleteEntry,
} from "./history";

function makeHut(overrides: Partial<Hut> = {}): Hut {
  return {
    id: "hut-1",
    ortho_id: "ortho-1",
    x: 10,
    y: 20,
    w: 30,
    h: 40,
    confidence: "certain",
    labeler_id: "dev",
    created_at: null,
    ...overrides,
  };
}

describe("recordChange", () => {
  it("pushes onto the undo stack and clears the redo stack", () => {
    const entry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "hut-1",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const withRedo = { undoStack: [], redoStack: [entry] };
    const next = recordChange(withRedo, entry);
    expect(next.undoStack).toEqual([entry]);
    expect(next.redoStack).toEqual([]);
  });

  it("caps the undo stack so it doesn't grow unboundedly", () => {
    let history = EMPTY_HISTORY;
    for (let i = 0; i < 210; i++) {
      const entry: BoxEntry = {
        entryId: `e${i}`,
        type: "box",
        hutId: "hut-1",
        before: { x: 1, y: 2, w: 3, h: 4 },
        after: { x: 5, y: 6, w: 7, h: 8 },
      };
      history = recordChange(history, entry);
    }
    expect(history.undoStack.length).toBeLessThanOrEqual(200);
    // the oldest entries should have been dropped, newest kept
    expect(history.undoStack[history.undoStack.length - 1].entryId).toBe("e209");
  });
});

describe("dropEntry / updateEntry", () => {
  it("removes an entry by id from whichever stack it's in", () => {
    const entry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "hut-1",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const history = { undoStack: [entry], redoStack: [] };
    expect(dropEntry(history, "e1")).toEqual(EMPTY_HISTORY);
    expect(dropEntry(history, "missing")).toEqual(history);
  });

  it("rewrites an entry in place by id, leaving others untouched", () => {
    const a: BoxEntry = {
      entryId: "a",
      type: "box",
      hutId: "hut-1",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const b: BoxEntry = { ...a, entryId: "b" };
    const history = { undoStack: [a, b], redoStack: [] };
    const next = updateEntry(history, "a", (e) => ({ ...e, hutId: "hut-2" }));
    expect(next.undoStack[0].hutId).toBe("hut-2");
    expect(next.undoStack[1]).toBe(b);
  });
});

describe("takeUndo / takeRedo", () => {
  it("pops the most recent entry and returns the rest", () => {
    const first: BoxEntry = {
      entryId: "first",
      type: "box",
      hutId: "hut-1",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const second: BoxEntry = { ...first, entryId: "second" };
    const history = { undoStack: [first, second], redoStack: [] };
    const popped = takeUndo(history);
    expect(popped?.entry.entryId).toBe("second");
    expect(popped?.rest.undoStack).toEqual([first]);
  });

  it("returns undefined on an empty stack", () => {
    expect(takeUndo(EMPTY_HISTORY)).toBeUndefined();
    expect(takeRedo(EMPTY_HISTORY)).toBeUndefined();
  });

  it("settleUndo/settleRedo move an entry to the opposite stack", () => {
    const entry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "hut-1",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const afterUndo = settleUndo(EMPTY_HISTORY, entry);
    expect(afterUndo.redoStack).toEqual([entry]);
    expect(afterUndo.undoStack).toEqual([]);

    const afterRedo = settleRedo(EMPTY_HISTORY, entry);
    expect(afterRedo.undoStack).toEqual([entry]);
    expect(afterRedo.redoStack).toEqual([]);
  });
});

describe("invertForUndo / invertForRedo", () => {
  it("create: undo removes, redo recreates", () => {
    const snapshot = makeHut();
    const entry: CreateEntry = { entryId: "e1", type: "create", hutId: "hut-1", snapshot };
    expect(invertForUndo(entry)).toEqual({ kind: "remove", hutId: "hut-1" });
    expect(invertForRedo(entry)).toEqual({ kind: "recreate", snapshot });
  });

  it("delete: undo recreates, redo removes", () => {
    const snapshot = makeHut();
    const entry: DeleteEntry = { entryId: "e1", type: "delete", hutId: "hut-1", snapshot };
    expect(invertForUndo(entry)).toEqual({ kind: "recreate", snapshot });
    expect(invertForRedo(entry)).toEqual({ kind: "remove", hutId: "hut-1" });
  });

  it("delete: the recreate snapshot preserves a non-default confidence", () => {
    // A DeleteEntry snapshots the full Hut (not just geometry), so an "unsure"
    // hut's flag rides along in the "recreate" action — App.tsx's handleUndo
    // passes snapshot.confidence into createHut so undoing the delete
    // restores it instead of falling back to the server's "certain" default.
    const snapshot = makeHut({ confidence: "unsure" });
    const entry: DeleteEntry = { entryId: "e1", type: "delete", hutId: "hut-1", snapshot };
    const action = invertForUndo(entry);
    expect(action).toEqual({ kind: "recreate", snapshot });
    expect(action.kind === "recreate" && action.snapshot.confidence).toBe("unsure");
  });

  it("box: undo applies before, redo applies after", () => {
    const entry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "hut-1",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    expect(invertForUndo(entry)).toEqual({ kind: "setBox", hutId: "hut-1", x: 1, y: 2, w: 3, h: 4 });
    expect(invertForRedo(entry)).toEqual({ kind: "setBox", hutId: "hut-1", x: 5, y: 6, w: 7, h: 8 });
  });

  it("confidence: undo applies from, redo applies to", () => {
    const entry: ConfidenceEntry = {
      entryId: "e1",
      type: "confidence",
      hutId: "hut-1",
      from: "certain",
      to: "unsure",
    };
    expect(invertForUndo(entry)).toEqual({
      kind: "setConfidence",
      hutId: "hut-1",
      confidence: "certain",
    });
    expect(invertForRedo(entry)).toEqual({
      kind: "setConfidence",
      hutId: "hut-1",
      confidence: "unsure",
    });
  });
});

describe("remapEntry / remapHistory", () => {
  it("rewrites hutId on box entries", () => {
    const entry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "old-id",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const remapped = remapEntry(entry, "old-id", "new-id");
    expect(remapped.hutId).toBe("new-id");
    expect(remapped).not.toBe(entry); // unchanged entries are untouched, but a rewrite is a new object
  });

  it("rewrites hutId on confidence entries", () => {
    const entry: ConfidenceEntry = {
      entryId: "e1",
      type: "confidence",
      hutId: "old-id",
      from: "certain",
      to: "unsure",
    };
    const remapped = remapEntry(entry, "old-id", "new-id");
    expect(remapped.hutId).toBe("new-id");
    expect(remapped).not.toBe(entry);
  });

  it("leaves entries referencing a different hut untouched", () => {
    const entry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "other-id",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    expect(remapEntry(entry, "old-id", "new-id")).toEqual(entry);
  });

  it("rewrites both hutId and the embedded snapshot.id on create/delete entries", () => {
    const snapshot = makeHut({ id: "old-id" });
    const entry: DeleteEntry = { entryId: "e1", type: "delete", hutId: "old-id", snapshot };
    const remapped = remapEntry(entry, "old-id", "new-id") as DeleteEntry;
    expect(remapped.hutId).toBe("new-id");
    expect(remapped.snapshot.id).toBe("new-id");
    // rest of the snapshot is preserved
    expect(remapped.snapshot.x).toBe(snapshot.x);
  });

  it("remapHistory rewrites every matching entry across both stacks, mixed kinds included", () => {
    const boxEntry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "old-id",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const confidenceEntry: ConfidenceEntry = {
      entryId: "e2",
      type: "confidence",
      hutId: "old-id",
      from: "certain",
      to: "unsure",
    };
    const untouched: ConfidenceEntry = { ...confidenceEntry, entryId: "e3", hutId: "unrelated-id" };
    const history = { undoStack: [boxEntry, untouched], redoStack: [confidenceEntry] };
    const next = remapHistory(history, "old-id", "new-id");
    expect(next.undoStack[0].hutId).toBe("new-id");
    expect(next.undoStack[1].hutId).toBe("unrelated-id");
    expect(next.redoStack[0].hutId).toBe("new-id");
  });
});

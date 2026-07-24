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
  type AttrsEntry,
  type BoxEntry,
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
    structure_type: "dwelling_hut",
    confidence: "certain",
    labeler_id: "dev",
    created_at: null,
    ...overrides,
  };
}

describe("recordChange", () => {
  it("pushes onto the undo stack and clears the redo stack", () => {
    const entry: AttrsEntry = {
      entryId: "e1",
      type: "attrs",
      hutId: "hut-1",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "certain" },
    };
    const withRedo = { undoStack: [], redoStack: [entry] };
    const next = recordChange(withRedo, entry);
    expect(next.undoStack).toEqual([entry]);
    expect(next.redoStack).toEqual([]);
  });

  it("caps the undo stack so it doesn't grow unboundedly", () => {
    let history = EMPTY_HISTORY;
    for (let i = 0; i < 210; i++) {
      const entry: AttrsEntry = {
        entryId: `e${i}`,
        type: "attrs",
        hutId: "hut-1",
        before: { structure_type: "dwelling_hut", confidence: "certain" },
        after: { structure_type: "feeding_platform", confidence: "certain" },
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
    const entry: AttrsEntry = {
      entryId: "e1",
      type: "attrs",
      hutId: "hut-1",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "certain" },
    };
    const history = { undoStack: [entry], redoStack: [] };
    expect(dropEntry(history, "e1")).toEqual(EMPTY_HISTORY);
    expect(dropEntry(history, "missing")).toEqual(history);
  });

  it("rewrites an entry in place by id, leaving others untouched", () => {
    const a: AttrsEntry = {
      entryId: "a",
      type: "attrs",
      hutId: "hut-1",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "certain" },
    };
    const b: AttrsEntry = { ...a, entryId: "b" };
    const history = { undoStack: [a, b], redoStack: [] };
    const next = updateEntry(history, "a", (e) => ({ ...e, hutId: "hut-2" }));
    expect(next.undoStack[0].hutId).toBe("hut-2");
    expect(next.undoStack[1]).toBe(b);
  });
});

describe("takeUndo / takeRedo", () => {
  it("pops the most recent entry and returns the rest", () => {
    const first: AttrsEntry = {
      entryId: "first",
      type: "attrs",
      hutId: "hut-1",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "certain" },
    };
    const second: AttrsEntry = { ...first, entryId: "second" };
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
    const entry: AttrsEntry = {
      entryId: "e1",
      type: "attrs",
      hutId: "hut-1",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "certain" },
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

  it("attrs: undo applies before, redo applies after", () => {
    const entry: AttrsEntry = {
      entryId: "e1",
      type: "attrs",
      hutId: "hut-1",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "maybe" },
    };
    expect(invertForUndo(entry)).toEqual({
      kind: "setAttrs",
      hutId: "hut-1",
      attrs: { structure_type: "dwelling_hut", confidence: "certain" },
    });
    expect(invertForRedo(entry)).toEqual({
      kind: "setAttrs",
      hutId: "hut-1",
      attrs: { structure_type: "feeding_platform", confidence: "maybe" },
    });
  });
});

describe("remapEntry / remapHistory", () => {
  it("rewrites hutId on box/attrs entries", () => {
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

  it("remapHistory rewrites every matching entry across both stacks", () => {
    const boxEntry: BoxEntry = {
      entryId: "e1",
      type: "box",
      hutId: "old-id",
      before: { x: 1, y: 2, w: 3, h: 4 },
      after: { x: 5, y: 6, w: 7, h: 8 },
    };
    const attrsEntry: AttrsEntry = {
      entryId: "e2",
      type: "attrs",
      hutId: "old-id",
      before: { structure_type: "dwelling_hut", confidence: "certain" },
      after: { structure_type: "feeding_platform", confidence: "certain" },
    };
    const untouched: AttrsEntry = { ...attrsEntry, entryId: "e3", hutId: "unrelated-id" };
    const history = { undoStack: [boxEntry, untouched], redoStack: [attrsEntry] };
    const next = remapHistory(history, "old-id", "new-id");
    expect(next.undoStack[0].hutId).toBe("new-id");
    expect(next.undoStack[1].hutId).toBe("unrelated-id");
    expect(next.redoStack[0].hutId).toBe("new-id");
  });
});

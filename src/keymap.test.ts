import { describe, expect, it } from "vitest";
import { HUT_MUTATING_ACTIONS, resolveKey, type KeyContext } from "./keymap";

// The point of this file is the first block: proving over the WHOLE keyboard
// that review mode cannot resolve to a hut mutation. Existing labels are never
// changed or removed by a reviewer, and that guarantee should not depend on
// anyone re-reading App.tsx's switch.

function press(key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, ...mods };
}

const REVIEW: KeyContext = { mode: "review", hutSelected: false };
// The nastier variant: a hut selection left over from before the review began.
const REVIEW_WITH_HUT: KeyContext = { mode: "review", hutSelected: true };
const LABEL: KeyContext = { mode: "label", hutSelected: true };

// Every printable key we bind or might plausibly collide with, plus the named
// keys, plus the modifier combinations App's handler inspects.
const KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ..."0123456789".split(""),
  "[", "]", "/", "?", "-", "=", ".", ",", "`", "'", ";", "\\",
  "Escape", "Enter", "Tab", " ", "Backspace", "Delete",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", "F1", "F5",
];
const MODS = [
  {},
  { shiftKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { ctrlKey: true, shiftKey: true },
  { metaKey: true, shiftKey: true },
];

describe("review mode never resolves to a hut mutation", () => {
  it("produces no hut-mutating action for any key or modifier combination", () => {
    const offenders: string[] = [];
    for (const ctx of [REVIEW, REVIEW_WITH_HUT]) {
      for (const key of KEYS) {
        for (const mods of MODS) {
          const { action } = resolveKey(press(key, mods), ctx);
          if ((HUT_MUTATING_ACTIONS as readonly string[]).includes(action.kind)) {
            offenders.push(`${JSON.stringify(mods)}+${key} -> ${action.kind}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("swallows undo/redo rather than letting them through to the browser", () => {
    for (const e of [
      press("z", { metaKey: true }),
      press("z", { ctrlKey: true }),
      press("z", { metaKey: true, shiftKey: true }),
      press("y", { ctrlKey: true }),
    ]) {
      const res = resolveKey(e, REVIEW);
      expect(res.action).toEqual({ kind: "none" });
      expect(res.preventDefault).toBe(true);
    }
  });

  it("never deletes a hut with Backspace, even with a stale hut selection", () => {
    expect(resolveKey(press("Backspace"), REVIEW_WITH_HUT).action).toEqual({
      kind: "verdict",
      pressed: "clear",
    });
    // Delete has no review-mode meaning at all, and must not fall through to
    // the hut handler below it.
    expect(resolveKey(press("Delete"), REVIEW_WITH_HUT).action).toEqual({ kind: "none" });
  });

  it("does not toggle confidence on C, even with a stale hut selection", () => {
    expect(resolveKey(press("c"), REVIEW_WITH_HUT).action).toEqual({ kind: "none" });
    expect(resolveKey(press("C"), REVIEW_WITH_HUT).action).toEqual({ kind: "none" });
  });
});

describe("review-mode bindings", () => {
  it("maps the verdict keys in both cases", () => {
    expect(resolveKey(press("y"), REVIEW).action).toEqual({ kind: "verdict", pressed: "hut" });
    expect(resolveKey(press("Y"), REVIEW).action).toEqual({ kind: "verdict", pressed: "hut" });
    expect(resolveKey(press("n"), REVIEW).action).toEqual({ kind: "verdict", pressed: "not_hut" });
    expect(resolveKey(press("u"), REVIEW).action).toEqual({ kind: "verdict", pressed: "unsure" });
    expect(resolveKey(press("Backspace"), REVIEW).action).toEqual({
      kind: "verdict",
      pressed: "clear",
    });
  });

  it("steps the queue with J/K and ]/[", () => {
    for (const key of ["j", "J", "]"]) {
      expect(resolveKey(press(key), REVIEW).action).toEqual({ kind: "stepCandidate", delta: 1 });
    }
    for (const key of ["k", "K", "["]) {
      expect(resolveKey(press(key), REVIEW).action).toEqual({ kind: "stepCandidate", delta: -1 });
    }
  });

  it("leaves ortho nav, reset view, Esc and help working", () => {
    expect(resolveKey(press("ArrowLeft"), REVIEW).action).toEqual({ kind: "stepOrtho", delta: -1 });
    expect(resolveKey(press("ArrowRight"), REVIEW).action).toEqual({ kind: "stepOrtho", delta: 1 });
    expect(resolveKey(press("0"), REVIEW).action).toEqual({ kind: "resetView" });
    expect(resolveKey(press("Escape"), REVIEW).action).toEqual({ kind: "escape" });
    expect(resolveKey(press("?"), REVIEW).action).toEqual({ kind: "openHelp" });
  });

  it("does not claim the magnifier's Z", () => {
    // OrthoMap binds Z itself; App must leave it alone in both modes.
    expect(resolveKey(press("z"), REVIEW).action).toEqual({ kind: "none" });
    expect(resolveKey(press("z"), REVIEW).preventDefault).toBe(false);
    expect(resolveKey(press("z"), LABEL).action).toEqual({ kind: "none" });
  });
});

describe("labeling mode is unchanged", () => {
  it("still maps undo, redo and the hut keys", () => {
    expect(resolveKey(press("z", { metaKey: true }), LABEL).action).toEqual({ kind: "undo" });
    expect(resolveKey(press("z", { ctrlKey: true }), LABEL).action).toEqual({ kind: "undo" });
    expect(resolveKey(press("z", { metaKey: true, shiftKey: true }), LABEL).action).toEqual({
      kind: "redo",
    });
    expect(resolveKey(press("y", { ctrlKey: true }), LABEL).action).toEqual({ kind: "redo" });
    expect(resolveKey(press("c"), LABEL).action).toEqual({ kind: "toggleConfidence" });
    expect(resolveKey(press("Delete"), LABEL).action).toEqual({ kind: "deleteHut" });
    expect(resolveKey(press("Backspace"), LABEL).action).toEqual({ kind: "deleteHut" });
  });

  it("leaves C and Delete alone when no hut is selected", () => {
    const noSelection: KeyContext = { mode: "label", hutSelected: false };
    for (const key of ["c", "C", "Delete", "Backspace"]) {
      const res = resolveKey(press(key), noSelection);
      expect(res.action).toEqual({ kind: "none" });
      expect(res.preventDefault).toBe(false);
    }
  });

  it("lets other Cmd/Ctrl shortcuts through to the browser", () => {
    for (const key of ["a", "c", "v", "r", "s", "f"]) {
      const res = resolveKey(press(key, { metaKey: true }), LABEL);
      expect(res.action).toEqual({ kind: "none" });
      expect(res.preventDefault).toBe(false);
    }
  });

  it("opens help on ? and on Shift+/", () => {
    expect(resolveKey(press("?"), LABEL).action).toEqual({ kind: "openHelp" });
    expect(resolveKey(press("/", { shiftKey: true }), LABEL).action).toEqual({ kind: "openHelp" });
  });

  it("has no review bindings", () => {
    for (const key of ["y", "n", "u", "j", "k"]) {
      const { action } = resolveKey(press(key), LABEL);
      expect(action.kind).not.toBe("verdict");
      expect(action.kind).not.toBe("stepCandidate");
    }
  });
});

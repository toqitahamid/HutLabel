import { VERDICTS, reviewedCount, verdictLabel, type Candidate, type Verdict } from "./model";
import { CandidateList } from "./CandidateList";

// Right rail in review mode — the stand-in for AttributePanel, which stays
// exactly as it was for normal labeling. Same three-part shape: the magnifier
// slot at the top, the selected item's controls, then the list.
//
// It replaces rather than extends AttributePanel because the two modes share no
// controls: there is no hut selected, nothing to delete, and no confidence to
// set. Both panels render `zoomSlot` at the top, so the magnifier portal lands
// in the same place whichever one is mounted.
export function CandidatePanel({
  candidates,
  hiddenCount,
  revealHidden,
  batch,
  selectedCandidateId,
  onSetVerdict,
  onClearVerdict,
  onFocusCandidate,
  labelsVisible,
  zoomSlot,
}: {
  // The VISIBLE queue, already filtered by App — everything here counts what
  // the reviewer is actually asked to work through.
  candidates: Candidate[];
  // How many of this ortho's candidates sit on a box that is already labelled.
  // Counted whichever way `revealHidden` is set, so the line reads the same
  // either way and only the verb changes.
  hiddenCount: number;
  revealHidden: boolean;
  // Which pipeline batch this queue came from — the newest one on the ortho,
  // which is the server's default. Shown because two batches now exist in the
  // database and "which boxes am I looking at" should not need a devtools tab.
  // Null when the queue is empty and there is nothing to name.
  batch: string | null;
  selectedCandidateId: string | null;
  // Same handlers the Y / N / U and Backspace keys call, so the buttons and the
  // shortcuts can never drift apart.
  onSetVerdict: (verdict: Verdict) => void;
  onClearVerdict: () => void;
  onFocusCandidate: (id: string) => void;
  // Whether the ortho's existing labels are on the map right now (the `L` key,
  // App's state). Shown here so the hint names what L will do next, and so the
  // reviewer can see which way it is set without hunting for a dashed box.
  labelsVisible: boolean;
  zoomSlot?: React.ReactNode;
}) {
  const selected = candidates.find((c) => c.id === selectedCandidateId) ?? null;
  const reviewed = reviewedCount(candidates);

  return (
    <aside className="right-rail">
      {zoomSlot}

      <div className="rail-section head">
        <span className="rail-title">Review</span>
        <span className="rail-coord">
          reviewed {reviewed} / {candidates.length}
        </span>
      </div>

      {/* Batch and the already-labelled skip, together: both answer "what am I
          being shown, and what am I not". Rendered outside the selected branch
          so an ortho whose whole queue is hidden still explains itself. */}
      {(batch !== null || hiddenCount > 0) && (
        <div className="rail-section">
          {batch !== null && <p className="rail-hint">Batch {batch}</p>}
          {hiddenCount > 0 && (
            <p className="rail-hint">
              {revealHidden
                ? `${hiddenCount} already labelled, shown`
                : `${hiddenCount} hidden, already labelled`}{" "}
              — {hiddenCount === 1 ? "it overlaps a" : "they overlap a"} box you
              have already drawn. <kbd>H</kbd> {revealHidden ? "hides" : "shows"}{" "}
              {hiddenCount === 1 ? "it" : "them"}.
            </p>
          )}
        </div>
      )}

      {selected ? (
        <>
          <div className="rail-section">
            <span className="rail-label">Verdict</span>
            <div className="verdict-toggle" role="group" aria-label="Verdict">
              {VERDICTS.map((v) => (
                <button
                  type="button"
                  key={v}
                  className={`verdict-option verdict-${v}`}
                  aria-pressed={selected.verdict === v}
                  onClick={() => onSetVerdict(v)}
                >
                  {verdictLabel(v)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn verdict-clear"
              onClick={onClearVerdict}
              disabled={selected.verdict === null}
            >
              Clear my verdict
            </button>
          </div>

          <div className="rail-section">
            <p className="rail-hint">
              <kbd>Y</kbd> hut · <kbd>N</kbd> not hut · <kbd>U</kbd> unsure ·{" "}
              <kbd>⌫</kbd> clear. After a verdict the map jumps to the next
              unreviewed candidate; <kbd>J</kbd> / <kbd>K</kbd> step through the
              list by hand.
            </p>
            <p className="rail-hint">
              Drag the corner handles to resize this box, or the centre one to
              move it — your corrected box is saved with your verdict.
            </p>
          </div>
        </>
      ) : (
        <div className="rail-section">
          <p className="rail-hint">
            {candidates.length > 0
              ? "Pick a candidate from the list to review it."
              : hiddenCount > 0
                ? "Every candidate on this ortho sits on a box you have already labelled."
                : "No candidates on this ortho."}
          </p>
        </div>
      )}

      {/* Outside the selected branch: L works whether or not a candidate is
          picked, and which way it is set is recorded with every verdict. */}
      <div className="rail-section">
        <p className="rail-hint">
          Existing labels are {labelsVisible ? "shown" : "hidden"} — dashed, in
          their own colours, and not editable here. <kbd>L</kbd>{" "}
          {labelsVisible ? "hides" : "shows"} them. Each verdict records whether
          they were on screen when you gave it.
        </p>
      </div>

      <CandidateList
        candidates={candidates}
        selectedCandidateId={selectedCandidateId}
        onSelectCandidate={onFocusCandidate}
      />
    </aside>
  );
}

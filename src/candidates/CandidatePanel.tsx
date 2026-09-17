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
  selectedCandidateId,
  onSetVerdict,
  onClearVerdict,
  onFocusCandidate,
  zoomSlot,
}: {
  candidates: Candidate[];
  selectedCandidateId: string | null;
  // Same handlers the Y / N / U and Backspace keys call, so the buttons and the
  // shortcuts can never drift apart.
  onSetVerdict: (verdict: Verdict) => void;
  onClearVerdict: () => void;
  onFocusCandidate: (id: string) => void;
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
              move it — your corrected box is saved with your verdict. Existing
              labels that overlap a candidate appear only once you have voted on
              it.
            </p>
          </div>
        </>
      ) : (
        <div className="rail-section">
          <p className="rail-hint">
            {candidates.length === 0
              ? "No candidates on this ortho."
              : "Pick a candidate from the list to review it."}
          </p>
        </div>
      )}

      <CandidateList
        candidates={candidates}
        selectedCandidateId={selectedCandidateId}
        onSelectCandidate={onFocusCandidate}
      />
    </aside>
  );
}

import { useEffect, useRef } from "react";
import {
  VERDICTS,
  VERDICT_KEY,
  queueNav,
  reviewedCount,
  verdictLabel,
  type Candidate,
  type Verdict,
} from "./model";
import { CandidateList } from "./CandidateList";
import { ReviewHelp } from "./ReviewHelp";

// Right rail in review mode — the stand-in for AttributePanel, which stays
// exactly as it was for normal labeling. Same three-part shape: the magnifier
// slot at the top, the selected item's controls, then the list.
//
// It replaces rather than extends AttributePanel because the two modes share no
// controls: there is no hut selected, nothing to delete, and no confidence to
// set. Both panels render `zoomSlot` at the top, so the magnifier portal lands
// in the same place whichever one is mounted.
//
// Everything above the list is kept to a fixed, small height on purpose: the
// list is the only shrinkable child of the rail (see .hut-list-section in
// App.css), so every paragraph up here comes straight out of the queue the
// reviewer has to reach. The instructions therefore live behind the header's
// "?" (ReviewHelp) and the state they described is compressed into one muted
// line, leaving the rail with the magnifier, the header, Prev / Next, the
// verdict buttons, and the list.
export function CandidatePanel({
  candidates,
  hiddenCount,
  revealHidden,
  batch,
  selectedCandidateId,
  onSetVerdict,
  onClearVerdict,
  onFocusCandidate,
  onStepCandidate,
  labelsVisible,
  helpOpen,
  onOpenHelp,
  onCloseHelp,
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
  // The J / K handler itself, for the Prev / Next buttons — same reason: one
  // stepping rule, whether it is reached by key or by click.
  onStepCandidate: (delta: -1 | 1) => void;
  // Whether the ortho's existing labels are on the map right now (the `L` key,
  // App's state). Shown here so the reviewer can see which way it is set
  // without hunting for a dashed box.
  labelsVisible: boolean;
  // The "?" dialog's open state lives in App, not here, so App's keydown effect
  // can hand it the keyboard while it is open — otherwise Y / N / U would land
  // verdicts on a candidate hidden behind it.
  helpOpen: boolean;
  onOpenHelp: () => void;
  onCloseHelp: () => void;
  zoomSlot?: React.ReactNode;
}) {
  const selected = candidates.find((c) => c.id === selectedCandidateId) ?? null;
  const reviewed = reviewedCount(candidates);
  const nav = queueNav(candidates, selectedCandidateId);

  // Focus comes back to the "?" after the dialog closes, however it was closed
  // (×, backdrop, Esc). The dialog is the one that moves focus away, so putting
  // it back is this component's job — it owns the button focus should land on.
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpWasOpen = useRef(false);
  useEffect(() => {
    if (helpWasOpen.current && !helpOpen) helpButtonRef.current?.focus();
    helpWasOpen.current = helpOpen;
  }, [helpOpen]);

  return (
    <aside className="right-rail">
      {zoomSlot}

      <div className="rail-section head">
        <span className="rail-title">Review</span>
        <span className="rail-head-actions">
          <span className="rail-coord">
            reviewed {reviewed} / {candidates.length}
          </span>
          <button
            type="button"
            className="rail-help"
            ref={helpButtonRef}
            onClick={onOpenHelp}
            aria-label="How candidate review works"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            title="How candidate review works"
          >
            ?
          </button>
        </span>
      </div>

      {/* One muted line of state: which batch, whether the existing labels are
          drawn, and how many candidates are being kept out of the queue. What
          each of those means, and which key flips it, is in the "?" dialog. */}
      <div className="rail-section rail-meta">
        <p className="rail-hint">
          {batch !== null && <>Batch {batch} · </>}
          labels {labelsVisible ? "shown" : "hidden"}
          {hiddenCount > 0 && (
            <>
              {" · "}
              {hiddenCount} already labelled, {revealHidden ? "shown" : "hidden"}
            </>
          )}
        </p>
      </div>

      <div className="rail-section review-controls">
        <div className="candidate-nav" role="group" aria-label="Move through the queue">
          <button
            type="button"
            className="btn candidate-step"
            onClick={() => onStepCandidate(-1)}
            disabled={!nav.canPrev}
            aria-label="Previous candidate"
            title="Previous candidate (K)"
          >
            ‹ Prev
          </button>
          <span className="candidate-position" title="Position in the visible queue">
            {nav.label}
          </span>
          <button
            type="button"
            className="btn candidate-step"
            onClick={() => onStepCandidate(1)}
            disabled={!nav.canNext}
            aria-label="Next candidate"
            title="Next candidate (J)"
          >
            Next ›
          </button>
        </div>

        {selected ? (
          <>
            <div className="verdict-toggle" role="group" aria-label="Verdict">
              {VERDICTS.map((v) => (
                <button
                  type="button"
                  key={v}
                  className={`verdict-option verdict-${v}`}
                  aria-pressed={selected.verdict === v}
                  onClick={() => onSetVerdict(v)}
                  aria-label={`${verdictLabel(v)} (key ${VERDICT_KEY[v]})`}
                  title={`${verdictLabel(v)} (${VERDICT_KEY[v]})`}
                >
                  <span className="verdict-name">{verdictLabel(v)}</span>
                  <kbd className="verdict-key">{VERDICT_KEY[v]}</kbd>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn verdict-clear"
              onClick={onClearVerdict}
              disabled={selected.verdict === null}
              aria-label="Clear my verdict (key Backspace)"
              title="Clear my verdict (Backspace)"
            >
              Clear <kbd className="verdict-key">⌫</kbd>
            </button>
          </>
        ) : (
          <p className="rail-hint">
            {candidates.length > 0
              ? "Pick a candidate to review it."
              : hiddenCount > 0
                ? "Every candidate here sits on a box you have already labelled."
                : "No candidates on this ortho."}
          </p>
        )}
      </div>

      <CandidateList
        candidates={candidates}
        selectedCandidateId={selectedCandidateId}
        onSelectCandidate={onFocusCandidate}
      />

      {helpOpen && <ReviewHelp onClose={onCloseHelp} />}
    </aside>
  );
}

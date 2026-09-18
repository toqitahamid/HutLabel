import { useEffect, useRef } from "react";

// The review panel's instructions, behind the "?" in its header. They used to
// be three paragraphs stacked above the candidate list, which pushed the list
// off the bottom of the rail — the reviewer reads them once and then wants the
// queue, so they live here and the rail keeps the controls.
//
// Same backdrop/modal idiom as App's KeyboardHelp and WelcomeCard, and the same
// CSS classes, so the three read as one system. Esc is handled where those are —
// App's keydown effect, which also stops Y / N / U / J / K reaching the queue
// while this is open (see `reviewHelpOpen` there). Backdrop click and the ×
// close it too.
export function ReviewHelp({ onClose }: { onClose: () => void }) {
  // Focus moves into the dialog so Esc and Tab act on it rather than on
  // whatever the reviewer last clicked. The "?" button gets focus back when the
  // dialog closes — CandidatePanel does that, since it owns the button.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal review-help"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="How candidate review works"
      >
        <div className="help-header">
          <div className="help-title">How candidate review works</div>
          <button
            className="help-close"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            title="Esc"
          >
            ×
          </button>
        </div>

        <div className="review-help-sections">
          <section className="help-section">
            <div className="help-section-title">Verdicts</div>
            <p className="review-help-body">
              <kbd>Y</kbd> hut · <kbd>N</kbd> not hut · <kbd>U</kbd> unsure ·{" "}
              <kbd>⌫</kbd> clear. Pressing the key a candidate already carries
              does nothing — <kbd>⌫</kbd> is the one way to take a verdict back.
            </p>
          </section>

          <section className="help-section">
            <div className="help-section-title">Moving on</div>
            <p className="review-help-body">
              After a verdict the map jumps to the next unreviewed candidate.
              <kbd>J</kbd> and <kbd>K</kbd> (or <kbd>]</kbd> and <kbd>[</kbd>),
              and the Prev / Next buttons, step through the list by hand; they
              stop at each end rather than wrapping round.
            </p>
          </section>

          <section className="help-section">
            <div className="help-section-title">Fixing the box</div>
            <p className="review-help-body">
              Drag the corner handles to resize the selected box, or the centre
              one to move it — your corrected box is saved with your verdict.
            </p>
          </section>

          <section className="help-section">
            <div className="help-section-title">Existing labels</div>
            <p className="review-help-body">
              Your existing labels are drawn dashed, in their own colours, and
              are not editable here. <kbd>L</kbd> shows and hides them, and each
              verdict records whether they were on screen when you gave it.
            </p>
          </section>

          <section className="help-section">
            <div className="help-section-title">Hidden candidates</div>
            <p className="review-help-body">
              A candidate sitting on a box you have already labelled is kept out
              of the queue — you have answered that one. <kbd>H</kbd> puts them
              back in, and takes them out again.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

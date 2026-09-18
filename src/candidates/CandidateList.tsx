import { useEffect, useRef } from "react";
import { verdictLabel, type Candidate } from "./model";

// Per-ortho list of machine candidates in rank order, the review-mode twin of
// HutList. Renders straight off the same `candidates` array the map draws, so a
// verdict shows up here the moment it is applied, with no fetch of its own.
//
// A row shows its position and MY verdict, and nothing else: the pipeline's
// score never reaches the client (see src/candidates/model.ts), and rank is
// only rendered as "#n in the queue" — the order is already as much of a hint
// as a blind reviewer gets.
export function CandidateList({
  candidates,
  selectedCandidateId,
  onSelectCandidate,
}: {
  candidates: Candidate[];
  selectedCandidateId: string | null;
  // Clicking a row selects that candidate AND re-centers the map on it, the
  // same focus signal a hut row sends.
  onSelectCandidate: (id: string) => void;
}) {
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  // A selection made elsewhere (map click, J/K, auto-advance after a verdict)
  // scrolls its row into view too — same as HutList, and the reason the
  // auto-advance never leaves the reviewer looking at a list that didn't move.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedCandidateId]);

  return (
    <div className="rail-section hut-list-section">
      <div className="rail-label">
        <span>Candidates ({candidates.length})</span>
      </div>
      {candidates.length === 0 ? (
        // "in the queue", not "on this ortho": the rows this list is given are
        // the visible queue, so an ortho whose candidates are all hidden as
        // already labelled would be described wrongly by the stronger claim.
        // The panel above says which of the two it is.
        <p className="rail-hint">No candidates in the queue.</p>
      ) : (
        <div className="hut-list">
          {candidates.map((candidate, i) => {
            const selected = candidate.id === selectedCandidateId;
            const label = verdictLabel(candidate.verdict);
            return (
              <button
                type="button"
                key={candidate.id}
                ref={selected ? selectedRowRef : undefined}
                className={
                  "hut-row candidate-row" +
                  (selected ? " active" : "") +
                  (candidate.verdict ? ` verdict-${candidate.verdict}` : "")
                }
                onClick={() => onSelectCandidate(candidate.id)}
                title={`#${i + 1} · ${label}`}
              >
                #{i + 1} · {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

-- Reviewer box correction: where a reviewer disagrees with the box the pipeline
-- drew rather than with the box's contents.
--
-- The correction lands on candidate_reviews, not on candidates: the candidates
-- table is the immutable record of what the model proposed, and a run's
-- precision is only measurable against the boxes it actually emitted. It is the
-- reviewer's own opinion, so it belongs with the reviewer's own verdict — one
-- correction per reviewer per candidate, cascading away with the row the same
-- way the verdict does.
--
-- Adds columns to ONE table, the table migration 004 created for this feature.
-- It creates nothing, drops nothing, and writes no existing row; the label
-- tables are not named here and are not touched.
--
-- verdict is NOT NULL, so a correction cannot exist without a verdict: the UI
-- holds a pending adjustment locally and sends it with the verdict. Clearing a
-- verdict deletes the row and the correction with it, which is the intended
-- behaviour — an adjustment is part of the reviewer's call, not separate from
-- it.
--
-- Run this AFTER 004 so a fresh replay lands in order. One transaction, so a
-- failure leaves nothing half-applied. Deliberately NOT `if not exists`: a
-- second run should fail loudly rather than silently accept columns of the
-- wrong shape as if they were these.
--
-- APPLIED to the Neon default branch 2026-09-17, with the owner's approval.
-- The label table's fingerprint was identical before and after, and matched the
-- offline backup. candidate_reviews held 0 rows at the time, so no verdict was
-- touched either.

begin;

alter table candidate_reviews
  -- Native-resolution pixels of that ortho, origin top-left, the same
  -- coordinate system and the same bounds checks the proposal columns use.
  add column adj_x int check (adj_x >= 0),
  add column adj_y int check (adj_y >= 0),
  add column adj_w int check (adj_w > 0),
  add column adj_h int check (adj_h > 0),
  -- A box is four numbers or it is nothing. Without this a half-written
  -- correction (x and y moved, w and h left behind) would be storable, and
  -- every reader would then have to decide what that means.
  add constraint candidate_reviews_adj_all_or_none check (
    (adj_x is null and adj_y is null and adj_w is null and adj_h is null)
    or (adj_x is not null and adj_y is not null and adj_w is not null and adj_h is not null)
  );

commit;

-- Rollback, if this ever needs undoing. Drops only the four columns and the
-- constraint this migration added; the verdicts themselves survive it.
--
-- begin;
-- alter table candidate_reviews
--   drop constraint candidate_reviews_adj_all_or_none,
--   drop column adj_x,
--   drop column adj_y,
--   drop column adj_w,
--   drop column adj_h;
-- commit;

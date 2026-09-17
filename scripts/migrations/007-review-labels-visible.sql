-- Was this verdict blind? One flag per review row, recording whether the
-- existing labels were on screen when the reviewer made the call.
--
-- The review started out blind: the reviewer saw the machine's proposals and
-- nothing else, which is what made the two passes independent enough to
-- estimate how many structures BOTH the annotator and the model missed. The
-- owner has asked for the labels to be visible from the start instead, and a
-- reviewer can hide them again with a keystroke. Either way the analysis needs
-- to know which it was, per verdict, rather than inferring it from a deploy
-- date — so the flag travels with the verdict that was given under it.
--
-- Nullable on purpose: null means "recorded before this column existed", which
-- no longer happens once the client sends it on every write. candidate_reviews
-- holds 0 rows right now, so there is nothing to backfill and no default to
-- invent.
--
-- Adds ONE column to ONE table, the table migration 004 created for this
-- feature. It creates nothing, drops nothing, writes no existing row, and names
-- no other table.
--
-- Run this AFTER 005 so a fresh replay lands in order. One transaction, so a
-- failure leaves nothing half-applied. Deliberately NOT `if not exists`: a
-- second run should fail loudly rather than silently accept a column of the
-- wrong shape as if it were this one.
--
-- NOT APPLIED. The owner applies it.

begin;

alter table candidate_reviews
  add column labels_visible boolean;

commit;

-- Rollback, if this ever needs undoing. Drops only the column this migration
-- added; the verdicts themselves survive it.
--
-- begin;
-- alter table candidate_reviews
--   drop column labels_visible;
-- commit;

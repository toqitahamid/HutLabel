-- Reintroduces the confidence half of what 002-drop-hut-attributes.sql
-- removed (structure_type stays gone — the labmate only asked for confidence
-- back). Every hut defaults to "certain"; a labeler flips it to "unsure" for
-- a doubtful box so the PI can scan for exactly those later. Run this AFTER
-- 001 and 002 so a fresh replay lands 001 -> 002 -> 003 in order.
--
-- Applied 2026-07-29. Record only — do not run.
alter table huts add column confidence text not null default 'certain';
alter table huts add constraint huts_confidence_check check (confidence in ('certain', 'unsure'));

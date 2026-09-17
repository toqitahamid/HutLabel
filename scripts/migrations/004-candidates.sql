-- Candidate review: machine-proposed boxes from the research pipeline, plus one
-- blind verdict per reviewer per candidate.
--
-- Two NEW tables and nothing else. This migration creates only what is named
-- below: it does not ALTER or DROP any existing table, and it does not write a
-- single existing row. Labels already in the database are untouchable — a
-- candidate is a proposal, not a label, and promoting a confirmed candidate
-- into a label would be a separate, owner-approved step that no code path in
-- this feature performs.
--
-- Column types and constraints mirror the verified live schema (Postgres 17):
-- ortho_id matches orthos.id (text) and cascades the same way the existing
-- label table's ortho reference does; the geometry checks match its x/y/w/h,
-- except that w and h are NOT NULL here because a candidate is always a box
-- (the pipeline has no point mode, so the paired
-- `(w is null) = (h is null)` check has no counterpart).
--
-- Run this AFTER 001-003 so a fresh replay lands in order. One transaction, so
-- a failure leaves nothing half-created; `if not exists` throughout, so a
-- re-run is a no-op rather than an error.
--
-- Not yet applied.

begin;

create table if not exists candidates (
  id uuid primary key default gen_random_uuid(),
  ortho_id text not null references orthos(id) on delete cascade,
  -- Provenance label for one pipeline run, e.g. 'dinov3-sat-2026-09-20'. The
  -- unit a reviewer works through, and what makes a re-import idempotent.
  batch text not null,
  -- The pipeline's own ordering within (batch, ortho), 1-based. Drives review
  -- order; `score` is deliberately never shown to the reviewer (see
  -- api/candidates/index.ts).
  rank int not null check (rank >= 1),
  -- Native-resolution pixels of that ortho, origin top-left, the same
  -- coordinate system the labels use.
  x int not null check (x >= 0),
  y int not null check (y >= 0),
  w int not null check (w > 0),
  h int not null check (h > 0),
  score real,
  created_at timestamptz not null default now(),
  -- Makes re-running the importer for the same batch a no-op instead of a
  -- duplicate (api/candidates/index.ts relies on this for `on conflict`).
  unique (batch, ortho_id, rank)
);

-- The read path is "this ortho's candidates in this batch"; the unique index
-- above leads with `batch`, so it cannot serve that query.
create index if not exists candidates_ortho_batch_idx on candidates (ortho_id, batch);

create table if not exists candidate_reviews (
  candidate_id uuid not null references candidates(id) on delete cascade,
  -- Clerk user id, taken from the verified JWT server-side — never from the
  -- request body, the same rule the label table's labeler_id follows, and the
  -- same kind of value.
  reviewer_id text not null,
  verdict text not null check (verdict in ('hut', 'not_hut', 'unsure')),
  reviewed_at timestamptz not null default now(),
  -- One verdict per reviewer per candidate: a second reviewer's pass is a
  -- separate row, which is what makes an agreement measure possible.
  primary key (candidate_id, reviewer_id)
);

commit;

-- Rollback, if this ever needs undoing. Drops only the two tables this
-- migration created; every pre-existing table is untouched either way.
--
-- begin;
-- drop table candidate_reviews;
-- drop table candidates;
-- commit;

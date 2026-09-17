-- Candidate review: machine-proposed boxes from the research pipeline, plus one
-- blind verdict per reviewer per candidate. Two NEW tables — nothing here
-- touches `huts`, so the labeling UI and the hut export (api/export.ts) are
-- unaffected, and a candidate can never be mistaken for a human label.
--
-- Two assumptions, both forced by the base DDL not living in this repo:
--   * orthos.id is declared `text` here. scripts/seed-orthos.mjs inserts ids
--     like 'example-site-a', so text is the shape; if the base table used
--     varchar(n) or citext, change the column type below to match BEFORE
--     applying, or the foreign key will fail to create.
--   * gen_random_uuid() is assumed to be what huts.id already defaults to
--     (it is a Postgres 13+ builtin, no pgcrypto extension needed on Neon).
--
-- Run this AFTER 001-003 so a fresh replay lands in order.
--
-- Not yet applied.

create table if not exists candidates (
  id uuid primary key default gen_random_uuid(),
  ortho_id text not null references orthos(id),
  -- Provenance label for one pipeline run, e.g. 'dinov3-sat-2026-09-20'. The
  -- unit a reviewer works through, and what makes a re-import idempotent.
  batch text not null,
  -- The pipeline's own ordering within (batch, ortho). Drives review order;
  -- `score` is deliberately never shown to the reviewer (see api/candidates).
  rank int not null,
  -- Native-resolution pixels of that ortho, origin top-left, same coordinate
  -- system as huts. A candidate is always a box (the pipeline has no point
  -- mode), so unlike huts.w/h these are not null.
  x int not null,
  y int not null,
  w int not null,
  h int not null,
  score real,
  created_at timestamptz not null default now(),
  -- Makes re-running the importer for the same batch a no-op instead of a
  -- duplicate (api/candidates POST relies on this for `on conflict`).
  unique (batch, ortho_id, rank)
);

-- The read path is "this ortho's candidates in this batch, by rank"; the unique
-- index above leads with `batch`, so it cannot serve that query.
create index if not exists candidates_ortho_batch_rank_idx
  on candidates (ortho_id, batch, rank);

create table if not exists candidate_reviews (
  candidate_id uuid not null references candidates(id) on delete cascade,
  -- Clerk user id, taken from the verified JWT server-side — never from the
  -- request body, same rule huts.labeler_id follows.
  reviewer_id text not null,
  verdict text not null check (verdict in ('hut', 'not_hut', 'unsure')),
  reviewed_at timestamptz not null default now(),
  -- One verdict per reviewer per candidate: a second reviewer's pass is a
  -- separate row, which is what makes an agreement measure possible.
  primary key (candidate_id, reviewer_id)
);

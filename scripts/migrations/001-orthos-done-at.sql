-- done_at is null until an admin marks the ortho done; no separate "in progress"
-- column — that state is derived (see api/orthos.ts, src/App.tsx) from done_at + hut_count.
alter table orthos add column if not exists done_at timestamptz;

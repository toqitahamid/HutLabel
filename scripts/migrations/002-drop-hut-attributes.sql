-- A hut is now purely a box (id, ortho_id, x, y, w, h, labeler_id, created_at) —
-- structure_type/confidence are gone from the whole stack. Written when the
-- huts table was still empty, so there was no data to migrate off these columns.
alter table huts drop column if exists structure_type;
alter table huts drop column if exists confidence;

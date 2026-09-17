# HutLabel

Web tool for labeling muskrat huts on gigapixel drone orthomosaics. Wildlife
labmates draw hut bounding boxes over a tiled map viewer; the PI watches progress
live. Boxes later become masks via SAM (offline).

Stack: Vite/React/Leaflet SPA, Clerk for auth (invite-only email code, no
self-signup), Neon Postgres for hut/ortho data, Vercel functions for the API,
Cloudflare R2 for tile storage.

## Layout

```
src/
  viewer/        Leaflet CRS.Simple map over the tile pyramid
    OrthoMap.tsx        the map component (box-drag / point / pan modes)
    tile-geometry.ts    pure pyramid math, kept in lockstep with scripts/tiler.py
  huts/          hut domain model + attribute panel (pure model is unit-tested)
  candidates/    machine-candidate model + review panel/list (see "Candidate review")
  cloud/         Clerk auth gate, hut + candidate CRUD backend clients
  App.tsx        3-column shell: ortho list | map | attribute panel
api/             Vercel functions (orthos, huts, candidates, admin-users) — Clerk + Neon on the server
scripts/
  tiler.py            production tiler: GeoTIFF -> webp tile pyramid (runs locally or on Delta)
  ortho-inventory.mjs   parses data/Orthomosaics/**/*.tif filenames into {id, site, visit, path}
  tile-all.mjs          batch-runs tiler.py over all 41 orthos -> data/tiles/ + manifest.json
  seed-orthos.mjs        upserts a tiles manifest into the Neon orthos table
  import-candidates.mjs  loads one pipeline batch into the candidates table
data/            the 41 source orthomosaics + generated tiles (git-ignored; not committed)
```

## Dev

```
npm install
npm run dev             # vite on :5174, proxies /api -> :3999
vercel dev --listen 3999  # in a second terminal, serves the Vercel functions
npm test                 # vitest (pure model + geometry)
```

## Deploy

The Vercel project is connected to this repo, so pushing to `main` builds and
promotes to production automatically — no `vercel deploy` needed. Any other
branch gets a preview deployment instead. Env vars live in the Vercel project
settings, not in the repo.

Without Clerk env vars the app runs in local-dev mode: huts live in memory and
the ortho list comes from a local manifest. Set `VITE_CLERK_PUBLISHABLE_KEY`
(client) and `CLERK_SECRET_KEY` / `DATABASE_URL` (server, Vercel env) to use the
real backend — see `.env.example`.

Tiles are served one of two ways depending on `VITE_TILE_BASE` /
`VITE_TILE_EXT`:
- `/tiles-real` + `webp` — local dev, all 41 real orthos, streamed from `data/tiles/` by the
  `serveRealTiles` middleware in `vite.config.ts`. That middleware exists because
  `data/tiles/` holds ~190k tile files; symlinking it under `public/` would make
  both vite's and `vercel dev`'s chokidar watchers recurse into it and exhaust
  file descriptors (EMFILE). Serving it directly keeps neither watcher aware of
  the directory.
- a Cloudflare R2 public URL + `webp` — production.

## Candidate review

A research pipeline proposes boxes ("candidates"); a second annotator reviews
them here and gives each one a verdict. Candidates live in their own tables and
never touch `huts` or `/api/export`, so the hut ground truth is unaffected.

The review is **blind**. In review mode the human hut boxes are hidden (not even
fetched), hut editing is off, the sidebar's hut counts are blanked, the
pipeline's score is never sent to the browser, and each reviewer sees only their
own verdict — which is what makes two independent passes an agreement measure
rather than an echo.

One known limit: `GET /api/orthos` returns a per-ortho `hut_count` to every
signed-in user, and review mode does not change that route. So the counts are
hidden in the UI, not in the network response — review mode is *voluntary*
blindness for a trusted reviewer, not an access control. The hut boxes
themselves are not fetched at all while reviewing.

**Existing labels are never changed or removed by this feature.** No candidate
code path writes to `huts` or `orthos`, migration 004 does not touch them, and
every hut mutation (create, resize, confidence, delete, undo, redo) refuses
while review mode is on. `src/no-hut-writes.test.ts` and `src/keymap.test.ts`
enforce both halves. There is deliberately no "accept candidate as hut" action:
promoting confirmed candidates into labels is a separate, owner-approved step.

1. Apply `scripts/migrations/004-candidates.sql` — test it on a Neon branch
   first, then apply to the default branch. It runs in one transaction, creates
   `candidates` and `candidate_reviews`, and carries a commented-out rollback
   block.
2. Load a batch:
   ```
   DATABASE_URL=... node scripts/import-candidates.mjs batch.json --dry-run
   DATABASE_URL=... node scripts/import-candidates.mjs batch.json
   ```
   `--dry-run` validates every row (ortho exists, box fits inside it) and prints
   per-ortho counts without inserting. Re-running a real import is a no-op:
   `(batch, ortho_id, rank)` is unique. The file format is the fixed contract
   with the research repo:
   ```json
   { "batch": "run-name",
     "created_at": "2026-09-17T00:00:00Z",
     "coordinate_system": "pixels at native resolution; origin top-left; box = [x, y, w, h]",
     "candidates": [ { "ortho_id": "demo-site-a", "rank": 1,
                       "x": 100, "y": 200, "w": 180, "h": 180, "score": 7.3 } ] }
   ```
3. A **Review candidates** button appears in the titlebar for any ortho that has
   candidates, for every signed-in user. Keys in review mode:

   | Key | Action |
   | --- | --- |
   | `Y` / `N` / `U` | hut / not hut / unsure |
   | `⌫` | clear my verdict |
   | `J` / `K` (or `]` / `[`) | next / previous candidate |
   | `←` / `→` | previous / next ortho, as usual |

   After a verdict the map flies to the next candidate you haven't judged, and
   the rail counts "reviewed 7 / 10". Leaving review mode restores normal
   labeling exactly.
4. `GET /api/candidates-export` (admin) returns every candidate with every
   reviewer's verdict, keyed by `(batch, ortho_id, rank)` for the pipeline to
   join back on.

For local dev without Clerk or Neon, drop a file in the same format at
`public/tiles/candidates.dev.json`; the in-memory backend picks it up and keeps
verdicts for the session.

## Tiling pipeline

The browser can't open a `.tif` (277 MP, exceeds the GPU texture limit). Each
ortho is pre-sliced into a 256px tile pyramid, uploaded to Cloudflare R2, and
served as static files (egress-free) that the viewer streams on-screen-only.

1. `scripts/tiler.py <src.tif> <out_dir> webp 100` — slices one ortho into
   `<out_dir>/<level>/<col>_<row>.webp`. `quality 100` is the project's
   convention for lossless webp (see the script's `QUALITY == 100` branch).
   Prints the ortho's `max_level`/`W`/`H`, which the orthos table needs.
2. `node scripts/tile-all.mjs` — runs step 1 over all 41 orthos (from
   `scripts/ortho-inventory.mjs`, which resolves the inconsistent source
   filenames into `{id, site, visit, path}`), in a worker pool sized off
   available RAM. Writes `data/tiles/<id>/` and `data/tiles/manifest.json`.
3. `rclone sync data/tiles/ r2:hutlabel-tiles/` — pushes the tiles to the R2
   bucket the app serves from in production.
4. `node scripts/seed-orthos.mjs data/tiles/manifest.json` — upserts each
   ortho's `id`/`site`/`visit`/`width`/`height`/`max_level` into the Neon
   `orthos` table that `api/orthos.ts` reads. Requires `DATABASE_URL`.

Production env vars: `VITE_TILE_BASE=https://<r2-public-url>`,
`VITE_TILE_EXT=webp`.

## License

MIT — see [LICENSE](LICENSE).

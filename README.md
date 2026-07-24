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
  cloud/         Clerk auth gate, hut CRUD backend client
  App.tsx        3-column shell: ortho list | map | attribute panel
api/             Vercel functions (orthos, huts, admin-users) — Clerk + Neon on the server
scripts/
  tiler.py            production tiler: GeoTIFF -> webp tile pyramid (runs locally or on Delta)
  ortho-inventory.mjs   parses data/Orthomosaics/**/*.tif filenames into {id, site, visit, path}
  tile-all.mjs          batch-runs tiler.py over all 41 orthos -> data/tiles/ + manifest.json
  seed-orthos.mjs        upserts a tiles manifest into the Neon orthos table
  decode_demo_tiles.py  unpacks demo_pyramid.json -> public/tiles for offline dev
  demo_pyramid.json     pre-tiled Example Site crop (dev-only; delete once R2 tiles exist)
data/            the 41 source orthomosaics + generated tiles (git-ignored; not committed)
public/tiles/    decoded dev tileset (git-ignored; regenerate with npm run tiles:demo)
```

## Dev

```
npm install
npm run dev             # vite on :5174, proxies /api -> :3999
vercel dev --listen 3999  # in a second terminal, serves the Vercel functions
npm test                 # vitest (pure model + geometry)
```

Without Clerk env vars the app runs in local-dev mode: orthos come from the
decoded demo manifest and huts live in memory. Set `VITE_CLERK_PUBLISHABLE_KEY`
(client) and `CLERK_SECRET_KEY` / `DATABASE_URL` (server, Vercel env) to use the
real backend — see `.env.example`.

Tiles are served one of three ways depending on `VITE_TILE_BASE` /
`VITE_TILE_EXT`:
- `/tiles` + `jpg` — the decoded demo tileset (`npm run tiles:demo`), one ortho, fully offline.
- `/tiles-real` + `webp` — all 41 real orthos, streamed from `data/tiles/` by the
  `serveRealTiles` middleware in `vite.config.ts`. That middleware exists because
  `data/tiles/` holds ~190k tile files; symlinking it under `public/` would make
  both vite's and `vercel dev`'s chokidar watchers recurse into it and exhaust
  file descriptors (EMFILE). Serving it directly keeps neither watcher aware of
  the directory.
- a Cloudflare R2 public URL + `webp` — production.

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

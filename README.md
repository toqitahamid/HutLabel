# HutLabel

Web tool for labeling muskrat huts on gigapixel drone orthomosaics. Wildlife
labmates draw hut bounding boxes over a tiled map viewer; the PI watches progress
live. Boxes later become masks via SAM (offline). Reuses FlagLabel's Supabase
auth/admin patterns; replaces its canvas annotator with a Leaflet tile viewer.

## Layout

```
src/
  viewer/        Leaflet CRS.Simple map over the tile pyramid
    OrthoMap.tsx        the map component (box-drag / point / pan modes)
    tile-geometry.ts    pure pyramid math, kept in lockstep with scripts/tiler.py
  huts/          hut domain model + attribute panel (pure model is unit-tested)
  cloud/         Supabase client, auth gate (OTP), hut CRUD backend
  App.tsx        3-column shell: ortho list | map | attribute panel
scripts/
  tiler.py            production tiler: GeoTIFF -> tile pyramid (runs locally or on Delta)
  decode_demo_tiles.py  unpacks demo_pyramid.json -> public/tiles for offline dev
  demo_pyramid.json     pre-tiled Example Site crop (dev-only; delete once R2 tiles exist)
docs/            handoff brief + prior-session transcript (history)
data/            the 41 source orthomosaics (git-ignored; not committed)
public/tiles/    decoded dev tileset (git-ignored; regenerate with the script)
```

## Dev

```
npm install
npm run tiles:demo      # decode the Example Site demo tileset into public/tiles/
npm run dev             # http://localhost:5173
npm test                # vitest (pure model + geometry)
```

Without Supabase env vars the app runs in local-dev mode: orthos come from the
decoded demo manifest and huts live in memory. Set `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` in `.env.local` (see `.env.example`) to use the real
backend. `VITE_TILE_BASE` / `VITE_TILE_EXT` point the viewer at the tile host
(R2 in prod, `/tiles` + `jpg` for the demo).

## Tiling pipeline

The browser can't open a `.tif` (277 MP, exceeds the GPU texture limit). Each
ortho is pre-sliced by `scripts/tiler.py` into a 256px pyramid, then served as
static tiles from Cloudflare R2 (egress-free). The viewer streams only on-screen
tiles. Run the tiler over all 41 orthos in `data/`, upload to R2, register each
in the `orthos` table with the `max_level`/`width`/`height` the tiler prints.

#!/usr/bin/env python3
"""Production tiler: slice one orthomosaic GeoTIFF into the tile pyramid the
HutLabel viewer streams. A 277 MP GeoTIFF can't load in a browser, so each ortho
is pre-sliced into 256px tiles across power-of-two zoom levels.

Runs anywhere the data is — locally on the Mac (the orthos are in data/) or on
Delta. It's CPU batch work, not GPU (Delta is only needed later for training).

Usage:
    python3 tiler.py <src.tif> <out_dir>

`out_dir` must be the ortho's own tile root, i.e. .../<ortho_id>, because the
viewer requests tiles as {TILE_BASE}/{ortho_id}/{z}/{x}_{y}.png — this script
emits exactly {out_dir}/{level}/{col}_{row}.png (y from top, no TMS flip),
skipping fully-transparent tiles (the ragged ortho edges).

The final printed `maxlevel`, `W`, `H` ARE the orthos-table row fields
(max_level, width, height) — record them when registering the ortho.

Batch all 41: loop this over data/Orthomosaics/**/*.tif into public/tiles/<id>/
(or a staging dir), then upload the tiles to Cloudflare R2. Independent per
ortho, so parallelize with multiprocessing / a job array.

Keep in lockstep with src/viewer/tile-geometry.ts (same maxlevel/level/grid math)
and src/orthos.ts tileUrlTemplate (same URL scheme).
"""
import sys, os, math, rasterio, numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

SRC = sys.argv[1]
OUT = sys.argv[2]
TS = 256

with rasterio.open(SRC) as ds:
    W, H = ds.width, ds.height
    arr = ds.read([1,2,3,4])            # (4,H,W)
arr = np.transpose(arr, (1,2,0))         # (H,W,4)
base = Image.fromarray(arr, "RGBA")
del arr

maxlevel = math.ceil(math.log2(max(W, H)))
os.makedirs(OUT, exist_ok=True)
ntiles = 0
nbytes = 0
levels_meta = []
for lvl in range(maxlevel, -1, -1):
    scale = 2 ** (maxlevel - lvl)
    lw, lh = math.ceil(W/scale), math.ceil(H/scale)
    if lw < 1 or lh < 1: continue
    img = base if scale == 1 else base.resize((lw, lh), Image.LANCZOS)
    ldir = os.path.join(OUT, str(lvl)); os.makedirs(ldir, exist_ok=True)
    cols, rows = math.ceil(lw/TS), math.ceil(lh/TS)
    lvl_tiles = 0
    for r in range(rows):
        for c in range(cols):
            box = (c*TS, r*TS, min((c+1)*TS, lw), min((r+1)*TS, lh))
            tile = img.crop(box)
            if tile.getextrema()[3][1] == 0:   # fully transparent -> skip
                continue
            fp = os.path.join(ldir, f"{c}_{r}.png")
            tile.save(fp)
            nbytes += os.path.getsize(fp); ntiles += 1; lvl_tiles += 1
    levels_meta.append((lvl, lw, lh, cols, rows, lvl_tiles))
    print(f"level {lvl}: {lw}x{lh}  grid {cols}x{rows}  tiles {lvl_tiles}")

print(f"\nTOTAL tiles {ntiles}  bytes {nbytes}  MB {nbytes/1e6:.1f}")
print(f"maxlevel {maxlevel}  W {W} H {H}")

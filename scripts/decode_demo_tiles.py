#!/usr/bin/env python3
"""Decode demo_pyramid.json into a local tileset the dev viewer can stream.

demo_pyramid.json holds base64 JPEG tiles for a 4096x4096 native crop of Fox
Creek A (maxLevel 12), keyed {level}/{col}_{row}. That is exactly the URL scheme
the viewer expects ({ortho_id}/{z}/{x}_{y}.{ext}), so we just base64-decode each
tile to disk under public/tiles/demo-crop/ and write a local orthos manifest.

No re-encode (tiles stay JPEG -> .jpg), so no PIL/GDAL needed. Production tiles
come from tiler.py (PNG) on real orthos; this only feeds `npm run dev`.
"""
import base64
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "demo_pyramid.json")
ORTHO_ID = "demo-crop"
OUT = os.path.join(ROOT, "public", "tiles", ORTHO_ID)

with open(SRC) as f:
    d = json.load(f)

crop = d["cropSize"]          # 4096 (native px, this square demo crop)
max_level = d["maxLevel"]     # 12
n = 0
for lvl_str, lvl in d["levels"].items():
    ldir = os.path.join(OUT, lvl_str)
    os.makedirs(ldir, exist_ok=True)
    for key, b64 in lvl["tiles"].items():   # key = "col_row" == "x_y"
        with open(os.path.join(ldir, f"{key}.jpg"), "wb") as t:
            t.write(base64.b64decode(b64))
        n += 1

# A dev-only manifest mirroring the `orthos` table shape, so the app can list an
# ortho before Supabase is wired. width==height==cropSize for this square crop.
manifest = [
    {
        "id": ORTHO_ID,
        "site": "Example Site",
        "visit": "A",
        "width": crop,
        "height": crop,
        "max_level": max_level,
    }
]
with open(os.path.join(ROOT, "public", "tiles", "orthos.dev.json"), "w") as f:
    json.dump(manifest, f, indent=2)

print(f"wrote {n} tiles to {OUT}")
print(f"manifest: public/tiles/orthos.dev.json  ({crop}x{crop}, maxLevel {max_level})")

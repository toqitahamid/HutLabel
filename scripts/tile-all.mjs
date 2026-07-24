#!/usr/bin/env node
// Batch-runs tiler.py over all 41 orthos from ortho-inventory.mjs, writing
// data/tiles/<id>/ pyramids and a data/tiles/manifest.json that seed-orthos.mjs
// can feed straight into the DB. Tiling is independent per ortho and each
// tiler.py invocation loads the full uncompressed RGBA array into memory
// (peaks ~2.5GB on the largest orthos), so we run a small worker pool sized
// off available RAM rather than one process per ortho.
//
// Usage:
//   node scripts/tile-all.mjs [--force]
//
// --force re-tiles orthos that already have a complete-looking output dir
// (a "0" level directory present); without it those are skipped, so a run
// interrupted partway through is cheap to resume.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { totalmem } from "node:os";

import { buildInventory } from "./ortho-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PYTHON = join(ROOT, ".venv", "bin", "python");
const TILER = join(HERE, "tiler.py");
const TILES_DIR = join(ROOT, "data", "tiles");
const MANIFEST_PATH = join(TILES_DIR, "manifest.json");

const FORCE = process.argv.includes("--force");

// 100 is tiler.py's convention for lossless webp (see tiler.py's QUALITY ==
// 100 branch) rather than an actual quality percentage.
const TILE_QUALITY = 100;

// Each worker peaks around 2.5GB RSS on the largest orthos (full RGBA array
// held in memory by tiler.py). Leave the system at least half its RAM so the
// Mac stays usable while this runs for a while.
const WORKER_MEM_BYTES = 2.5 * 1024 ** 3;
const BUDGET_BYTES = totalmem() / 2;
const WORKERS = Math.max(1, Math.floor(BUDGET_BYTES / WORKER_MEM_BYTES));

function isComplete(outDir) {
  // A finished ortho has at least its level-0 directory populated; a run
  // killed mid-tile leaves partial higher levels but never gets back down to 0.
  return existsSync(join(outDir, "0"));
}

// Pulls width/height/max_level and the tile/byte totals out of tiler.py's
// stdout. Its last two printed lines are:
//   TOTAL tiles <n>  bytes <n>  MB <f>
//   maxlevel <n>  W <n> H <n>
function parseTilerOutput(stdout) {
  const totalMatch = stdout.match(/TOTAL tiles (\d+)\s+bytes (\d+)/);
  const dimsMatch = stdout.match(/maxlevel (\d+)\s+W (\d+) H (\d+)/);
  if (!totalMatch || !dimsMatch) {
    throw new Error(`Could not parse tiler output:\n${stdout}`);
  }
  return {
    tiles: Number(totalMatch[1]),
    bytes: Number(totalMatch[2]),
    max_level: Number(dimsMatch[1]),
    width: Number(dimsMatch[2]),
    height: Number(dimsMatch[3]),
  };
}

function runTiler(ortho) {
  const outDir = join(TILES_DIR, ortho.id);
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [TILER, ortho.path, outDir, "webp", String(TILE_QUALITY)]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tiler.py exited ${code} for ${ortho.id}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(parseTilerOutput(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Simple fixed-size worker pool: each worker pulls the next queued ortho
// until the queue is empty.
async function runPool(orthos, concurrency, onResult) {
  let next = 0;
  async function worker() {
    while (next < orthos.length) {
      const ortho = orthos[next++];
      await onResult(ortho);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  const inventory = buildInventory();
  await mkdir(TILES_DIR, { recursive: true });

  const todo = [];
  const skipped = [];
  for (const ortho of inventory) {
    const outDir = join(TILES_DIR, ortho.id);
    if (!FORCE && isComplete(outDir)) {
      skipped.push(ortho);
    } else {
      todo.push(ortho);
    }
  }

  console.log(
    `${inventory.length} orthos total, ${skipped.length} already tiled (skipped), ${todo.length} to run, ${WORKERS} parallel workers\n`,
  );

  const manifest = [];
  const failures = [];
  let totalTiles = 0;
  let totalBytes = 0;
  const wallStart = Date.now();

  await runPool(todo, WORKERS, async (ortho) => {
    const start = Date.now();
    try {
      const result = await runTiler(ortho);
      const seconds = ((Date.now() - start) / 1000).toFixed(1);
      const mb = (result.bytes / 1e6).toFixed(1);
      console.log(`ok    ${ortho.id}  ${seconds}s  ${result.tiles} tiles  ${mb} MB`);
      manifest.push({
        id: ortho.id,
        site: ortho.site,
        visit: ortho.visit,
        width: result.width,
        height: result.height,
        max_level: result.max_level,
      });
      totalTiles += result.tiles;
      totalBytes += result.bytes;
    } catch (err) {
      const seconds = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`FAIL  ${ortho.id}  ${seconds}s  ${err.message}`);
      failures.push({ id: ortho.id, error: err.message });
    }
  });

  // Manifest rows for orthos skipped this run still need to be in the
  // manifest (seed-orthos.mjs needs all 41), but we don't have their
  // width/height/max_level without re-reading tiler output — those were
  // already recorded in a prior manifest.json, so merge with it if present.
  if (skipped.length) {
    let prior = [];
    if (existsSync(MANIFEST_PATH)) {
      try {
        prior = JSON.parse(await (await import("node:fs/promises")).readFile(MANIFEST_PATH, "utf8"));
      } catch {
        prior = [];
      }
    }
    const priorById = new Map(prior.map((r) => [r.id, r]));
    for (const ortho of skipped) {
      const row = priorById.get(ortho.id);
      if (row) {
        manifest.push(row);
      } else {
        failures.push({
          id: ortho.id,
          error: "skipped (already tiled) but no prior manifest row found — rerun with --force",
        });
      }
    }
  }

  manifest.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const wallSeconds = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log(
    `\n${manifest.length}/${inventory.length} orthos in manifest, ${totalTiles} tiles generated, ${(totalBytes / 1e6).toFixed(1)} MB, wall time ${wallSeconds}s`,
  );

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f.id}: ${f.error}`);
    process.exit(1);
  }
}

main();

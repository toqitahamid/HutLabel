#!/usr/bin/env node
// Upserts a batch of tiled orthos into the `orthos` table that api/orthos.ts
// reads. Takes a manifest rather than talking to the tiler directly, so the
// (slow, per-machine) tiling step and the (fast, one-shot) DB registration
// step can run independently — tile locally or on Delta, then seed from
// wherever DATABASE_URL is reachable.
//
// Usage:
//   node scripts/seed-orthos.mjs <manifest.json>
//
// <manifest.json> is an array of rows, one per ortho, with the fields the
// orthos table needs — id/site from scripts/ortho-inventory.mjs, width/height/
// max_level from tiler.py's final printed line:
//   [{ "id": "example-site-a", "site": "Example Site", "visit": "A",
//      "width": 4096, "height": 4096, "max_level": 12 }, ...]

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const VALID_VISITS = new Set(["A", "B"]);

function loadManifest(path) {
  if (!path) {
    console.error("Usage: node scripts/seed-orthos.mjs <manifest.json>");
    process.exit(1);
  }
  let rows;
  try {
    rows = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Failed to read/parse manifest ${path}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(rows)) {
    console.error(`Manifest must be a JSON array of ortho rows, got: ${typeof rows}`);
    process.exit(1);
  }
  return rows;
}

// Fail fast on a malformed row rather than letting a bad insert land in the DB.
function validateRow(row, index) {
  const problems = [];
  if (typeof row.id !== "string" || !row.id) problems.push("id must be a non-empty string");
  if (typeof row.site !== "string" || !row.site) problems.push("site must be a non-empty string");
  if (!VALID_VISITS.has(row.visit)) problems.push("visit must be 'A' or 'B'");
  for (const field of ["width", "height", "max_level"]) {
    if (!Number.isInteger(row[field]) || row[field] < 0) {
      problems.push(`${field} must be a non-negative integer`);
    }
  }
  if (problems.length) {
    throw new Error(`Manifest row ${index} (${row.id ?? "?"}) invalid: ${problems.join("; ")}`);
  }
}

async function main() {
  const manifestPath = process.argv[2];
  const rows = loadManifest(manifestPath);
  rows.forEach(validateRow);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — export it before running this script.");
    process.exit(1);
  }
  const sql = neon(url);

  let failures = 0;
  for (const row of rows) {
    try {
      await sql`
        insert into orthos (id, site, visit, width, height, max_level)
        values (${row.id}, ${row.site}, ${row.visit}, ${row.width}, ${row.height}, ${row.max_level})
        on conflict (id) do update set
          site = excluded.site,
          visit = excluded.visit,
          width = excluded.width,
          height = excluded.height,
          max_level = excluded.max_level
      `;
      console.log(`ok    ${row.id}  (${row.site}, visit ${row.visit}, ${row.width}x${row.height}, max_level ${row.max_level})`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${row.id}: ${err.message}`);
    }
  }

  console.log(`\n${rows.length - failures}/${rows.length} orthos upserted`);
  if (failures) process.exit(1);
}

main();

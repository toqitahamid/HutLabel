#!/usr/bin/env node
// Imports one batch of machine candidates from the research pipeline into the
// `candidates` table that api/candidates.ts reads. Same connection pattern as
// scripts/seed-orthos.mjs (DATABASE_URL + the Neon serverless driver), and the
// same reason for being a script rather than an app feature: the pipeline runs
// on a cluster with no browser, and the hand-off is a file.
//
// Usage:
//   node scripts/import-candidates.mjs <file.json> [--dry-run]
//
// <file.json> is the fixed contract with the research repo:
//   { "batch": "dinov3-sat-2026-09-20",
//     "created_at": "2026-09-20T12:00:00Z",
//     "coordinate_system": "pixels at native resolution; origin top-left; box = [x, y, w, h]",
//     "candidates": [ { "ortho_id": "example-site-a", "rank": 1,
//                       "x": 100, "y": 200, "w": 180, "h": 180, "score": 7.3 } ] }
//
// --dry-run validates everything (including that each ortho_id exists and each
// box fits inside that ortho) and prints per-ortho counts WITHOUT inserting.
// Re-running a real import is a no-op: the insert is `on conflict do nothing`
// against the unique (batch, ortho_id, rank).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";

// Mirrors src/candidates/model.ts's MAX_CANDIDATE_ROWS / candidateInputProblems.
// Duplicated rather than imported because a plain .mjs script can't load the
// TypeScript module — the same reason seed-orthos.mjs carries its own
// validateRow. Keep the two in step when either changes.
export const MAX_CANDIDATE_ROWS = 2000;

// `rank` is an int4 column with `check (rank >= 1)`. Bounding it here turns a
// nonsense rank into a named bad row rather than a Postgres "integer out of
// range" halfway through the insert.
export const MIN_RANK = 1;
export const MAX_RANK = 2147483647;

// Everything wrong with one row, as a list. `dims` is the claimed ortho's size,
// or null when that ortho is unknown (or when sizes aren't loaded yet, in the
// file-shape pass below). An empty list means the row is good.
export function candidateRowProblems(row, dims) {
  const problems = [];
  if (typeof row !== "object" || row === null) return ["row must be an object"];
  if (typeof row.ortho_id !== "string" || !row.ortho_id) {
    problems.push("ortho_id must be a non-empty string");
  } else if (dims === null) {
    problems.push(`unknown ortho: ${row.ortho_id}`);
  }
  if (!Number.isInteger(row.rank)) {
    problems.push("rank must be an integer");
  } else if (row.rank < MIN_RANK || row.rank > MAX_RANK) {
    problems.push(`rank must be between ${MIN_RANK} and ${MAX_RANK}`);
  }
  for (const field of ["x", "y", "w", "h"]) {
    if (!Number.isInteger(row[field])) problems.push(`${field} must be an integer`);
  }
  if (Number.isInteger(row.x) && row.x < 0) problems.push("x must be >= 0");
  if (Number.isInteger(row.y) && row.y < 0) problems.push("y must be >= 0");
  if (Number.isInteger(row.w) && row.w <= 0) problems.push("w must be > 0");
  if (Number.isInteger(row.h) && row.h <= 0) problems.push("h must be > 0");
  // The far edge may touch the image boundary but not cross it — same rule as
  // isValidBox in src/huts/model.ts.
  if (dims && Number.isInteger(row.x) && Number.isInteger(row.w) && row.x + row.w > dims.width) {
    problems.push(`x + w (${row.x + row.w}) exceeds ortho width ${dims.width}`);
  }
  if (dims && Number.isInteger(row.y) && Number.isInteger(row.h) && row.y + row.h > dims.height) {
    problems.push(`y + h (${row.y + row.h}) exceeds ortho height ${dims.height}`);
  }
  if (row.score !== undefined && row.score !== null && !Number.isFinite(row.score)) {
    problems.push("score must be a finite number when present");
  }
  return problems;
}

// Validate the whole file: its envelope, then every row. `orthoDims` maps
// ortho_id -> {width, height} for the orthos that exist; pass null to skip the
// ortho-existence and in-image checks (the shape-only pass, used before the DB
// is reachable and by the tests). Pure — no DB, no I/O, no process.exit — so
// the same function covers both the script and its unit tests.
//
// Returns { batch, rows, invalid }, where `invalid` is [{index, ortho_id, rank,
// problems}] and is empty for a good file. Throws only when the envelope itself
// is unusable, since then there are no rows to report on.
export function validateCandidateFile(file, orthoDims) {
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw new Error("File must be a JSON object with `batch` and `candidates`");
  }
  if (typeof file.batch !== "string" || !file.batch) {
    throw new Error("`batch` must be a non-empty string");
  }
  if (!Array.isArray(file.candidates) || file.candidates.length === 0) {
    throw new Error("`candidates` must be a non-empty array");
  }
  if (file.candidates.length > MAX_CANDIDATE_ROWS) {
    throw new Error(
      `${file.candidates.length} candidates exceeds the ${MAX_CANDIDATE_ROWS}-row cap; split the file`,
    );
  }

  const invalid = [];
  const seen = new Set();
  file.candidates.forEach((row, index) => {
    const dims =
      orthoDims === null
        ? { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }
        : (orthoDims.get(row?.ortho_id) ?? null);
    const problems = candidateRowProblems(row, dims);
    // (ortho_id, rank) is unique within a batch in the DB; catching a duplicate
    // here names the offending row instead of silently dropping it to the
    // `on conflict do nothing`.
    const key = JSON.stringify([row?.ortho_id, row?.rank]);
    if (seen.has(key)) problems.push(`duplicate (ortho_id, rank) within this file`);
    seen.add(key);
    if (problems.length) {
      invalid.push({ index, ortho_id: row?.ortho_id, rank: row?.rank, problems });
    }
  });

  return { batch: file.batch, rows: file.candidates, invalid };
}

// Per-ortho row counts for the --dry-run report, in insert order.
export function countByOrtho(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.ortho_id, (counts.get(row.ortho_id) ?? 0) + 1);
  return counts;
}

function loadFile(path) {
  if (!path) {
    console.error("Usage: node scripts/import-candidates.mjs <file.json> [--dry-run]");
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Failed to read/parse ${path}: ${err.message}`);
    process.exit(1);
  }
}

function reportInvalid(invalid, total) {
  console.error(`\n${invalid.length}/${total} rows are invalid — nothing was inserted:`);
  for (const bad of invalid) {
    console.error(`  row ${bad.index} (${bad.ortho_id ?? "?"} #${bad.rank ?? "?"}): ${bad.problems.join("; ")}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--"));
  const file = loadFile(path);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — export it before running this script.");
    process.exit(1);
  }
  const sql = neon(url);

  // Ortho ids and sizes come from the DB, so an unknown site or an out-of-image
  // box is caught here rather than by a foreign-key error halfway through.
  const orthoRows = await sql`select id, width, height from orthos`;
  const orthoDims = new Map(orthoRows.map((o) => [o.id, { width: o.width, height: o.height }]));

  let batch, rows, invalid;
  try {
    ({ batch, rows, invalid } = validateCandidateFile(file, orthoDims));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`batch ${batch}: ${rows.length} candidates across ${countByOrtho(rows).size} orthos`);
  for (const [orthoId, count] of countByOrtho(rows)) {
    console.log(`  ${orthoId}  ${count}`);
  }

  if (invalid.length) {
    reportInvalid(invalid, rows.length);
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n--dry-run: validated, nothing inserted.");
    return;
  }

  // One multi-row insert, matching api/candidates/index.ts: the whole batch
  // goes over as a single json parameter and json_to_recordset unpacks it
  // server-side. The Neon template tag can't build a multi-row VALUES list, and
  // per-row inserts would be thousands of HTTP round trips.
  const inserted = await sql`
    insert into candidates (ortho_id, batch, rank, x, y, w, h, score)
    select r.ortho_id, ${batch}::text, r.rank, r.x, r.y, r.w, r.h, r.score
    from json_to_recordset(${JSON.stringify(rows)}::json)
      as r(ortho_id text, rank int, x int, y int, w int, h int, score real)
    on conflict (batch, ortho_id, rank) do nothing
    returning id
  `;
  console.log(
    `\n${inserted.length} inserted, ${rows.length - inserted.length} already present (re-import is a no-op).`,
  );
}

// Only run when invoked as a script — the validators above are imported by
// scripts/import-candidates.test.mjs, which must not open a DB connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
